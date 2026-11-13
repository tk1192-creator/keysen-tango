"""tools/build_pack.py のテスト（自作のダミー文だけを使う）。

実行: python -m unittest discover -s tests -v

音声は ffmpeg を使わずダミーのバイト列の .mp3 で代用する（build_pack.py は音声をデコードしないため）。
tests/fixtures/dummy-pack.zip（make_dummy_pack.py で作るもの）があれば、その中身も確かめる。
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tests"))
import build_pack  # noqa: E402
import make_dummy_pack  # noqa: E402

TOOL = str(ROOT / "tools" / "build_pack.py")
FIXTURE = ROOT / "tests" / "fixtures" / "dummy-pack.zip"


class BuildPackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.sp, self.wp, self.audio = make_dummy_pack.write_sources(self.tmp / "src", fake_audio=True)
        self.out = self.tmp / "out" / "pack.zip"

    def run_tool(self, *extra):
        return subprocess.run(
            [sys.executable, TOOL, "--sentences", str(self.sp), "--words", str(self.wp),
             "--audio-dir", str(self.audio), "--out", str(self.out), *extra],
            capture_output=True, text=True, encoding="utf-8")

    def test_build_ok(self):
        r = self.run_tool("--title", "テスト")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with zipfile.ZipFile(self.out) as zf:
            names = set(zf.namelist())
            pack = json.loads(zf.read("pack.json").decode("utf-8"))
            sentences = json.loads(zf.read("sentences.json").decode("utf-8"))
        self.assertEqual(names, {"pack.json", "sentences.json", "words.json",
                                 *(f"audio/dummy_{i:04d}.mp3" for i in range(1, 5))})
        self.assertEqual((pack["format"], pack["version"], pack["title"]), ("kk-pack", 1, "テスト"))
        self.assertRegex(pack["created"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$")
        self.assertEqual(sentences, make_dummy_pack.dummy_sentences())  # 中身がそのまま入っている
        self.assertFalse(self.out.with_name("pack.zip.tmp").exists())  # 一時ファイルが残らない

    def test_counts_match(self):
        self.assertEqual(self.run_tool().returncode, 0)
        with zipfile.ZipFile(self.out) as zf:
            counts = json.loads(zf.read("pack.json").decode("utf-8"))["counts"]
        self.assertEqual(counts, {"sentences": 4, "words": len(make_dummy_pack.DUMMY_WORDS), "audio": 4})
        actual, problems = build_pack.verify_pack(self.out)
        self.assertEqual(problems, [])
        self.assertEqual(actual, counts)

    def test_mp3_stored_json_deflated(self):
        self.assertEqual(self.run_tool().returncode, 0)
        with zipfile.ZipFile(self.out) as zf:
            for info in zf.infolist():
                expected = zipfile.ZIP_STORED if info.filename.endswith(".mp3") else zipfile.ZIP_DEFLATED
                self.assertEqual(info.compress_type, expected, info.filename)

    def test_missing_mp3_aborts(self):
        (self.audio / "dummy_0003.mp3").unlink()
        r = self.run_tool()
        self.assertEqual(r.returncode, 1)
        self.assertIn("dummy_0003.mp3", r.stdout)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.out.with_name("pack.zip.tmp").exists())

    def test_bad_sentence_id_and_duplicate_abort(self):
        words = json.loads(self.wp.read_text(encoding="utf-8"))
        words[0]["sentenceIds"] = [99]           # 存在しない例文
        words.append(dict(words[1]))             # id の重複
        self.wp.write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
        sentences = json.loads(self.sp.read_text(encoding="utf-8"))
        sentences[1]["id"] = 1                   # 例文 id の重複
        self.sp.write_text(json.dumps(sentences, ensure_ascii=False), encoding="utf-8")
        r = self.run_tool()
        self.assertEqual(r.returncode, 1)
        self.assertIn("99", r.stdout)
        self.assertIn("w0002 が重複", r.stdout)
        self.assertIn("id 1 が重複", r.stdout)
        self.assertFalse(self.out.exists())

    def test_bom_input_is_readable(self):
        for p in (self.sp, self.wp):
            p.write_text(p.read_text(encoding="utf-8"), encoding="utf-8-sig")
        self.assertEqual(self.sp.read_bytes()[:3], b"\xef\xbb\xbf")
        self.assertEqual(self.run_tool().returncode, 0)

    def test_existing_output_is_kept(self):
        self.out.parent.mkdir(parents=True)
        self.out.write_bytes(b"old pack")
        r = self.run_tool()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        baks = list(self.out.parent.glob("pack.zip.bak-*"))
        self.assertEqual(len(baks), 1)
        self.assertRegex(baks[0].name, r"^pack\.zip\.bak-\d{8}-\d{6}$")
        self.assertEqual(baks[0].read_bytes(), b"old pack")       # 古いものが残っている
        self.assertTrue(zipfile.is_zipfile(self.out))             # 新しいものができている
        # 2 回目も上書きしない（同じ秒でも別名になる）
        self.assertEqual(self.run_tool().returncode, 0)
        self.assertEqual(len(list(self.out.parent.glob("pack.zip.bak-*"))), 2)

    def test_existing_output_kept_when_check_fails(self):
        self.out.parent.mkdir(parents=True)
        self.out.write_bytes(b"old pack")
        (self.audio / "dummy_0001.mp3").unlink()
        self.assertEqual(self.run_tool().returncode, 1)
        self.assertEqual(self.out.read_bytes(), b"old pack")
        self.assertEqual(list(self.out.parent.glob("pack.zip.bak-*")), [])


@unittest.skipUnless(FIXTURE.exists(), "tests/fixtures/dummy-pack.zip がない（make_dummy_pack.py で作る）")
class FixtureTest(unittest.TestCase):
    def test_fixture_is_valid(self):
        actual, problems = build_pack.verify_pack(FIXTURE)
        self.assertEqual(problems, [])
        self.assertEqual(actual["sentences"], 4)
        with zipfile.ZipFile(FIXTURE) as zf:
            sentences = json.loads(zf.read("sentences.json").decode("utf-8"))
        for s in sentences:
            seg = s["seg"]
            self.assertEqual(list(seg), ["en1", "ja", "en2", "en3"])
            bounds = [t for k in seg for t in seg[k]]
            self.assertEqual(bounds, sorted(bounds))  # 区間が順に並んでいる


if __name__ == "__main__":
    unittest.main()
