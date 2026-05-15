#!/usr/bin/env bash
# Bring up the full airpods-mcp stack with one command.
#
# Components started:
#   1. Audio keeper (silent WAV loop) — required for AirPods motion stream
#   2. Motion source .app (Swift, CMHeadphoneMotionManager) — opened via LaunchServices
#   3. MCP-AQL adapter (Node) — stdio MCP + HUD HTTP/WS on 47834
#   4. Sample sidecar (Node) — consumes HUD WebSocket; gaze-driven focus + dwell blob
#
# Idempotent — re-running won't double-spawn anything.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

is_alive() { local p=$1; [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; }
read_pid() { local f=$1; [[ -f "$f" ]] && cat "$f" 2>/dev/null || true; }

# 1. Audio keeper
KEEPER_PID_FILE=/tmp/airpods-keeper.pid
KEEPER_PID=$(read_pid "$KEEPER_PID_FILE")
if is_alive "$KEEPER_PID"; then
  echo "audio keeper: already running (pid $KEEPER_PID)"
else
  if [[ ! -f /tmp/silent.wav ]]; then
    python3 -c "import struct;sr=44100;d=b'\x00'*(sr*2);open('/tmp/silent.wav','wb').write(b'RIFF'+struct.pack('<I',36+len(d))+b'WAVE'+b'fmt '+struct.pack('<IHHIIHH',16,1,1,sr,sr*2,2,16)+b'data'+struct.pack('<I',len(d))+d)"
  fi
  # bash -c (not a bare subshell): the tracked PID is then a process whose
  # `ps -o command=` contains "/tmp/silent.wav", so stop.sh can verify
  # identity before killing and won't SIGTERM a recycled PID.
  bash -c 'while true; do afplay -v 0.001 /tmp/silent.wav; done' > /dev/null 2>&1 &
  KEEPER_PID=$!
  disown
  echo "$KEEPER_PID" > "$KEEPER_PID_FILE"
  echo "audio keeper: started (pid $KEEPER_PID)"
fi

# 2. Motion source .app
if ! pgrep -fl airpods-mcp-server > /dev/null; then
  open "$HERE/server/airpods-mcp-server.app"
  sleep 0.5
  echo "motion source: launched via open"
else
  echo "motion source: already running"
fi

# 3. Adapter
ADAPTER_PID_FILE=/tmp/airpods-adapter.pid
ADAPTER_PID=$(read_pid "$ADAPTER_PID_FILE")
if is_alive "$ADAPTER_PID"; then
  echo "adapter: already running (pid $ADAPTER_PID)"
else
  # Subshell scopes the cd; exec replaces the subshell with node so $! in the
  # parent (and thus disown) targets the node process, not the subshell.
  # Backgrounding here (not inside the subshell) matches the keeper and sidecar
  # blocks above/below.
  ( cd "$HERE/adapter" && exec nohup node src/server.js > /tmp/airpods-adapter.log 2>&1 < /dev/null ) &
  ADAPTER_PID=$!
  disown
  echo "$ADAPTER_PID" > "$ADAPTER_PID_FILE"
  echo "adapter: started (pid $ADAPTER_PID)"
fi

# Wait for adapter HUD to be reachable
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:47834/health > /dev/null 2>&1; then break; fi
  sleep 0.2
done
# If the adapter never came up, the sidecar will still "start" but then spin in
# a reconnect loop against a dead HUD. Point the user at the real error.
if ! curl -fsS http://127.0.0.1:47834/health > /dev/null 2>&1; then
  echo "WARNING: adapter did not become healthy in ~4s — check /tmp/airpods-adapter.log"
fi

# 4. Sidecar
SIDECAR_PID_FILE=/tmp/airpods-sidecar.pid
SIDECAR_PID=$(read_pid "$SIDECAR_PID_FILE")
if is_alive "$SIDECAR_PID"; then
  echo "sidecar: already running (pid $SIDECAR_PID)"
else
  BLOB_FOLLOW=1 nohup node "$HERE/sidecar/index.js" > /tmp/airpods-sidecar.log 2>&1 < /dev/null &
  SIDECAR_PID=$!
  disown
  echo "$SIDECAR_PID" > "$SIDECAR_PID_FILE"
  echo "sidecar: started (pid $SIDECAR_PID)"
fi

echo ""
echo "Stack up. HUD: http://127.0.0.1:47834/"
echo "Tail logs: tail -f /tmp/airpods-{adapter,sidecar}.log"
echo "Stop: ./stop.sh"
