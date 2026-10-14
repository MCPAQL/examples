# Session Handoff — XP-Pen Shortcut Remote JIT MCP-AQL Adapter

**Generated:** 2026-04-28
**Working session model:** Claude Opus 4.7 (1M context)
**Purpose:** Continuity context for a new Claude Code session picking up this work without the conversation history.

---

## Mission state in one paragraph

A complete just-in-time MCP-AQL adapter for the XP-Pen Shortcut Remote (an undocumented vendor-locked USB HID keypad) was built end-to-end across two sessions on 2026-04-26 / 2026-04-28. Discovery was purely observational — no vendor SDK, no Ghidra, no published protocol. The adapter is installed in Claude Code, exposes 9 CRUDE operations, runs a live HTTP+WebSocket HUD that mirrors the XP-Pen UI's keypad graphic, and pairs with a sidecar process that selectively passes some buttons through as keystrokes while leaving others LLM-routed. The work is committed on `feature/shortcut-remote-jit-adapter` in `github.com/MCPAQL/examples` and pushed. The next session's job is to extend it — most likely either the smart-paste-with-wheel-formality build, the app-context-aware passthrough layer, or the empirical capture of XP-Pen's built-in default keystrokes for K1/K2/K11.

---

## What's deployed and live (verify before assuming)

| Surface | State | Where |
|---|---|---|
| MCP server `shortcut-remote` | Registered in user config | `~/.claude.json` mcpServers |
| Adapter source | Spawned by Claude Code per session | `MCPAQL/examples/generated/shortcut-remote-mcp/adapter/src/server.js` |
| HUD | Running when MCP server is up | `http://127.0.0.1:47832/` |
| Sidecar | Manual launch in separate terminal | `node sidecar/index.js` from project root |
| Feature branch | Pushed to origin | `https://github.com/MCPAQL/examples/tree/feature/shortcut-remote-jit-adapter` |
| Tools available in fresh session | `mcp__shortcut-remote__mcpaql_read` and `_delete` | Deferred — load via ToolSearch |

Verify on session start:

1. `/mcp` slash command — should list `shortcut-remote (user)` as connected
2. `curl -s http://127.0.0.1:47832/ | head -3` — should return HTML beginning with `<!doctype html>`
3. ToolSearch with `select:mcp__shortcut-remote__mcpaql_read` to load the schema
4. Test call: `mcp__shortcut-remote__mcpaql_read { operation: "list_devices" }` — should return 3 device listings (interfaces 0/1/2 of the same physical device)

---

## Mental model in three sentences

1. **Hardware → MCP-AQL adapter (Layer 1)** observes raw HID events from the device's vendor page and exposes them as CRUDE operations + a WebSocket broadcast.
2. **Sidecar (Layer 2)** consumes the WebSocket stream and applies actions per a passthrough table — keystrokes via osascript, MCP tool calls, HTTP webhooks, anything.
3. **Optional LLM (Layer 3)** is invoked by the sidecar when an action's meaning depends on current context (clipboard, formality knob, recent conversation, frontmost app); for context-free actions the sidecar acts deterministically.

This pattern generalizes to any HID input device. The keypad is the proof; Stream Decks, MIDI controllers, drawing tablets, gamepads all share the same shape.

---

## Repository map

Feature branch: `feature/shortcut-remote-jit-adapter` on `MCPAQL/examples` (public, AGPL-3.0 + CC BY 4.0 split).

```
generated/shortcut-remote-mcp/
├── README.md                          ← Overview, install, usage, architecture
├── HANDOFF.md                         ← (this file — session continuity)
├── docs/
│   └── xppen-decode-reference.md      ← Canonical reference for ALL the XP-Pen / HID decode facts
├── adapter/
│   └── src/
│       ├── server.js                  ← MCP server + HTTP/WebSocket HUD server
│       ├── schema.json                ← MCP-AQL schema (READ + DELETE endpoints)
│       ├── provenance.json            ← Discovery provenance metadata
│       ├── hud.html                   ← Live HUD (hot-reloaded per HTTP request)
│       └── xppen-mappings.json        ← Decoded XP-Pen Layer I-IV mappings (HUD reads via /xppen-mappings.json)
├── sidecar/
│   └── index.js                       ← Keystroke-synthesis passthrough daemon
├── tools/
│   ├── capture-hid.js                 ← Observational HID capture (vendor-page-only by default)
│   └── parse-xppen-config.js          ← ~/.xppen/config.xml → adapter/src/xppen-mappings.json
├── capture/
│   ├── raw-reports.jsonl              ← 235 raw HID input reports from the discovery session
│   └── discovery-bundle.json          ← MCP-AQL DiscoveryBundle (low-confidence operations)
└── validation/
    ├── smoke-test.js                  ← End-to-end MCP handshake + introspection + listing
    └── press-listener.js              ← Single-press capture via the running adapter
```

