#!/usr/bin/env python3
"""アプリのアイコン（PNG）を作る。Python 標準ライブラリだけで動く（zlib と struct で PNG を書く）。

使い方:
    python tools/make_icons.py --out-dir icons
    python tools/make_icons.py --out-dir icons --check     … 作ったあと読み直して、サイズと中身を確かめる

作るもの:
    icon-192.png           … 192×192（角丸の背景、外側は透明）
    icon-512.png           … 512×512（同上）
    icon-maskable-512.png  … 512×512（全面を背景色で塗り、文字は中央 80% の円に収める）
    apple-touch-icon.png   … 180×180（iPhone 用。透明部分があると黒くなるため全面を塗る）

デザイン:
    アプリの色（css/style.css の --primary：#2f5d8a）の背景に、白の「単」。
    フォントは使わず、矩形と太い線（両端が丸い線分）の組み合わせで描く。
    1 ピクセルを 4×4 に分けて塗り、平均してなめらかにする（アンチエイリアス）。
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import zlib
from pathlib import Path

BG = (0x2F, 0x5D, 0x8A)     # --primary
FG = (0xFF, 0xFF, 0xFF)     # 文字の色
SS = 4                      # 1 ピクセルあたりの分割数（縦横）

# 「単」の形。座標は中心 (0, 0)、だいたい ±44 の範囲（100 を一辺とする正方形のつもり）。
# ("rect", x0, y0, x1, y1) … 塗りつぶしの矩形
# ("line", xa, ya, xb, yb, w) … 太さ w の線分（両端は丸い）
STROKE = 8
GLYPH = [
    # 上の 3 つの点（ツ のような形）
    ("line", -21, -41, -15, -30, STROKE),
    ("line", 0, -43, 0, -31, STROKE),
    ("line", 21, -42, 13, -30, STROKE),
    # 田の形（外枠＋中の横線＋中の縦線）
    ("rect", -27, -25, 27, -25 + STROKE),        # 上辺
    ("rect", -27, 8 - STROKE, 27, 8),            # 下辺
    ("rect", -27, -25, -27 + STROKE, 8),         # 左辺
    ("rect", 27 - STROKE, -25, 27, 8),           # 右辺
    ("rect", -27, -12.5, 27, -12.5 + STROKE),    # 中の横線
    ("rect", -STROKE / 2, -25, STROKE / 2, 8),   # 中の縦線
    # 長い横線
    ("rect", -40, 18, 40, 18 + STROKE),
    # 下に伸びる縦線
    ("rect", -STROKE / 2, 8, STROKE / 2, 45),
]
GLYPH_RADIUS = max(  # 中心から一番遠い点までの距離（maskable の大きさ決めに使う）
    max(math.hypot(x, y) for x in (s[1], s[3]) for y in (s[2], s[4])) + (s[5] / 2 if s[0] == "line" else 0)
    for s in GLYPH
)


def render(size: int, glyph_scale: float, rounded: bool) -> bytes:
    """RGBA のピクセル列（size*size*4 バイト）を返す。

    glyph_scale: 文字の 1 単位を、画像の一辺の何分の 1 にするか（例：0.008 → 100 単位で 80%）
    rounded: True なら角丸の背景（外側は透明）、False なら全面を背景色で塗る
    """
    n = size * SS
    unit = glyph_scale * n           # 文字の 1 単位あたりのサブピクセル数
    cx = cy = n / 2
    fg = bytearray(n * n)            # 文字の部分なら 1
    bg = bytearray(n * n)            # 背景の部分なら 1

    # 背景
    if rounded:
        r = 0.18 * n
        for y in range(n):
            py = y + 0.5
            dy = max(r - py, py - (n - r), 0.0)
            if dy > 0:
                half = math.sqrt(max(r * r - dy * dy, 0.0))
                x0 = math.ceil(r - half - 0.5)
                x1 = math.floor(n - r + half - 0.5)
            else:
                x0, x1 = 0, n - 1
            for x in range(max(x0, 0), min(x1, n - 1) + 1):
                bg[y * n + x] = 1
    else:
        bg[:] = b"\x01" * (n * n)

    # 文字（図形ごとに、その外接矩形の中だけを調べる）
    for shape in GLYPH:
        if shape[0] == "rect":
            _, x0, y0, x1, y1 = shape
            px0, px1 = cx + x0 * unit, cx + x1 * unit
            py0, py1 = cy + y0 * unit, cy + y1 * unit
            for y in range(max(int(py0), 0), min(int(math.ceil(py1)), n)):
                if not (py0 <= y + 0.5 < py1):
                    continue
                row = y * n
                for x in range(max(int(px0), 0), min(int(math.ceil(px1)), n)):
                    if px0 <= x + 0.5 < px1:
                        fg[row + x] = 1
        else:
            _, xa, ya, xb, yb, w = shape
            ax, ay = cx + xa * unit, cy + ya * unit
            bx, by = cx + xb * unit, cy + yb * unit
            hw = w / 2 * unit
            dx, dy = bx - ax, by - ay
            ll = dx * dx + dy * dy
            for y in range(max(int(min(ay, by) - hw), 0), min(int(max(ay, by) + hw) + 1, n)):
                py = y + 0.5
                row = y * n
                for x in range(max(int(min(ax, bx) - hw), 0), min(int(max(ax, bx) + hw) + 1, n)):
                    px = x + 0.5
                    t = ((px - ax) * dx + (py - ay) * dy) / ll if ll else 0.0
                    t = min(max(t, 0.0), 1.0)
                    qx, qy = ax + t * dx - px, ay + t * dy - py
                    if qx * qx + qy * qy <= hw * hw:
                        fg[row + x] = 1

    # 縮小して RGBA にする
    out = bytearray(size * size * 4)
    area = SS * SS
    for y in range(size):
        for x in range(size):
            nb = nf = 0
            for sy in range(SS):
                base = (y * SS + sy) * n + x * SS
                for sx in range(SS):
                    i = base + sx
                    if bg[i]:
                        nb += 1
                        if fg[i]:
                            nf += 1
            o = (y * size + x) * 4
            if nb == 0:
                continue  # 透明（out は 0 で初期化済み）
            a = nf / nb   # 背景の中での文字の割合
            for c in range(3):
                out[o + c] = round(BG[c] * (1 - a) + FG[c] * a)
            out[o + 3] = round(255 * nb / area)
    return bytes(out)


def png_bytes(size: int, rgba: bytes) -> bytes:
    """RGBA（8bit）の PNG を作る。"""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    stride = size * 4
    raw = b"".join(b"\x00" + rgba[y * stride:(y + 1) * stride] for y in range(size))  # 各行の先頭はフィルタ 0
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def read_png(path: Path) -> tuple[int, int, bytes]:
    """作った PNG を読み直す（確認用）。署名・CRC・展開後の長さを検査し、(幅, 高さ, 行データ) を返す。"""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: PNG の署名がありません")
    pos, width, height, idat = 8, None, None, b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise ValueError(f"{path}: {kind!r} の CRC が合いません")
        if kind == b"IHDR":
            width, height, depth, ctype = struct.unpack(">IIBB", body[:10])
            if (depth, ctype) != (8, 6):
                raise ValueError(f"{path}: RGBA 8bit ではありません")
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
        pos += 12 + length
    raw = zlib.decompress(idat)
    if width is None or len(raw) != height * (1 + width * 4):
        raise ValueError(f"{path}: 画像データの長さが合いません")
    return width, height, raw


# (ファイル名, 一辺, 文字の大きさ, 角丸か)
# 通常のアイコンは文字の高さが一辺の約 70%。
# maskable は、文字全体が中心から半径 38% の円に収まる大きさにする（安全領域は中央 80%＝半径 40%）。
ICONS = [
    ("icon-192.png", 192, 0.0080, True),
    ("icon-512.png", 512, 0.0080, True),
    ("icon-maskable-512.png", 512, 0.38 / GLYPH_RADIUS, False),
    ("apple-touch-icon.png", 180, 0.0080, False),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="アプリのアイコン（PNG）を作る")
    ap.add_argument("--out-dir", required=True, type=Path, help="出力先のフォルダ（例：icons）")
    ap.add_argument("--check", action="store_true", help="作ったあと読み直して確かめる")
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for name, size, scale, rounded in ICONS:
        path = args.out_dir / name
        path.write_bytes(png_bytes(size, render(size, scale, rounded)))
        print(f"作成: {path}（{size}×{size}）")

    if args.check:
        ok = True
        for name, size, _, rounded in ICONS:
            path = args.out_dir / name
            try:
                w, h, raw = read_png(path)
            except ValueError as e:
                print(f"NG: {e}")
                ok = False
                continue
            # 角（左上）のピクセルの不透明度：角丸なら 0、全面塗りなら 255 のはず
            corner_alpha = raw[1 + 3]
            expect = 0 if rounded else 255
            status = "OK" if (w, h) == (size, size) and corner_alpha == expect else "NG"
            ok &= status == "OK"
            print(f"{status}: {name} {w}×{h}、左上の不透明度 {corner_alpha}（期待値 {expect}）")
        print(f"maskable の文字の外周：中心から一辺の {0.38 * 100:.0f}%（安全領域は 40%）")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
