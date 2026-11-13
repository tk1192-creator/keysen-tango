#!/usr/bin/env python3
"""テスト用のダミーデータパック tests/fixtures/dummy-pack.zip を作る。

使い方:
    python tests/make_dummy_pack.py
    python tests/make_dummy_pack.py --out tests/fixtures/dummy-pack.zip

中身:
    - 自作のダミー文 4 件（英文・和訳）と words 7 件。教材の文章・音声は使わない。
    - mp3 は ffmpeg（PATH にあること）で作るビープ音。教材の読み上げ構成
      （英語 → 日本語 → 英語 → 英語）をまねて、4 区間の音を無音でつないだ約 4 秒の音にする。
      英語の区間は高い音（880Hz）、日本語の区間は低い音（440Hz）。
      seg には各区間の開始・終了（秒）を入れ、作った後に ffmpeg の silencedetect で
      実際の音の位置と seg がずれていないか確かめる。
    - 作った素材（json と mp3）は一時フォルダに置き、tools/build_pack.py で zip にする。

既存の dummy-pack.zip は作り直せるので、削除してから作る（.bak を Git に残さないため）。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD_PACK = ROOT / "tools" / "build_pack.py"
DEFAULT_OUT = ROOT / "tests" / "fixtures" / "dummy-pack.zip"

SAMPLE_RATE = 22050
LEAD = 0.30   # 先頭の無音（秒）
GAP = 0.40    # 区間と区間の間の無音（秒）
TAIL = 0.30   # 末尾の無音（秒）
FREQ = {"en": 880, "ja": 440}

# 自作のダミー文（英文, 和訳, 英語区間の長さ, 日本語区間の長さ）
DUMMY_TEXTS = [
    ("My cat sleeps on the sofa.", "私のネコはソファで眠る。", 0.6, 0.7),
    ("We waited for the green bus.", "私たちは緑のバスを待った。", 0.7, 0.8),
    ("She reads a book every night.", "彼女は毎晩本を読む。", 0.8, 0.6),
    ("The boy can swim very fast.", "その少年はとても速く泳げる。", 0.5, 0.9),
]

DUMMY_WORDS = [
    # (見出し語, 品詞, 意味, 熟語か, 例文番号, 例文中の形)
    ("sleep", "動詞", "眠る", False, [1], "sleeps"),
    ("sofa", "名詞", "ソファ", False, [1], "sofa"),
    ("wait for", "熟語", "～を待つ", True, [2], "waited for"),
    ("green", "形容詞", "緑の", False, [2], "green"),
    ("read", "動詞", "～を読む", False, [3], "reads"),
    ("every night", "熟語", "毎晩", True, [3], "every night"),
    ("swim", "動詞", "泳ぐ", False, [4], "swim"),
]


def segments(en_len: float, ja_len: float) -> tuple[dict, float]:
    """英語→日本語→英語→英語 の区間（秒）と全体の長さを計算する。"""
    seg = {}
    t = LEAD
    for key, length in (("en1", en_len), ("ja", ja_len), ("en2", en_len), ("en3", en_len)):
        seg[key] = [round(t, 2), round(t + length, 2)]
        t += length + GAP
    total = t - GAP + TAIL
    return seg, round(total, 2)


def dummy_sentences() -> list[dict]:
    out = []
    for i, (en, ja, en_len, ja_len) in enumerate(DUMMY_TEXTS, start=1):
        seg, _ = segments(en_len, ja_len)
        out.append({"id": i, "file": f"dummy_{i:04d}.mp3", "en": en, "ja": ja,
                    "seg": seg, "needsReview": False, "note": ""})
    return out


def dummy_words() -> list[dict]:
    return [
        {"id": f"w{i:04d}", "word": w, "pos": pos, "meaning": m, "isPhrase": ph,
         "sentenceIds": sids, "form": form, "source": "auto", "verified": False}
        for i, (w, pos, m, ph, sids, form) in enumerate(DUMMY_WORDS, start=1)
    ]


def make_beep_mp3(path: Path, seg: dict) -> None:
    """seg の区間にビープ音、それ以外を無音にした mp3 を ffmpeg で作る。"""
    parts: list[tuple[str, float]] = [("silence", LEAD)]
    for n, key in enumerate(("en1", "ja", "en2", "en3")):
        if n:
            parts.append(("silence", GAP))
        start, end = seg[key]
        parts.append(("ja" if key == "ja" else "en", end - start))
    parts.append(("silence", TAIL))

    inputs: list[str] = []
    for kind, dur in parts:
        if kind == "silence":
            src = f"anullsrc=r={SAMPLE_RATE}:cl=mono,atrim=duration={dur:.3f}"
        else:
            src = f"sine=frequency={FREQ[kind]}:sample_rate={SAMPLE_RATE}:duration={dur:.3f}"
        inputs += ["-f", "lavfi", "-i", src]
    labels = "".join(f"[{i}:a]" for i in range(len(parts)))
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs,
           "-filter_complex", f"{labels}concat=n={len(parts)}:v=0:a=1[out]",
           "-map", "[out]", "-ac", "1", "-ar", str(SAMPLE_RATE),
           "-c:a", "libmp3lame", "-b:a", "32k", str(path)]
    subprocess.run(cmd, check=True)


def detect_sounds(path: Path) -> list[tuple[float, float]]:
    """silencedetect で音のある区間を求める（seg の確認用）。"""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path),
                        "-af", "silencedetect=noise=-35dB:d=0.2", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    # 無音の終わり → 次の無音の始まり が音のある区間
    return [(e, s) for e, s in zip(ends, starts[1:])]


def write_sources(src_dir: Path, fake_audio: bool = False) -> tuple[Path, Path, Path]:
    """sentences.json / words.json / audio/*.mp3 を src_dir に書く。

    fake_audio=True のときは ffmpeg を使わず、中身がダミーのバイト列の .mp3 を置く
    （build_pack.py は音声をデコードしないので、テストの高速化に使う）。
    戻り値は（sentences.json, words.json, audio フォルダ）のパス。
    """
    audio_dir = src_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    sentences = dummy_sentences()
    for s in sentences:
        mp3 = audio_dir / s["file"]
        if fake_audio:
            mp3.write_bytes(b"ID3" + bytes(range(256)) * 4)
        else:
            make_beep_mp3(mp3, s["seg"])
    sp = src_dir / "sentences.json"
    wp = src_dir / "words.json"
    sp.write_text(json.dumps(sentences, ensure_ascii=False, indent=1), encoding="utf-8")
    wp.write_text(json.dumps(dummy_words(), ensure_ascii=False, indent=1), encoding="utf-8")
    return sp, wp, audio_dir


def check_segments(audio_dir: Path, tolerance: float = 0.05) -> tuple[list[str], float]:
    """作った mp3 の音の位置と seg が合っているか確かめる。戻り値は（問題の一覧, 最大のずれ秒）。"""
    problems = []
    max_diff = 0.0
    for s in dummy_sentences():
        found = detect_sounds(audio_dir / s["file"])
        expected = [s["seg"][k] for k in ("en1", "ja", "en2", "en3")]
        if len(found) != 4:
            problems.append(f"{s['file']}: 音の区間が 4 つではありません: {found}")
            continue
        for key, (a, b), (c, d) in zip(("en1", "ja", "en2", "en3"), expected, found):
            max_diff = max(max_diff, abs(a - c), abs(b - d))
            if abs(a - c) > tolerance or abs(b - d) > tolerance:
                problems.append(f"{s['file']} {key}: seg {a:.2f}–{b:.2f} / 実測 {c:.2f}–{d:.2f}")
    return problems, max_diff


def main() -> int:
    ap = argparse.ArgumentParser(description="テスト用のダミーデータパックを作る")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="作る zip のパス")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        print("エラー: ffmpeg が見つかりません（PATH を確認してください）")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        sp, wp, audio_dir = write_sources(Path(tmp))
        problems, max_diff = check_segments(audio_dir)
        if problems:
            for p in problems:
                print(f"エラー: {p}")
            print("seg と実際の音の位置がずれているため、中止しました。")
            return 1
        print(f"mp3 を {len(DUMMY_TEXTS)} 本作りました"
              f"（seg と実際の音の位置の一致を確認済み、最大のずれ {max_diff:.3f} 秒）", flush=True)

        if args.out.exists():
            args.out.unlink()
            print(f"既存のダミーパックを削除しました（作り直すため）: {args.out}", flush=True)
        r = subprocess.run([sys.executable, str(BUILD_PACK), "--sentences", str(sp),
                            "--words", str(wp), "--audio-dir", str(audio_dir),
                            "--out", str(args.out), "--title", "ダミーパック（テスト用）"])
        return r.returncode


if __name__ == "__main__":
    sys.exit(main())
