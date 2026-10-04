#!/bin/bash

# 普通发布版的最后一次编码：可同时把封面放入第 1-5 帧并压缩体积。
# 用法: compress_publish.sh <input.mp4> <output.mp4> [--cover cover.png]

set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "用法: $0 <input.mp4> <output.mp4> [--cover cover.png]"
  exit 1
fi

INPUT="$1"
OUTPUT="$2"
shift 2
COVER=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cover)
      [ "$#" -ge 2 ] || { echo "--cover 缺少图片路径"; exit 1; }
      COVER="$2"
      shift 2
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

[ -f "$INPUT" ] || { echo "输入视频不存在: $INPUT"; exit 1; }
[ -z "$COVER" ] || [ -f "$COVER" ] || { echo "封面不存在: $COVER"; exit 1; }

INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
OUTPUT_DIR="$(mkdir -p "$(dirname "$OUTPUT")" && cd "$(dirname "$OUTPUT")" && pwd)"
OUTPUT_ABS="$OUTPUT_DIR/$(basename "$OUTPUT")"
[ "$INPUT_ABS" != "$OUTPUT_ABS" ] || { echo "输入和输出不能是同一文件"; exit 1; }

WIDTH="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$INPUT")"
HEIGHT="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$INPUT")"
[ -n "$WIDTH" ] && [ -n "$HEIGHT" ] || { echo "无法读取视频尺寸"; exit 1; }

FPS="${PUBLISH_FPS:-30}"
VIDEO_BITRATE="${PUBLISH_VIDEO_BITRATE:-6M}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ai-jian-koubo-compress.XXXXXX")"
TMP_OUTPUT="$TMP_DIR/publish.mp4"
cleanup() {
  rm -f "$TMP_OUTPUT"
  rmdir "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

build_inputs_and_filter() {
  if [ -n "$COVER" ]; then
    INPUT_ARGS=(-i "$INPUT" -loop 1 -framerate "$FPS" -i "$COVER")
    FILTER="[0:v]fps=$FPS,format=yuv420p[base];[1:v]scale=$WIDTH:$HEIGHT:force_original_aspect_ratio=increase,crop=$WIDTH:$HEIGHT,format=yuv420p[cover];[base][cover]overlay=enable='lt(n,5)':shortest=1,format=yuv420p[vout]"
  else
    INPUT_ARGS=(-i "$INPUT")
    FILTER="[0:v]fps=$FPS,format=yuv420p[vout]"
  fi
}

encode_videotoolbox() {
  ffmpeg -y -hide_banner -loglevel warning \
    "${INPUT_ARGS[@]}" \
    -filter_complex "$FILTER" \
    -map '[vout]' -map '0:a:0?' \
    -c:v h264_videotoolbox -profile:v high -b:v "$VIDEO_BITRATE" \
    -maxrate 8M -bufsize 12M -realtime 1 -prio_speed 1 -allow_sw 1 \
    -c:a aac -b:a 160k -ar 48000 \
    -movflags +faststart "$TMP_OUTPUT"
}

encode_libx264() {
  ffmpeg -y -hide_banner -loglevel warning \
    "${INPUT_ARGS[@]}" \
    -filter_complex "$FILTER" \
    -map '[vout]' -map '0:a:0?' \
    -c:v libx264 -preset veryfast -crf 22 -profile:v high -pix_fmt yuv420p \
    -c:a aac -b:a 160k -ar 48000 \
    -movflags +faststart "$TMP_OUTPUT"
}

build_inputs_and_filter

if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'h264_videotoolbox'; then
  echo "使用 VideoToolbox 快速压缩"
  if ! encode_videotoolbox; then
    echo "VideoToolbox 失败，回退到 libx264" >&2
    encode_libx264 || exit 1
  fi
else
  echo "未找到 VideoToolbox，使用 libx264"
  encode_libx264 || exit 1
fi

mv -f "$TMP_OUTPUT" "$OUTPUT_ABS"
echo "发布版已生成: $OUTPUT_ABS"
