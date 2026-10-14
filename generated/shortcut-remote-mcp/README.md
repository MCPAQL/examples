# Shortcut Remote — JIT MCP-AQL Adapter

A working, just-in-time-discovered MCP-AQL adapter for the **XP-Pen Shortcut Remote** (Hanvon Ugee, USB `0x28bd:0x0202`, internal model code `ACK05`).

Built end-to-end in a single session — observational HID discovery, generated CRUDE adapter, live HUD, sidecar for keystroke passthrough — with **no vendor SDK, no kernel extension, and no published protocol documentation**. This is the reference implementation of the JIT pattern for the long tail of programmable input hardware.

---

## What it proves

The adapter generator pattern in `MCPAQL/adapter-generator/` was originally designed for wrapping existing MCP servers. This project demonstrates that the same `DiscoveryBundle` substrate works for **observational discovery against undocumented hardware** — recording raw HID input reports while a user presses each button, then mechanically deriving the byte layout to emit a CRUDE adapter.

The deeper claim: **any HID input device can become a context-aware programmable surface** through a uniform three-layer pattern.

---

## Architecture

The adapter is **one long-lived launchd-managed process** that does five things from a single port (127.0.0.1:47832):

```
Hardware                                            ←  XP-Pen Shortcut Remote
  ↓ raw HID reports (vendor page 0xFF0A, kept exclusive)
═════════════════════════════════════════════════════════════════
adapter/src/server.js  (one process, port 47832)
  ├── HID observer            → decodes button + wheel + battery reports
  ├── Layer state machine     → K2 advances; broadcast as `layer_change`
  ├── Wheel state             → CW/CCW ticks, broadcast as `wheel_state`
  ├── Keystroke + shell       → osascript synth (K3-K6, K9-K11 per layer);
  │  dispatcher               │ K1=open HUD, K7=SuperWhisper, K8=Escape are
  │                           │ hardwired across all layers
  ├── HUD HTTP server         → GET /          → live keypad page
  │                           → GET /events    → WS broadcast
  │                           → POST /control/{restart,stop,disable}
  └── MCP-AQL endpoint        → POST /mcp (streamable HTTP, stateful sessions)
═════════════════════════════════════════════════════════════════
              ↓ WS broadcast              ↓ MCP
        Live HUD (browser tab)     Claude Code, etc.
                                       │
                                       └──→ post_annotation broadcasts back
                                            into the WS so the HUD shows
                                            the LLM's interpretation in
                                            real time. Wheel + K11 are
                                            reserved as the AI input surface.
```

**Why one process for everything?** Because the HID handle is a process-wide singleton (exclusive seize), and the WebSocket / HUD HTML / MCP endpoint all need to broadcast the same events to multiple consumers. Splitting them just means a fan-out, never independent state.

**Where the LLM fits (still mostly open).** The wheel + K11 emit `wheel_state` events but never synthesize keystrokes. MCP clients can read them and post `annotation` payloads back via `post_annotation` — those land in the HUD's "AI Dial" overlay so the user sees what the model thinks the wheel currently means. The first concrete use case planned is a smart-paste-with-wheel-formality binding on Layer III.

---

## Discovery method (observational HID)

The XP-Pen Shortcut Remote ships with a Mac app and driver. The buttons are mapped via XP-Pen's userspace daemon to keystrokes (Ctrl+Z, Cmd+S, etc.), which are then injected into the macOS event queue. **No public protocol exists for the device's vendor page**, the configuration UI is closed, and the actual byte layout of the vendor reports is not documented.

The discovery process used here:

1. **Enumerate** matching HID devices via `node-hid` (`tools/capture-hid.js`).
2. **Filter** to vendor-defined pages only (`usagePage >= 0xFF00`) so opening doesn't seize the OS-level keyboard interface.
3. **Capture** raw input reports while a human presses every button and rotates the wheel.
4. **Mechanically derive** byte layout by counting unique payloads and which bits change with which physical action.

The captured raw reports live at `capture/raw-reports.jsonl` (235 events). Derived structure:

| Byte | Field |
|---|---|
| 0 | Report ID (always `0x02`) |
| 1 | Report type (`0xf0` = button/wheel, `0xf2` = battery heartbeat) |
| 2 | Primary button bitmap (8 bits) |
| 3 | Secondary button bitmap (3 bits observed) |
| 4–6 | Reserved / zero |
| 7 | Wheel direction (`0x01` = CW, `0x02` = CCW) |
| 8–11 | Reserved / zero |

K# (XP-Pen's labels) → bit mapping, verified live:

- K1–K8 = primary bits 0–7
- K9, K10 = secondary bits 0, 1
- K11 (wheel-center button) = secondary bit 2

---

## Directory layout

