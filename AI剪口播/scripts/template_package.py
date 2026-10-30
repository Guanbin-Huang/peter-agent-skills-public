#!/usr/bin/env python3
"""Frozen 1080x1920 CFR30 subtitle packaging; rebuild JSON, never edit the renderer.

Overrides: {"captions": {"font_size": 76, "y": 1360, ...},
            "protected_regions": [{"x": 0, "y": 0, "width": 100, "height": 100}]}
Requires Pillow, fontTools, ffmpeg/ffprobe; explicit BT709 source metadata.
At most two explicit caption lines. Snapshot times must align to CFR30 frames.
Snapshot/master are native resolution; preview scales to 540x960 before ASS.
No ASR, cuts or speed edits.
"""
from __future__ import annotations
import argparse
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from PIL import Image, ImageFont
from fontTools.ttLib import TTFont

DEFAULT_PRESET = Path(__file__).resolve().parent.parent / 'assets/templates/peter-talking-head-v1.json'
CAPTION_KEYS = {'font_size', 'x', 'y', 'primary_color', 'shadow_opacity', 'shadow_offset', 'shadow_blur'}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def run(command):
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    if result.stderr.strip():
        raise ValueError(f'external command emitted errors: {result.stderr.strip()}')
    return result.stdout


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def number(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{name} must be finite and in [{low}, {high}]')


def resolve_style(preset, overrides=None):
    style = json.loads(Path(preset).read_text())
    if set(style) != {'schema_version', 'id', 'canvas', 'captions', 'protected_regions'}:
        raise ValueError('unknown or missing preset keys')
    if style['schema_version'] != 1 or style['id'] != 'peter-talking-head-v1' or style['canvas'] != {'width': 1080, 'height': 1920, 'fps': 30}:
        raise ValueError('only fixed peter-talking-head-v1 canvas is supported')
    if overrides:
        changes = json.loads(Path(overrides).read_text())
        if not isinstance(changes, dict) or set(changes) - {'captions', 'protected_regions'}:
            raise ValueError('unknown override keys')
        captions = changes.get('captions', {})
        if not isinstance(captions, dict) or set(captions) - CAPTION_KEYS:
            raise ValueError('unknown caption override keys')
        style['captions'].update(captions)
        if 'protected_regions' in changes:
            style['protected_regions'] = changes['protected_regions']
    c = style['captions']
    if not isinstance(c, dict) or set(c) != CAPTION_KEYS:
        raise ValueError('unknown or missing caption keys')
    for key, low, high in [('font_size', 1, 300), ('x', 0, 1080), ('y', 0, 1920), ('shadow_opacity', 0, 1), ('shadow_offset', 0, 100), ('shadow_blur', 0, 100)]:
        number(c[key], key, low, high)
    if not isinstance(c['primary_color'], str) or not re.fullmatch(r'#[0-9A-Fa-f]{6}', c['primary_color']):
        raise ValueError('primary_color must be #RRGGBB')
    if not isinstance(style['protected_regions'], list):
        raise ValueError('protected_regions must be a list')
    for r in style['protected_regions']:
        if not isinstance(r, dict) or set(r) != {'x', 'y', 'width', 'height'}:
            raise ValueError('invalid protected region keys')
        for key, hi in [('x', 1080), ('y', 1920), ('width', 1080), ('height', 1920)]:
            number(r[key], key, 0, hi)
        if r['width'] <= 0 or r['height'] <= 0 or r['x'] + r['width'] > 1080 or r['y'] + r['height'] > 1920:
            raise ValueError('protected region outside canvas')
    return style


def parse_srt(path, duration):
    content = Path(path).read_text(encoding='utf-8-sig').replace('\r\n', '\n').strip()
    if not content:
        raise ValueError('SRT must not be empty')
    cues, previous_end, previous_ass_end = [], 0, 0
    for index, block in enumerate(re.split(r'\n\s*\n', content), 1):
        lines = block.split('\n')
        if len(lines) < 3 or lines[0] != str(index):
            raise ValueError('SRT requires sequential indexes and nonempty text')
        m = re.fullmatch(r'(\d{2,}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2,}):(\d{2}):(\d{2}),(\d{3})', lines[1])
        if not m:
            raise ValueError('SRT requires standard timestamps')
        v = list(map(int, m.groups()))
        if any(v[i] >= 60 for i in (1, 2, 5, 6)):
            raise ValueError('invalid SRT minute/second')
        start, end = [(h * 3600 + mi * 60 + s) + ms / 1000 for h, mi, s, ms in (v[:4], v[4:])]
        text = '\n'.join(lines[2:])
        if not text.strip() or any(ch in text for ch in '{}\\') or any(ord(ch) < 32 and ch != '\n' for ch in text):
            raise ValueError('SRT contains empty text or ASS injection/control characters')
        if start < previous_end or end <= start or end > duration + 1e-6:
            raise ValueError('SRT reversed, overlapping or outside media duration')
        # ASS has centisecond timing: fail rather than silently collapse a cue.
        if round(start * 100) < previous_ass_end:
            raise ValueError('SRT overlaps after ASS centisecond quantization')
        if round(end * 100) <= round(start * 100):
            raise ValueError('SRT cue too short for ASS centisecond timing')
        cues.append((start, end, text))
        previous_end = end
        previous_ass_end = round(end * 100)
    return cues


def layout_guard(style, cues, font_path):
    c = style['captions']
    font = ImageFont.truetype(str(font_path), round(c['font_size']))
    with TTFont(str(font_path)) as metadata:
        names = metadata['name']
        family_record = names.getName(1, 3, 1, 0x409) or names.getName(1, 3, 10, 0x409)
        if family_record is None:
            family_record = names.getName(6, 3, 1, 0x409) or names.getName(6, 3, 10, 0x409)
        if family_record is None:
            raise ValueError('font requires Windows en-US family nameID1 or PostScript nameID6')
        family = family_record.toUnicode()
        cmap = metadata.getBestCmap()
        if not cmap:
            raise ValueError('font has no Unicode cmap')
        missing = sorted({ch for _, _, text in cues for ch in text if ch != '\n' and ord(ch) not in cmap})
        if missing:
            raise ValueError('font is missing subtitle glyphs: ' + ''.join(missing))
    if not family.strip() or any(ch in family for ch in ',\r\n'):
        raise ValueError('font internal family invalid for ASS')
    ascent, descent = font.getmetrics()
    for _, _, text in cues:
        lines = text.split('\n')
        if len(lines) > 2:
            raise ValueError('fixed template supports at most two explicit caption lines')
        width = max(font.getlength(line) for line in lines)
        height = len(lines) * (ascent + descent)
        # Conservative metrics include font ascenders/descenders and blur footprint.
        pad = 3 * c['shadow_blur'] + c['shadow_offset']
        box = (c['x'] - width / 2 - pad, c['y'] - height - pad, c['x'] + width / 2 + pad, c['y'] + pad)
        if box[0] < 0 or box[1] < 0 or box[2] > 1080 or box[3] > 1920:
            raise ValueError('measured caption text box outside canvas')
        for r in style['protected_regions']:
            if box[0] < r['x'] + r['width'] and box[2] > r['x'] and box[1] < r['y'] + r['height'] and box[3] > r['y']:
                raise ValueError('measured caption text box overlaps protected region')
    return family


def ass_time(t):
    cs = round(t * 100)
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f'{h}:{m:02d}:{s:02d}.{cs:02d}'


def compile_ass(style, cues, family):
    c = style['captions']
    rgb = c['primary_color'][1:]
    color = '&H00' + rgb[4:6] + rgb[2:4] + rgb[:2]
    alpha = round((1 - c['shadow_opacity']) * 255)
    shadow = f'&H{alpha:02X}000000'
    head = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
    for name, col in [('Shadow', shadow), ('Foreground', color)]:
        head += f'Style: {name},{family},{c["font_size"]},{col},{col},{col},{col},0,0,0,0,100,100,0,0,1,0,0,2,80,160,560,1\n'
    head += '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    for start, end, text in cues:
        text = text.replace('\n', r'\N')
        for layer, name, offset, blur in [(0, 'Shadow', c['shadow_offset'], c['shadow_blur']), (1, 'Foreground', 0, 0)]:
            head += f'Dialogue: {layer},{ass_time(start)},{ass_time(end)},{name},,0,0,0,,{{\\pos({c["x"] + offset},{c["y"] + offset})\\blur{blur}\\shad0}}{text}\n'
    return head


def probe(path):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))