**`docs/xppen-decode-reference.md` is the canonical source of truth for the device protocol decode.** If anything is unclear about how the device works, that file has the answer. Other files (parser code, JSON outputs) are mechanical derivations of what's documented there.

---

## What works (verified live as of 2026-04-28)

- HID enumeration of the device (3 interfaces visible)
- Observational capture of vendor-page reports (235 raw events on file)
- Decoded 12-byte vendor report layout (button bitmap, wheel direction, battery heartbeat)
- K1–K11 → HID bit mapping (verified by Mick pressing each labeled key)
- MCP-AQL adapter exposing 9 operations under 2 tools (`mcpaql_read`, `mcpaql_delete`)
- `mcpaql_read` ops: introspect, list_devices, get_device_info, get_battery_status, get_button_state, wait_for_button_press, get_recent_events, is_device_open, get_hud_url
- `mcpaql_delete` op: release_device (hands keypad back to XP-Pen daemon mid-session)
- HUD with keypad-shaped layout, K1–K10 grid + K11 in the wheel, layer toggles for I/II/III/IV, live highlight on press, wheel-tick counters, battery indicator, event log
- HUD hot-reload (edits to `hud.html` and `xppen-mappings.json` take effect on browser refresh — no MCP server restart needed)
- Sidecar passing K7 (SuperWhisper / Opt+Cmd+3) and K8 (Escape) through to OS via osascript
- XP-Pen config decode for all 4 layers
- Two commits on the feature branch: `feat:` (the adapter) and `docs:` (the reference doc)

---

## What's still open (priority-ordered for next session)

### 1. Smart-paste-with-wheel-formality (designed, not built)

The flagship LLM-mediated action that demonstrates the sidecar's full power. Spec:

- User copies text in any app
- Presses K11 (wheel-center button) → sidecar reads clipboard, saves as "original"
- Sidecar calls LLM with (original text, current formality level set by wheel position) and writes a formatted version to the clipboard, then synthesizes Cmd+V
- Wheel CW/CCW between presses adjusts a `formality_level` state (no action fires on wheel ticks alone — they just modify the next-press parameter)
- Press K11 again → sidecar detects "lastPasteWasOurs == true", sends Cmd+Z to undo our previous paste, generates new version with current formality, pastes again. **Replace, not append.**
- Any user activity that isn't us (typing, mouse click) clears `lastPasteWasOurs` — sidecar knows to start fresh next press

LLM call origin tradeoff space (pick when implementing):

- **Direct Anthropic API** with sidecar's own key — simplest, lowest latency, no current-session awareness
- **Claude Agent SDK with Dollhouse MCP wired in** — captures user's persona memory and writing-voice context
- **Bridge through Dollhouse memory** — closest to "knows what we're talking about right now" but most architectural lift

Recommended start: Anthropic API direct. Upgrade to Agent SDK once core loop works.

Implementation: extend `sidecar/index.js`. Add a stateful action handler. Add clipboard read/write via `pbpaste`/`pbcopy`. Maybe ~150 lines on top of the existing sidecar.

### 2. App-context-aware passthrough (described, not built)

Per-app config layering. Sidecar listens to `NSWorkspace.shared.frontmostApplication` change events (via Swift helper or polling osascript) and swaps the active passthrough table per bundle ID. Different K-mappings for Photoshop vs Logic vs Slack.