```
shortcut-remote-mcp/
├── README.md                          ← this file
├── capture/
│   ├── capture.log                    ← stderr from the capture run
│   ├── raw-reports.jsonl              ← 235 raw HID input reports
│   └── discovery-bundle.json          ← MCP-AQL DiscoveryBundle (low-confidence operations)
├── schema/                            ← reserved for canonical schema build output
├── adapter/
│   ├── package.json                   ← deps: @modelcontextprotocol/sdk, node-hid, ws
│   └── src/
│       ├── server.js                  ← THE adapter — HID + MCP-AQL + HUD + WS + control endpoints + keystroke synthesis
│       ├── schema.json                ← MCP-AQL schema (READ + UPDATE + DELETE endpoints)
│       ├── provenance.json            ← discovery provenance metadata
│       ├── hud.html                   ← live HUD page (hot-reloaded per HTTP request)
│       └── xppen-mappings.json        ← decoded XP-Pen Layer I-IV mappings (HUD reads via /xppen-mappings.json)
├── sidecar/                           ← RETIRED 2026-05-02 — synthesis was folded into adapter; left for git history reference
├── tools/
│   ├── capture-hid.js                 ← observational HID capture (with vendor-page-only safety filter)
│   ├── parse-xppen-config.js          ← parses ~/.xppen/config.xml → adapter/src/xppen-mappings.json
│   ├── kill-shortcut-remote-mcp.sh    ← terminal escape hatch when HUD is unreachable
│   └── package.json                   ← deps: node-hid
└── validation/
    ├── smoke-test.js                  ← end-to-end MCP handshake + introspection + listing
    └── press-listener.js              ← single-press capture via the running adapter
```

---

## Operations exposed by the adapter

Three MCP tools, ten READ + four UPDATE + one DELETE, plus introspection:

| Tool | Operation | Description |
|---|---|---|
| `mcpaql_read` | `introspect` | Discover available operations and their params at runtime |
| `mcpaql_read` | `list_devices` | Enumerate connected Shortcut Remote devices |
| `mcpaql_read` | `get_device_info` | Vendor info + inferred capabilities |
| `mcpaql_read` | `get_battery_status` | Latest battery percent + charging state |
| `mcpaql_read` | `get_button_state` | Currently-held buttons (latest snapshot) |
| `mcpaql_read` | `wait_for_button_press` | Block until next press (timeout configurable) |
| `mcpaql_read` | `get_recent_events` | Ring buffer of recent events (button + wheel + release + layer_change) |
| `mcpaql_read` | `is_device_open` | Whether the adapter is holding the vendor-page handle |
| `mcpaql_read` | `get_hud_url` | Returns the live-HUD URL (default `http://127.0.0.1:47832/`) |
| `mcpaql_read` | `get_current_layer` | Returns current layer (1..4) — adapter is the source of truth |
| `mcpaql_read` | `get_wheel_value` | Returns current wheel value (signed integer counter) |
| `mcpaql_update` | `set_current_layer` | Jump to a specific layer; broadcasts `layer_change` |
| `mcpaql_update` | `set_wheel_value` | Set wheel value (e.g. clamp, jump to preset) |
| `mcpaql_update` | `reset_wheel_value` | Reset wheel value to 0 |
| `mcpaql_update` | `post_annotation` | Broadcast a free-form payload to the HUD's AI overlay |
| `mcpaql_update` | `set_wheel_binding` | Bind the wheel to keystrokes (CW + CCW); pass null to clear back to AI mode |
| `mcpaql_update` | `submit_voice_command` | Submit a transcribed voice command — adapter spawns `claude -p` to interpret and reconfigure |
| `mcpaql_read`   | `get_wheel_binding` | Current wheel binding (null = AI mode) |
| `mcpaql_delete` | `release_device` | Hand the keypad back to XP-Pen daemon mid-session |

---

## Live HUD

The adapter starts an HTTP+WebSocket server on `127.0.0.1:47832` (configurable via `SHORTCUT_REMOTE_HUD_PORT`; set to `0` to disable). Open the URL in a browser tab to see:

- Visual keypad rendering matching the XP-Pen UI's layout (90° rotated)
- Each K# shows its label and human shortcut from your active XP-Pen layer
- Layer I / II / III / IV toggle (read-only preview of mappings)
- Live highlighting on press, fade on release
- Wheel CW / CCW counters
- Battery indicator
- Event log

The HUD reads `xppen-mappings.json` on load via `/xppen-mappings.json`, so any change to the JSON (or to `hud.html`) is picked up on browser refresh — no adapter restart needed.

---

## Layer behavior

