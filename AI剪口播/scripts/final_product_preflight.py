#!/usr/bin/env python3
"""Fail before a long final render when EDL, timings, font, or outro are invalid."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path


def probe(path: Path) -> dict:
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=codec_type,width,height,avg_frame_rate,sample_rate",
        "-of", "json", str(path),
    ], text=True))


def load_words(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    words = payload.get("words", payload) if isinstance(payload, dict) else payload
    if not isinstance(words, list) or not words:
        raise ValueError("word timings must contain a non-empty words list")
    return words


def validate_words(words: list[dict]) -> None:
    previous_start = -1.0
    previous_end = -1.0
    for index, word in enumerate(words):
        start = float(word["start"])
        end = float(word["end"])
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError(f"word timing {index} has invalid bounds: {start}..{end}")
        if start < previous_start - 0.001 or end < previous_end - 0.001:
            raise ValueError(f"word timing {index} is non-monotonic")
        previous_start, previous_end = start, end


def validate_edl(path: Path, mode: str = "full") -> tuple[dict, list[dict]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    fps = float(payload["fps"])
    if mode == "lightweight" and "speed" not in payload:
        raise ValueError("lightweight EDL requires explicit global speed")
    speed = float(payload.get("speed", 1))
    clips = payload.get("clips", payload.get("segments"))
    if not math.isfinite(fps) or fps <= 0 or not isinstance(clips, list) or not clips:
        raise ValueError("EDL requires positive fps and a non-empty clips or segments list")
    if not math.isfinite(speed) or speed <= 0:
        raise ValueError("EDL requires positive speed")
    expected_start = 0
    source_cache: dict[str, dict] = {}
    previous_end: dict[str, float] = {}
    retained: dict[str, list[tuple[float, float]]] = {}
    sources = payload.get("sources", {})
    for index, clip in enumerate(clips):
        start_frame = clip.get("output_start_frame")
        frame_count = clip.get("output_frame_count")
        if (type(start_frame) is not int or start_frame != expected_start
                or type(frame_count) is not int or frame_count <= 0):
            raise ValueError(f"EDL clip {index} is not a positive contiguous integer-frame clip")
        expected_start += frame_count
        source_id = clip.get("source_id")
        source_path = clip.get("source_path")
        if not source_path and source_id is not None:
            source_path = sources[source_id]["path"]
        if not source_path:
            if mode == "full":
                continue
            raise ValueError(f"EDL clip {index} requires source_path or source_id")
        source = Path(source_path).expanduser()
        source = (path.parent / source).resolve()
        if not source.is_file():
            raise ValueError(f"EDL clip {index} source is missing: {source}")
        key = str(source)
        if key not in source_cache:
            source_cache[key] = probe(source)
        duration = float(source_cache[key]["format"]["duration"])
        source_start = float(clip.get("source_start", clip.get("start", 0)))
        source_end = float(clip.get("source_end", clip.get("end", duration)))
        if (not math.isfinite(source_start) or not math.isfinite(source_end)
                or source_start < 0 or source_end <= source_start or source_end > duration + 0.050):
            raise ValueError(f"EDL clip {index} source range is invalid")
        if mode == "lightweight" or "speed" in payload or "speed" in clip:
            clip_speed = speed if mode == "lightweight" else float(clip.get("speed", speed))
            if not math.isfinite(clip_speed) or clip_speed <= 0:
                raise ValueError(f"EDL clip {index} requires positive speed")
            if abs((source_end - source_start) / clip_speed * fps - frame_count) > 1.000001:
                raise ValueError(f"EDL clip {index} speed/frame count mismatch")
        if mode == "lightweight" and source_start < previous_end.get(key, 0) - 0.000001:
            raise ValueError(f"EDL clip {index} reorders or overlaps source content")
        previous_end[key] = source_end
        retained.setdefault(key, []).append((source_start, source_end))

    def interval_source(interval: dict) -> str:
        source_id = interval.get("source_id")
        if source_id is not None:
            return str((path.parent / Path(sources[source_id]["path"]).expanduser()).resolve())
        if len(source_cache) != 1:
            raise ValueError("protected laughter/cut requires source_id for multiple sources")
        return next(iter(source_cache))

    for laughter in payload.get("protected_laughter", []):
        key = interval_source(laughter)
        start, end = float(laughter["start"]), float(laughter["end"])
        if (not math.isfinite(start) or not math.isfinite(end) or start < 0
                or end <= start or key not in source_cache
                or end > float(source_cache[key]["format"]["duration"]) + 0.050):
            raise ValueError("protected laughter has invalid bounds")
        for cut in payload.get("cuts", []):
            if interval_source(cut) == key and float(cut["start"]) < end and float(cut["end"]) > start:
                raise ValueError("cut overlaps protected laughter")
        covered_until = start
        for left, right in sorted(retained[key]):
            if left > covered_until + 0.000001:
                break
            covered_until = max(covered_until, min(end, right))
        if covered_until < end - 0.000001:
            raise ValueError("EDL removes protected laughter")
    return {"fps": fps, "total_frames": expected_start}, list(source_cache.values())


def validate_captions(path: Path, duration: float, terms_file: Path | None) -> int:
    # Reuse canonical SRT parser without importing its full delivery policy.
    scripts = Path(__file__).resolve().parents[2] / "douyin-captions" / "scripts"
    sys.path.insert(0, str(scripts))
    try:
        from validate_captions import normalized, parse_srt, read_list
    finally:
        sys.path.pop(0)
    cues = parse_srt(path)
    previous_end = 0.0
    previous_index = 0
    joined = ""
    boundaries: list[int] = []
    for cue in cues:
        if cue.start < 0 or cue.end <= cue.start or cue.end > duration + 0.001:
            raise ValueError(f"SRT cue {cue.index} has invalid bounds")
        if cue.index <= previous_index:
            raise ValueError("SRT cues are out of order")
        if cue.start < previous_end - 0.000001:
            raise ValueError(f"SRT cue {cue.index} overlap")
        previous_end, previous_index = cue.end, cue.index
        for line in cue.lines:
            joined += normalized(line)
            boundaries.append(len(joined))
    for raw_term in read_list([], terms_file):
        term = normalized(raw_term)
        if not term:
            continue
        start = joined.find(term)
        while start >= 0:
            if any(start < boundary < start + len(term) for boundary in boundaries):
                raise ValueError(f"protected term crosses caption line/cue: {raw_term}")
            start = joined.find(term, start + 1)
    return len(cues)


def smoke_test_font(font: Path, text: str) -> None:
    if not font.is_file():
        raise ValueError(f"font is missing: {font}")
    escaped_font = str(font).replace("'", "\\'").replace(":", "\\:")
    escaped_text = text.replace("'", "\\'").replace(":", "\\:")
    with tempfile.TemporaryDirectory(prefix="final-product-font-") as directory:
        output = Path(directory) / "font-smoke.png"
        subprocess.check_call([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=gray:s=540x960:d=0.1",
            "-vf", (
                f"drawtext=fontfile='{escaped_font}':text='{escaped_text}':"
                "fontcolor=white:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2"
            ),
            "-frames:v", "1", "-update", "1", str(output),
        ])
        if not output.is_file() or output.stat().st_size < 1000:
            raise ValueError("font smoke render did not produce a valid image")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edl", required=True, type=Path)
    parser.add_argument("--mode", choices=("full", "lightweight"), default="full")
    parser.add_argument("--cover", type=Path)
    parser.add_argument("--captions", type=Path)
    parser.add_argument("--protected-terms-file", type=Path)
    parser.add_argument("--word-timings", type=Path)
    parser.add_argument("--font", type=Path)
    parser.add_argument("--outro", type=Path)
    parser.add_argument("--cover-title")
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    findings: list[str] = []
    report: dict = {"status": "fail"}
    try:
        if args.mode == "full":
            required = ("word_timings", "font", "outro", "cover_title")
            missing = ["--" + key.replace("_", "-") for key in required if not getattr(args, key)]
            if missing:
                raise ValueError("full mode requires " + ", ".join(missing))
        edl, sources = validate_edl(args.edl, mode=args.mode)
        report.update({"edl": edl, "source_count": len(sources), "mode": args.mode})
        if args.cover:
            if not args.cover.is_file() or args.cover.suffix.lower() != ".png":
                raise ValueError("cover requires an existing PNG image")
            cover_probe = probe(args.cover)
            if not any(stream.get("codec_type") == "video" and stream.get("width", 0) > 0
                       and stream.get("height", 0) > 0 for stream in cover_probe.get("streams", [])):
                raise ValueError("cover has no valid image stream")
            if args.mode == "lightweight":
                stream = next(stream for stream in cover_probe["streams"]
                              if stream.get("codec_type") == "video")
                if stream["width"] * 16 != stream["height"] * 9:
                    raise ValueError("lightweight cover must have a 9:16 image ratio")
            report["cover"] = str(args.cover.resolve())
        if args.captions:
            if not args.font:
                raise ValueError("captions require --font")
            report["caption_count"] = validate_captions(
                args.captions, edl["total_frames"] / edl["fps"], args.protected_terms_file)
            smoke_test_font(args.font, "中文字幕")
            report["font"] = str(args.font.resolve())
        if args.mode == "full":
            words = load_words(args.word_timings)
            validate_words(words)
            if not args.outro.is_file():
                raise ValueError(f"outro is missing: {args.outro}")
            outro_probe = probe(args.outro)
            smoke_test_font(args.font, args.cover_title + " 中文字幕")
            report.update({
                "word_count": len(words), "font": str(args.font.resolve()),
                "outro": {"path": str(args.outro.resolve()), "probe": outro_probe},
                "cover_title": args.cover_title,
            })
        report["status"] = "pass"
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        findings.append(str(error))
        report["findings"] = findings

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