Components needed:
- Frontmost-app observer (~50 lines Swift, or polling osascript loop)
- Sidecar config schema upgrade from flat map to nested `{ bundle_id: passthroughs }`
- Per-app config files in `~/.dollhouse/keyboard-personalities/` or similar
- Optional: LLM-mediated proposal layer that suggests config when a new app is detected

### 3. Empirical capture of XP-Pen built-in defaults (K1, K2, K11)

K1, K2, and K11 in Layer I currently show as "default Actid 110/111/105 — built-in mapping not extractable from XML". The actions live in the XP-Pen app binary's static action table. Two recovery paths:

- **Force-customize** — Mick clicks "Save" on each in the XP-Pen UI; the XML materializes the entry; our parser picks it up automatically
- **Empirical capture** — temporarily hold both interface 0 (keyboard) and interface 2 (vendor page) of the device; press each default-mapped K once; correlate the synthesized keystroke (interface 0) with the bit transition (interface 2); save as `xppen-defaults-snapshot.json`

Empirical is more thorough (one capture covers all defaults across all 4 layers) but disruptive (interface 0 seize blocks XP-Pen synthesis to OS during the capture window).

### 4. Multi-device input fleet view

The user has multiple input devices (XP-Pen keypad + Magic Keyboard + Magic Trackpad + MX Master + Satechi Bluetooth Keypad). Per-app configs could coordinate ALL of them as one input surface for one app. Different buttons on different devices for different actions, harmonized.

This is an ambitious build but only requires extending the existing sidecar pattern to subscribe to multiple device WebSockets simultaneously. Each device gets a separate JIT MCP-AQL adapter; the sidecar consumes them all.

### 5. Local-model proposal layer

When a new app is detected and no per-app config exists, run a small local LLM (Phi-4, Llama-3.1-8B, Mistral-7B) with the user's hardware fleet inventory and ask: "what's a reasonable default keypad config for this app?" Web-search if needed. Render proposal in the HUD as an approval surface (already half-built — the HUD's HTTP server can grow more routes). User approves → config file persists.

The local-model fit is the architectural payoff: small models can hold the full MCP-AQL surface in working context where flat MCP would choke. Cloud-model escalation only on novel/complex cases.

### 6. MCP-AQL spec extension: `output_target` flag for adapter generator

The keypad work surfaced an architectural insight: the JIT discovery pipeline could emit DIFFERENT kinds of adapters from the same `DiscoveryBundle`. Today the generator emits an MCP-AQL server. It could equally emit:

- A native-HID emulator (so the device works in every macOS app, not just LLM-aware ones)
- An OpenAPI/REST frontend (so HTTP clients can drive the same surface)
- A gRPC service

Spec change: add `output_target: "mcp-aql" | "native-hid" | "openapi" | "grpc"` to the generator CLI and schema. Keeps `DiscoveryBundle` identical; only the code generator at the end changes.

This is an MCPAQL spec proposal, not a keypad-specific build. Worth filing as an issue against `MCPAQL/spec`.

### 7. BetterTouchTool MCP-AQL adapter (separate but related)

