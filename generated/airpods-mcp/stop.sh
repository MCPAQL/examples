#!/usr/bin/env bash
# Tear down the airpods-mcp stack. Leaves the motion source .app alone (lightweight; restarts are slow).
set -euo pipefail

stop_pid_file() {
  local label=$1 file=$2
  if [[ -f "$file" ]]; then
    local p
    p=$(cat "$file" 2>/dev/null || echo "")
    if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then
      kill "$p" 2>/dev/null || true
      echo "$label: stopped (pid $p)"
    else
      echo "$label: not running"
    fi
    rm -f "$file"
  else
    echo "$label: no pid file"
  fi
}

stop_pid_file "sidecar"      /tmp/airpods-sidecar.pid
stop_pid_file "adapter"      /tmp/airpods-adapter.pid
stop_pid_file "audio keeper" /tmp/airpods-keeper.pid

# Optional: also stop motion source — uncomment if desired
# pkill -f airpods-mcp-server && echo "motion source: stopped"

echo ""
echo "Sidecar/adapter/keeper down. Motion source left running (lightweight)."
echo "To stop motion source too: pkill -f airpods-mcp-server"
