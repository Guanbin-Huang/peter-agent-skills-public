#!/usr/bin/env python3
"""Make a bounded, text-only revision to aligned SRT and ASS captions."""

import argparse
import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path


SRT_TIME = re.compile(r"^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$")
ASS_TIME = re.compile(r"^(\d+):(\d{2}):(\d{2})\.(\d{2})$")
ASS_TOKEN = re.compile(r"(\{[^{}]*\}|\\[Nnh])")


def plain(value, label):
    if not value.strip() or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in value):
        raise ValueError(f"{label} must be nonempty single-line plain text")
    if any(c in value for c in "\\{}"):
        raise ValueError(f"{label} contains ASS syntax")
    return value


def milliseconds(groups, ass=False):
    values = [int(part) for part in groups]
    if ass:
        hours, minutes, seconds, centiseconds = values
        if minutes >= 60 or seconds >= 60:
            raise ValueError("invalid ASS timing")
        return ((hours * 60 + minutes) * 60 + seconds) * 1000 + centiseconds * 10
    hours, minutes, seconds, millis = values
    if minutes >= 60 or seconds >= 60:
        raise ValueError("invalid SRT timing")
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def parse_srt(source):
    chunks = re.split(r"(\r?\n\r?\n)", source)
    cues = []
    for chunk_index in range(0, len(chunks), 2):
        chunk = chunks[chunk_index]
        if not chunk.strip():
            continue
        match = re.fullmatch(r"(\d+)(\r?\n)([^\r\n]+)(\r?\n)(.*)", chunk, re.DOTALL)
        if not match or not match.group(5).strip():
            raise ValueError(f"invalid SRT cue near block {len(cues) + 1}")
        timing = SRT_TIME.fullmatch(match.group(3))
        if not timing:
            raise ValueError(f"invalid SRT timing in cue {len(cues) + 1}")
        start = milliseconds(timing.groups()[:4])
        end = milliseconds(timing.groups()[4:])
        if end <= start:
            raise ValueError(f"invalid SRT timing in cue {len(cues) + 1}")
        raw_text = match.group(5)
        text = raw_text.rstrip("\r\n")
        cues.append({"chunk": chunk_index, "prefix": chunk[:match.start(5)], "text": text,
                     "suffix": raw_text[len(text):],
                     "start": start, "end": end})
    if not cues:
        raise ValueError("SRT has no cues")
    return chunks, cues


def ass_visible(raw):
    parts = ASS_TOKEN.split(raw)
    if any("{" in part or "}" in part for part in parts[::2]):
        raise ValueError("invalid ASS override tag")
    return "".join("\n" if part == "\\N" else " " if part in ("\\n", "\\h")
                   else "" if part.startswith("{") and part.endswith("}") else part
                   for part in parts)


def patch_ass_text(raw, old, new):
    parts = ASS_TOKEN.split(raw)
    return "".join(part if part.startswith("{") or part in ("\\N", "\\n", "\\h")
                   else part.replace(old, new) for part in parts)


def parse_ass(source):
    lines = source.splitlines(keepends=True)
    in_events = False
    columns = None
    events = []
    for index, line in enumerate(lines):
        body = line.rstrip("\r\n")
        if body.startswith("[") and body.endswith("]"):
            in_events = body == "[Events]"
            continue
        if not in_events:
            continue
        if body.startswith("Format:"):
            columns = [column.strip().lower() for column in body.partition(":")[2].split(",")]
            if not {"start", "end", "text"}.issubset(columns) or columns[-1] != "text":
                raise ValueError("unsupported ASS event format")
            continue
        if not body.startswith("Dialogue:"):
            continue
        if columns is None:
            raise ValueError("ASS Dialogue appears before Events Format")
        _, _, payload = body.partition(":")
        fields = payload.lstrip(" ").split(",", len(columns) - 1)
        if len(fields) != len(columns):
            raise ValueError(f"invalid ASS Dialogue at line {index + 1}")
        start_match = ASS_TIME.fullmatch(fields[columns.index("start")].strip())
        end_match = ASS_TIME.fullmatch(fields[columns.index("end")].strip())
        if not start_match or not end_match:
            raise ValueError(f"invalid ASS timing at line {index + 1}")
        start = milliseconds(start_match.groups(), ass=True)
        end = milliseconds(end_match.groups(), ass=True)
        if end <= start:
            raise ValueError(f"invalid ASS timing at line {index + 1}")
        text = fields[-1]
        if not text:
            raise ValueError(f"empty ASS Dialogue text at line {index + 1}")
        events.append({"line": index, "prefix": body[:-len(text)], "text": text,
                       "suffix": line[len(body):], "start": start, "end": end,
                       "visible": ass_visible(text)})
    if not events:
        raise ValueError("ASS has no Dialogue events")
    return lines, events


