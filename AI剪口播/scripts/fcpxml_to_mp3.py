#!/usr/bin/env python3
"""
FCPXML → 干净 MP3 导出工具

问题背景:
  ffmpeg concat demuxer 直接拼 MP4 源文件时, 因非连续 DTS 时间戳会导致:
  1. 音频内容重复
  2. ffprobe 误读时长(如 13+ 分钟, 实际只有 2 分钟)

解决方案:
  每个片段单独提取成无损 WAV, 再拼接, 完全绕开时间戳问题。

用法:
  python3 fcpxml_to_mp3.py <fcpxml路径> <源视频路径> <输出mp3路径> [--prepend-start SEC --prepend-end SEC]

沉淀日期: 2026-07-16
"""
import subprocess, os, re, sys, argparse, tempfile, shutil

def main():
    parser = argparse.ArgumentParser(description="FCPXML to clean MP3")
    parser.add_argument("fcpxml", help="FCPXML 路径")
    parser.add_argument("source", help="源视频路径")
    parser.add_argument("output", help="输出 MP3 路径")
    parser.add_argument("--prepend-start", type=float, help="前置片段起始秒")
    parser.add_argument("--prepend-end", type=float, help="前置片段结束秒")
    parser.add_argument("--bitrate", default="192k", help="MP3 比特率")
    args = parser.parse_args()

    with open(args.fcpxml) as f:
        fcpxml = f.read()
    clips = re.findall(r'<asset-clip[^>]*start="(\d+)/25s"\s+duration="(\d+)/25s"', fcpxml)
    if not clips:
        print("ERROR: FCPXML 中未找到 asset-clip")
        sys.exit(1)

    segments = []
    if args.prepend_start is not None:
        segments.append((args.prepend_start, args.prepend_end))
    for sf, df in clips:
        s, d = int(sf)/25.0, int(df)/25.0
        segments.append((s, s+d))

    total = sum(e-s for s,e in segments)
    print(f"片段: {len(segments)}, 总时长: {total:.1f}s")

    tmpdir = tempfile.mkdtemp(prefix="fcpxml_mp3_")
    wavs, failed = [], 0

    for i, (s, e) in enumerate(segments):
        seg = os.path.join(tmpdir, f"seg_{i:04d}.wav")
        r = subprocess.run([
            "ffmpeg", "-y", "-v", "error",
            "-i", args.source, "-ss", str(s), "-t", str(e-s),
            "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", seg
        ], capture_output=True, text=True)
        if r.returncode:
            print(f"WARN: 片段 {i} ({s:.2f}-{e:.2f}s) 失败")
            failed += 1
        else:
            wavs.append(seg)

    if not wavs:
        print("ERROR: 全部提取失败"); sys.exit(1)
    if failed:
        print(f"  成功 {len(wavs)}/{len(segments)}, 失败 {failed}")

    lst = os.path.join(tmpdir, "list.txt")
    with open(lst, "w") as f:
        for w in wavs:
            f.write(f"file '{w}'\n")

    r = subprocess.run([
        "ffmpeg", "-y", "-v", "warning",
        "-f", "concat", "-safe", "0", "-i", lst,
        "-acodec", "libmp3lame", "-b:a", args.bitrate, args.output
    ], capture_output=True, text=True)
    if r.returncode:
        print("ERROR: 编码失败"); print(r.stderr[-500:]); sys.exit(1)

    r = subprocess.run(["ffprobe", args.output], capture_output=True, text=True)
    for line in r.stderr.split("\n"):
        if "Duration" in line:
            print(f"✅ {line.strip()}")
    subprocess.run(["ls", "-lh", args.output])
    shutil.rmtree(tmpdir, ignore_errors=True)

if __name__ == "__main__":
    main()
