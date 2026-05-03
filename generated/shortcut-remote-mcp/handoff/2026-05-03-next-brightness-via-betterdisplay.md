# Next task — Wheel binding for brightness via BetterDisplay CLI

## Goal

Bind the XP-Pen Shortcut Remote's wheel so each CW/CCW tick adjusts screen brightness (of whatever display the cursor is on) by 5%, with the same Tink-tick audio feedback the volume binding has. Reachable through the AI loop, so the user can say *"set the wheel to control brightness"* via K11 and Claude reconfigures it without hand-edits.

## State you're inheriting

- **`betterdisplaycli` is installed** at `/opt/homebrew/bin/betterdisplaycli` (Homebrew formula `waydabber/betterdisplay/betterdisplaycli`, version 1.0.1). Verified working via `betterdisplaycli get -displayWithMainStatus -brightness` returning a float (e.g. `0.938`).
- **CLI integration is enabled** in BetterDisplay's settings (the user toggled this on). Other integrations (URL scheme, HTTP server, OSD broadcast) are intentionally OFF — CLI-only is enough.
- **No security token** configured — local CLI calls don't need one.
- The wheel is currently bound to `Volume + Tink (no overlap)`. After the brightness work is done, this binding will be replaced. Confirm with `mcpaql_read get_wheel_binding` before changing anything.
- BetterDisplay version is 4.2.3 (build 48120). Help dump is in this folder if you want it: run `betterdisplaycli help` to see ops/parameters.

## Plan

### Step 1 — write `tools/wheel-brightness-step.sh`

A small shell wrapper that takes one arg (`up` | `down`), calls betterdisplaycli with the brightness offset, and plays Tink with the same anti-overlap pattern as volume. Place it next to `tools/k11-voice-trigger.sh`.

```bash
#!/usr/bin/env bash
# Adjust brightness of the display under the mouse by ±5%, with Tink audio
# feedback. Used as a wheel binding action: { command: <this script>, args: ["up"|"down"] }.
set -u
DIR="${1:-up}"
STEP="${BR_STEP:-5%}"
case "$DIR" in
  up)   OFFSET="$STEP"   ;;
  down) OFFSET="-$STEP"  ;;
  *)    exit 2 ;;
esac
/opt/homebrew/bin/betterdisplaycli set -displayWithMouse -brightness="$OFFSET" -offset 2>/dev/null || true
/usr/bin/killall afplay 2>/dev/null
/usr/bin/afplay /System/Library/Sounds/Tink.aiff > /dev/null 2>&1 &
```

`chmod +x` it after writing.

**Note on display targeting:** `-displayWithMouse` is the user's preferred target for a knob-feel — turn the wheel while looking at the display you want dimmed. Alternatives if that doesn't feel right:
- `-displayWithMainStatus` (always the main display)
- `-displayWithFocus` (the display with the focused window)
- `-name=<DisplayName>` (specific display)

The user has multiple displays. Verify which behaviour they want; default to mouse for now.

### Step 2 — set the wheel binding via MCP

Use the existing `set_wheel_binding` op with the `command` action shape:

```js
{
  "binding": {
    "label": "Brightness ±5% (BetterDisplay)",
    "cw":  { "command": "/Users/mick/Developer/Organizations/MCPAQL/examples/generated/shortcut-remote-mcp/tools/wheel-brightness-step.sh", "args": ["up"],   "label": "Brightness +5%" },
    "ccw": { "command": "/Users/mick/Developer/Organizations/MCPAQL/examples/generated/shortcut-remote-mcp/tools/wheel-brightness-step.sh", "args": ["down"], "label": "Brightness -5%" }
  },
  "source": "manual" // or "voice-handoff" if using the voice loop
}
```

You can do this two ways:

**(a) Direct MCP call from your session.** Open an MCP session against `http://127.0.0.1:47832/mcp`, init, then `tools/call mcpaql_update set_wheel_binding`. There's an example flow in the previous session's bash logs — see `triggerVoiceCommand` and the `set_wheel_binding` schema in `adapter/src/schema.json`.

**(b) Through the voice loop.** Press K11 on the device, say *"set the wheel to control brightness on the display under my mouse, in 5% steps, with the Tink sound"*, stop. Watch for the `[sw-watch] new transcript`, `[voice] received`, `[voice] claude exit 0` lines in `/tmp/shortcut-remote-mcp.err.log`. Then `mcpaql_read get_wheel_binding` to confirm. **Bonus:** you'll be exercising the full voice loop end-to-end and confirming it still works after the brightness binding lands. If Claude gets it slightly wrong (e.g., uses AppleScript shape with `key code 144` because that's still in its system prompt), tell it more directly via voice or fall back to (a).

### Step 3 — test

1. Spin the wheel CW: brightness goes up, Tink plays. Spin CCW: brightness goes down, Tink plays.
2. Spin fast: Tink ticks should not overlap (`killall afplay` cuts the previous one).
3. Move the mouse to a different display, spin: that display's brightness should change, not the original.
4. Brightness should clamp at 0% / 100% (BetterDisplay handles this).

### Step 4 — update README

The brightness binding via shell-wrapper is a nice second example after volume-via-AppleScript. Add a short section to `README.md` showing the wrapper script + example MCP call, alongside the existing voice-control section. Optional but useful for future readers.

## Things to think about

### Should the brightness step be configurable?

Right now `BR_STEP` defaults to 5%. If we expose an MCP op like `set_wheel_brightness_step` we'd let the LLM tune it via voice ("make it finer, 2% steps"). Possibly out of scope; first pass keeps it as an env var on the script.

### Should the system prompt teach Claude about BetterDisplay?

Currently `VOICE_SYSTEM_PROMPT` in `server.js` lists AppleScript recipes for volume / mute / music transport but doesn't mention BetterDisplay. After this binding lands, consider adding a recipe block:

```
- Brightness (any display, requires betterdisplaycli installed):
  shell: betterdisplaycli set -displayWithMouse -brightness=<±step>% -offset
  Use action shape: { command: "<path>/wheel-brightness-step.sh", args: ["up"|"down"] }
```

That way Claude can rebind brightness via voice in future sessions without the user re-explaining.

### Claude won't already know about `wheel-brightness-step.sh`

The system prompt isn't going to know the wrapper's path until you tell it. For Step 2(b) the voice command should either point at the script directly or fall back to inline AppleScript-via-shell-out. Easiest: have the LLM use the `command` shape with the absolute path; tell it the path in the voice command if needed.

## Sanity-check commands for the new session

```bash
# Adapter is up and serving
launchctl print gui/$UID/org.mcpaql.shortcut-remote | grep -E "state|pid"

# BetterDisplay CLI is reachable
betterdisplaycli get -displayWithMouse -brightness

# Current wheel binding
curl -sS -X POST http://127.0.0.1:47832/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0.0.1"}}}' \
  -i > /tmp/init.txt
SID=$(grep -i "^mcp-session-id:" /tmp/init.txt | awk '{print $2}' | tr -d '\r\n')
curl -sS -X POST http://127.0.0.1:47832/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
curl -sS -X POST http://127.0.0.1:47832/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mcpaql_read","arguments":{"operation":"get_wheel_binding"}}}'
```

## Estimated time

15–30 minutes for an experienced session — write the wrapper, test it, set the binding via MCP, verify with the wheel. Plus 10 more if you also do the system-prompt update so Claude can rebind brightness via voice in the future.
