"""tools/csv_io.py のテスト（自作のダミー文だけを使う）。

実行: python -m unittest discover -s tests -v
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import csv_io  # noqa: E402

SENTENCES = [
    {"id": 1, "file": "dummy_0001.mp3", "en": "My cat sleeps on the sofa.", "ja": "私のネコはソファで眠る。",
     "seg": {}, "needsReview": False, "note": ""},
    {"id": 2, "file": "dummy_0002.mp3", "en": "We waited for the green bus.", "ja": "私たちは緑のバスを待った。",
     "seg": {}, "needsReview": False, "note": ""},
]
WORDS = [
    {"id": "w0001", "word": "sleep", "pos": "動詞", "meaning": "眠る", "isPhrase": False,
     "sentenceIds": [1], "form": "sleeps", "source": "auto", "verified": False},
    {"id": "w0002", "word": "sofa", "pos": "名詞", "meaning": "ソファ", "isPhrase": False,
     "sentenceIds": [1], "form": "sofa", "source": "auto", "verified": False},
    {"id": "w0003", "word": "wait for", "pos": "熟語", "meaning": "～を待つ", "isPhrase": True,
     "sentenceIds": [2], "form": "waited for", "source": "auto", "verified": True},
]


def row(**kw) -> str:
    """CSV の 1 行を列の見出しで指定して作る（指定しない列は空欄）。"""
    titles = [c[0] for c in csv_io.COLUMNS]
    return ",".join(kw.get(t, "") for t in titles)


def plain(word: str, **extra) -> dict:
    """候補計算などに使う最小限の語。"""
    return {"id": "w0000", "word": word, "sentenceIds": [1], **extra}


class CsvIoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.sent = {s["id"]: s for s in SENTENCES}

    def roundtrip(self, words=WORDS):
        p = self.tmp / "w.csv"
        csv_io.words_to_csv(words, self.sent, p)
        return p

    def add_rows(self, p: Path, *rows: str) -> str:
        return csv_io.read_csv_text(p) + "".join(r + "\n" for r in rows)

    def test_roundtrip_unchanged(self):
        p = self.roundtrip()
        self.assertEqual(p.read_bytes()[:3], b"\xef\xbb\xbf")  # BOM 付き
        words, problems = csv_io.csv_to_words(csv_io.read_csv_text(p), self.sent)
        self.assertEqual(words, WORDS)
        self.assertEqual([x for x in problems if x.startswith("エラー")], [])

    def test_add_row_gets_new_id_and_book_source(self):
        p = self.roundtrip()
        p.write_text(self.add_rows(p, row(**{"見出し語": "green", "品詞": "形容詞", "意味": "緑の",
                                               "例文番号": "2", "例文中の形": "green", "確認済み": "○"})),
                     encoding="utf-8-sig")
        words, _ = csv_io.csv_to_words(csv_io.read_csv_text(p), self.sent)
        new = words[-1]
        self.assertEqual((new["id"], new["source"], new["verified"]), ("w0004", "book", True))

    def test_cp932_csv_is_readable(self):
        p = self.roundtrip()
        text = csv_io.read_csv_text(p)
        p.write_bytes(text.encode("cp932"))  # Excel の普通の「CSV」保存を想定
        words, _ = csv_io.csv_to_words(csv_io.read_csv_text(p), self.sent)
        self.assertEqual(words[0]["meaning"], "眠る")

    def test_errors_detected(self):
        p = self.roundtrip()
        text = self.add_rows(
            p,
            row(**{"ID": "w0001", "見出し語": "dup", "意味": "重複", "例文番号": "1"}),  # ID 重複
            row(**{"見出し語": "nothing", "意味": "なし", "例文番号": "99"}),           # 存在しない例文
        )
        _, problems = csv_io.csv_to_words(text, self.sent)
        joined = "\n".join(problems)
        self.assertIn("重複", joined)
        self.assertIn("例文番号 99", joined)

    def test_cli_backup_and_refuse_on_error(self):
        wj = self.tmp / "words.json"
        sj = self.tmp / "sentences.json"
        wj.write_text(json.dumps(WORDS, ensure_ascii=False), encoding="utf-8")
        sj.write_text(json.dumps(SENTENCES, ensure_ascii=False), encoding="utf-8")
        p = self.roundtrip()
        tool = str(ROOT / "tools" / "csv_io.py")
        ok = subprocess.run([sys.executable, tool, "to-json", "--csv", str(p), "--words", str(wj),
                             "--sentences", str(sj)], capture_output=True)
        self.assertEqual(ok.returncode, 0)
        self.assertEqual(len(list(self.tmp.glob("words.json.bak-*"))), 1)
        p.write_text(self.add_rows(p, row(**{"品詞": "名詞", "意味": "空の見出し語", "例文番号": "1"})),
                     encoding="utf-8-sig")
        ng = subprocess.run([sys.executable, tool, "to-json", "--csv", str(p), "--words", str(wj),
                             "--sentences", str(sj)], capture_output=True)
        self.assertEqual(ng.returncode, 1)
        self.assertEqual(json.loads(wj.read_text(encoding="utf-8")), WORDS)  # 書き換えていない

    # --- 本の番号・まとめ・関連例文 ---

    def test_header_order(self):
        p = self.roundtrip()
        header = csv_io.read_csv_text(p).splitlines()[0].split(",")
        self.assertEqual(header, ["ID", "本の番号", "番号の候補", "見出し語", "品詞", "意味", "熟語", "まとめ",
                                  "例文番号", "関連例文", "例文中の形", "出典", "確認済み", "メモ",
                                  "参照:英文", "参照:和訳"])

    def test_roundtrip_with_new_fields(self):
        words = [dict(w) for w in WORDS]
        words[0] = {"id": "w0001", "bookNo": 10, **{k: v for k, v in WORDS[0].items() if k != "id"}}
        words.append({"id": "w0004", "bookNo": 12, "word": "kitten", "pos": "名詞", "meaning": "子ネコ",
                      "isPhrase": False, "group": "似た意味", "sentenceIds": [], "relatedSentenceIds": [1, 2],
                      "form": "", "source": "book", "verified": False})
        p = self.roundtrip(words)
        back, problems = csv_io.csv_to_words(csv_io.read_csv_text(p), self.sent)
        self.assertEqual(back, words)
        self.assertEqual(problems, [])  # book の行は例文番号が空でも警告しない
        # 新しい項目が無い語には、項目を足さない
        self.assertNotIn("group", back[1])
        self.assertNotIn("bookNo", back[1])
        self.assertNotIn("relatedSentenceIds", back[1])
        # JSON にしたときのキーの並びも往復で変わらない
        self.assertEqual(json.dumps(back, ensure_ascii=False), json.dumps(words, ensure_ascii=False))

    def test_old_csv_without_new_columns_is_readable(self):
        old_cols = ["ID", "見出し語", "品詞", "意味", "熟語", "例文番号", "例文中の形", "出典", "確認済み", "メモ"]
        text = ",".join(old_cols) + "\nw0001,sleep,動詞,眠る,,1,sleeps,auto,,\n"
        words, problems = csv_io.csv_to_words(text, self.sent)
        self.assertEqual(words, [WORDS[0]])
        self.assertEqual(problems, [])

    def test_candidates_fill_between(self):
        ws = [plain("a", bookNo=87), plain("b"), plain("c"), plain("d"), plain("e"), plain("f", bookNo=92)]
        self.assertEqual(csv_io.book_no_candidates(ws), [None, 88, 89, 90, 91, None])

    def test_candidates_between_too_many_words(self):
        # 間の語が番号の差より多いとき、後ろの番号とぶつかる候補は空欄
        ws = [plain("a", bookNo=5), plain("b"), plain("c"), plain("d"), plain("e", bookNo=8)]
        self.assertEqual(csv_io.book_no_candidates(ws), [None, 6, 7, None, None])

    def test_candidates_one_side_only(self):
        ws = [plain("a"), plain("b"), plain("c", bookNo=50), plain("d"), plain("e")]
        self.assertEqual(csv_io.book_no_candidates(ws), [48, 49, None, 51, 52])

    def test_candidates_without_any_book_no(self):
        ws = [plain("a"), plain("b"), plain("c")]
        self.assertEqual(csv_io.book_no_candidates(ws), [1, 2, 3])

    def test_candidates_out_of_range_are_blank(self):
        ws = [plain("a"), plain("b"), plain("c", bookNo=2), plain("d", bookNo=1812), plain("e"), plain("f")]
        self.assertEqual(csv_io.book_no_candidates(ws), [None, 1, None, None, 1813, None])
        # CSV でも空欄になる
        p = self.roundtrip(ws)
        lines = csv_io.read_csv_text(p).splitlines()[1:]
        self.assertEqual([ln.split(",")[2] for ln in lines], ["", "1", "", "", "1813", ""])

    def test_book_no_range_and_type_errors(self):
        p = self.roundtrip()
        text = self.add_rows(
            p,
            row(**{"本の番号": "0", "見出し語": "zero", "意味": "x", "例文番号": "1"}),
            row(**{"本の番号": "1814", "見出し語": "over", "意味": "x", "例文番号": "1"}),
            row(**{"本の番号": "3.5", "見出し語": "half", "意味": "x", "例文番号": "1"}),
            row(**{"本の番号": "abc", "見出し語": "text", "意味": "x", "例文番号": "1"}),
        )
        _, problems = csv_io.csv_to_words(text, self.sent)
        errors = [x for x in problems if x.startswith("エラー")]
        self.assertEqual(len(errors), 4)
        self.assertTrue(any("5行目" in e and "範囲外" in e for e in errors))
        self.assertTrue(any("6行目" in e and "範囲外" in e for e in errors))
        self.assertTrue(any("7行目" in e and "整数ではありません" in e for e in errors))
        self.assertTrue(any("8行目" in e and "整数ではありません" in e for e in errors))

    def test_book_no_duplicate_error(self):
        words = [dict(w) for w in WORDS]
        words[0]["bookNo"] = 7
        words[2]["bookNo"] = 7
        p = self.roundtrip(words)
        _, problems = csv_io.csv_to_words(csv_io.read_csv_text(p), self.sent)
        dup = [x for x in problems if "本の番号 7" in x]
        self.assertEqual(len(dup), 1)
        self.assertTrue(dup[0].startswith("エラー"))
        self.assertIn("2行目「sleep」", dup[0])
        self.assertIn("4行目「wait for」", dup[0])

    def test_empty_sentence_ids_warning_only_for_auto(self):
        p = self.roundtrip()
        text = self.add_rows(
            p,
            row(**{"本の番号": "100", "見出し語": "uncle", "意味": "おじ", "まとめ": "家族"}),  # 出典は空→book
            row(**{"見出し語": "aunt", "意味": "おば", "出典": "book"}),
            row(**{"ID": "w0009", "見出し語": "lonely", "意味": "ひとりの", "出典": "auto"}),
        )
        words, problems = csv_io.csv_to_words(text, self.sent)
        warn = [x for x in problems if "例文番号がありません" in x]
        self.assertEqual(len(warn), 1)
        self.assertIn("lonely", warn[0])
        uncle = next(w for w in words if w["word"] == "uncle")
        self.assertEqual((uncle["source"], uncle["sentenceIds"], uncle["group"], uncle["bookNo"]),
                         ("book", [], "家族", 100))

    def test_related_sentence_must_exist(self):
        p = self.roundtrip()
        text = self.add_rows(p, row(**{"見出し語": "uncle", "意味": "おじ", "関連例文": "1;77"}))
        _, problems = csv_io.csv_to_words(text, self.sent)
        self.assertTrue(any(x.startswith("エラー") and "関連例文 77" in x for x in problems))

    def test_bookno_summary(self):
        words = [plain("a", bookNo=1), plain("b", bookNo=3), plain("c")]
        s = csv_io.bookno_summary(words)
        self.assertIn("入力済み 2 件", s)
        self.assertIn("未入力の語 1 件", s)
        self.assertIn("まだ使われていない番号 1811 個", s)
        self.assertIn("先頭 30 個: 2, 4, 5,", s)

    def test_check_bookno_output(self):
        words = [plain("a", bookNo=1, meaning="あ"), plain("b", bookNo=3, meaning="い"),
                 plain("c", bookNo=3, meaning="う", sentenceIds=[1, 2]), plain("d")]
        wj = self.tmp / "words.json"
        out = self.tmp / "check.csv"
        wj.write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
        r = subprocess.run([sys.executable, str(ROOT / "tools" / "csv_io.py"), "check-bookno",
                            "--words", str(wj), "--out", str(out)],
                           capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(out.read_bytes()[:3], b"\xef\xbb\xbf")  # BOM 付き
        lines = out.read_text(encoding="utf-8-sig").splitlines()
        self.assertEqual(lines[0], "番号,見出し語,意味,例文番号,状態")
        self.assertEqual(lines[1:5], ["1,a,あ,1,割り当て済み", "2,,,,空き",
                                      "3,b,い,1,重複", "3,c,う,1;2,重複"])
        self.assertEqual(len(lines), 1 + 1813 + 1)  # 見出し + 1813 番号 + 重複の追加 1 行
        self.assertIn("空き 1811 個", r.stdout)
        self.assertIn("重複 1 個", r.stdout)


if __name__ == "__main__":
    unittest.main()
