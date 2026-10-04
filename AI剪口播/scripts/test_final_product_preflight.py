#!/usr/bin/env python3

import contextlib
import io
import json
import sys
from unittest.mock import patch
import tempfile
import unittest
from pathlib import Path

import final_product_preflight as preflight
from final_product_preflight import load_words, validate_words


class FinalProductPreflightTest(unittest.TestCase):
    def test_loads_words_object(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "words.json"
            path.write_text(json.dumps({
                "words": [
                    {"text": "测", "start": 0.0, "end": 0.1},
                    {"text": "试", "start": 0.1, "end": 0.2},
                ]
            }), encoding="utf-8")
            words = load_words(path)
            validate_words(words)
            self.assertEqual(2, len(words))

    def test_rejects_zero_duration_before_render(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid bounds"):
            validate_words([{"text": "坏", "start": 1.0, "end": 1.0}])

    def test_rejects_non_monotonic_timing_before_render(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-monotonic"):
            validate_words([
                {"text": "前", "start": 1.0, "end": 1.2},
                {"text": "后", "start": 0.8, "end": 1.0},
            ])

class LightweightPreflightTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.mp4"
        self.source.touch()
        self.edl = self.root / "edl.json"
        self.payload = {"fps": 30, "speed": 1.1,
                        "sources": {"dad": {"path": str(self.source)}},
                        "segments": [{"source_id": "dad", "start": i * 1.1,
                                      "end": (i + 1) * 1.1,
                                      "output_start_frame": i * 30,
                                      "output_frame_count": 30} for i in range(5)]}
        self.prober = patch.object(preflight, "probe", return_value={"format": {"duration": "10"}})
        self.mock_probe = self.prober.start()
        self.addCleanup(self.prober.stop)

    def validate(self):
        self.edl.write_text(json.dumps(self.payload))
        return preflight.validate_edl(self.edl, mode="lightweight")

    def cli(self, *options):
        self.edl.write_text(json.dumps(self.payload))
        report = self.root / "report.json"
        with patch.object(sys, "argv", ["preflight", "--edl", str(self.edl),
                                      "--report", str(report), *options]), contextlib.redirect_stdout(io.StringIO()):
            status = preflight.main()
        return status, json.loads(report.read_text())

    def test_segments_and_one_probe_per_source(self):
        edl, sources = self.validate()
        self.assertEqual(150, edl["total_frames"])
        self.assertEqual(1, len(sources))
        self.assertEqual(1, self.mock_probe.call_count)

    def test_legacy_clips_cache(self):
        self.payload["clips"] = [
            {"source_path": str(self.source), "source_start": i * 1.1,
             "source_end": (i + 1) * 1.1, "output_start_frame": i * 30,
             "output_frame_count": 30} for i in range(5)]
        del self.payload["segments"]
        self.validate()
        self.assertEqual(1, self.mock_probe.call_count)

    def test_lightweight_without_words_font_or_outro(self):
        status, report = self.cli("--mode", "lightweight")
        self.assertEqual(0, status)
        self.assertEqual("pass", report["status"])

    def test_full_requires_original_assets(self):
        status, report = self.cli()
        self.assertEqual(1, status)
        self.assertIn("--word-timings", report["findings"][0])

    def test_speed_frame_mismatch(self):
        self.payload["segments"][0]["end"] = 1.4
        with self.assertRaisesRegex(ValueError, "speed"):
            self.validate()

    def test_reordered_segments(self):
        self.payload["segments"][1]["start"] = 0
        self.payload["segments"][1]["end"] = 1.1
        with self.assertRaisesRegex(ValueError, "reorder"):
            self.validate()

    def test_noninteger_output_start(self):
        self.payload["segments"][0]["output_start_frame"] = 0.0
        with self.assertRaisesRegex(ValueError, "integer"):
            self.validate()

    def test_protected_laughter_cut(self):
        self.payload["protected_laughter"] = [{"start": 1.0, "end": 1.5}]
        self.payload["cuts"] = [{"start": 1.2, "end": 1.3}]
        with self.assertRaisesRegex(ValueError, "laughter"):
            self.validate()

    def test_disabled_assets_are_not_read(self):
        status, _ = self.cli("--mode", "lightweight", "--word-timings", "/missing/words",
                             "--outro", "/missing/outro", "--font", "/missing/font")
        self.assertEqual(0, status)

    def test_source_bounds(self):
        self.payload["segments"][4]["end"] = 11
        with self.assertRaisesRegex(ValueError, "source range"):
            self.validate()

    def test_undeclared_cut_removes_protected_laughter(self):
        self.payload["segments"][1]["start"] = 1.2
        self.payload["segments"][1]["output_frame_count"] = 27
        for segment in self.payload["segments"][2:]:
            segment["output_start_frame"] -= 3
        self.payload["protected_laughter"] = [{"start": 1, "end": 1.5}]
        with self.assertRaisesRegex(ValueError, "laughter"):
            self.validate()

    def test_full_legacy_implicit_speed(self):
        self.payload.pop("speed")
        self.payload["segments"][0]["end"] = 1.3
        self.edl.write_text(json.dumps(self.payload))
        preflight.validate_edl(self.edl)

    def test_full_clip_speed_overrides_global(self):
        self.payload["segments"][0]["end"] = 1.3
        self.payload["segments"][0]["speed"] = 1.3
        self.edl.write_text(json.dumps(self.payload))
        preflight.validate_edl(self.edl)

    def test_full_missing_source_legacy(self):
        self.payload = {"fps": 30, "clips": [
            {"output_start_frame": 0, "output_frame_count": 30}]}
        self.edl.write_text(json.dumps(self.payload))
        info, sources = preflight.validate_edl(self.edl)
        self.assertEqual(30, info["total_frames"])
        self.assertEqual([], sources)

    def test_lightweight_requires_source_and_global_speed(self):
        self.payload.pop("speed")
        with self.assertRaisesRegex(ValueError, "global speed"):
            self.validate()
        self.payload = {"fps": 30, "speed": 1.1, "clips": [
            {"output_start_frame": 0, "output_frame_count": 30}]}
        with self.assertRaisesRegex(ValueError, "requires source"):
            self.validate()

    def test_lightweight_uses_global_speed(self):
        self.payload["segments"][0]["end"] = 1.3
        self.payload["segments"][0]["speed"] = 1.3
        with self.assertRaisesRegex(ValueError, "speed/frame"):
            self.validate()

    def test_relative_source_and_laughter_resolve_from_edl(self):
        self.payload["sources"]["dad"]["path"] = "source.mp4"
        self.payload["protected_laughter"] = [{"source_id": "dad", "start": 1, "end": 1.5}]
        self.validate()
        self.assertEqual(self.source.resolve(), self.mock_probe.call_args.args[0])

    def test_lightweight_cover_requires_portrait_ratio(self):
        cover = self.root / "cover.png"
        cover.touch()
        for width, height, status in [(1920, 1080, 1), (1080, 1920, 0)]:
            self.mock_probe.return_value = {
                "format": {"duration": "10"},
                "streams": [{"codec_type": "video", "width": width, "height": height}]}
            result, report = self.cli("--mode", "lightweight", "--cover", str(cover))
            self.assertEqual(status, result)
            if status:
                self.assertIn("9:16", report["findings"][0])

    def test_srt_overlap(self):
        srt = self.root / "captions.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:01,000\n前\n\n2\n00:00:00,910 --> 00:00:02,000\n后\n")
        with self.assertRaisesRegex(ValueError, "overlap"):
            preflight.validate_captions(srt, 5.0, None)

    def test_protected_term_line_or_cue_split(self):
        terms = self.root / "terms.txt"
        terms.write_text("商业模式\n")
        srt = self.root / "captions.srt"
        for text in ["1\n00:00:00,000 --> 00:00:01,000\n商业\n模式\n",
                     "1\n00:00:00,000 --> 00:00:01,000\n商业\n\n2\n00:00:01,000 --> 00:00:02,000\n模式\n"]:
            srt.write_text(text)
            with self.assertRaisesRegex(ValueError, "protected term"):
                preflight.validate_captions(srt, 5.0, terms)

    def test_caption_bounds(self):
        srt = self.root / "captions.srt"
        for stamp in ["00:00:00,000 --> 00:00:00,000", "00:00:04,000 --> 00:00:06,000"]:
            srt.write_text("1\n" + stamp + "\n字\n")
            with self.assertRaisesRegex(ValueError, "bounds"):
                preflight.validate_captions(srt, 5.0, None)



class LaughterUnionRegressionTest(unittest.TestCase):
    def test_repeated_half_does_not_count_as_complete_laughter(self):
        from unittest.mock import patch
        from final_product_preflight import validate_edl
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"fixture")
            edl = root / "edl.json"
            edl.write_text(json.dumps({"fps": 30, "speed": 1, "clips": [
                {"source_path": str(source), "source_start": 0, "source_end": .5, "output_start_frame": 0, "output_frame_count": 15},
                {"source_path": str(source), "source_start": 0, "source_end": .5, "output_start_frame": 15, "output_frame_count": 15}
            ], "protected_laughter": [{"start": 0, "end": 1}]}))
            with patch("final_product_preflight.probe", return_value={"format": {"duration": "2.0"}}):
                with self.assertRaisesRegex(ValueError, "removes protected laughter"):
                    validate_edl(edl, mode="full")


if __name__ == "__main__":
    unittest.main()
