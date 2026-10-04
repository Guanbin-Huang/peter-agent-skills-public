#!/bin/bash
# 用法: serve_preview_review.sh <review_dir> <preview_video> <server_js> [port|auto]
# SERVE_PREVIEW_REVIEW_NO_SPAWN=1 时只生成启动脚本，不自动开 Terminal。

set -e

guard_review_dir() {
  # Read only: callback publicStatus() is deliberately not used because it writes.
  python3 - "$1" <<'PY'
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
def fail(code):
    print(f"❌ 批注目录启动检查失败：{code}；保留现有进程、配置和批注。", file=sys.stderr)
    raise SystemExit(1)

if not root.is_dir():
    fail('REVIEW_DIR_MISSING')
pid_file = root / '.preview_review_server.pid'
if pid_file.exists() or pid_file.is_symlink():
    try:
        raw = pid_file.read_text().strip()
        if not raw.isascii() or not raw.isdecimal() or int(raw) <= 0:
            fail('SERVER_PID_INVALID')
        pid = int(raw)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pass  # A proven stale PID does not block; do not delete its file.
        except PermissionError:
            fail('SERVER_PID_ALIVE_OR_UNVERIFIABLE')
        else:
            # A reused PID still fails closed: never guess its ownership or kill it.
            fail('SERVER_PID_ALIVE_OR_REUSED')
    except (OSError, ValueError, OverflowError):
        fail('SERVER_PID_UNVERIFIABLE')

status_file = root / 'codex_callback_status.json'
if status_file.exists() or status_file.is_symlink():
    try:
        status = json.loads(status_file.read_text())
        state = status.get('state') if isinstance(status, dict) else None
    except (OSError, ValueError):
        fail('CALLBACK_STATUS_UNREADABLE')
    if state in ('queued', 'running'):
        fail('CALLBACK_ACTIVE')  # queued may have no PID yet; state alone blocks.
    if state not in ('idle', 'completed', 'failed'):
        fail('CALLBACK_STATUS_UNKNOWN')
PY
}

# Generated launchers recheck immediately before starting, not only at generation.
if [ "${1:-}" = "--check-review-idle" ]; then
  guard_review_dir "${2:-}"
  exit $?
fi

REVIEW_DIR="$1"
VIDEO="$2"
SERVER_JS="$3"
WANT_PORT="${4:-auto}"

[ -d "$REVIEW_DIR" ] || { echo "❌ 批注目录不存在: $REVIEW_DIR"; exit 1; }
[ -f "$VIDEO" ] || { echo "❌ Preview 视频不存在: $VIDEO"; exit 1; }
[ -f "$SERVER_JS" ] || { echo "❌ 批注服务器不存在: $SERVER_JS"; exit 1; }
guard_review_dir "$REVIEW_DIR"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "❌ 找不到 node"; exit 1; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if [ "$WANT_PORT" = "auto" ]; then
  PORT=""
  for p in $(seq 8910 8999); do port_busy "$p" || { PORT="$p"; break; }; done
  [ -n "$PORT" ] || { echo "❌ 端口 8910-8999 都被占用"; exit 1; }
else
  PORT="$WANT_PORT"
  if port_busy "$PORT"; then
    echo "❌ 指定端口已有服务；保留原服务，请使用 auto 或空闲端口。"
    exit 1
  fi
fi
URL="http://localhost:$PORT"

case "$(uname -s)" in
  Darwin) LAUNCHER="$REVIEW_DIR/启动Preview批注.command" ;;
  *) LAUNCHER="$REVIEW_DIR/启动Preview批注.sh" ;;
esac
{
  printf '%s\n' '#!/bin/bash'
  printf '%s\n' '# 双击本文件即可启动 Preview 批注网址；批注完成后可关闭这个终端窗口。'
  printf 'bash %q --check-review-idle %q || exit 1\n' "$SELF" "$REVIEW_DIR"
  printf 'cd "%s" || exit 1\n' "$REVIEW_DIR"
  printf 'exec "%s" "%s" %s "%s"\n' "$NODE_BIN" "$SERVER_JS" "$PORT" "$VIDEO"
} > "$LAUNCHER"
chmod +x "$LAUNCHER"

SPAWNED=0
if [ -z "$SERVE_PREVIEW_REVIEW_NO_SPAWN" ]; then
  case "$(uname -s)" in
    Darwin) open "$LAUNCHER" && SPAWNED=1 ;;
    Linux)
      for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
        command -v "$t" >/dev/null 2>&1 || continue
        setsid "$t" -e bash "$LAUNCHER" >/dev/null 2>&1 && { SPAWNED=1; break; }
      done
      ;;
  esac
fi

READY=0
if [ "$SPAWNED" = 1 ]; then
  for _ in $(seq 1 20); do
    sleep 0.4
    if curl -fsS --max-time 1 "$URL/api/config" -o /dev/null 2>&1; then READY=1; break; fi
  done
fi

if [ "$READY" = 1 ]; then
  # A healthy config endpoint can belong to an old process serving another MP4.
  # Only the actual served bytes and a functioning Range seek prove readiness.
  VERIFY_SCRIPT="$(dirname "$SERVER_JS")/verify_served_media.py"
  python3 "$VERIFY_SCRIPT" --video "$VIDEO" --url "$URL/video" \
    --report "$REVIEW_DIR/served_media_verification.json" || {
      echo "❌ 实际播放文件验收失败；未宣布交付，保留既有服务和批注。"
      exit 1
    }
  echo "✅ Preview 批注网址已启动: $URL"
  open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true
  echo "   下次重启：双击 $LAUNCHER"
else
  echo "⚠️ 未自动打开，请在终端运行并保持窗口开启："
  echo "   bash \"$LAUNCHER\""
  echo "   然后访问 $URL"
fi
