#!/usr/bin/env bash
set -euo pipefail

# Stop only the Shortcut Remote MCP adapter by default. The adapter is the
# process that opens the XP-Pen/Hanvon Ugee vendor HID page and can prevent the
# XP-Pen production controller from seeing the device.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SHORTCUT_REMOTE_MCP_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ADAPTER_DIR="$ROOT_DIR/adapter"
ADAPTER_SCRIPT="$ADAPTER_DIR/src/server.js"
SIDECAR_DIR="$ROOT_DIR/sidecar"
SIDECAR_SCRIPT="$SIDECAR_DIR/index.js"
HUD_PORT="${SHORTCUT_REMOTE_HUD_PORT:-47832}"

include_sidecar=0
force=0
quiet=0
status_only=0
watch=0
interval=2

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Gracefully stops the Shortcut Remote MCP adapter and releases the HID handle.

Options:
  --status           Print current adapter/sidecar status only.
  --include-sidecar  Also stop shortcut-remote-mcp/sidecar/index.js.
  --force            Escalate to SIGKILL if SIGTERM does not exit in time.
  --watch            Keep running and stop matching adapter processes as they appear.
  --interval N       Watch interval in seconds. Default: 2.
  --quiet            Suppress normal output.
  --help             Show this help.

Default target:
  $ADAPTER_SCRIPT
EOF
}

while (($#)); do
  case "$1" in
    --status) status_only=1 ;;
    --include-sidecar|--all) include_sidecar=1 ;;
    --force) force=1 ;;
    --watch|--keep-dead) watch=1 ;;
    --interval)
      shift
      interval="${1:-2}"
      ;;
    --quiet) quiet=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  if [[ "$quiet" != "1" ]]; then
    printf '%s\n' "$*"
  fi
}

is_number() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

pid_exists() {
  /bin/ps -p "$1" >/dev/null 2>&1
}

pid_command() {
  /bin/ps -p "$1" -o command= 2>/dev/null || true
}

pid_cwd() {
  /usr/sbin/lsof -a -p "$1" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p' | /usr/bin/head -n 1 || true
}

pid_files() {
  /usr/sbin/lsof -p "$1" -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p' || true
}

is_adapter_pid() {
  local pid="$1" cmd cwd files
  is_number "$pid" || return 1
  [[ "$pid" != "$$" ]] || return 1
  pid_exists "$pid" || return 1

  cmd="$(pid_command "$pid")"
  cwd="$(pid_cwd "$pid")"

  if [[ "$cmd" == *"$ADAPTER_SCRIPT"* ]]; then
    return 0
  fi

  if [[ "$cwd" == "$ADAPTER_DIR" && "$cmd" == *"node"* && "$cmd" == *"src/server.js"* ]]; then
    return 0
  fi

  files="$(pid_files "$pid")"
  if [[ "$cmd" == *"node"* && "$files" == *"$ADAPTER_DIR"* && "$files" == *"node-hid"* ]]; then
    return 0
  fi

  if [[ "$cmd" == *"node"* && "$files" == *"$ADAPTER_DIR"* && "$files" == *"/private/tmp/keypad-adapter.log"* ]]; then
    return 0
  fi

  return 1
}

is_sidecar_pid() {
  local pid="$1" cmd cwd
  is_number "$pid" || return 1
  [[ "$pid" != "$$" ]] || return 1
  pid_exists "$pid" || return 1

  cmd="$(pid_command "$pid")"
  cwd="$(pid_cwd "$pid")"

  if [[ "$cmd" == *"$SIDECAR_SCRIPT"* ]]; then
    return 0
  fi

  if [[ "$cwd" == "$SIDECAR_DIR" && "$cmd" == *"node"* && "$cmd" == *"index.js"* ]]; then
    return 0
  fi

  return 1
}

candidate_pids() {
  {
    if is_number "$HUD_PORT" && [[ "$HUD_PORT" != "0" ]]; then
      /usr/sbin/lsof -nP -tiTCP:"$HUD_PORT" -sTCP:LISTEN 2>/dev/null || true
    fi
    /usr/bin/pgrep -f "$ADAPTER_SCRIPT" 2>/dev/null || true
    /usr/bin/pgrep -f 'node[[:space:]]+src/server\.js' 2>/dev/null || true
    /usr/bin/pgrep -f 'src/server\.js' 2>/dev/null || true
    /usr/bin/pgrep -f 'keypad-adapter|generated-shortcut-remote|shortcut-remote-mcp' 2>/dev/null || true
  } | /usr/bin/sort -u
}

adapter_pids() {
  local pid
  while IFS= read -r pid; do
    if is_adapter_pid "$pid"; then
      printf '%s\n' "$pid"
    fi
  done < <(candidate_pids)
}

sidecar_pids() {
  local pid
  while IFS= read -r pid; do
    if is_sidecar_pid "$pid"; then
      printf '%s\n' "$pid"
    fi
  done < <(candidate_pids)
}

join_pids() {
  /usr/bin/paste -sd, - 2>/dev/null || true
}

print_status() {
  local adapters sidecars
  adapters="$(adapter_pids | join_pids)"
  sidecars="$(sidecar_pids | join_pids)"

  if [[ -n "$adapters" ]]; then
    echo "Adapter: running ($adapters)"
  else
    echo "Adapter: stopped"
  fi

  if [[ -n "$sidecars" ]]; then
    echo "Sidecar: running ($sidecars)"
  else
    echo "Sidecar: stopped"
  fi

  if is_number "$HUD_PORT" && [[ "$HUD_PORT" != "0" ]]; then
    if /usr/sbin/lsof -nP -iTCP:"$HUD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "HUD port $HUD_PORT: in use"
    else
      echo "HUD port $HUD_PORT: free"
    fi
  fi
}

wait_for_exit() {
  local pid="$1" tries=50
  while ((tries > 0)); do
    if ! pid_exists "$pid"; then
      return 0
    fi
    /bin/sleep 0.1
    tries=$((tries - 1))
  done
  return 1
}

stop_pid() {
  local pid="$1" label="$2" cmd
  pid_exists "$pid" || return 0
  cmd="$(pid_command "$pid")"
  log "Sending SIGTERM to $label PID $pid"
  log "  $cmd"
  /bin/kill -TERM "$pid" 2>/dev/null || true
  if wait_for_exit "$pid"; then
    log "$label PID $pid stopped"
    return 0
  fi
  if [[ "$force" == "1" ]]; then
    log "$label PID $pid did not exit after SIGTERM; sending SIGKILL"
    /bin/kill -KILL "$pid" 2>/dev/null || true
    wait_for_exit "$pid" || return 1
    log "$label PID $pid stopped"
    return 0
  fi
  log "$label PID $pid is still running; rerun with --force if needed"
  return 1
}

stop_once() {
  local found=0 failed=0 pid

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    found=1
    stop_pid "$pid" "adapter" || failed=1
  done < <(adapter_pids)

  if [[ "$include_sidecar" == "1" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      found=1
      stop_pid "$pid" "sidecar" || failed=1
    done < <(sidecar_pids)
  fi

  if [[ "$found" == "0" ]]; then
    log "No Shortcut Remote MCP adapter process found."
  fi

  return "$failed"
}

if [[ "$status_only" == "1" ]]; then
  print_status
  exit 0
fi

if [[ "$watch" == "1" ]]; then
  log "Keeping Shortcut Remote MCP adapter stopped. Press Ctrl+C to quit."
  while true; do
    stop_once || true
    /bin/sleep "$interval"
  done
fi

stop_once
