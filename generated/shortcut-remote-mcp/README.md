# Shortcut Remote — JIT MCP-AQL Adapter

A working, just-in-time-discovered MCP-AQL adapter for the **XP-Pen Shortcut Remote** (Hanvon Ugee, USB `0x28bd:0x0202`, internal model code `ACK05`).

Built end-to-end in a single session — observational HID discovery, generated CRUDE adapter, live HUD, sidecar for keystroke passthrough — with **no vendor SDK, no kernel extension, and no published protocol documentation**. This is the reference implementation of the JIT pattern for the long tail of programmable input hardware.

---

## What it proves

The adapter generator pattern in `MCPAQL/adapter-generator/` was originally designed for wrapping existing MCP servers. This project demonstrates that the same `DiscoveryBundle` substrate works for **observational discovery against undocumented hardware** — recording raw HID input reports while a user presses each button, then mechanically deriving the byte layout to emit a CRUDE adapter.

The deeper claim: **any HID input device can become a context-aware programmable surface** through a uniform three-layer pattern.

---

## Architecture

```
Hardware                                            ←  XP-Pen Shortcut Remote
  ↓ raw HID reports (vendor page 0xFF0A)
MCP-AQL adapter  (this directory)                   ←  Layer 1: observe contract
  ├── stdio JSON-RPC  →  Claude Code MCP host       ←  CRUDE operations to LLM
  └── WebSocket broadcast → ws://127.0.0.1:47832/events
                       ↓
               ┌───────┴───────┐
               ↓               ↓
       Live HUD (browser)   Sidecar process         ←  Layer 2: act contract
       (visualization)      (keystroke synthesis,
                            LLM action dispatch,
                            anything else)
                                ↓
                         macOS / running apps       ←  Layer 3: dynamic meaning
```

**Layer 1 (adapter)** observes the device, exposes events as CRUDE operations + WebSocket broadcast. Lives in `adapter/`.

**Layer 2 (sidecar)** consumes the WebSocket stream and dispatches actions per a passthrough table. Lives in `sidecar/`. Currently configured to passthrough K7 (SuperWhisper) and K8 (Escape) to the OS as XP-Pen-equivalent keystrokes; everything else flows to the LLM through the MCP adapter.

**Layer 3 (LLM, optional)** computes context-aware meaning when an action depends on current state (clipboard contents, formality knob, frontmost app, conversation context). Not yet wired; the smart-paste-with-wheel-formality build is the planned first such action.

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
│       ├── server.js                  ← MCP server + HUD HTTP/WS server
│       ├── schema.json                ← MCP-AQL schema (READ + DELETE endpoints)
│       ├── provenance.json            ← discovery provenance metadata
│       ├── hud.html                   ← live HUD page (hot-reloaded per HTTP request)
│       └── xppen-mappings.json        ← decoded XP-Pen Layer I-IV mappings (HUD reads via /xppen-mappings.json)
├── sidecar/
│   ├── package.json                   ← deps: ws
│   └── index.js                       ← keystroke-synthesis passthrough daemon
├── tools/
│   ├── capture-hid.js                 ← observational HID capture (with vendor-page-only safety filter)
│   ├── parse-xppen-config.js          ← parses ~/.xppen/config.xml → adapter/src/xppen-mappings.json
│   └── package.json                   ← deps: node-hid
└── validation/
    ├── smoke-test.js                  ← end-to-end MCP handshake + introspection + listing
    └── press-listener.js              ← single-press capture via the running adapter
```

---

## Operations exposed by the adapter

Two MCP tools, eight READ operations and one DELETE, plus introspection:

| Tool | Operation | Description |
|---|---|---|
| `mcpaql_read` | `introspect` | Discover available operations and their params at runtime |
| `mcpaql_read` | `list_devices` | Enumerate connected Shortcut Remote devices |
| `mcpaql_read` | `get_device_info` | Vendor info + inferred capabilities |
| `mcpaql_read` | `get_battery_status` | Latest battery percent + charging state |
| `mcpaql_read` | `get_button_state` | Currently-held buttons (latest snapshot) |
| `mcpaql_read` | `wait_for_button_press` | Block until next press (timeout configurable) |
| `mcpaql_read` | `get_recent_events` | Ring buffer of recent events (button + wheel + release) |
| `mcpaql_read` | `is_device_open` | Whether the adapter is holding the vendor-page handle |
| `mcpaql_read` | `get_hud_url` | Returns the live-HUD URL (default `http://127.0.0.1:47832/`) |
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

## Sidecar passthrough

`sidecar/index.js` listens to the same WebSocket the HUD uses and synthesizes keystrokes via `osascript` for configured passthrough buttons. Default config:

```js
const PASSTHROUGH = {
  "primary:6": { mac_code: 20, modifiers: ["option", "command"], label: "K7 → SuperWhisper (Opt+Cmd+3)" },
  "primary:7": { mac_code: 53, modifiers: [], label: "K8 → Escape" },
};
```

Run with `node sidecar/index.js` in a separate terminal. macOS will prompt for Accessibility permission on first synthesis — grant once.

Other buttons remain LLM-routed through the MCP adapter.

---

## Install

This adapter is registered in `~/.claude.json` as the `shortcut-remote` MCP server:

```json
"shortcut-remote": {
  "type": "stdio",
  "command": "node",
  "args": [
    "/Users/mick/Developer/Organizations/MCPAQL/examples/generated/shortcut-remote-mcp/adapter/src/server.js"
  ],
  "env": {}
}
```

To use in any new Claude Code session: `claude --resume` (or `claude --continue`).

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