The adapter owns layer state (1..4 = XP-Pen's I/II/III/IV) and dispatches keystrokes per layer. K1, K2, K7, K8, and K11 are special and consistent across all layers:

| Key | Behavior | Where it's defined |
|---|---|---|
| **K1** | Opens this HUD page (`/usr/bin/open` of the HUD URL) | hardwired in adapter |
| **K2** | Advances layer (forward cycle 1→2→3→4→1) | hardwired in adapter |
| **K7** | SuperWhisper (Opt+Cmd+3) | hardwired in adapter |
| **K8** | Escape | hardwired in adapter |
| **K11** + wheel | **AI input surface** — never synthesizes; broadcasts `wheel_state`; LLMs interpret via MCP and post back annotations to the HUD | adapter does no synthesis |
| K3–K6, K9, K10 | Per-layer keystroke from `xppen-mappings.json` if defined | per-layer |

If a per-layer slot has no binding, pressing it is a no-op (HUD lights up, nothing fires).

---

## Voice control (works from any app)

The adapter has a `/voice-command` POST endpoint. Any HTTP client can submit transcribed speech and the adapter will spawn `claude -p` (using your existing `~/.claude.json` auth + MCP setup) to interpret and reconfigure the keypad live. The HUD reflects the changes in real time as the LLM calls back through MCP.

Test it in the HUD's **AI Dial** panel — there's a text box that POSTs to `/voice-command`. Type *"set the wheel to volume up and volume down"* and watch the binding label flip and the wheel reconfigure.

### Wiring SuperWhisper for hands-free voice → reconfigure

SuperWhisper 2.10 has no per-mode hotkeys. Instead it has a `superwhisper://` URL scheme and a per-mode `script` field. Both are set up automatically:

- **Mode JSON** — `~/Documents/superwhisper/modes/custom.json` (key `custom`, name "Shortcut Remote command") has `scriptEnabled: true` and a `script` body that curl-POSTs the transcribed text (using `{{SW_USER_TRANSCRIPT}}` placeholder) to `http://127.0.0.1:47832/voice-command`. The script uses a single-quoted shell heredoc so any quotes in the transcript are preserved verbatim.
- **K11 trigger** — pressing K11 runs `/usr/bin/open 'superwhisper://mode?key=custom' && sleep 0.2 && /usr/bin/open 'superwhisper://record'`. SuperWhisper switches to the right mode, then begins recording. When you stop speaking, SuperWhisper transcribes, runs the script, posts to `/voice-command`, and the existing `claude -p` pipeline takes it from there.

If you ever need to recreate the SuperWhisper mode from scratch:

1. SuperWhisper → Settings → Modes → **+ New Custom Mode** (or pick any existing custom mode).
2. Name it whatever (e.g. "Shortcut Remote command"). Note the mode's `key` field — you'll find it in `~/Documents/superwhisper/modes/<key>.json`.
3. Open the JSON file, set `"scriptEnabled": true`, and replace the `"script"` field with:

   ```sh
   /usr/bin/curl -sS -X POST -H 'Content-Type: text/plain' --data-binary @- http://127.0.0.1:47832/voice-command <<'SUPERWHISPEREOF'
   {{SW_USER_TRANSCRIPT}}
   SUPERWHISPEREOF
   ```

4. If the key isn't `custom`, update `HARDWIRED_ACTIONS.K11` in `adapter/src/server.js` to use `superwhisper://mode?key=<your-key>`.

After that, the loop runs anywhere on macOS:

- **Press K11** (or `Ctrl+⌥⌘9` on the keyboard directly) → SuperWhisper's voice-command mode starts recording.
- **Speak** ("set the wheel to brightness up brightness down", "switch to layer III", "make K3 fire Cmd+R", "wheel for browser tab navigation").
- SuperWhisper auto-stops on silence, transcribes, runs the AppleScript, POSTs to `/voice-command`.
- Adapter spawns `claude -p`. Claude calls back through MCP to reconfigure (`set_wheel_binding`, `set_current_layer`, etc.). HUD updates live.

You can still POST to `/voice-command` directly from anywhere (curl, the HUD's test input, an MCP `submit_voice_command` call) without going through K11 — K11 is just one convenient trigger.

If you want a different hotkey for K11, edit `HARDWIRED_ACTIONS.K11` in `adapter/src/server.js`. **Convention:** prefer **F-keys above F15** (F16-F20) for adapter-driven global hotkeys — these aren't used by macOS or normal apps, so they're collision-free. Mac codes: F16=106, F17=64, F18=79, F19=80, F20=90.

`claude -p` runs as a child of the adapter and is not interactive — it uses the system prompt baked into the adapter (see `VOICE_SYSTEM_PROMPT` in `server.js`) plus your transcribed speech, then exits.

### How it flows

```
[any app] press SuperWhisper hotkey → speak → release
   ↓ Custom Mode AppleScript
POST http://127.0.0.1:47832/voice-command  { text: "..." }
   ↓ adapter broadcasts voice_command_received
   ↓ adapter spawns: claude -p "<smart prompt + your text>"
Claude reads ~/.claude.json → connects to this same adapter via MCP
   ↓ calls set_wheel_binding / set_current_layer / etc.
   ↓ each call broadcasts a *_change event → HUD updates live
   ↓ Claude finishes → adapter posts annotation with summary
```

Throttle: only one voice command in flight at a time. Send a second too soon and you'll get HTTP 429.

---

## HUD as the control surface

The HUD page (`http://127.0.0.1:47832/`) has a **Server** panel with three buttons:

- **↻ Restart** — `launchctl kickstart -k`. Cleanly restarts the adapter without a terminal.
- **■ Stop (this session)** — clean exit; launchd does not auto-restart, but `RunAtLoad` will start it again at next login.
- **⚠ Stop & disable** — `launchctl disable` + `launchctl bootout`. Permanently disabled until you re-enable it from terminal.

To **re-enable** after a "Stop & disable":

```bash
launchctl enable gui/$UID/org.mcpaql.shortcut-remote && \
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/org.mcpaql.shortcut-remote.plist
```

---

## Terminal escape hatches (for when the HUD is unreachable)

If the adapter is wedged or its HUD endpoint isn't responding, fall back to:

```bash
# Status
./tools/kill-shortcut-remote-mcp.sh --status

# Stop now (the adapter's SIGTERM handler exits cleanly, so launchd doesn't restart)
./tools/kill-shortcut-remote-mcp.sh

# Restart immediately
launchctl kickstart -k gui/$UID/org.mcpaql.shortcut-remote

# Stop and keep dead until re-enabled
launchctl disable gui/$UID/org.mcpaql.shortcut-remote && launchctl bootout gui/$UID/org.mcpaql.shortcut-remote
```

The previous menu-bar Kill Switch app and the standalone `sidecar/` process were both retired on 2026-05-02 — their behaviors are now folded into the adapter (synthesis) and the HUD (controls).

---

## Install

The adapter runs as a launchd-managed daemon and Claude Code connects to it over streamable HTTP.

**LaunchAgent:** `~/Library/LaunchAgents/org.mcpaql.shortcut-remote.plist`. RunAtLoad + KeepAlive (restart on crash, not on clean exit), 10-second throttle.

**`~/.claude.json` entry:**

```json
"shortcut-remote": {
  "type": "http",
  "url": "http://127.0.0.1:47832/mcp"
}
```

Multiple Claude Code sessions can connect concurrently — each gets its own MCP session ID; the underlying HID device, layer state, and wheel state remain a process-wide singleton fan-out across all of them.

---

## Critical behavior notes

- **Exclusive HID seize.** `node-hid` on macOS uses `kIOHIDOptionsTypeSeizeDevice` — when the adapter holds the vendor page, the XP-Pen daemon gets nothing. Other interfaces (mouse, digitizer) stay untouched because the adapter filters to `usagePage >= 0xFF00`. Use `release_device` to hand the keypad back to XP-Pen mid-session.
- **XP-Pen built-in defaults aren't extractable.** When a button is at `id="0"` in `~/.xppen/config.xml`, only the Actid is recorded; the actual keystroke lives in the XP-Pen app binary. To populate those, either re-set the button explicitly in the XP-Pen UI (which materializes the entry), or capture empirically by holding both keyboard interface + vendor page briefly and observing what XP-Pen synthesizes.
- **HUD hot-reload.** The server reads `hud.html` per-HTTP-request and `xppen-mappings.json` on demand. Edits to either land on browser refresh, no Claude Code restart.

---

## What's planned (vision threads)

1. **Smart-paste-with-wheel-formality** — wheel becomes a continuous formality knob; wheel-center button = paste with AI-formatted text. Press again for replace-not-append via Cmd+Z + new Cmd+V. Demonstrates the LLM-mediated context-aware action pattern that the sidecar enables.
2. **App-context-aware passthrough** — sidecar listens to `NSWorkspace.frontmostApplication`, swaps the passthrough table per-app. Foundation for the "context-aware keyboard" vision.
3. **Multi-device fleet view** — coordinate the keypad with the user's other input hardware (Magic Keyboard, Magic Trackpad, Bluetooth keypad, MX Master) as a single app-aware control surface.
4. **Local-model proposal layer** — when a new app is detected, a small local LLM proposes a passthrough config based on web-searchable shortcuts and the user's persona memory. User approves via the HUD's existing UI surface. No cloud LLM required for the common path.

---

## Provenance

- Discovery: observational HID capture, 2026-04-26
- K# layout verification: 2026-04-28 (Mick, live)
- Adapter generator pattern: `MCPAQL/adapter-generator/src/{schema-builder.ts, generator.ts}`
- Reference implementation status: pre-graduation. Lives in `examples/generated/`. May graduate to `MCPAQL/adapters/` after labeling pass + Layer-defaults capture.
