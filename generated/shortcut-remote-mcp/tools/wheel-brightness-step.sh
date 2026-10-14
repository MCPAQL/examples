#!/usr/bin/env bash
# Adjust brightness of the display under the mouse by +/- BR_STEP (default 5%),
# with Tink audio feedback ONLY on success. Used as a wheel binding action shape:
#   { command: <this script>, args: ["up"|"down"] }
#
# Failure-handling rationale: if BetterDisplay is unreachable we want SILENCE,
# not a Tink. A beep with no brightness change is a confusing signal — and worse,
# fast wheel-spam against a wedged BetterDisplay piles up afplay invocations
# that keep ticking after the user stops spinning. Silence + a log line is the
# right failure mode (lesson from 2026-05-03 incident — BetterDisplay had
# crashed, every CLI call hung for 5s, the wheel became a beep machine).

set -u

BD="${BD_CLI:-/opt/homebrew/bin/betterdisplaycli}"
BD_APP="${BD_APP:-/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay}"
DIR="${1:-up}"
STEP="${BR_STEP:-5%}"
TARGET="${BR_TARGET:--displayWithMouse}"
CALL_TIMEOUT="${BR_CALL_TIMEOUT:-2}"
LOG="/tmp/sr-brightness.log"

case "$DIR" in
  up)   OFFSET="$STEP"   ;;
  down) OFFSET="-$STEP"  ;;
  *)    printf 'usage: %s up|down\n' "$0" >&2; exit 2 ;;
esac

ts() { date '+%H:%M:%S'; }

# Fast precheck: if BetterDisplay isn't running, skip the CLI call entirely.
# Avoids a multi-second IPC timeout per wheel tick when the app has crashed.
if ! /usr/bin/pgrep -qf "$BD_APP"; then
  printf '[%s] skipped: BetterDisplay not running\n' "$(ts)" >> "$LOG"
  exit 0
fi

# Time-bound the CLI call so a wedged-but-running BetterDisplay cannot pile
# up backlog. macOS ships no GNU timeout(1); perl alarm survives exec.
/usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' \
  "$CALL_TIMEOUT" "$BD" set "$TARGET" -brightness="$OFFSET" -offset \
  >> "$LOG" 2>&1
RC=$?

if [ "$RC" -ne 0 ]; then
  printf '[%s] betterdisplaycli failed (rc=%d, offset=%s) — no Tink\n' "$(ts)" "$RC" "$OFFSET" >> "$LOG"
  exit 0
fi

/usr/bin/killall afplay 2>/dev/null
/usr/bin/afplay /System/Library/Sounds/Tink.aiff > /dev/null 2>&1 &