def align(cues, events):
    groups = []
    for event in events:
        if (groups and event["start"] == groups[-1][0]["start"]
                and event["end"] == groups[-1][0]["end"]
                and event["visible"] == groups[-1][0]["visible"]):
            groups[-1].append(event)
        else:
            groups.append([event])
    if len(groups) != len(cues):
        raise ValueError(f"SRT/ASS caption page count mismatch: {len(cues)} vs {len(groups)}")
    for number, (cue, group) in enumerate(zip(cues, groups), 1):
        first = group[0]
        if (cue["text"].replace("\r\n", "\n") != first["visible"]
                or abs(cue["start"] - first["start"]) > 10
                or abs(cue["end"] - first["end"]) > 10):
            raise ValueError(f"SRT/ASS caption mismatch in cue {number}")
    return groups


def run(args):
    old = plain(args.old, "--old")
    new = plain(args.new, "--new")
    if old == new:
        raise ValueError("--old and --new must differ")
    if args.expect_cues is not None and args.expect_cues < 1:
        raise ValueError("--expect-cues must be positive")
    srt_path, ass_path, out_dir = Path(args.srt), Path(args.ass), Path(args.out_dir)
    if out_dir.exists() or out_dir.is_symlink():
        raise ValueError(f"output already exists: {out_dir}")
    if srt_path.resolve() == ass_path.resolve():
        raise ValueError("SRT and ASS sources must differ")
    srt_bytes, ass_bytes = srt_path.read_bytes(), ass_path.read_bytes()
    srt_chunks, cues = parse_srt(srt_bytes.decode("utf-8-sig"))
    ass_lines, events = parse_ass(ass_bytes.decode("utf-8-sig"))
    groups = align(cues, events)

    changed = []
    ass_event_count = 0
    for number, (cue, group) in enumerate(zip(cues, groups), 1):
        if old not in cue["text"]:
            continue
        revised = cue["text"].replace(old, new)
        for event in group:
            patched = patch_ass_text(event["text"], old, new)
            if patched == event["text"] or ass_visible(patched) != revised.replace("\r\n", "\n"):
                raise ValueError(f"ASS text cannot be patched consistently in cue {number}")
            ass_lines[event["line"]] = event["prefix"] + patched + event["suffix"]
            ass_event_count += 1
        srt_chunks[cue["chunk"]] = cue["prefix"] + revised + cue["suffix"]
        changed.append({"cue": number, "start_ms": cue["start"], "end_ms": cue["end"]})
    if not changed:
        raise ValueError(f"no caption matches --old: {old}")
    if args.expect_cues is not None and len(changed) != args.expect_cues:
        raise ValueError(f"expected {args.expect_cues} changed cues, found {len(changed)}")

    manifest = {
        "mode": "text_only", "media_rendered": False,
        "source_srt": str(srt_path.resolve()), "source_ass": str(ass_path.resolve()),
        "source_srt_sha256": hashlib.sha256(srt_bytes).hexdigest(),
        "source_ass_sha256": hashlib.sha256(ass_bytes).hexdigest(),
        "old": old, "new": new,
        "changed_cue_count": len(changed), "changed_ass_event_count": ass_event_count,
        "changed_intervals": changed,
    }
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{out_dir.name}.", dir=out_dir.parent) as staging:
        stage = Path(staging)
        (stage / "captions.srt").write_text(("\ufeff" if srt_bytes.startswith(b"\xef\xbb\xbf") else "") + "".join(srt_chunks), encoding="utf-8", newline="")
        (stage / "captions.ass").write_text(("\ufeff" if ass_bytes.startswith(b"\xef\xbb\xbf") else "") + "".join(ass_lines), encoding="utf-8", newline="")
        (stage / "caption_patch.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        stage.rename(out_dir)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--srt", required=True)
    parser.add_argument("--ass", required=True)
    parser.add_argument("--old", required=True)
    parser.add_argument("--new", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--expect-cues", type=int)
    args = parser.parse_args()
    try:
        manifest = run(args)
    except (OSError, UnicodeError, ValueError) as exc:
        parser.exit(2, f"caption patch failed: {exc}\n")
    print(f"changed {manifest['changed_cue_count']} cues / {manifest['changed_ass_event_count']} ASS events")


if __name__ == "__main__":
    main()