def frame_pts(path, time_base):
    result = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp', '-of', 'json', str(path)]))
    return [int(f['best_effort_timestamp']) * Fraction(time_base) for f in result['frames']]


def validate_video(path):
    p = probe(path)
    videos = [s for s in p['streams'] if s['codec_type'] == 'video']
    audios = [s for s in p['streams'] if s['codec_type'] == 'audio']
    if len(videos) != 1 or len(audios) != 1:
        raise ValueError('source requires exactly one video and exactly one original audio track')
    v, a = videos[0], audios[0]
    if (v['width'], v['height']) != (1080, 1920) or v.get('sample_aspect_ratio') != '1:1':
        raise ValueError('source must be 1080x1920 square-pixel portrait')
    rotation = float(v.get('tags', {}).get('rotate', 0))
    rotations = [float(s['rotation']) for s in v.get('side_data_list', []) if 'rotation' in s]
    if not math.isfinite(rotation) or rotation != 0 or any(r != 0 for r in rotations):
        raise ValueError('rotation is not supported')
    for key in ('color_transfer', 'color_space', 'color_primaries'):
        if v.get(key) != 'bt709':
            raise ValueError(f'source requires explicit SDR BT709 {key}')
    if Fraction(v['r_frame_rate']) != 30 or Fraction(v['avg_frame_rate']) != 30:
        raise ValueError('source must be CFR30')
    tick = Fraction(v['time_base'])
    if Fraction(v['start_time']) != 0 or abs(Fraction(a['start_time']) - Fraction(v['start_time'])) > tick:
        raise ValueError('source requires zero video start and audio delta <= one video tick')
    pts = frame_pts(path, v['time_base'])
    if not pts or any(abs(t - Fraction(n, 30)) > tick / 2 for n, t in enumerate(pts)):
        raise ValueError('frame PTS guard rejected non-CFR30 source')
    return p, pts, len(pts) / 30


