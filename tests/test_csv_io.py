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


class CsvIoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.sent = {s["id"]: s for s in SENTENCES}

    def roundtrip(self):
        p = self.tmp / "w.csv"
        csv_io.words_to_csv(WORDS, self.sent, p)
        return p

    def test_roundtrip_unchanged(self):
        p = self.roundtrip()
        self.assertEqual(p.read_bytes()[:3], b"\xef\xbb\xbf")  # BOM 付き
        words, problems = csv_io.csv_to_words(csv_io.read_csv_text(p), self.sent)
        self.assertEqual(words, WORDS)
        self.assertEqual([x for x in problems if x.startswith("エラー")], [])

    def test_add_row_gets_new_id_and_book_source(self):
        p = self.roundtrip()
        p.write_text(csv_io.read_csv_text(p) + ",green,形容詞,緑の,,2,green,,○,,\n", encoding="utf-8-sig")
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
        lines = csv_io.read_csv_text(p).splitlines()
        lines.append("w0001,dup,名詞,重複,,1,dup,auto,,,")   # ID 重複
        lines.append(",nothing,名詞,なし,,99,x,,,,")          # 存在しない例文
        _, problems = csv_io.csv_to_words("\n".join(lines), self.sent)
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
        p.write_text(csv_io.read_csv_text(p) + ",,名詞,空の見出し語,,1,,,,,\n", encoding="utf-8-sig")
        ng = subprocess.run([sys.executable, tool, "to-json", "--csv", str(p), "--words", str(wj),
                             "--sentences", str(sj)], capture_output=True)
        self.assertEqual(ng.returncode, 1)
        self.assertEqual(json.loads(wj.read_text(encoding="utf-8")), WORDS)  # 書き換えていない


if __name__ == "__main__":
    unittest.main()
