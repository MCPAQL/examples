#!/usr/bin/env bash
# K11 voice-command trigger — start/stop toggle.
#
# - First press (no lock): save current SuperWhisper mode, switch to the
#   "Shortcut Remote command" mode, start recording, drop lock file.
# - Second press (lock present + recent): synthesize the SuperWhisper
#   toggleRecording hotkey (default Opt+Cmd+3) to stop the in-progress
#   recording. SuperWhisper then transcribes and runs the mode script,
#   which curl-POSTs to /voice-command and restores the prev mode.

set -u

OUR_MODE_KEY="${SR_VOICE_MODE_KEY:-custom}"
PREV_FILE="${SR_PREV_MODE_FILE:-/tmp/sr-prev-mode}"
LOCK_FILE="${SR_LOCK_FILE:-/tmp/sr-voice-recording}"
LOCK_TTL="${SR_LOCK_TTL:-60}"
TOGGLE_KEYCODE="${SR_TOGGLE_KEYCODE:-20}"
TOGGLE_MODIFIERS="${SR_TOGGLE_MODIFIERS:-option down, command down}"
LOG="/tmp/sr-k11.log"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"; }

log "K11 helper invoked (pid=$$, ppid=$PPID)"
log "  PATH=$PATH"
log "  SHELL=${SHELL:-?}  HOME=${HOME:-?}"

if [ -f "$LOCK_FILE" ]; then
  AGE=$(($(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0)))
  if [ "$AGE" -lt "$LOCK_TTL" ]; then
    log "lock present (age=${AGE}s) → toggle stop via osascript"
    /usr/bin/osascript -e "tell application \"System Events\" to key code ${TOGGLE_KEYCODE} using {${TOGGLE_MODIFIERS}}" >> "$LOG" 2>&1
    /bin/rm -f "$LOCK_FILE"
    log "stop sent, lock cleared, exit"
    exit 0
  fi
  log "stale lock (age=${AGE}s) → removing"
  /bin/rm -f "$LOCK_FILE"
fi

log "no lock → starting voice command flow"

CURRENT="$(/usr/bin/defaults read com.superduper.superwhisper activeModeKey 2>/dev/null || true)"
log "current SuperWhisper mode: ${CURRENT:-<none>}"

if [ -n "${CURRENT:-}" ] && [ "$CURRENT" != "$OUR_MODE_KEY" ]; then
  printf '%s\n' "$CURRENT" > "$PREV_FILE"
  log "saved prev mode '$CURRENT' to $PREV_FILE"
fi

log "open superwhisper://mode?key=${OUR_MODE_KEY}"
/usr/bin/open "superwhisper://mode?key=${OUR_MODE_KEY}" >> "$LOG" 2>&1
OPEN1=$?
log "  open exited with $OPEN1"

/bin/sleep 0.2

log "open superwhisper://record"
/usr/bin/open "superwhisper://record" >> "$LOG" 2>&1
OPEN2=$?
log "  open exited with $OPEN2"

/usr/bin/touch "$LOCK_FILE"
log "lock file created at $LOCK_FILE"
log "K11 helper done"
