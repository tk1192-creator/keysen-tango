"""tools/merge_words.py のテスト（自作のダミー文だけを使う）。

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
import merge_words  # noqa: E402

SENTENCES = [
    {"id": 1, "en": "My cat sleeps on the sofa.", "ja": "x"},
    {"id": 2, "en": "The cats slept while we looked for the key.", "ja": "x"},
    {"id": 3, "en": "She looks for her keys and sleeps late.", "ja": "x"},
]


def keysets(i):
    return merge_words.sentence_keysets(SENTENCES)[i]


class MergeWordsTest(unittest.TestCase):
    def test_occurs_with_inflection(self):
        self.assertTrue(merge_words.occurs("sleep", False, keysets(2)))   # slept
        self.assertTrue(merge_words.occurs("cat", False, keysets(2)))     # cats
        self.assertFalse(merge_words.occurs("sofa", False, keysets(2)))

    def test_no_false_match(self):
        sents = [{"id": 1, "en": "This is his news.", "ja": "x"}]
        ks = merge_words.sentence_keysets(sents, {"hi", "new", "news"})[1]
        self.assertFalse(merge_words.occurs("hi", False, ks))    # his ≠ hi
        self.assertFalse(merge_words.occurs("new", False, ks))   # news ≠ new
        self.assertTrue(merge_words.occurs("news", False, ks))

    def test_phrase_in_order(self):
        self.assertTrue(merge_words.occurs("look for", True, keysets(2)))   # looked for
        self.assertTrue(merge_words.occurs("look for", True, keysets(3)))   # looks for
        self.assertFalse(merge_words.occurs("look for", True, keysets(1)))

    def test_cli_merge(self):
        tmp = Path(tempfile.mkdtemp())
        parts = tmp / "parts"
        parts.mkdir()
        (parts / "part1.json").write_text(json.dumps([
            {"word": "sofa", "pos": "名詞", "meaning": "ソファ", "isPhrase": False, "sentenceId": 1, "form": "sofa"},
            {"word": "sleep", "pos": "動詞", "meaning": "眠る", "isPhrase": False, "sentenceId": 1, "form": "sleeps"},
        ], ensure_ascii=False), encoding="utf-8")
        (parts / "part2.json").write_text(json.dumps([
            {"word": "look for", "pos": "熟語", "meaning": "～を探す", "isPhrase": True, "sentenceId": 2, "form": "looked for"},
            {"word": "sleep", "pos": "動詞", "meaning": "眠る", "isPhrase": False, "sentenceId": 2, "form": "slept"},
        ], ensure_ascii=False), encoding="utf-8")
        sj = tmp / "s.json"
        sj.write_text(json.dumps(SENTENCES), encoding="utf-8")
        out = tmp / "w.json"
        r = subprocess.run([sys.executable, str(ROOT / "tools" / "merge_words.py"), "--parts", str(parts),
                            "--sentences", str(sj), "--out", str(out)], capture_output=True)
        self.assertEqual(r.returncode, 0, r.stdout.decode("utf-8", "replace"))
        words = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual([w["word"] for w in words], ["sleep", "sofa", "look for"])  # 例文中の位置順
        self.assertEqual(words[0]["sentenceIds"], [1, 2, 3])   # 重複は1件にまとまり、ほかの例文も集まる
        self.assertEqual(words[2]["sentenceIds"], [2, 3])
        self.assertEqual(words[0]["id"], "w0001")


if __name__ == "__main__":
    unittest.main()