def record(path):
    return {'path': str(Path(path).resolve()), 'sha256': sha(path)}


def publish_dir(temp, destination):
    # mkdir is an exclusive reservation; no rename-over-existing semantics.
    destination.mkdir()
    directory_inode = destination.stat().st_ino
    published = []
    try:
        for child in sorted(Path(temp).rglob('*')):
            target = destination / child.relative_to(temp)
            if child.is_dir():
                target.mkdir()
                published.append((target, target.stat().st_ino))
            else:
                os.link(child, target)
                published.append((target, child.stat().st_ino))
    except OSError:
        if destination.stat().st_ino == directory_inode:
            for target, inode in reversed(published):
                if target.exists() and target.stat().st_ino == inode:
                    if target.is_dir():
                        if not any(target.iterdir()):
                            target.rmdir()
                    else:
                        target.unlink()
            if not any(destination.iterdir()):
                destination.rmdir()
        raise


def build(args):
    started = time.perf_counter()
    out = args.output_dir.resolve()
    if out.exists():
        raise ValueError(f'output conflict: {out}')
    inputs = {k: Path(getattr(args, k)).expanduser().resolve() for k in ('video', 'srt', 'font')}
    input_snapshot = {k: record(v) for k, v in inputs.items()}
    preset = args.preset.expanduser().resolve()
    overrides = args.overrides.expanduser().resolve() if args.overrides else None
    configurations = {'preset': record(preset)}
    if overrides:
        configurations['overrides'] = record(overrides)
    style = resolve_style(preset, overrides)
    p, pts, duration = validate_video(inputs['video'])
    cues = parse_srt(inputs['srt'], duration)
    family = layout_guard(style, cues, inputs['font'])
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as td:
        temp = Path(td)
        write_json(temp / 'style.json', style)
        (temp / 'captions.ass').write_text(compile_ass(style, cues, family), encoding='utf-8')
        # Isolate the exact font; do not load arbitrary sibling directory fonts.
        (temp / 'fonts').mkdir()
        font_asset = 'fonts/font' + inputs['font'].suffix
        shutil.copyfile(inputs['font'], temp / font_asset)
        assets = {name: {'path': str(out / name), 'sha256': sha(temp / name)} for name in ('style.json', 'captions.ass', font_asset)}
        package = {'schema_version': 1, 'inputs': input_snapshot, 'configuration_sources': configurations, 'assets': assets, 'probe': p, 'frames': len(pts), 'duration': duration, 'font_family': family, 'asr_calls': 0, 'speed_changed': False, 'status': 'packaged', 'build_seconds': time.perf_counter() - started}
        write_json(temp / 'package.json', package)
        for group in (input_snapshot, configurations):
            for name, r in group.items():
                if sha(r['path']) != r['sha256']:
                    raise ValueError(f'{name} changed during build; rebuild into a new directory')
        publish_dir(temp, out)
    return {'package': str(out / 'package.json'), 'status': 'packaged', 'seconds': time.perf_counter() - started}


