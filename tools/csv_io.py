#!/usr/bin/env python3
"""words.json ⇔ words.csv の変換（親が Excel で確認・修正するため）。

使い方:
    # JSON → CSV（Excel で開ける UTF-8 BOM 付き。参照用に例文の英文・和訳の列も付ける）
    python tools/csv_io.py to-csv --words data/private/words.json ^
        --sentences data/private/sentences.json --csv data/private/words.csv

    # CSV → JSON（元の words.json は日時つきの .bak に残してから書き換える）
    python tools/csv_io.py to-json --csv data/private/words.csv ^
        --sentences data/private/sentences.json --words data/private/words.json

CSV の書き方（親向け）:
    - 行を直す：そのまま書き換えて保存する。確認が済んだ行は「確認済み」に ○ を入れる。
    - 行を足す：一番下に行を追加し、ID は空欄のままにする（自動で採番、出典は book になる）。
    - 行を消す：行ごと削除する。
    - 「例文番号」は 12 や 12;40 のように ; 区切り。最初の番号が代表の例文になる。
    - 「参照:」で始まる列は見るためだけの列。書き換えても取り込まれない。
    - Excel で保存するときは「CSV UTF-8（コンマ区切り）」を選ぶ。
      普通の「CSV」で保存してしまっても読み込めるようにしてある（Shift_JIS として読む）。
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

# CSV の列（見出し, words.json のキー）。キーが None の列は参照用で、取り込まない。
COLUMNS = [
    ("ID", "id"),
    ("見出し語", "word"),
    ("品詞", "pos"),
    ("意味", "meaning"),
    ("熟語", "isPhrase"),
    ("例文番号", "sentenceIds"),
    ("例文中の形", "form"),
    ("出典", "source"),
    ("確認済み", "verified"),
    ("メモ", "note"),
    ("参照:英文", None),
    ("参照:和訳", None),
]
TRUE_WORDS = {"○", "〇", "◯", "1", "true", "yes", "y", "はい", "済"}
ID_RE = re.compile(r"^w(\d{4,})$")


def to_bool(s: str) -> bool:
    return str(s).strip().lower() in TRUE_WORDS


def read_csv_text(path: Path) -> str:
    """UTF-8（BOM の有無を問わない）で読み、だめなら Shift_JIS（cp932）で読む。"""
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp932")


def load_sentences(path: Path | None) -> dict[int, dict]:
    if not path:
        return {}
    return {s["id"]: s for s in json.loads(path.read_text(encoding="utf-8-sig"))}


def words_to_csv(words: list[dict], sentences: dict[int, dict], csv_path: Path) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([c[0] for c in COLUMNS])
        for wd in words:
            sid = wd.get("sentenceIds") or []
            ref = sentences.get(sid[0], {}) if sid else {}
            w.writerow([
                wd["id"], wd["word"], wd.get("pos", ""), wd.get("meaning", ""),
                "○" if wd.get("isPhrase") else "",
                ";".join(str(i) for i in sid),
                wd.get("form", ""), wd.get("source", "auto"),
                "○" if wd.get("verified") else "",
                wd.get("note", ""),
                ref.get("en", ""), ref.get("ja", ""),
            ])


def csv_to_words(text: str, sentences: dict[int, dict]) -> tuple[list[dict], list[str]]:
    """CSV の内容を words のリストにする。戻り値の 2 つめは警告（取り込みは続ける）とエラー。"""
    rows = list(csv.reader(text.splitlines()))
    if not rows:
        raise ValueError("CSV が空です")
    header = [h.strip() for h in rows[0]]
    idx = {}
    for title, key in COLUMNS:
        if key and title not in header:
            raise ValueError(f"列「{title}」がありません（1行目の見出しを消していませんか）")
        if key:
            idx[key] = header.index(title)

    problems: list[str] = []
    words: list[dict] = []
    used_ids: set[str] = set()
    max_no = 0
    for r in rows[1:]:
        m = ID_RE.match(r[idx["id"]].strip()) if len(r) > idx["id"] else None
        if m:
            max_no = max(max_no, int(m.group(1)))

    for line_no, r in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in r):
            continue  # 空行は無視
        r = r + [""] * (len(header) - len(r))
        get = lambda k: r[idx[k]].strip()
        wid = get("id")
        if not wid:
            max_no += 1
            wid = f"w{max_no:04d}"
            source = get("source") or "book"
        else:
            source = get("source") or "auto"
            if not ID_RE.match(wid):
                problems.append(f"エラー: {line_no}行目 ID「{wid}」の形が違います（w0001 の形）")
        if wid in used_ids:
            problems.append(f"エラー: {line_no}行目 ID「{wid}」が重複しています")
        used_ids.add(wid)

        word = get("word")
        if not word:
            problems.append(f"エラー: {line_no}行目 見出し語が空です")
        sids: list[int] = []
        for t in re.split(r"[;；,、\s]+", get("sentenceIds")):
            if not t:
                continue
            if not t.isdigit():
                problems.append(f"エラー: {line_no}行目 例文番号「{t}」が数字ではありません")
                continue
            n = int(t)
            if sentences and n not in sentences:
                problems.append(f"エラー: {line_no}行目 例文番号 {n} の例文がありません")
            sids.append(n)
        if not sids:
            problems.append(f"警告: {line_no}行目「{word}」に例文番号がありません")
        if source not in ("auto", "book"):
            problems.append(f"警告: {line_no}行目 出典「{source}」は auto か book にしてください")
        if not get("meaning"):
            problems.append(f"警告: {line_no}行目「{word}」の意味が空です")

        words.append({
            "id": wid, "word": word, "pos": get("pos"), "meaning": get("meaning"),
            "isPhrase": to_bool(get("isPhrase")),
            "sentenceIds": sids, "form": get("form"), "source": source,
            "verified": to_bool(get("verified")),
            **({"note": get("note")} if get("note") else {}),
        })
    words.sort(key=lambda w: int(ID_RE.match(w["id"]).group(1)) if ID_RE.match(w["id"]) else 10**9)
    return words, problems


def diff_summary(old: list[dict], new: list[dict]) -> str:
    o = {w["id"]: w for w in old}
    n = {w["id"]: w for w in new}
    added = [i for i in n if i not in o]
    deleted = [i for i in o if i not in n]
    changed = [i for i in n if i in o and n[i] != o[i]]
    verified = sum(1 for w in new if w["verified"])
    return (f"追加 {len(added)} / 変更 {len(changed)} / 削除 {len(deleted)} / "
            f"合計 {len(new)} 件（うち確認済み {verified} 件）")


def main() -> int:
    ap = argparse.ArgumentParser(description="words.json ⇔ words.csv の変換")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("to-csv", help="words.json → words.csv")
    a.add_argument("--words", required=True, type=Path)
    a.add_argument("--csv", required=True, type=Path)
    a.add_argument("--sentences", type=Path, help="参照用の英文・和訳を付ける場合に指定")
    b = sub.add_parser("to-json", help="words.csv → words.json")
    b.add_argument("--csv", required=True, type=Path)
    b.add_argument("--words", required=True, type=Path)
    b.add_argument("--sentences", type=Path, help="例文番号が実在するか確かめる場合に指定")
    b.add_argument("--dry-run", action="store_true", help="チェックと差分の表示だけして書き込まない")
    args = ap.parse_args()

    sentences = load_sentences(args.sentences)
    if args.cmd == "to-csv":
        words = json.loads(args.words.read_text(encoding="utf-8-sig"))
        words_to_csv(words, sentences, args.csv)
        print(f"書き出し: {args.csv}（{len(words)} 件）")
        return 0

    new, problems = csv_to_words(read_csv_text(args.csv), sentences)
    for p in problems:
        print(p)
    errors = [p for p in problems if p.startswith("エラー")]
    old = json.loads(args.words.read_text(encoding="utf-8-sig")) if args.words.exists() else []
    print(diff_summary(old, new))
    if errors:
        print(f"エラーが {len(errors)} 件あるため、words.json は書き換えていません。")
        return 1
    if args.dry_run:
        print("--dry-run のため書き込みはしていません。")
        return 0
    if args.words.exists():
        bak = args.words.with_name(f"{args.words.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
        shutil.copy2(args.words, bak)
        print(f"元のファイルを保存: {bak}")
    args.words.write_text(json.dumps(new, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"書き出し: {args.words}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
