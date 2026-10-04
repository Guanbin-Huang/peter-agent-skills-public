#!/bin/bash

# 并行转录多段口播。默认使用 Seed ASR 标准版，默认 3 路、最多 4 路。
# 用法: batch_transcribe.sh <output_root> <video1> [video2 ...]
# 可选环境变量: ASR_ENGINE=flash|v3-standard|auto  BATCH_JOBS=1..4
# standard 资源可用 VOLCENGINE_ASR_RESOURCE_ID 覆盖，默认 volc.seedasr.auc。

set -o pipefail

if [ "$#" -lt 2 ]; then
  echo "用法: $0 <output_root> <video1> [video2 ...]"
  exit 1
fi

OUTPUT_ROOT="$1"
shift
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="${ASR_ENGINE:-v3-standard}"
JOBS="${BATCH_JOBS:-3}"

case "$ENGINE" in
  flash|v3-standard|auto) ;;
  *) echo "未知 ASR_ENGINE: $ENGINE"; exit 1 ;;
esac

case "$JOBS" in
  1|2|3|4) ;;
  *) echo "BATCH_JOBS 必须是 1、2、3 或 4"; exit 1 ;;
esac

mkdir -p "$OUTPUT_ROOT"

run_one() {
  local index="$1"
  local video="$2"
  local filename stem output_dir env_file selected_engine

  if [ ! -f "$video" ]; then
    echo "视频不存在: $video" >&2
    return 1
  fi

  filename="$(basename "$video")"
  stem="${filename%.*}"
  output_dir="$OUTPUT_ROOT/$(printf '%02d' "$index")_$stem"
  env_file="${VOLCENGINE_ENV_FILE:-$SKILL_DIR/.env}"

  run_transcribe() {
    selected_engine="$1"
    if [ "$selected_engine" = "v3-standard" ]; then
      export VOLCENGINE_ASR_RESOURCE_ID="${VOLCENGINE_ASR_RESOURCE_ID:-volc.seedasr.auc}"
    fi
    if [ -f "$env_file" ]; then
      env -u VOLCENGINE_API_KEY VOLCENGINE_ENV_FILE="$env_file" \
        bash "$SKILL_DIR/scripts/run_transcribe.sh" "$video" "$output_dir" "--$selected_engine"
    else
      bash "$SKILL_DIR/scripts/run_transcribe.sh" "$video" "$output_dir" "--$selected_engine"
    fi
  }

  echo "[$index] 开始: $filename"
  if run_transcribe "$ENGINE"; then
    echo "[$index] 完成: $output_dir/1_转录"
    return 0
  fi

  if [ "$ENGINE" = "flash" ]; then
    echo "[$index] flash 失败，改用 standard 重试" >&2
    if run_transcribe "v3-standard"; then
      echo "[$index] 完成: $output_dir/1_转录"
      return 0
    fi
  fi

  echo "[$index] 失败: $filename" >&2
  return 1
}

index=0
failed=0
pids=()

for video in "$@"; do
  index=$((index + 1))
  run_one "$index" "$video" &
  pids+=("$!")

  if [ "${#pids[@]}" -ge "$JOBS" ]; then
    for pid in "${pids[@]}"; do
      wait "$pid" || failed=1
    done
    pids=()
  fi
done

for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done

if [ "$failed" -ne 0 ]; then
  echo "至少一段转录失败" >&2
  exit 1
fi

echo "全部转录完成: $OUTPUT_ROOT"
