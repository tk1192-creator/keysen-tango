#!/usr/bin/env python3
"""範囲ごとに抽出した見出し語（words_parts/*.json）を1つの words.json にまとめる。

使い方:
    python tools/merge_words.py --parts data/private/words_parts ^
        --sentences data/private/sentences.json --out data/private/words.json ^
        --report data/private/merge_report.txt

やること:
    1) part*.json を読み、文番号順・例文中の位置順に並べる
    2) 同じ見出し語（大文字小文字を区別しない）が複数あれば、最初の例文のものを代表にする。
       ただし意味が違う（多義語の別の意味）ものは別項目として残す
    3) 各見出し語が出てくる「ほかの例文」を探し、sentenceIds に加える（代表の例文が先頭）
       単語は活用形も含めて探す（tools/candidates.py と同じ素朴な原形判定）
    4) form が代表の例文の英文に含まれているかを検査する
    5) ID を w0001 から振り直し、source="auto"・verified=false を付けて書き出す

入力の各項目: {"word", "pos", "meaning", "isPhrase", "sentenceId", "form", "note"}
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from candidates import STOP, lemma_keys, tokens  # noqa: E402

POS_OK = {"名詞", "動詞", "形容詞", "副詞", "前置詞", "接続詞", "助動詞", "代名詞",
          "間投詞", "数詞", "熟語", "会話表現"}


def token_keys(t: str, headwords: set[str]) -> set[str]:
    """1語の原形候補。誤った一致（his→hi、news→new など）を防ぐため、
    機能語と、それ自体が見出し語になっている語は、語尾をはがさずにそのまま使う。"""
    low = t.lower().replace("’", "'")
    if low in STOP or low in headwords:
        return {low}
    return lemma_keys(t)


def sentence_keysets(sentences: list[dict], headwords: set[str] | None = None) -> dict[int, list[set[str]]]:
    """文ごとに、各トークンの原形候補の集合の並びを作る。
    文の途中で大文字で始まる語（人名・地名など。例：Mr. Parks）は、小文字の見出し語と一致させないよう
    原形をはがさず、大文字のまま（"Parks" のように）入れる。"""
    hw = headwords or set()
    out = {}
    for s in sentences:
        toks = tokens(s["en"])
        ks = []
        for i, t in enumerate(toks):
            prev = toks[i - 1] if i else ""
            mid_cap = i > 0 and t[:1].isupper() and t != "I" and not prev.endswith((".", "?", "!"))
            ks.append({t} if mid_cap else token_keys(t, hw))
        out[s["id"]] = ks
    return out


def occurs(word: str, is_phrase: bool, keysets: list[set[str]]) -> bool:
    """見出し語が、その文に（活用形を含めて）出てくるか。"""
    parts = [p for p in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", word.replace("’", "'"))]
    if not parts:
        return False
    # 見出し語は原形で書かれているので、そのままの形と照らし合わせる
    targets = [{p.lower()} for p in parts]
    if not is_phrase or len(parts) == 1:
        return any(targets[0] & ks for ks in keysets)
    # 熟語：構成語が順番どおりに、間に最大2語まで挟んで出てくれば一致とみなす（picked them up など）
    def match_from(i: int, j: int) -> bool:
        if j == len(targets):
            return True
        for k in range(i, min(i + 3, len(keysets))):
            if targets[j] & keysets[k] and match_from(k + 1, j + 1):
                return True
        return False
    return any(targets[0] & keysets[i] and match_from(i + 1, 1) for i in range(len(keysets)))


def main() -> int:
    ap = argparse.ArgumentParser(description="words_parts/*.json を words.json にまとめる")
    ap.add_argument("--parts", required=True, type=Path)
    ap.add_argument("--sentences", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--report", type=Path, help="集計と要確認の一覧を書き出す")
    args = ap.parse_args()

    sentences = json.loads(args.sentences.read_text(encoding="utf-8-sig"))
    sent_by_id = {s["id"]: s for s in sentences}

    items = []
    for p in sorted(args.parts.glob("part*.json")):
        items.extend(json.loads(p.read_text(encoding="utf-8-sig")))
    headwords = {it["word"].strip().lower() for it in items if " " not in it["word"].strip()}
    keysets = sentence_keysets(sentences, headwords)
    problems: list[str] = []

    # 例文の番号順、例文中の位置順に並べる
    def pos_in_sentence(it):
        en = sent_by_id.get(it["sentenceId"], {}).get("en", "")
        i = en.find(it.get("form", ""))
        return i if i >= 0 else 10**6
    items.sort(key=lambda it: (it["sentenceId"], pos_in_sentence(it)))

    # 重複の整理：同じ見出し語・同じ意味なら最初のものだけ残す
    merged: list[dict] = []
    seen_word: dict[str, list[dict]] = {}
    dup = 0
    for it in items:
        key = it["word"].strip().lower()
        same = [m for m in seen_word.get(key, []) if m["meaning"] == it["meaning"]]
        if same:
            dup += 1
            continue
        if key in seen_word:
            it.setdefault("note", "")
            it["note"] = (it["note"] + "／" if it["note"] else "") + \
                f"同じ見出し語が文{seen_word[key][0]['sentenceId']}にもある（別の意味として残した）"
        seen_word.setdefault(key, []).append(it)
        merged.append(it)

    phrases = {it["word"].strip().lower() for it in merged if " " in it["word"].strip()}
    words = []
    for n, it in enumerate(merged, 1):
        sid = it["sentenceId"]
        s = sent_by_id.get(sid)
        if s is None:
            problems.append(f"文{sid} がない: {it['word']}")
            continue
        if it.get("form") and it["form"] not in s["en"]:
            problems.append(f"文{sid} の英文に form「{it['form']}」がない: {it['word']}")
        if it.get("pos") not in POS_OK:
            problems.append(f"文{sid} の品詞「{it.get('pos')}」がルール外: {it['word']}")
        is_phrase = bool(it.get("isPhrase")) or (" " in it["word"].strip() and it.get("pos") in ("熟語", "会話表現"))
        others = []
        if len(seen_word[it["word"].strip().lower()]) == 1:  # 多義で分けた語は、ほかの例文を自動で足さない
            wl = it["word"].strip().lower()
            # この語を含む熟語（例：good → Good morning.、put → put on）。その熟語として出ている文は除く
            containing = [p for p in phrases if p != wl and wl in re.findall(r"[a-z]+(?:'[a-z]+)?", p)]
            for x in sentences:
                if x["id"] == sid or not occurs(it["word"], is_phrase, keysets[x["id"]]):
                    continue
                if any(occurs(p, True, keysets[x["id"]]) for p in containing):
                    continue
                others.append(x["id"])
        words.append({
            "id": f"w{n:04d}", "word": it["word"].strip(), "pos": it.get("pos", ""),
            "meaning": it.get("meaning", "").strip(), "isPhrase": is_phrase,
            "sentenceIds": [sid] + others, "form": it.get("form", ""),
            "source": "auto", "verified": False,
            **({"note": it["note"]} if it.get("note") else {}),
        })

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(words, ensure_ascii=False, indent=1), encoding="utf-8")

    n_phrase = sum(w["isPhrase"] for w in words)
    pos_count = Counter(w["pos"] for w in words)
    per_sent = Counter(w["sentenceIds"][0] for w in words)
    empty = [s["id"] for s in sentences if per_sent[s["id"]] == 0]
    lines = [
        f"見出し語 {len(words)} 件（単語 {len(words) - n_phrase} / 熟語・会話表現 {n_phrase}）",
        f"重複として除いた項目 {dup} 件",
        "品詞: " + "、".join(f"{k} {v}" for k, v in pos_count.most_common()),
        f"1文あたり 平均 {len(words) / len(sentences):.2f} 項目 / 最多 {max(per_sent.values())} 項目",
        f"見出し語が0件の文: {len(empty)} 文 {empty[:30]}",
        f"検査で見つかった問題: {len(problems)} 件",
        *problems[:50],
    ]
    for s in range(0, 562, 50):
        rng = range(s + 1, min(s + 50, 562) + 1)
        lines.append(f"ステージ{s // 50 + 1}（文{rng[0]}-{rng[-1]}）: {sum(per_sent[i] for i in rng)} 項目")
    report = "\n".join(lines)
    print(report)
    if args.report:
        args.report.write_text(report + "\n", encoding="utf-8")
    print(f"書き出し: {args.out}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
