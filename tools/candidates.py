#!/usr/bin/env python3
"""単語・熟語の抽出の下準備。例文ごとに「その文で初めて出てくる内容語」を一覧にする。

使い方:
    python tools/candidates.py --sentences data/private/sentences.json ^
        --out data/private/candidates.json

考え方:
    本は約1,800の見出し語を562文に「ほぼ重複なく」割り振っている。
    そのため、例文を番号順に読んで「初めて出てくる語」がその例文の見出し語の候補になる。
    活用形（-s, -ed, -ing など）は簡単な規則で原形に寄せ、既出かどうかを判定する。
    最終的な見出し語・熟語・意味の判断は人（または Claude）が行う。この出力は候補にすぎない。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# ごく基本の機能語（be動詞・冠詞・代名詞・基本的な前置詞/接続詞/助動詞など）。候補から外す。
STOP = set("""
a an the be am is are was were been being i me my mine you your yours he him his she her hers
it its we us our ours they them their theirs this that these those there here
and or but so if because than as of to in on at by for with from up down out off over into
do does did done doing have has had having will would shall should can could may might must
not no yes oh ok okay mr mrs ms dr s t d ll re ve m
""".split())

IRREGULAR = {
    "went": "go", "gone": "go", "saw": "see", "seen": "see", "ate": "eat", "eaten": "eat",
    "took": "take", "taken": "take", "came": "come", "made": "make", "got": "get", "gotten": "get",
    "gave": "give", "given": "give", "knew": "know", "known": "know", "thought": "think",
    "told": "tell", "said": "say", "found": "find", "left": "leave", "felt": "feel", "kept": "keep",
    "bought": "buy", "brought": "bring", "taught": "teach", "caught": "catch", "wrote": "write",
    "written": "write", "spoke": "speak", "spoken": "speak", "ran": "run", "began": "begin",
    "begun": "begin", "swam": "swim", "sang": "sing", "sung": "sing", "drank": "drink", "drunk": "drink",
    "met": "meet", "sat": "sit", "stood": "stand", "understood": "understand", "lost": "lose",
    "won": "win", "heard": "hear", "held": "hold", "built": "build", "sent": "send", "spent": "spend",
    "slept": "sleep", "paid": "pay", "sold": "sell", "flew": "fly", "flown": "fly", "drew": "draw",
    "drawn": "draw", "drove": "drive", "driven": "drive", "rode": "ride", "ridden": "ride",
    "broke": "break", "broken": "break", "chose": "choose", "chosen": "choose", "forgot": "forget",
    "forgotten": "forget", "fell": "fall", "fallen": "fall", "grew": "grow", "grown": "grow",
    "threw": "throw", "thrown": "throw", "wore": "wear", "worn": "wear", "woke": "wake",
    "led": "lead", "lent": "lend", "meant": "mean", "fed": "feed", "fought": "fight", "hid": "hide",
    "hidden": "hide", "rose": "rise", "risen": "rise", "shook": "shake", "stole": "steal",
    "better": "good", "best": "good", "worse": "bad", "worst": "bad", "children": "child",
    "men": "man", "women": "woman", "feet": "foot", "teeth": "tooth", "mice": "mouse", "people": "people",
}


def tokens(en: str) -> list[str]:
    en = en.replace("’", "'")
    return [t for t in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", en)]


def lemma_keys(w: str) -> set[str]:
    """原形の候補（規則変化を素朴にはがしたもの）。既出判定に使う。"""
    w = w.lower()
    w = re.sub(r"'(s|re|ve|ll|d|m|t)$", "", w)
    if w.endswith("n't"):
        w = w[:-3]
    keys = {w, IRREGULAR.get(w, w)}
    for suf, rep in (("ies", "y"), ("ied", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"),
                     ("ing", ""), ("ing", "e"), ("er", ""), ("est", ""), ("ly", ""), ("ier", "y"),
                     ("iest", "y"), ("ily", "y")):
        if w.endswith(suf) and len(w) - len(suf) >= 2:
            b = w[: -len(suf)] + rep
            keys.add(b)
            if len(b) >= 3 and b[-1] == b[-2] and b[-1] not in "aeiouls":  # stopped → stop
                keys.add(b[:-1])
    return keys


def main() -> int:
    ap = argparse.ArgumentParser(description="例文ごとに初出の内容語を一覧にする")
    ap.add_argument("--sentences", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    # utf-8-sig：メモ帳などで保存し直して BOM が付いた JSON も読めるようにする
    sents = sorted(json.loads(args.sentences.read_text(encoding="utf-8-sig")), key=lambda s: s["id"])
    seen: dict[str, int] = {}   # 原形の候補 → 最初に出た例文番号
    out = []
    total_new = 0
    for s in sents:
        new, old = [], []
        for t in tokens(s["en"]):
            low = t.lower()
            keys = lemma_keys(t)
            if low in STOP or keys & STOP and len(low) <= 4:
                continue
            first = min((seen[k] for k in keys if k in seen), default=None)
            if first is None or first == s["id"]:
                if t not in new:
                    new.append(t)
            else:
                old.append(f"{t}(#{first})")
            for k in keys:
                seen.setdefault(k, s["id"])
        total_new += len(new)
        out.append({"id": s["id"], "en": s["en"], "ja": s["ja"], "new": new, "seen": old})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"例文 {len(out)} 文 / 初出の内容語 のべ {total_new} 語（1文平均 {total_new / max(1, len(out)):.1f}）")
    print(f"書き出し: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
