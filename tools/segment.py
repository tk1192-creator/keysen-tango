#!/usr/bin/env python3
"""英語1・日本語・英語2・英語3 の区間（開始秒/終了秒）を求める。

使い方:
    python tools/segment.py --audio-dir data/private/audio --ids 1 2 5 300 562
    python tools/segment.py --audio-dir data/private/audio --ids 1-10 --out data/private/segments.json
    python tools/segment.py --audio-dir data/private/audio --all --out data/private/segments.json

考え方（CLAUDE.md 2章）:
    文の途中にも 0.3〜0.6 秒の無音があるため、無音の長さだけでは区切れない。
    1) 最初の発声の冒頭（既定 0.4 秒）を「型」にして、ファイル全体と波形の相互相関を取る。
       英語は同じ録音が3回流れるので、英語2・英語3の開始位置に鋭い山が立つ。
    2) 英語3は「開始位置〜ファイル末尾の最後の発声」なので、ここから英語の長さ L が決まる。
    3) 英語1 = [最初の発声, +L]、英語2 = [英語2の開始, +L]、その間の発声を日本語とする。
    4) 波形が一致しない場合は、無音で区切ったブロックの「長さの一致」で求める（予備の方法）。

必要なもの: ffmpeg（PATH にあること）、numpy
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 16000          # 解析用のサンプリング周波数
HOP = 160           # 10ms
FILE_RE = re.compile(r"_(\d{4})_")


def decode(path: Path) -> np.ndarray:
    """ffmpeg でモノラル 16kHz の float32 に変換して読み込む。"""
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def active_runs(x: np.ndarray, thr_db: float, min_run: float = 0.03) -> list[tuple[float, float]]:
    """しきい値を超える区間（秒）の一覧。ごく短い音（クリックなど）は捨てる。"""
    n = len(x) // HOP
    frames = x[: n * HOP].reshape(n, HOP)
    db = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)
    act = db > thr_db
    runs = []
    i = 0
    while i < n:
        if act[i]:
            j = i
            while j < n and act[j]:
                j += 1
            if (j - i) * HOP / SR >= min_run:
                runs.append((i * HOP / SR, j * HOP / SR))
            i = j
        else:
            i += 1
    return runs


def merge_runs(runs: list[tuple[float, float]], min_sil: float) -> list[tuple[float, float]]:
    """min_sil 秒未満の無音でつながる区間を1つにまとめる（silencedetect 相当）。"""
    out: list[list[float]] = []
    for s, e in runs:
        if out and s - out[-1][1] < min_sil:
            out[-1][1] = e
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def ncc(x: np.ndarray, tmpl: np.ndarray) -> np.ndarray:
    """正規化相互相関。戻り値[i] は x[i:i+len(tmpl)] と tmpl の相関（-1〜1）。"""
    m = len(tmpl)
    size = 1 << int(np.ceil(np.log2(len(x) + m)))
    num = np.fft.irfft(np.fft.rfft(x, size) * np.conj(np.fft.rfft(tmpl, size)), size)[: len(x) - m + 1]
    csum = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    energy = csum[m:] - csum[:-m]
    denom = np.sqrt(np.maximum(energy, 1e-12) * float((tmpl.astype(np.float64) ** 2).sum()))
    return num / denom


def seg_corr(x: np.ndarray, a: float, b: float, length: float) -> float:
    """x の a 秒からと b 秒からの、長さ length 秒の波形の相関。"""
    n = int(length * SR)
    ia, ib = int(round(a * SR)), int(round(b * SR))
    n = min(n, len(x) - ia, len(x) - ib)
    if n <= 0:
        return 0.0
    u, v = x[ia: ia + n], x[ib: ib + n]
    d = float(np.sqrt((u ** 2).sum() * (v ** 2).sum()))
    return float((u * v).sum() / d) if d > 0 else 0.0


def by_waveform(x, runs, tmpl_sec, peak_thr):
    """波形の一致で英語2・英語3の開始位置を求める。失敗したら None。"""
    t0, t_end = runs[0][0], runs[-1][1]
    i0 = int(round(t0 * SR))
    m = int(tmpl_sec * SR)
    c = ncc(x, x[i0: i0 + m])
    c[: i0 + m] = 0  # 自分自身との一致を除く
    peaks = []
    for _ in range(8):
        k = int(np.argmax(c))
        if c[k] < peak_thr:
            break
        peaks.append(k / SR)
        c[max(0, k - m): k + m] = 0
    if len(peaks) < 2:
        return None, f"波形の一致が{len(peaks)}か所（2か所以上必要）"
    # 文中に冒頭と似た音があると一致が3か所以上になる。
    # 「英語3は末尾の発声で終わる」「英語1・2・3は同じ長さで重ならない」を満たし、
    # 英語全体の波形が最もよく一致する組を選ぶ。
    best = None
    for s3 in peaks:
        length = t_end - s3
        if length <= tmpl_sec:
            continue
        for s2 in peaks:
            if s2 - t0 < length or s3 - s2 < length:
                continue
            score = min(seg_corr(x, t0, s2, length), seg_corr(x, t0, s3, length))
            if best is None or score > best[4]:
                best = (t0, s2, s3, length, score)
    if best is None:
        return None, "波形の一致位置と長さが矛盾"
    return best, ""


def by_length(runs, min_sil, tol=0.15):
    """無音で区切ったブロックの長さの一致で求める（予備の方法）。"""
    blocks = merge_runs(runs, min_sil)
    t0, t_end = blocks[0][0], blocks[-1][1]
    best = None
    nb = len(blocks)
    for i in range(1, nb - 2):                     # 英語1 = blocks[0:i]
        length = blocks[i - 1][1] - t0
        for k in range(i + 2, nb):                 # 英語3 = blocks[k:]
            e3 = abs((t_end - blocks[k][0]) - length)
            if e3 > tol:
                continue
            for j in range(i + 1, k):              # 英語2 = blocks[j:k]
                e2 = abs((blocks[k - 1][1] - blocks[j][0]) - length)
                if e2 <= tol and (best is None or e2 + e3 < best[0]):
                    best = (e2 + e3, blocks[j][0], blocks[k][0], length)
    if best is None:
        return None
    return t0, best[1], best[2], best[3]


def segment_file(path: Path, thr_db=-35.0, min_sil=0.4, tmpl_sec=0.4, peak_thr=0.6) -> dict:
    """1ファイルの区間を求める。"""
    m = FILE_RE.search(path.name)
    res = {"id": int(m.group(1)) if m else 0, "file": path.name, "seg": None,
           "method": "", "score": 0.0, "needsReview": True, "note": ""}
    x = decode(path)
    res["dur"] = round(len(x) / SR, 2)
    runs = active_runs(x, thr_db)
    if not runs:
        res["note"] = "発声が見つからない"
        return res

    found, why = by_waveform(x, runs, tmpl_sec, peak_thr)
    notes = []
    if found:
        t0, s2, s3, length, score = found
        res["method"], res["score"] = "waveform", round(score, 3)
        if score < 0.8:
            notes.append(f"英語3回の波形の一致が低い({score:.2f})")
    else:
        alt = by_length(runs, min_sil)
        if not alt:
            res["note"] = why + "／長さの一致でも特定できない"
            return res
        t0, s2, s3, length = alt
        res["method"] = "length"
        notes.append(why + "のため長さの一致で特定")

    # 日本語 = 英語1の終わりから英語2の始まりまでの間にある発声
    mid = [(s, e) for s, e in runs if s >= t0 + length - 0.02 and e <= s2 + 0.02]
    # 英語1の語尾がしきい値をまたいで残った分は、英語1の直後に続く短い区間として現れるので除く
    while mid and mid[0][0] - (t0 + length) < 0.1 and mid[0][1] - mid[0][0] < 0.15:
        mid.pop(0)
    if not mid:
        notes.append("日本語の区間が見つからない")
        ja = [round(t0 + length, 2), round(s2, 2)]
    else:
        ja = [round(mid[0][0], 2), round(mid[-1][1], 2)]
        if ja[0] - (t0 + length) < 0.2:
            notes.append("英語1と日本語の間の無音が短い")
        if s2 - ja[1] < 0.2:
            notes.append("日本語と英語2の間の無音が短い")
        if ja[1] - ja[0] < 0.3:
            notes.append("日本語の区間が短すぎる")

    r = lambda a: [round(a, 2), round(a + length, 2)]
    res["seg"] = {"en1": r(t0), "ja": ja, "en2": r(s2), "en3": r(s3)}
    res["needsReview"] = bool(notes)
    res["note"] = "／".join(notes)
    return res


def parse_ids(tokens: list[str]) -> list[int]:
    """「1 2 5」「1-10」のような指定を番号の一覧にする。"""
    ids: list[int] = []
    for t in tokens:
        if "-" in t:
            a, b = t.split("-", 1)
            ids.extend(range(int(a), int(b) + 1))
        else:
            ids.append(int(t))
    return ids


def main() -> int:
    ap = argparse.ArgumentParser(description="英語1・日本語・英語2・英語3 の区間を求める")
    ap.add_argument("--audio-dir", required=True, type=Path, help="mp3 のフォルダ")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--ids", nargs="+", help="処理する番号（例: 1 2 5 300 または 1-10）")
    g.add_argument("--all", action="store_true", help="フォルダ内の全 mp3 を処理する")
    ap.add_argument("--out", type=Path, help="結果を書き出す JSON のパス（省略時は表示のみ）")
    ap.add_argument("--threshold-db", type=float, default=-35.0, help="無音とみなす音量（既定 -35dB）")
    ap.add_argument("--min-silence", type=float, default=0.4, help="区切りとみなす無音の長さ（既定 0.4秒）")
    args = ap.parse_args()

    files = {}
    for p in sorted(args.audio_dir.glob("*.mp3")):
        m = FILE_RE.search(p.name)
        if m:
            files[int(m.group(1))] = p
    ids = sorted(files) if args.all else parse_ids(args.ids)

    results = []
    print("番号 | 長さ  | 英語1         | 日本語        | 英語2         | 英語3         | 方法     | 一致  | 要確認")
    for i in ids:
        if i not in files:
            print(f"{i:04d} | ファイルがない", file=sys.stderr)
            continue
        r = segment_file(files[i], args.threshold_db, args.min_silence)
        results.append(r)
        if r["seg"]:
            f = lambda k: f"{r['seg'][k][0]:5.2f}–{r['seg'][k][1]:5.2f}"
            print(f"{i:04d} | {r['dur']:5.2f} | {f('en1')} | {f('ja')} | {f('en2')} | {f('en3')} | "
                  f"{r['method']:8s} | {r['score']:.3f} | {r['note'] or '-'}")
        else:
            print(f"{i:04d} | {r.get('dur', 0):5.2f} | 特定できず: {r['note']}")

    n_review = sum(1 for r in results if r["needsReview"])
    print(f"\n処理 {len(results)} 件 / 要確認 {n_review} 件")
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"書き出し: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