def load_package(path, validate_frames=True):
    package = json.loads(Path(path).read_text())
    if package['schema_version'] != 1:
        raise ValueError('unsupported package schema')
    for group in ('inputs', 'assets'):
        for name, r in package[group].items():
            if sha(r['path']) != r['sha256']:
                raise ValueError(f'stale {group}/{name}; rebuild into a new directory')
    if not validate_frames:
        return package, None
    p, pts, duration = validate_video(package['inputs']['video']['path'])
    if len(pts) != package['frames'] or duration != package['duration'] or p != package['probe']:
        raise ValueError('source metadata differs; rebuild')
    return package, pts


def filter_path(path):
    return str(path).replace('\\', '\\\\').replace("'", "'\\\\\\''").replace(':', '\\:')


def subtitle_filter(package):
    ass = package['assets']['captions.ass']['path']
    font_asset = next(r for name, r in package['assets'].items() if name.startswith('fonts/'))
    return f"subtitles=filename='{filter_path(ass)}':fontsdir='{filter_path(Path(font_asset['path']).parent)}'"


def audio_packets(path):
    p = probe(path)
    a = next(s for s in p['streams'] if s['codec_type'] == 'audio')
    tb = Fraction(a['time_base'])
    packets = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,duration,data_hash', '-of', 'json', str(path)]))['packets']
    return [(Fraction(x['pts']) * tb, Fraction(x['dts']) * tb, Fraction(x['duration']) * tb, x['data_hash']) for x in packets]


def render_command(package, profile, output):
    v = next(s for s in package['probe']['streams'] if s['codec_type'] == 'video')
    time_base = Fraction(v['time_base'])
    return ['ffmpeg', '-hide_banner', '-v', 'error', '-copyts', '-i', package['inputs']['video']['path'], '-map', '0:v:0', '-map', '0:a:0', '-vf', ('scale=540:960,setsar=1,' if profile == 'preview' else '') + subtitle_filter(package), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18' if profile == 'master' else '20', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-enc_time_base', str(time_base), '-video_track_timescale', str(time_base.denominator), '-c:a', 'copy', '-avoid_negative_ts', 'disabled', '-movflags', '+faststart', '-n', str(output)]


