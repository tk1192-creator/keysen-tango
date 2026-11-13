#!/usr/bin/env python3
"""words.json ⇔ words.csv の変換と、本の番号の点検（親が Excel で確認・修正するため）。

使い方:
    # JSON → CSV（Excel で開ける UTF-8 BOM 付き。参照用に例文の英文・和訳の列も付ける）
    python tools/csv_io.py to-csv --words data/private/words.json ^
        --sentences data/private/sentences.json --csv data/private/words.csv

    # CSV → JSON（元の words.json は日時つきの .bak に残してから書き換える）
    python tools/csv_io.py to-json --csv data/private/words.csv ^
        --sentences data/private/sentences.json --words data/private/words.json
    #   --dry-run を付けると、検査と差分の表示だけして書き込まない

    # 本の番号 1〜1813 の割り当て状況を一覧にする（UTF-8 BOM 付き CSV）
    python tools/csv_io.py check-bookno --words data/private/words.json ^
        --out data/private/bookno_check.csv

CSV の列（左から）:
    ID, 本の番号, 番号の候補, 見出し語, 品詞, 意味, 熟語, まとめ, 例文番号, 関連例文,
    例文中の形, 出典, 確認済み, メモ, 参照:英文, 参照:和訳

CSV の書き方（親向け）:
    - 行を直す：そのまま書き換えて保存する。確認が済んだ行は「確認済み」に ○ を入れる。
    - 行を足す：一番下に行を追加し、ID は空欄のままにする（自動で採番、出典は book になる）。
    - 行を消す：行ごと削除する。
    - 「本の番号」には本に書かれている見出し語の番号（1〜1813）を入れる。
      同じ番号を 2 つの行に入れるとエラーになる。分からなければ空欄でよい。
    - 「番号の候補」は、前後の行の本の番号から連番で推測した番号。見るためだけの列で、取り込まれない。
      合っていれば「本の番号」に書き写す。
    - 例文にない語（「家族」「似た意味」のようなまとめの語）は、一番下に行を足し、
      ID は空欄、まとめ・本の番号・意味・品詞を書く。例文番号は空欄、関連例文は分かれば書く。
    - 「例文番号」「関連例文」は 12 や 12;40 のように ; 区切り。例文番号は最初の番号が代表の例文になる。
    - 「参照:」で始まる列も見るためだけの列。書き換えても取り込まれない。
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
    ("本の番号", "bookNo"),
    ("番号の候補", None),
    ("見出し語", "word"),
    ("品詞", "pos"),
    ("意味", "meaning"),
    ("熟語", "isPhrase"),
    ("まとめ", "group"),
    ("例文番号", "sentenceIds"),
    ("関連例文", "relatedSentenceIds"),
    ("例文中の形", "form"),
    ("出典", "source"),
    ("確認済み", "verified"),
    ("メモ", "note"),
    ("参照:英文", None),
    ("参照:和訳", None),
]
# 後から足した列。古い CSV に無くても読めるようにする（無ければ空欄扱い）。
OPTIONAL_KEYS = {"bookNo", "group", "relatedSentenceIds"}
BOOK_NO_MIN = 1
BOOK_NO_MAX = 1813
TRUE_WORDS = {"○", "〇", "◯", "1", "true", "yes", "y", "はい", "済"}
ID_RE = re.compile(r"^w(\d{4,})$")
SPLIT_RE = re.compile(r"[;；,、\s]+")


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


def valid_book_no(v) -> int | None:
    """words.json の bookNo が範囲内の整数ならその値、そうでなければ None。"""
    if isinstance(v, int) and not isinstance(v, bool) and BOOK_NO_MIN <= v <= BOOK_NO_MAX:
        return v
    return None


def book_no_candidates(words: list[dict]) -> list[int | None]:
    """本の番号が空の語に、今の並びから連番で推測した番号の候補を付ける。

    - 前後に本の番号がある語：前の番号から 1 ずつ増やす（後ろの番号に届いたらそれ以降は空欄）。
    - 前にしかない：前の番号から 1 ずつ増やす。後ろにしかない：後ろの番号から 1 ずつ減らす。
    - 本の番号が 1 つも無い：並びの順に 1, 2, 3…。
    - 1〜1813 の外になる候補と、本の番号がすでに入っている語は None（空欄）。
    """
    nos = [valid_book_no(w.get("bookNo")) for w in words]
    known = [i for i, n in enumerate(nos) if n is not None]
    result: list[int | None] = [None] * len(words)
    if not known:
        for i in range(len(words)):
            result[i] = i + 1 if BOOK_NO_MIN <= i + 1 <= BOOK_NO_MAX else None
        return result

    prev_i: int | None = None
    k = 0  # known の中で「次に本の番号がある位置」を指す
    for i, n in enumerate(nos):
        if n is not None:
            prev_i = i
            k += 1
            continue
        next_i = known[k] if k < len(known) else None
        if prev_i is not None:
            cand = nos[prev_i] + (i - prev_i)
            if next_i is not None and cand >= nos[next_i]:
                cand = None  # 間の語の数が番号の差より多い：後ろの番号とぶつかるので推測しない
        else:
            cand = nos[next_i] - (next_i - i)
        if cand is not None and BOOK_NO_MIN <= cand <= BOOK_NO_MAX:
            result[i] = cand
    return result


def words_to_csv(words: list[dict], sentences: dict[int, dict], csv_path: Path) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    cands = book_no_candidates(words)
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([c[0] for c in COLUMNS])
        for wd, cand in zip(words, cands):
            sid = wd.get("sentenceIds") or []
            rel = wd.get("relatedSentenceIds") or []
            ref = sentences.get(sid[0], {}) if sid else {}
            book_no = wd.get("bookNo")
            w.writerow([
                wd["id"],
                "" if book_no is None else book_no,
                "" if cand is None else cand,
                wd["word"], wd.get("pos", ""), wd.get("meaning", ""),
                "○" if wd.get("isPhrase") else "",
                wd.get("group", ""),
                ";".join(str(i) for i in sid),
                ";".join(str(i) for i in rel),
                wd.get("form", ""), wd.get("source", "auto"),
                "○" if wd.get("verified") else "",
                wd.get("note", ""),
                ref.get("en", ""), ref.get("ja", ""),
            ])


def parse_ids(text: str, line_no: int, title: str, sentences: dict[int, dict],
              problems: list[str]) -> list[int]:
    """「12;40」のような例文番号の並びを読む。数字でない・例文が無いものはエラーに積む。"""
    ids: list[int] = []
    for t in SPLIT_RE.split(text):
        if not t:
            continue
        if not t.isdigit():
            problems.append(f"エラー: {line_no}行目 {title}「{t}」が数字ではありません")
            continue
        n = int(t)
        if sentences and n not in sentences:
            problems.append(f"エラー: {line_no}行目 {title} {n} の例文がありません")
        ids.append(n)
    return ids


def csv_to_words(text: str, sentences: dict[int, dict]) -> tuple[list[dict], list[str]]:
    """CSV の内容を words のリストにする。戻り値の 2 つめは警告（取り込みは続ける）とエラー。"""
    rows = list(csv.reader(text.splitlines()))
    if not rows:
        raise ValueError("CSV が空です")
    header = [h.strip() for h in rows[0]]
    idx: dict[str, int] = {}
    for title, key in COLUMNS:
        if not key:
            continue
        if title in header:
            idx[key] = header.index(title)
        elif key not in OPTIONAL_KEYS:
            raise ValueError(f"列「{title}」がありません（1行目の見出しを消していませんか）")

    problems: list[str] = []
    words: list[dict] = []
    used_ids: set[str] = set()
    book_no_lines: dict[int, list[tuple[int, str]]] = {}
    max_no = 0
    for r in rows[1:]:
        m = ID_RE.match(r[idx["id"]].strip()) if len(r) > idx["id"] else None
        if m:
            max_no = max(max_no, int(m.group(1)))

    for line_no, r in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in r):
            continue  # 空行は無視
        r = r + [""] * (len(header) - len(r))
        get = lambda k: r[idx[k]].strip() if k in idx else ""
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

        book_no: int | None = None
        raw_no = get("bookNo")
        if raw_no:
            if not re.fullmatch(r"[0-9０-９]+", raw_no):
                problems.append(f"エラー: {line_no}行目 本の番号「{raw_no}」が整数ではありません")
            else:
                book_no = int(raw_no)
                if not BOOK_NO_MIN <= book_no <= BOOK_NO_MAX:
                    problems.append(f"エラー: {line_no}行目 本の番号 {book_no} は "
                                    f"{BOOK_NO_MIN}〜{BOOK_NO_MAX} の範囲外です")
                    book_no = None
                else:
                    book_no_lines.setdefault(book_no, []).append((line_no, word))

        sids = parse_ids(get("sentenceIds"), line_no, "例文番号", sentences, problems)
        rel = parse_ids(get("relatedSentenceIds"), line_no, "関連例文", sentences, problems)
        if not sids and source != "book":
            problems.append(f"警告: {line_no}行目「{word}」に例文番号がありません")
        if source not in ("auto", "book"):
            problems.append(f"警告: {line_no}行目 出典「{source}」は auto か book にしてください")
        if not get("meaning"):
            problems.append(f"警告: {line_no}行目「{word}」の意味が空です")

        # 新しい項目は値があるときだけ入れる（無い語は今までと同じ形のまま）
        wd: dict = {"id": wid}
        if book_no is not None:
            wd["bookNo"] = book_no
        wd.update({"word": word, "pos": get("pos"), "meaning": get("meaning"),
                   "isPhrase": to_bool(get("isPhrase"))})
        if get("group"):
            wd["group"] = get("group")
        wd["sentenceIds"] = sids
        if rel:
            wd["relatedSentenceIds"] = rel
        wd.update({"form": get("form"), "source": source, "verified": to_bool(get("verified"))})
        if get("note"):
            wd["note"] = get("note")
        words.append(wd)

    for no, lines in sorted(book_no_lines.items()):
        if len(lines) > 1:
            where = "、".join(f"{ln}行目「{w}」" for ln, w in lines)
            problems.append(f"エラー: 本の番号 {no} が {len(lines)} 行にあります（{where}）")

    words.sort(key=lambda w: int(ID_RE.match(w["id"]).group(1)) if ID_RE.match(w["id"]) else 10**9)
    return words, problems


def unused_book_nos(words: list[dict]) -> list[int]:
    used = {valid_book_no(w.get("bookNo")) for w in words}
    return [n for n in range(BOOK_NO_MIN, BOOK_NO_MAX + 1) if n not in used]


def bookno_summary(words: list[dict]) -> str:
    """取り込み後に表示する、本の番号の入力状況。"""
    filled = sum(1 for w in words if valid_book_no(w.get("bookNo")) is not None)
    unused = unused_book_nos(words)
    head = ", ".join(str(n) for n in unused[:30]) + (" …" if len(unused) > 30 else "")
    return (f"本の番号：入力済み {filled} 件／未入力の語 {len(words) - filled} 件／"
            f"まだ使われていない番号 {len(unused)} 個"
            + (f"（先頭 30 個: {head}）" if unused else ""))


def bookno_rows(words: list[dict]) -> tuple[list[list], int, int]:
    """1〜1813 の各番号の割り当て状況。戻り値は（行の一覧, 空きの数, 重複している番号の数）。"""
    by_no: dict[int, list[dict]] = {}
    for w in words:
        n = valid_book_no(w.get("bookNo"))
        if n is not None:
            by_no.setdefault(n, []).append(w)
    rows: list[list] = []
    empty = dup = 0
    for n in range(BOOK_NO_MIN, BOOK_NO_MAX + 1):
        ws = by_no.get(n, [])
        if not ws:
            rows.append([n, "", "", "", "空き"])
            empty += 1
            continue
        state = "重複" if len(ws) > 1 else "割り当て済み"
        dup += len(ws) > 1
        for w in ws:
            rows.append([n, w.get("word", ""), w.get("meaning", ""),
                         ";".join(str(i) for i in w.get("sentenceIds") or []), state])
    return rows, empty, dup


def write_bookno_check(words: list[dict], out: Path) -> tuple[int, int]:
    rows, empty, dup = bookno_rows(words)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["番号", "見出し語", "意味", "例文番号", "状態"])
        w.writerows(rows)
    return empty, dup


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
    ap = argparse.ArgumentParser(description="words.json ⇔ words.csv の変換と本の番号の点検")
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
    c = sub.add_parser("check-bookno", help="本の番号 1〜1813 の割り当て状況を CSV に書く")
    c.add_argument("--words", required=True, type=Path)
    c.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    if args.cmd == "check-bookno":
        words = json.loads(args.words.read_text(encoding="utf-8-sig"))
        empty, dup = write_bookno_check(words, args.out)
        print(f"書き出し: {args.out}")
        print(f"本の番号 {BOOK_NO_MIN}〜{BOOK_NO_MAX}：空き {empty} 個／重複 {dup} 個")
        return 0

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
    print(bookno_summary(new))
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
