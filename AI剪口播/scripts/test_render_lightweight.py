#!/usr/bin/env python3
"""Focused lightweight renderer contract tests; uses no ASR/model service."""
import argparse
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import render_lightweight as renderer


class LightweightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"source")
        self.cover = self.root / "cover.png"
        self.cover.write_bytes(b"cover")
        self.edl = self.root / "timeline.json"
        self.timeline = {"fps": 30, "speed": 1.1, "sources": {"sample": {"path": str(self.source)}},
                         "segments": [{"source_id": "sample", "start": 0, "end": 1.1, "output_start_frame": 0, "output_frame_count": 30}], "output_frames": 30}
        self.edl.write_text(json.dumps(self.timeline))
        self.args = argparse.Namespace(source=self.source, timeline=self.edl, cover=self.cover, output=self.root / "out.mp4", profile="preview", captions=None, font=None, protected_terms_file=None)
        self.probe = json.dumps({"streams": [{"codec_type": "video", "width": 180, "height": 320, "sample_aspect_ratio": "1:1"}, {"codec_type": "audio"}]})

    def test_speed_chain(self):
        chain = renderer.build_filter(self.timeline, "preview")
        self.assertIn("setpts=(PTS-STARTPTS)/1.1,fps=30,tpad=", chain)
        self.assertLess(chain.index("fps=30"), chain.index("trim=end_frame=30"))
        self.assertEqual(chain.count("setpts=(PTS-STARTPTS)/1.1"), 1)
        self.assertEqual(chain.count("atempo=1.1"), 1)
        self.assertIn("atrim=duration=1[a0]", chain)
        self.assertIn("overlay=enable='lt(n,3)'", chain)

    def test_source_mismatch(self):
        with patch.object(renderer.subprocess, "run") as run:
            self.args.source = self.root / "other.mp4"
            with self.assertRaisesRegex(ValueError, "contradicts"):
                renderer.render(self.args)
            run.assert_not_called()

    def test_output_conflict(self):
        self.args.output.write_bytes(b"existing")
        with patch.object(renderer.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "path conflict"):
                renderer.render(self.args)
            run.assert_not_called()
        self.assertEqual(self.args.output.read_bytes(), b"existing")

    def test_preflight_exit_rejection(self):
        with patch.object(renderer.subprocess, "check_output", return_value=self.probe), patch.object(renderer.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)) as run:
            with self.assertRaisesRegex(ValueError, "preflight failed"):
                renderer.render(self.args)
            self.assertEqual(run.call_count, 1)
            self.assertNotEqual(run.call_args.args[0][0], "ffmpeg")
            self.assertFalse(self.args.output.with_suffix(".filter").exists())

    def test_preflight_report_rejection(self):
        def fail_report(command, **kwargs):
            Path(command[command.index("--report") + 1]).write_text('{"status":"fail"}')
            return subprocess.CompletedProcess(command, 0)
        with patch.object(renderer.subprocess, "check_output", return_value=self.probe), patch.object(renderer.subprocess, "run", side_effect=fail_report) as run:
            with self.assertRaisesRegex(ValueError, "report did not pass"):
                renderer.render(self.args)
            self.assertEqual(run.call_count, 1)

    def test_no_captions_no_asr(self):
        def success(command, **kwargs):
            if "--report" in command:
                Path(command[command.index("--report") + 1]).write_text('{"status":"pass"}')
            return subprocess.CompletedProcess(command, 0)
        with patch.object(renderer.subprocess, "check_output", return_value=self.probe), patch.object(renderer.subprocess, "run", side_effect=success) as run, patch.object(renderer, "make_ass", side_effect=AssertionError("captions accessed")):
            metadata = renderer.render(self.args)
        self.assertEqual(metadata["asr_calls"], 0)
        self.assertEqual(metadata["encode_count"], 1)
        self.assertEqual(run.call_count, 2)
        self.assertNotIn("--captions", metadata["preflight_command"])
        self.assertNotIn("ass=", self.args.output.with_suffix(".filter").read_text())
        self.assertFalse(self.args.output.with_suffix(".ass").exists())

    def test_non_portrait_rejection(self):
        probe = json.dumps({"streams": [{"codec_type": "video", "width": 1920, "height": 1080}, {"codec_type": "audio"}]})
        with patch.object(renderer.subprocess, "check_output", return_value=probe), patch.object(renderer.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "9:16"):
                renderer.render(self.args)
            run.assert_not_called()


    def test_rotation_display_rejection(self):
        probe = json.loads(self.probe)
        probe["streams"][0]["side_data_list"] = [{"rotation": 90}]
        with patch.object(renderer.subprocess, "check_output", return_value=json.dumps(probe)), patch.object(renderer.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "display must be 9:16"):
                renderer.render(self.args)
            run.assert_not_called()

    def test_source_clock_offset_rejection(self):
        probe = json.loads(self.probe)
        probe["streams"][0]["start_time"] = "0.0"
        probe["streams"][1]["start_time"] = "0.2"
        with patch.object(renderer.subprocess, "check_output", return_value=json.dumps(probe)), patch.object(renderer.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "start offset"):
                renderer.render(self.args)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
