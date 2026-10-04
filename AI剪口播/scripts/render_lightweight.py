#!/usr/bin/env python3
"""Render one frozen daily-lightweight timeline; never transcribe or change its EDL."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path


def load_timeline(path: Path, source: Path) -> dict:
    timeline = json.loads(path.read_text(encoding="utf-8"))
    if timeline["fps"] != 30:
        raise ValueError("lightweight delivery requires timeline fps=30")
    speed = float(timeline["speed"])
    if not math.isfinite(speed) or not 0.5 <= speed <= 2:
        raise ValueError("timeline speed must be finite and between 0.5 and 2")
    sources = timeline["sources"]
    if len(sources) != 1:
        raise ValueError("lightweight renderer accepts exactly one source")
    source_id, record = next(iter(sources.items()))
    declared = Path(record["path"]).expanduser()
    if not declared.is_absolute():
        declared = path.parent / declared
    if declared.resolve() != source.resolve():
        raise ValueError("--source contradicts timeline sources path")
    if not source.is_file():
        raise ValueError(f"source is missing: {source}")
    expected = 0
    segments = timeline["segments"]
    if not segments:
        raise ValueError("timeline segments must not be empty")
    for segment in segments:
        n = segment["output_frame_count"]
        start, end = float(segment["start"]), float(segment["end"])
        if segment["source_id"] != source_id:
            raise ValueError("segment source_id contradicts timeline source")
        if (type(n) is not int or n <= 0 or segment["output_start_frame"] != expected
                or not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start):
            raise ValueError("segments require valid ranges and contiguous positive integer frames")
        expected += n
    if expected != timeline["output_frames"] or expected < 4:
        raise ValueError("output_frames must match segments and include three cover frames plus body")
    return timeline


def filter_path(path: Path) -> str:
    # FFmpeg's quoted filter argument has two parsing levels.
    return str(path).replace("\\", "\\\\").replace("'", "'\\\\\\''").replace(":", "\\:")


def make_ass(captions: Path, font: Path, output: Path) -> None:
    from PIL import ImageFont
    family = ImageFont.truetype(str(font), 76).getname()[0]
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Shadow,{family},76,&H00000000,&H00000000,&H90000000,&H90000000,0,0,0,0,100,100,0,0,1,0,0,2,80,160,560,1
Style: Foreground,{family},76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,80,160,560,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for block in re.split(r"\n\s*\n", captions.read_text(encoding="utf-8-sig").strip()):
        lines = block.splitlines()
        match = re.fullmatch(r"(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})", lines[1])
        if not match:
            raise ValueError("captions must contain confirmed standard SRT timestamps")
        values = [int(x) for x in match.groups()]
        times = []
        for h, m, s, ms in (values[:4], values[4:]):
            cs = round((((h * 60 + m) * 60 + s) * 1000 + ms) / 10)
            hh, cs = divmod(cs, 360000)
            mm, cs = divmod(cs, 6000)
            ss, cs = divmod(cs, 100)
            times.append(f"{hh}:{mm:02d}:{ss:02d}.{cs:02d}")
        text = r"\N".join(lines[2:]).replace("{", r"\{").replace("}", r"\}")
        for layer, style, position, blur in ((0, "Shadow", "543,1363", 3), (1, "Foreground", "540,1360", 0)):
            events.append(f"Dialogue: {layer},{times[0]},{times[1]},{style},,0,0,0,,{{\\pos({position})\\blur{blur}\\shad0}}{text}")
    output.write_text(header + "\n".join(events) + "\n", encoding="utf-8")


def build_filter(timeline: dict, profile: str, ass: Path | None = None, font: Path | None = None) -> str:
    fps, speed = timeline["fps"], float(timeline["speed"])
    parts = []
    for i, segment in enumerate(timeline["segments"]):
        a, b, n = segment["start"], segment["end"], segment["output_frame_count"]
        parts.extend([
            f"[0:v]trim=start={a}:end={b},settb=AVTB,setpts=(PTS-STARTPTS)/{speed:g},fps={fps},tpad=stop_mode=clone:stop_duration=0.05,trim=end_frame={n},setpts=PTS-STARTPTS[v{i}]",
            f"[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,atempo={speed:g},aresample=48000,apad=pad_dur=0.05,atrim=duration={n/fps:.12g}[a{i}]",
        ])
    count = len(timeline["segments"])
    parts.append("".join(f"[v{i}][a{i}]" for i in range(count)) + f"concat=n={count}:v=1:a=1[vcat][aout]")
    width, height = (360, 640) if profile == "preview" else (1080, 1920)
    subtitle = f",ass=filename='{filter_path(ass)}':fontsdir='{filter_path(font.parent)}'" if ass else ""
    parts.extend([
        f"[vcat]scale={width}:{height},setsar=1{subtitle},fps={fps},settb=1/{fps}[body]",
        f"[1:v]scale={width}:{height},setsar=1[cover]",
        "[body][cover]overlay=enable='lt(n,3)':eof_action=repeat,format=yuv420p[vout]",
    ])
    return ";\n".join(parts) + "\n"


def render(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    source, edl, cover, output = (p.expanduser().resolve() for p in (args.source, args.timeline, args.cover, args.output))
    paths = {"sidecar": output.with_suffix(".render.json"), "command": output.with_suffix(".command.sh"),
             "filter": output.with_suffix(".filter"), "preflight": output.with_suffix(".preflight.json")}
    if args.captions:
        paths["ass"] = output.with_suffix(".ass")
    for path in [output, *paths.values()]:
        if path.exists():
            raise ValueError(f"output path conflict (never overwrite): {path}")
    if args.font and not args.captions or args.protected_terms_file and not args.captions:
        raise ValueError("--font and --protected-terms-file require --captions")
    if args.captions and not args.font:
        raise ValueError("confirmed captions require --font")
    timeline = load_timeline(edl, source)
    source_probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(source)], text=True))
    video = next(s for s in source_probe["streams"] if s["codec_type"] == "video")
    rotation = float(next((item["rotation"] for item in video.get("side_data_list", []) if "rotation" in item), video.get("tags", {}).get("rotate", 0)))
    if not math.isfinite(rotation) or rotation % 90:
        raise ValueError("source rotation requires the strict transform workflow")
    width, height = video["width"], video["height"]
    if rotation % 180:
        width, height = height, width
    if width * 16 != height * 9 or video.get("sample_aspect_ratio", "1:1") not in ("1:1", "N/A"):
        raise ValueError("source display must be 9:16 square-pixel video; no implicit crop is performed")
    audio = next((stream for stream in source_probe["streams"] if stream["codec_type"] == "audio"), None)
    if audio is None:
        raise ValueError("source must contain its original audio")
    if abs(float(video.get("start_time", 0)) - float(audio.get("start_time", 0))) > 1 / timeline["fps"]:
        raise ValueError("source audio/video start offset requires the strict timing workflow")
    output.parent.mkdir(parents=True, exist_ok=True)
    preflight_command = [sys.executable, str(Path(__file__).with_name("final_product_preflight.py")), "--mode", "lightweight", "--edl", str(edl), "--cover", str(cover), "--report", str(paths["preflight"])]
    for option, value in (("--captions", args.captions), ("--font", args.font), ("--protected-terms-file", args.protected_terms_file)):
        if value:
            preflight_command.extend([option, str(value.expanduser().resolve())])
    preflight_start = time.perf_counter()
    result = subprocess.run(preflight_command, check=False)
    preflight_seconds = time.perf_counter() - preflight_start
    if result.returncode != 0:
        raise ValueError(f"preflight failed (exit {result.returncode}); encoding was not started")
    if json.loads(paths["preflight"].read_text())["status"] != "pass":
        raise ValueError("preflight report did not pass; encoding was not started")
    if args.captions:
        make_ass(args.captions.expanduser().resolve(), args.font.expanduser().resolve(), paths["ass"])
    paths["filter"].write_text(build_filter(timeline, args.profile, paths.get("ass"), args.font.expanduser().resolve() if args.font else None))
    command = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-threads", "4", "-i", str(source), "-loop", "1", "-framerate", "30", "-i", str(cover), "-filter_complex_threads", "2", "-filter_complex_script", str(paths["filter"]), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-threads", "4", "-preset", "veryfast", "-crf", "23" if args.profile == "preview" else "18", "-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr", "-video_track_timescale", "15360", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", "-ar", "48000", "-b:a", "128k", "-t", f"{timeline['output_frames']/30:.12g}", "-movflags", "+faststart", "-n", str(output)]
    paths["command"].write_text("#!/bin/sh\nset -eu\n" + shlex.join(command) + "\n")
    paths["command"].chmod(0o755)
    encode_start = time.perf_counter()
    result = subprocess.run(command, check=False)
    stat = source.stat()
    small_inputs = {"timeline": edl, "cover": cover}
    if args.captions:
        small_inputs.update(captions=args.captions.expanduser().resolve(), font=args.font.expanduser().resolve())
    if args.protected_terms_file:
        small_inputs["protected_terms_file"] = args.protected_terms_file.expanduser().resolve()
    metadata = {"status": "encoded" if result.returncode == 0 else "encode_failed", "output": str(output),
                "source": {"path": str(source), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns},
                "inputs": {k: {"path": str(v), "sha256": hashlib.sha256(v.read_bytes()).hexdigest()} for k, v in small_inputs.items()},
                "profile": args.profile, "speed": timeline["speed"], "fps": 30, "frames": timeline["output_frames"],
                "preflight_seconds": preflight_seconds, "encode_seconds": time.perf_counter() - encode_start,
                "total_seconds": time.perf_counter() - started, "encode_count": 1, "asr_calls": 0,
                "command": command, "preflight_command": preflight_command, "encode_exit_status": result.returncode}
    paths["sidecar"].write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, command)
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "timeline", "cover", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    for name in ("captions", "font", "protected-terms-file"):
        parser.add_argument(f"--{name}", type=Path)
    parser.add_argument("--profile", choices=("preview", "master"), required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(render(args), ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        print(f"LIGHTWEIGHT_RENDER_FAILED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
