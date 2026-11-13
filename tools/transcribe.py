#!/usr/bin/env python3
"""区間ごとに文字起こしをして sentences.json を作る。

使い方:
    # 5本で試す
    python tools/transcribe.py --audio-dir data/private/audio --work-dir data/private/transcripts ^
        --ids 1 2 5 300 562 --sentences data/private/sentences_trial.json

    # 全件（途中で止まっても、もう一度同じコマンドで続きから再開できる）
    python tools/transcribe.py --audio-dir data/private/audio --work-dir data/private/transcripts ^
        --all --sentences data/private/sentences.json --review-csv data/private/review.csv

処理の流れ（1ファイルごと）:
    1) tools/segment.py で 英語1・日本語・英語2・英語3 の区間を求める
    2) 英語1・英語2 を language="en"、日本語を language="ja" で別々に文字起こしする
    3) 英語1と英語2が食い違えば英語3も文字起こしし、needsReview=true にする
    4) 結果を work-dir/0001.json のように1本ずつ保存する（保存済みはスキップ）
    最後に work-dir の全結果をまとめて sentences.json（CLAUDE.md 6章の形式）を書き出す。

必要なもの: ffmpeg、numpy、faster-whisper（初回はモデルを自動でダウンロードする）
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import segment as sg  # noqa: E402

PAD = 0.15             # 区間の前後に足す余白（秒）。語頭・語尾の切れを防ぐ
LOGPROB_WARN = -0.6    # これより自信が低い文字起こしは要確認にする
# 日本語に句読点を付けさせるためのヒント（教材とは無関係の自作文）
JA_PROMPT = "こんにちは。今日は、とてもいい天気ですね。私は、毎朝7時に起きます。"
# ヒント文がそのまま出力される（混入する）ことがあるため、検出用に文ごとに分けておく
JA_PROMPT_SENTS = [s + "。" for s in JA_PROMPT.split("。") if s]


def norm_en(s: str) -> str:
    """英文の比較用。大文字小文字・句読点・余分な空白を無視する。"""
    s = s.lower().replace("’", "'")
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return " ".join(s.split())


def clip(x, span, dur):
    """音声配列から区間 span（秒）を切り出す。"""
    a = max(0.0, span[0] - PAD)
    b = min(dur, span[1] + PAD)
    return x[int(a * sg.SR): int(b * sg.SR)]


def run_asr(model, audio, lang: str, beam: int, use_prompt: bool = True) -> tuple[str, float]:
    """1区間を文字起こしし、(テキスト, 平均対数確率の最小値) を返す。"""
    segs, _ = model.transcribe(
        audio, language=lang, beam_size=beam, vad_filter=False,
        condition_on_previous_text=False, without_timestamps=True, temperature=0.0,
        initial_prompt=JA_PROMPT if (lang == "ja" and use_prompt) else None,
    )
    segs = list(segs)
    sep = "" if lang == "ja" else " "
    text = sep.join(s.text.strip() for s in segs).strip()
    lp = min((s.avg_logprob for s in segs), default=-9.0)
    return text, round(float(lp), 3)


def process(path: Path, model, beam: int) -> dict:
    """1ファイルを処理して、作業用の結果（詳細つき）を返す。"""
    t_start = time.time()
    seg = sg.segment_file(path)
    rec = {"id": seg["id"], "file": seg["file"], "en": "", "ja": "", "seg": seg["seg"],
           "needsReview": True, "note": "", "detail": {}}
    reasons = []
    if seg["needsReview"]:
        reasons.append("区間: " + (seg["note"] or "要確認"))
    if not seg["seg"]:
        rec["note"] = "／".join(reasons)
        return rec

    x = sg.decode(path)
    dur = len(x) / sg.SR
    s = seg["seg"]
    en1, lp1 = run_asr(model, clip(x, s["en1"], dur), "en", beam)
    en2, lp2 = run_asr(model, clip(x, s["en2"], dur), "en", beam)
    ja, lpj = run_asr(model, clip(x, s["ja"], dur), "ja", beam)
    d = {"en1": en1, "en2": en2, "lp_en1": lp1, "lp_en2": lp2, "lp_ja": lpj}
    # ヒント文の混入対策：ヒント文と同じ文が出たら、ヒントなしでやり直して比べる
    if any(p in ja for p in JA_PROMPT_SENTS):
        ja2, lpj2 = run_asr(model, clip(x, s["ja"], dur), "ja", beam, use_prompt=False)
        d.update({"ja_with_prompt": ja, "ja_no_prompt": ja2})
        if ja2.rstrip("。") != ja.rstrip("。"):
            ja, lpj = ja2, lpj2
            d["lp_ja"] = lpj
            reasons.append("ヒント文の混入の疑い（ヒントなしで認識し直した。句読点なし）")

    en = en1
    if norm_en(en1) != norm_en(en2):
        en3, lp3 = run_asr(model, clip(x, s["en3"], dur), "en", beam)
        d.update({"en3": en3, "lp_en3": lp3})
        if norm_en(en3) == norm_en(en2):
            en = en2
            reasons.append("英語1と英語2が不一致（英語3は英語2と一致→英語2を採用）")
        elif norm_en(en3) == norm_en(en1):
            reasons.append("英語1と英語2が不一致（英語3は英語1と一致→英語1を採用）")
        else:
            reasons.append("英語1・2・3がすべて不一致")
    if not en.strip():
        reasons.append("英文が空")
    if not ja.strip():
        reasons.append("和訳が空")
    if min(lp1, lp2) < LOGPROB_WARN:
        reasons.append(f"英語の認識の自信が低い({min(lp1, lp2):.2f})")
    if lpj < LOGPROB_WARN:
        reasons.append(f"日本語の認識の自信が低い({lpj:.2f})")

    d["sec"] = round(time.time() - t_start, 1)
    rec.update({"en": en, "ja": ja, "needsReview": bool(reasons),
                "note": "／".join(reasons), "detail": d})
    return rec


def apply_corrections(recs: list[dict], path: Path | None) -> int:
    """人が直した内容（corrections.json）を自動の結果より優先して反映する。

    corrections.json の形:
        {"146": {"en": "...", "ja": "...", "by": "...", "date": "...", "memo": "...", "needsReview": false}}
    en / ja のうち書かれている項目だけを置き換える。
    needsReview は省略すると false（確定）。true にすると、直した上で要確認として残す（本での確認待ち）。
    """
    if not path or not path.exists():
        return 0
    fixes = json.loads(path.read_text(encoding="utf-8-sig"))
    by_id = {r["id"]: r for r in recs}
    n = 0
    for key, fx in fixes.items():
        r = by_id.get(int(key))
        if not r:
            print(f"警告: corrections.json の番号 {key} の結果がありません")
            continue
        for k in ("en", "ja"):
            if fx.get(k):
                r[k] = fx[k]
        r["needsReview"] = bool(fx.get("needsReview", False))
        head = "要確認（本で確認）" if r["needsReview"] else "手修正済み"
        memo = f"：{fx['memo']}" if fx.get("memo") else ""
        r["note"] = f"{head}{memo}（{fx.get('by', '')} {fx.get('date', '')}）／自動判定: {r['note'] or 'なし'}"
        n += 1
    return n


def normalize(recs: list[dict]) -> None:
    """機械的にそろえられる表記を直す（手修正より前に行う）。
    和訳：半角スペースを取り除き、文末に句点がなければ「。」を付ける。
    英文：先頭を大文字にし、文末に句読点がなければ「.」を付ける。
    """
    for r in recs:
        ja = r["ja"].replace(" ", "").strip()
        if ja and ja[-1] not in "。?!？！」":
            ja += "。"
        r["ja"] = ja
        en = r["en"].strip()
        if en:
            en = en[0].upper() + en[1:]
            if en[-1] not in ".?!\"":
                en += "."
        r["en"] = en


def build_outputs(work_dir: Path, sentences: Path | None, review_csv: Path | None,
                  corrections: Path | None = None) -> list[dict]:
    """作業フォルダの全結果を sentences.json と review.csv にまとめる。"""
    recs = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(work_dir.glob("[0-9]*.json"))]
    recs.sort(key=lambda r: r["id"])
    normalize(recs)
    n_fix = apply_corrections(recs, corrections)
    if n_fix:
        print(f"手修正を反映: {n_fix} 件")
    keys = ["id", "file", "en", "ja", "seg", "needsReview", "note"]
    if sentences:
        sentences.parent.mkdir(parents=True, exist_ok=True)
        out = [{k: r[k] for k in keys} for r in recs]
        sentences.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    if review_csv:
        review_csv.parent.mkdir(parents=True, exist_ok=True)
        # Excel で文字化けしないよう UTF-8 BOM 付き
        with review_csv.open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["番号", "英文", "和訳", "要確認の理由", "英語1", "英語2", "英語3"])
            for r in recs:
                if r["needsReview"]:
                    d = r.get("detail", {})
                    w.writerow([r["id"], r["en"], r["ja"], r["note"],
                                d.get("en1", ""), d.get("en2", ""), d.get("en3", "")])
    return recs


def main() -> int:
    ap = argparse.ArgumentParser(description="区間ごとに文字起こしをして sentences.json を作る")
    ap.add_argument("--audio-dir", required=True, type=Path, help="mp3 のフォルダ")
    ap.add_argument("--work-dir", required=True, type=Path, help="1本ずつの結果を保存するフォルダ")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--ids", nargs="+", help="処理する番号（例: 1 2 5 300 または 1-10）")
    g.add_argument("--all", action="store_true", help="フォルダ内の全 mp3 を処理する")
    ap.add_argument("--sentences", type=Path, help="まとめた sentences.json の出力先")
    ap.add_argument("--review-csv", type=Path, help="要確認の一覧（CSV）の出力先")
    ap.add_argument("--corrections", type=Path,
                    help="人が直した内容（corrections.json）。自動の結果より優先して反映する")
    ap.add_argument("--model", default="medium", help="Whisper のモデル（既定 medium）")
    ap.add_argument("--compute-type", default="int8", help="既定 int8")
    ap.add_argument("--threads", type=int, default=4, help="CPU スレッド数（既定 4）")
    ap.add_argument("--beam", type=int, default=5, help="ビーム幅（既定 5）")
    ap.add_argument("--force", action="store_true", help="保存済みでも処理し直す")
    ap.add_argument("--shard", default="0/1",
                    help="並列実行の担当分け k/n（番号を n で割った余りが k のものだけ処理）。例: 0/2 と 1/2")
    args = ap.parse_args()
    shard_k, shard_n = (int(v) for v in args.shard.split("/"))

    files = {}
    for p in sorted(args.audio_dir.glob("*.mp3")):
        m = sg.FILE_RE.search(p.name)
        if m:
            files[int(m.group(1))] = p
    ids = sorted(files) if args.all else sg.parse_ids(args.ids)
    args.work_dir.mkdir(parents=True, exist_ok=True)

    ids = [i for i in ids if i % shard_n == shard_k]
    todo = [i for i in ids if i in files and (args.force or not (args.work_dir / f"{i:04d}.json").exists())]
    print(f"対象 {len(ids)} 本 / 処理済みでスキップ {len(ids) - len(todo)} 本 / これから処理 {len(todo)} 本", flush=True)

    if todo:
        from faster_whisper import WhisperModel
        t0 = time.time()
        model = WhisperModel(args.model, device="cpu", compute_type=args.compute_type, cpu_threads=args.threads)
        print(f"モデル {args.model} 読み込み {time.time() - t0:.1f} 秒", flush=True)
        t_all = time.time()
        for n, i in enumerate(todo, 1):
            # 別のプロセスが先に処理していたら飛ばす（並列実行のとき用）
            if not args.force and (args.work_dir / f"{i:04d}.json").exists():
                continue
            rec = process(files[i], model, args.beam)
            tmp = args.work_dir / f"{i:04d}.json.tmp"
            tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(args.work_dir / f"{i:04d}.json")  # 書きかけのファイルを残さない
            el = time.time() - t_all
            eta = el / n * (len(todo) - n)
            flag = "要確認" if rec["needsReview"] else "OK"
            print(f"[{n}/{len(todo)}] {i:04d} {flag} {rec['detail'].get('sec', 0)}秒 "
                  f"（経過 {el / 60:.1f} 分・残り約 {eta / 60:.0f} 分）", flush=True)

    recs = build_outputs(args.work_dir, args.sentences, args.review_csv, args.corrections)
    sel = [r for r in recs if r["id"] in set(ids)]
    print(f"\n対象のうち 要確認 {sum(r['needsReview'] for r in sel)} 件 / {len(sel)} 件")
    if args.sentences:
        print(f"書き出し: {args.sentences}（作業フォルダ内の全 {len(recs)} 件）")
    if args.review_csv:
        print(f"書き出し: {args.review_csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