def render(args):
    started = time.perf_counter()
    out = args.output.expanduser().resolve()
    report = out.with_suffix('.render.json')
    if out.exists() or report.exists():
        raise ValueError('output conflict')
    package, source_pts = load_package(args.package)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as td:
        temp = Path(td) / out.name
        command = render_command(package, args.profile, temp)
        encode_start = time.perf_counter()
        run(command)
        encode_seconds = time.perf_counter() - encode_start
        run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(temp), '-f', 'null', '-'])
        p = probe(temp)
        v = next(s for s in p['streams'] if s['codec_type'] == 'video')
        size = (540, 960) if args.profile == 'preview' else (1080, 1920)
        if (v['width'], v['height'], v.get('sample_aspect_ratio')) != (*size, '1:1'):
            raise ValueError('output dimensions/SAR differ from frozen canvas')
        if frame_pts(temp, v['time_base']) != source_pts:
            raise ValueError('output video PTS differ from frozen source')
        if audio_packets(temp) != audio_packets(package['inputs']['video']['path']):
            raise ValueError('output audio packet SHA/PTS/DTS/duration differ from source')
        # Recheck fingerprints immediately before publishing.
        for group in ('inputs', 'assets'):
            for r in package[group].values():
                if sha(r['path']) != r['sha256']:
                    raise ValueError('input changed during render; rebuild')
        data = {'status': 'technical_verified', 'visual_approved': False, 'width': size[0], 'height': size[1], 'profile': args.profile, 'output': str(out), 'output_sha256': sha(temp), 'asr_calls': 0, 'speed_changed': False, 'frames': len(source_pts), 'audio_packets_equal': True, 'video_pts_equal': True, 'decode_exit_status': 0, 'encode_seconds': encode_seconds, 'total_seconds': time.perf_counter() - started, 'command': command}
        temp_report = Path(td) / report.name
        write_json(temp_report, data)
        # Hard links are atomic and fail if the destination already exists.
        os.link(temp_report, report)
        try:
            os.link(temp, out)
        except OSError:
            if report.exists() and report.stat().st_ino == temp_report.stat().st_ino:
                report.unlink()
            raise
    return data


def snapshot(args):
    started = time.perf_counter()
    out = args.output_dir.expanduser().resolve()
    if out.exists():
        raise ValueError('output conflict')
    package, _ = load_package(args.package, validate_frames=False)
    if not args.at or len(set(args.at)) != len(args.at):
        raise ValueError('snapshot times must be nonempty and unique')
    for at in args.at:
        number(at, 'snapshot time', 0, package['duration'])
        if abs(at * 30 - round(at * 30)) > 1e-7:
            raise ValueError('snapshot time must align to an integer CFR30 frame')
        if at >= package['duration']:
            raise ValueError('snapshot time outside media')
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as td:
        temp = Path(td)
        commands = []
        for i, at in enumerate(args.at):
            command = ['ffmpeg', '-hide_banner', '-v', 'error', '-ss', str(at), '-copyts', '-i', package['inputs']['video']['path'], '-map', '0:v:0', '-vf', subtitle_filter(package), '-frames:v', '1', '-fps_mode', 'passthrough', '-n', str(temp / f'snapshot-{i:03d}.png')]
            run(command)
            with Image.open(temp / f'snapshot-{i:03d}.png') as im:
                im.load()
                if im.size != (1080, 1920):
                    raise ValueError('snapshot dimensions differ from frozen canvas')
            commands.append(command)
        for group in ('inputs', 'assets'):
            for r in package[group].values():
                if sha(r['path']) != r['sha256']:
                    raise ValueError('input changed during snapshot; rebuild')
        write_json(temp / 'snapshots.json', {'status': 'generated', 'at': args.at, 'sampled_frame_indexes': [round(t * 30) for t in args.at], 'sampled_pts': [round(t * 30) / 30 for t in args.at], 'width': 1080, 'height': 1920, 'asr_calls': 0, 'speed_changed': False, 'seconds': time.perf_counter() - started, 'commands': commands})
        publish_dir(temp, out)
    return {'status': 'generated', 'output_dir': str(out), 'seconds': time.perf_counter() - started}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='action', required=True)
    b = sub.add_parser('build', help='package confirmed SRT + frozen clean video; rebuild to a NEW directory')
    for key in ('video', 'srt', 'font', 'output-dir'):
        b.add_argument('--' + key, type=Path, required=True)
    b.add_argument('--preset', type=Path, default=DEFAULT_PRESET)
    b.add_argument('--overrides', type=Path)
    s = sub.add_parser('snapshot', help='native PNG snapshots, retaining original subtitle timestamps')
    s.add_argument('--package', type=Path, required=True)
    s.add_argument('--at', type=float, nargs='+', required=True)
    s.add_argument('--output-dir', type=Path, required=True)
    r = sub.add_parser('render', help='encode captions only; verify audio packets and video PTS before publication')
    r.add_argument('--package', type=Path, required=True)
    r.add_argument('--profile', choices=('preview', 'master'), required=True)
    r.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps({'build': build, 'snapshot': snapshot, 'render': render}[args.action](args), ensure_ascii=False))


if __name__ == '__main__':
    main()
