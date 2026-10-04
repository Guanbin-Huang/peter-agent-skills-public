import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from patch_caption_text import plain


SCRIPT = Path(__file__).with_name("patch_caption_text.py")


def fixture():
    captions = ["旧词甲", "乙旧词", "旧词丙", "丁旧词"]
    srt = "\n\n".join(
        f"{i}\n00:00:{i:02d},000 --> 00:00:{i:02d},900\n{caption}"
        for i, caption in enumerate(captions, 1)
    ) + "\n"
    ass = (
        "[Script Info]\nTitle: Caption test\n\n"
        "[V4+ Styles]\nStyle: Main,Font,76\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    for i, caption in enumerate(captions, 1):
        for layer, style, y in [(0, "Shadow", 1370), (1, "Main", 1360)]:
            ass += (f"Dialogue: {layer},0:00:{i:02d}.00,0:00:{i:02d}.90,{style},,0,0,360,,"
                    f"{{\\pos(540,{y})}}{caption}\n")
    return srt, ass


class CaptionPatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.srt = self.root / "input.srt"
        self.ass = self.root / "input.ass"
        self.out = self.root / "patched"
        srt, ass = fixture()
        self.srt.write_text(srt, encoding="utf-8")
        self.ass.write_text(ass, encoding="utf-8")

    def command(self, *extra):
        return [sys.executable, str(SCRIPT), "--srt", str(self.srt), "--ass", str(self.ass),
                "--old", "旧词", "--new", "新词", "--out-dir", str(self.out), *extra]

    def execute(self, *extra):
        return subprocess.run(self.command(*extra), capture_output=True, text=True)

    def test_four_semantic_cues_eight_ass_events_and_sources_immutable(self):
        before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in (self.srt, self.ass)}
        result = self.execute("--expect-cues", "4")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "changed 4 cues / 8 ASS events\n")
        self.assertEqual(before, {path: hashlib.sha256(path.read_bytes()).hexdigest()
                                  for path in (self.srt, self.ass)})
        patched_srt = (self.out / "captions.srt").read_text(encoding="utf-8")
        patched_ass = (self.out / "captions.ass").read_text(encoding="utf-8")
        self.assertEqual(patched_srt.count("新词"), 4)
        self.assertEqual(patched_ass.count("新词"), 8)
        self.assertNotIn("旧词", patched_srt + patched_ass)
        self.assertEqual(patched_ass.replace("新词", "旧词"), self.ass.read_text(encoding="utf-8"))
        self.assertEqual(patched_srt.replace("新词", "旧词"), self.srt.read_text(encoding="utf-8"))
        manifest = json.loads((self.out / "caption_patch.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["mode"], "text_only")
        self.assertFalse(manifest["media_rendered"])
        self.assertEqual(manifest["changed_cue_count"], 4)
        self.assertEqual(manifest["changed_ass_event_count"], 8)
        self.assertEqual(len(manifest["changed_intervals"]), 4)
        self.assertEqual(manifest["source_srt_sha256"], before[self.srt])
        self.assertEqual(manifest["source_ass_sha256"], before[self.ass])

    def test_mismatched_caption_fails_without_outputs(self):
        self.ass.write_text(self.ass.read_text().replace("旧词甲", "错误甲", 1))
        result = self.execute()
        self.assertEqual(result.returncode, 2)
        self.assertIn("caption page count mismatch", result.stderr)
        self.assertFalse(self.out.exists())

    def test_no_match_fails_without_outputs(self):
        result = subprocess.run([*self.command(), "--expect-cues", "5"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("expected 5 changed cues", result.stderr)
        self.assertFalse(self.out.exists())
        command = self.command()
        command[command.index("--old") + 1] = "不存在"
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("no caption matches", result.stderr)
        self.assertFalse(self.out.exists())

    def test_unsafe_replacement_fails_without_outputs(self):
        for unsafe in ("", "换\n行", "{\\pos(1,2)}", "\\N"):
            with self.subTest(unsafe=unsafe):
                command = self.command()
                command[command.index("--new") + 1] = unsafe
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.out.exists())
        with self.assertRaisesRegex(ValueError, "single-line plain text"):
            plain("a\x00b", "--new")

    def test_existing_output_fails_before_publishing(self):
        self.out.mkdir()
        sentinel = self.out / "keep.txt"
        sentinel.write_text("unchanged", encoding="utf-8")
        result = self.execute()
        self.assertEqual(result.returncode, 2)
        self.assertIn("output already exists", result.stderr)
        self.assertEqual(list(self.out.iterdir()), [sentinel])
        self.assertEqual(sentinel.read_text(), "unchanged")

    def test_invalid_timing_fails_without_outputs(self):
        self.srt.write_text(self.srt.read_text().replace("00:00:01,900", "00:00:01,000", 1))
        result = self.execute()
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid SRT timing", result.stderr)
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
