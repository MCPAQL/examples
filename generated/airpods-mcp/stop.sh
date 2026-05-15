#!/usr/bin/env bash
# Tear down the airpods-mcp stack. Leaves the motion source .app alone (lightweight; restarts are slow).
set -euo pipefail

# Kill the process recorded in $file only if it is still alive AND its command
# line matches $pattern for this component. Without the identity check, a stale
# PID file whose PID the OS has since recycled to an unrelated process would be
# SIGTERM'd — stopping something the user did not start. If identity can't be
# confirmed, the PID file is treated as stale: removed, not acted on.
stop_pid_file() {
  local label=$1 file=$2 pattern=$3
  if [[ ! -f "$file" ]]; then
    echo "$label: no pid file"
    return
  fi
  local p
  p=$(cat "$file" 2>/dev/null || echo "")
  if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then
    local cmd
    cmd=$(ps -p "$p" -o command= 2>/dev/null || echo "")
    if [[ "$cmd" == *"$pattern"* ]]; then
      kill "$p" 2>/dev/null || true
      echo "$label: stopped (pid $p)"
    else
      echo "$label: pid $p does not look like $label (reused PID / stale file) — NOT killing"
    fi
  else
    echo "$label: not running"
  fi
  rm -f "$file"
}

stop_pid_file "sidecar"      /tmp/airpods-sidecar.pid "sidecar/index.js"
stop_pid_file "adapter"      /tmp/airpods-adapter.pid "src/server.js"
stop_pid_file "audio keeper" /tmp/airpods-keeper.pid  "/tmp/silent.wav"

# Optional: also stop motion source — uncomment if desired
# pkill -f airpods-mcp-server && echo "motion source: stopped"

echo ""
echo "Sidecar/adapter/keeper down. Motion source left running (lightweight)."
echo "To stop motion source too: pkill -f airpods-mcp-server"
