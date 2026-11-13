#!/usr/bin/env python3
"""見出し語の点検結果（修正案）を、抽出結果（words_parts）に反映する。

使い方:
    python tools/apply_review.py --parts data/private/words_parts ^
        --words data/private/words.json --reviews data/private/review_words ^
        --reject part2:18 part3:20 --out data/private/words_parts_reviewed

    その後、反映済みのフォルダから words.json を作り直す:
    python tools/merge_words.py --parts data/private/words_parts_reviewed ...

考え方:
    - 修正案の id（w0123）は、その時点の words.json の番号。番号は作り直すたびに変わるので、
      words.json を使って「代表の例文番号・見出し語・意味」に置き換えてから、抽出結果に当てる。
    - 元の抽出結果（--parts）は書き換えない。反映したものを --out に別に書く。
    - --reject で、採用しない修正案を「ファイル名:番号」で指定する（番号は 0 から）。
    - 反映した内容と見送った内容は、--out の apply_log.txt に残す。

修正案の形（review_words/part*.json）:
    {"action": "modify", "id": "w0123", "field": "meaning", "old": "…", "new": "…", "reason": "…"}
    {"action": "add", "sentenceId": 45, "word": "…", "pos": "…", "meaning": "…", "isPhrase": false, "form": "…", "reason": "…"}
    {"action": "delete", "id": "w0456", "reason": "…"}
    {"action": "merge", "ids": ["w0100", "w0200"], "reason": "…"}   … 先頭を残し、残りを消す
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

FIELDS = {"word", "pos", "meaning", "isPhrase", "form"}


def key_of(word: dict) -> tuple:
    """words.json の項目 → 抽出結果の項目を探すための鍵"""
    return (word["sentenceIds"][0], word["word"].strip(), word["meaning"].strip())


def main() -> int:
    ap = argparse.ArgumentParser(description="点検の修正案を抽出結果に反映する")
    ap.add_argument("--parts", required=True, type=Path)
    ap.add_argument("--words", required=True, type=Path, help="修正案を作ったときの words.json（id の対応に使う）")
    ap.add_argument("--reviews", required=True, type=Path)
    ap.add_argument("--reject", nargs="*", default=[], help="採用しない修正案（例: part2:18）")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    words = {w["id"]: w for w in json.loads(args.words.read_text(encoding="utf-8-sig"))}
    parts = {p.name: json.loads(p.read_text(encoding="utf-8-sig")) for p in sorted(args.parts.glob("part*.json"))}
    items = [it for name in sorted(parts) for it in parts[name]]
    index = {(it["sentenceId"], it["word"].strip(), it["meaning"].strip()): it for it in items}
    rejected = set(args.reject)
    log: list[str] = []
    errors: list[str] = []
    to_delete: set[int] = set()
    added: list[dict] = []

    def find(wid: str):
        w = words.get(wid)
        if not w:
            errors.append(f"{wid} が words.json にない")
            return None
        it = index.get(key_of(w))
        if it is None:
            errors.append(f"{wid}（{w['word']}）が抽出結果に見つからない")
        return it

    for rp in sorted(args.reviews.glob("part*.json")):
        for n, r in enumerate(json.loads(rp.read_text(encoding="utf-8-sig"))):
            tag = f"{rp.stem}:{n}"
            act = r["action"]
            desc = r.get("word") or r.get("id") or r.get("ids")
            if tag in rejected:
                log.append(f"見送り {tag} {act} {desc}")
                continue
            if act == "modify":
                if r["field"] not in FIELDS:
                    errors.append(f"{tag} field が不正: {r['field']}")
                    continue
                it = find(r["id"])
                if it is not None:
                    it[r["field"]] = r["new"]
                    log.append(f"変更 {tag} {r['id']} {r['field']}: {r['old']} → {r['new']}")
            elif act == "add":
                new = {k: r[k] for k in ("word", "pos", "meaning", "form")}
                new.update({"isPhrase": bool(r.get("isPhrase")), "sentenceId": r["sentenceId"],
                            "note": "点検で追加"})
                added.append(new)
                log.append(f"追加 {tag} #{r['sentenceId']} {r['word']}（{r['meaning']}）")
            elif act in ("delete", "merge"):
                ids = [r["id"]] if act == "delete" else r["ids"][1:]
                for wid in ids:
                    it = find(wid)
                    if it is not None:
                        to_delete.add(id(it))
                        log.append(f"{'削除' if act == 'delete' else '統合で削除'} {tag} {wid} {it['word']}")
            else:
                errors.append(f"{tag} action が不正: {act}")

    if errors:
        print("エラーがあるため中止しました:")
        for e in errors:
            print("  " + e)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    for name, its in parts.items():
        kept = [it for it in its if id(it) not in to_delete]
        (args.out / name).write_text(json.dumps(kept, ensure_ascii=False, indent=1), encoding="utf-8")
    (args.out / "part9_review_added.json").write_text(json.dumps(added, ensure_ascii=False, indent=1), encoding="utf-8")
    (args.out / "apply_log.txt").write_text("\n".join(log) + "\n", encoding="utf-8")
    n = {k: sum(1 for x in log if x.startswith(k)) for k in ("変更", "追加", "削除", "統合で削除", "見送り")}
    print("反映: " + " / ".join(f"{k} {v}" for k, v in n.items()))
    print(f"書き出し: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