Web search confirmed: existing community MCP servers wrap BTT, but none use MCP-AQL CRUDE pattern. Mick agreed building an AQL one is worthwhile because:
- Token-efficient surface for power users with hundreds of named triggers
- BTT's webserver API is well-defined (HTTP + Unix socket at `/tmp/com.hegenberg.BetterTouchTool.sock`)
- Andreas Hegenberg (BTT's author) ships an MCP CLIENT in BTT (h@llo.AI feature) but no SERVER side — building one closes the bidirectional integration loop

This would live as `MCPAQL/examples/generated/bettertouchtool-mcp/` (or graduate to `MCPAQL/adapters/`) and is conceptually similar to the keypad work but talks HTTP to BTT instead of HID to the device.

---

## Pitfalls / lessons learned (don't re-learn these)

### node-hid exclusive seize behavior on macOS

`node-hid` opens HID devices with `kIOHIDOptionsTypeSeizeDevice`. While our adapter holds an interface, no other process — not even the vendor daemon — can read it. Opening interface 0 (keyboard) of the Shortcut Remote stole keystrokes XP-Pen would have synthesized to the OS, breaking Mick's normal Photoshop shortcuts mid-session.

**Always filter to vendor-defined pages only** (`usagePage >= 0xFF00`) by default. Provide an `MCPAQL_HID_OPEN_ALL=1` env override only if explicitly needed. Always ship a `release_device` operation so the user can hand the keypad back to XP-Pen mid-session without quitting Claude Code.

### XP-Pen config storage

The Shortcut Remote's mappings are under `<ACK05>` (internal model code), NOT `<ShortcutRemote>` (which is a stale legacy template in the same file). Multiple template sections exist for every device XP-Pen supports — most aren't relevant. Always check `<DeviceInfo>` (key/ring counts) and presence of customized entries (`id="1"`) to identify the active section.

Built-in defaults aren't extractable from the config — they live in the app binary. See section 11 of `docs/xppen-decode-reference.md` for the two recovery paths.

### HUD hot-reload required a server.js patch

Originally `server.js` did `const HUD_HTML = readFileSync(...)` once at startup. Edits to `hud.html` then required a Claude Code restart (which respawns the MCP server) to take effect. Patched to read per-HTTP-request, so future HUD changes land on browser Cmd+Shift+R. **Don't revert this** — it's the difference between "iterate on HUD design at conversational speed" and "every iteration costs a session restart."

Same for `xppen-mappings.json` — the server reads on demand via the `/xppen-mappings.json` HTTP route.

### `wait_for_button_press` doesn't fire on wheel ticks

Intentional. Wheel ticks emit `kind: "wheel"` events, not `button_press`. The waiter resolves only on button-bit transitions. This was confusing during a labeling pass — *button presses* show up via `wait_for_button_press` but *wheel ticks* must be pulled from `get_recent_events` (or observed via the HUD WebSocket).

If a future use case needs a unified "wait for any input event" semantic, add a separate `wait_for_input` operation rather than changing the existing one.

### Browser cache on `localhost`

Safari and Chrome aggressively cache `localhost` HTML even on Cmd+R. After editing `hud.html`, hard refresh (Cmd+Shift+R) is required to bust the cache. If new HUD code "isn't taking effect," that's the first thing to check before assuming the server isn't serving the right content.

### Dollhouse memory sanitizer strips XML/HTML tags

DollhouseMCP issue #2175 (https://github.com/DollhouseMCP/mcp-server/issues/2175). Memories with `<TAG>` content lose those tags during storage, even inside markdown code spans. Workaround: use `[TAG]` notation or HTML entities when authoring memories with tag-rich content. Or, better, store technical reference content as files in the repo (like `docs/xppen-decode-reference.md`) and let memories be pointers.

### Session-spawn behavior — MCP server restart timing

The MCP server is spawned fresh by Claude Code per session. Server-code changes (`server.js`, schema, etc.) require a Claude Code session restart to take effect. Browser-side / HUD changes (`hud.html`, `xppen-mappings.json`) hot-reload per HTTP request — no restart needed.

To restart Claude Code mid-conversation: quit (Ctrl+C twice or close terminal) → `claude --resume` → pick the same conversation. Full conversation history persists, MCP servers respawn fresh.

---

## External context that lives outside this repo

### Dollhouse memories created in this work (6)

Searchable via `mcp__dollhousemcp__mcp_aql_read` with `search_elements`:

- `jit-keypad-adapter` — the working JIT adapter as reference implementation
- `mcpaql-three-layer-pattern` — the architecture pattern
- `mcpaql-local-model-fit` — why MCPAQL fits local/small models
- `xppen-config-storage` — XP-Pen XML decode reference (degraded by sanitizer; canonical is `docs/xppen-decode-reference.md`)
- `node-hid-seize-behavior` — the seize gotcha and mitigation
- `shortcut-remote-bit-mapping` — K# → bit mapping

### Claude Code auto-memories created in this work (6)

Same titles, slightly different format. At `~/.claude/projects/-Users-mick-Developer-Organizations-DollhouseMCP/memory/`. These auto-load into every Claude Code session in this project. Mick may choose to delete them — if so, the Dollhouse memories and `docs/xppen-decode-reference.md` cover the same ground.

### Filed issue

DollhouseMCP/mcp-server#2175 — memory content sanitizer strips XML/HTML tags from technical content. Includes reproduction, four suggested fixes.

### Strategic context that wasn't captured in any file

- The session covered substantial vision territory beyond the keypad: Ghidra as discovery sensor, AI-driven protocol reverse-engineering for retro hardware (SideWinder Strategic Commander, Ergodex DX1 — both have RE'd protocols available online), the "context-aware keyboard like Star Trek LCARS" vision where apps trigger keypad reconfiguration, AirPods Pro head-tracking as an MCP-AQL input source.
- Key strategic claims: (a) the pattern proven with $30 keypad applies to Stream Decks, MIDI controllers, gamepads, sensors; (b) MCP-AQL's token efficiency makes it the right protocol for local-model agentic systems, not just cloud-LLM; (c) "anything can become an HID emulator" — same discovery pipeline, different output target, lets weird hardware appear as standard input devices to every app on the OS.

---

## How to bring a fresh session up to speed

1. **Read these three files in order:**
   - `MCPAQL/examples/generated/shortcut-remote-mcp/HANDOFF.md` (this file)
   - `MCPAQL/examples/generated/shortcut-remote-mcp/README.md`
   - `MCPAQL/examples/generated/shortcut-remote-mcp/docs/xppen-decode-reference.md`

2. **Verify state with live calls** (don't trust memory or this doc for time-sensitive facts):
   - `/mcp` — confirm `shortcut-remote` is connected
   - `mcp__shortcut-remote__mcpaql_read { operation: "introspect", params: { query: "operations" } }` — confirm operation surface
   - `mcp__shortcut-remote__mcpaql_read { operation: "is_device_open" }` — see if adapter currently holds the device
   - `git -C ~/Developer/Organizations/MCPAQL/examples log --oneline -5` — confirm latest commits

3. **Search Dollhouse memories** for the broader strategic frame:
   - `mcp__dollhousemcp__mcp_aql_read { operation: "search_elements", params: { query: "jit keypad" } }`
   - `mcp__dollhousemcp__mcp_aql_read { operation: "get_element", element_type: "memory", params: { element_name: "mcpaql-three-layer-pattern" } }`

4. **Check open work signals:**
   - `gh issue view 2175 --repo DollhouseMCP/mcp-server` — see the memory sanitization issue's state
   - `git -C ~/Developer/Organizations/MCPAQL/examples branch -a` — see if main/develop have moved past the feature branch's base

---

## Critical reminders for the next session

- The MCP-AQL examples repo is **public** at `github.com/MCPAQL/examples`. Anything committed there is visible to the world. The current feature branch is pushed but not yet merged.
- Mick is the author of MCP-AQL. The split-license model (CC BY 4.0 for spec, AGPL-3.0 for code) is deliberate. Keep this work AGPL-licensed.
- **Do not open interface 0 of the keypad** unless explicitly capturing built-in defaults via the empirical method described in section 11 of the decode reference. Default to vendor-page-only.
- **Always release the device** before leaving the user idle. The `release_device` op is the contract — call it whenever the user signals they're done with the keypad-as-LLM-controller.
- Mick uses voice transcription that occasionally inserts garbled phrases ("up down down" etc. mid-message). When a sentence reads as nonsense, treat it as transcription noise and ignore it — don't try to interpret. Ask for clarification only if the rest of the message is also unclear.
- The next concrete actionable build is **smart-paste-with-wheel-formality** in the sidecar. It's fully designed (see section 1 of "What's still open"). The sidecar already exists; this is an extension, not new infrastructure.

---

## How to use this handoff

Two ways:

1. **Hand to a new Claude Code session:** Open a fresh session in `~/Developer/Organizations/DollhouseMCP/` (or any subdirectory that includes the MCPAQL examples in scope). Paste this file's path or contents into the first message. The new session will use it to come up to speed.

2. **Hand to a human collaborator:** Same content covers what they need to understand the work. Pair with the README and the decode reference for full onboarding.

This file is committed-optional. Delete it, gitignore it, or leave it in the branch — your call. It will go stale; if you keep it committed, plan to update or delete it as the work evolves.
