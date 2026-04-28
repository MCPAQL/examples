# AirPods MCPAQL Adapter — Session Handoff

**Generated:** 2026-04-28
**Working session model:** Claude Opus 4.7 (1M context)
**Sister project:** `shortcut-remote-mcp/` (XP-Pen Shortcut Remote keypad adapter — same pattern, different bottom layer)

---

## Mission state in one paragraph

A working MCPAQL adapter for AirPods Pro head-tracking was built end-to-end on 2026-04-28. The bottom layer is a Swift `.app` bundle that wraps Apple's `CMHeadphoneMotionManager` and broadcasts pose data over TCP. A Node sidecar consumes that stream and provides the user-specific experience: calibrated head-pose-to-screen-coordinate mapping (10-point calibration, 5 per monitor), gaze-driven X-mouse-style window focus (with `AX_RAISE` for window-level targeting), a transparent floating blob that visualizes where the system thinks you're looking, and motion-aware behavior (smoothing, drift compensation, fade-on-stillness). Multi-device composition is demonstrated by binding the XP-Pen keypad's K11 (wheel-center) button to send `SIGUSR1` to the AirPods sidecar, triggering a guided recalibration mode — head-tracking adapter and HID adapter cooperating through MCPAQL infrastructure.

---

## What's deployed and live (verify before assuming)

| Surface | State | Where |
|---|---|---|
| Swift motion source | Long-running `.app` bundle | `server/airpods-mcp-server.app/Contents/MacOS/airpods-mcp-server` (PID via `pgrep -fl airpods-mcp-server`) |
| Raw pose stream (TCP) | JSON-line per sample | `127.0.0.1:47833` |
| MCP-AQL adapter | Long-running Node process | `adapter/src/server.js` (pid file `/tmp/airpods-adapter.pid`) |
| Adapter HUD | HTTP + WebSocket | `http://127.0.0.1:47834/` and `ws://127.0.0.1:47834/events` |
| Adapter MCP transport | stdio | Spawn via `node adapter/src/server.js` from a host (Claude Code, etc.) |
| Audio keeper | `afplay -v 0.001 silent.wav` loop | Required — AirPods stop streaming when no audio session is active |
| Calibration data | 10 anchor points (5 per monitor) | `calibration.json` |
| Live offsets | Refreshed by recenter | `/tmp/airpods-offsets.json` (sidecar polls every 1s) |
| AirPods sidecar | Node, long-running | `sidecar/index.js` (pid file `/tmp/airpods-sidecar.pid`) |
| Window-at-point daemon | Swift, long-running, AX-permission required | `sidecar/window-at-point` |
| Dwell-blob daemon | Swift, transparent NSWindow overlay | `sidecar/dwell-blob` |
| Move-cursor daemon (optional) | Swift, only when `MOUSE_FOLLOW=1` | `sidecar/move-cursor` |
| Multi-device hook | XP-Pen K11 → SIGUSR1 → sidecar calibration mode | `shortcut-remote-mcp/sidecar/index.js` PASSTHROUGH `secondary:2` |

Verify on session start:

1. `pgrep -fl airpods-mcp-server` — server alive
2. `nc -w 1 localhost 47833 | head -1` — should see hello + pose JSON; if hello only, AirPods motion stream stopped (audio session inactive)
3. `pgrep -fl "node.*airpods-mcp/sidecar"` — sidecar alive
4. `pgrep -fl dwell-blob` — overlay alive (if `BLOB_FOLLOW=1`)
5. `cat /tmp/airpods-offsets.json` — current applied offsets

---

## Mental model in three sentences

1. **Hardware → MCPAQL adapter (Layer 1)** wraps `CMHeadphoneMotionManager` in an `.app` bundle for TCC, broadcasts pose JSON over TCP at ~25 Hz.
2. **Sidecar (Layer 2)** consumes the stream, applies calibration, smooths with a 1-Euro filter, classifies pose into a monitor region, queries `window-at-point` for the app/window under gaze, raises that window via `AX_RAISE` on a stable dwell.
3. **Optional LLM (Layer 3)** is unused for this build but the seam — the dwell candidate plus its ms-stable identity — is exactly where an LLM-mediated decision would slot in (e.g., "should I switch focus to this window or speak its title aloud?").

This pattern is the same as the keypad. The bottom layer differs (Apple framework vs. node-hid HID seize) but the architecture is identical.

---

## Repository map

```
examples/generated/airpods-mcp/
├── HANDOFF.md                          ← (this file)
├── README.md                           ← Quick install + usage (run alongside HANDOFF)
├── calibration.json                    ← 10-anchor calibration capture (5/screen, captured 2026-04-28)
├── server/
│   ├── server.swift                    ← Swift motion broadcaster
│   ├── Info.plist                      ← NSMotionUsageDescription (required by TCC)
│   └── airpods-mcp-server.app/         ← Built bundle, ad-hoc signed, launched via `open`
├── sidecar/
│   ├── index.js                        ← The big one: smoothing, drift, calibration, dwell, focus, blob
│   ├── window-at-point.swift           ← stdin daemon: query app/window at point + AX_RAISE focus
│   ├── dwell-blob.swift                ← Transparent NSWindow overlay; "alpha" + "fade" stdin commands
│   ├── move-cursor.swift               ← Optional cursor warp (MOUSE_FOLLOW=1)
│   ├── activate-pid.swift              ← (Legacy) one-shot app-pid activator; superseded by AX_RAISE
│   ├── speak-pan.swift                 ← Spatial-audio cue (left/right pan) using AVAudioPlayer
│   ├── focus-on-display.swift          ← (Legacy) monitor-level activator; superseded by window-at-point
│   └── window-at-point, dwell-blob, … ← Built binaries
├── calibrate/
│   ├── calibrate.js                    ← One-shot 10-point calibration capture (audio-cued)
│   ├── recenter.js                     ← Verbose recenter (used during early development)
│   └── recenter-quick.js               ← Silent 1s recenter (callable from any hardware trigger)
└── start.sh / stop.sh                  ← Bring up / tear down the full stack
```

(Earlier scaffolding `probe/` and `key-binder/` was removed before merge; their roles are
now covered by `server/` (motion source) and the keypad sidecar's K11 → SIGUSR1 binding.)

`README.md` is the install + usage reference. `HANDOFF.md` (this file) is session-continuity context.

---

## What works (verified live as of 2026-04-28)

- `CMHeadphoneMotionManager` access via .app bundle on macOS 15.7.4 with AirPods Pro
- TCP pose stream at ~25 Hz when audio session active (silent-WAV loop keeps it alive)
- 10-point calibration capture with audio cues + countdown
- 3-anchor piecewise-linear pose-to-screen-uv interpolation (left/center/right per axis), so calibrated `main_center` actually maps to (0.5, 0.5)
- Motion-gated 1-Euro smoothing: smoothed pose freezes during stillness
- Leaky drift integrator with per-sample cap (`MAX_ABSORB_PER_SAMPLE`): absorbs gyro drift during stillness without over-correcting on breathing/posture micro-motion
- Region classification with explicit seam + hysteresis dead band (~5.7°), kills boundary flicker
- Window-level focus: `CGWindowListCopyWindowInfo` to find window at gaze point, `AXUIElement` + `kAXRaiseAction` to raise that *specific* window (so two Chrome windows on same screen are distinct targets)
- Transparent floating overlay blob with smooth fade animation; three-zone motion behavior (still / small-motion / real-motion) and force-show-on-app-change
- SIGUSR1 calibration mode: lock blob to MAIN center, audio-cued countdown, 1s capture window, applies offsets atomically
- XP-Pen keypad K11 → SIGUSR1 (multi-device cross-adapter integration)

---

## What's still open (priority-ordered for next session)

### 1. ~~Promote the server to a real MCPAQL surface~~ — **DONE 2026-04-28**

Built `adapter/` with stdio MCP + CRUDE schema + HUD HTTP/WS at port 47834. Node process (uses `@modelcontextprotocol/sdk`) connects to the Swift motion source at TCP 47833 and proxies the stream into the proper MCPAQL spec surface.

**Operations exposed:**
- `read`: list_devices, is_streaming, get_pose, wait_for_pose, get_recent_poses, get_calibration, get_hud_url, get_provenance
- `create`: calibrate_point (named anchor)
- `update`: recenter (atomic capture+apply against main_center), set_offset
- `delete`: clear_offsets

**Files added**: `adapter/package.json`, `adapter/src/{server.js, schema.json, provenance.json}`. Modeled on the keypad adapter's shape.

Remaining work: switch the sidecar to consume the adapter's HUD WebSocket (ws://127.0.0.1:47834/events) instead of talking directly to the Swift source on TCP 47833. Both work today; the WebSocket route is the architecturally clean path. Small refactor, not blocking.

### 2. Per-app context awareness in the sidecar

Sidecar tracks dwell on `(pid, wnum)` but doesn't yet know *what* that app is for. App-context-aware behavior could:
- Tune dwell threshold per app (faster for terminals, slower for IDE)
- Adjust which monitor regions are "interesting" (e.g., ignore Slack notifications)
- Trigger different actions per frontmost app

This is the same pattern as the keypad sidecar's app-context-aware passthrough roadmap.

### 3. Server-side calibration handoff

Right now calibration is a separate Node script (`calibrate.js`). If the server owns calibration state and exposes `create.calibrate_point` operations, calibration becomes any-client-can-drive. An LLM could even guide the user through it: "look at top-left of MAIN now," wait for confirmation, capture, etc.

### 4. Drift compensation improvements

The leaky integrator with cap works but isn't optimal:
- Could add a Kalman-style sensor fusion using rotation rate as the high-frequency signal and attitude as the low-frequency reference
- Could detect sustained motion below `STILL_REF` (small head turns) vs. true stillness, and only absorb during true stillness
- Could expose drift estimate as a server-side metric so the LLM can decide when to suggest recenter

### 5. Bundle into a single launchable

Currently 5 processes need to be running:
- `airpods-mcp-server.app`
- AirPods sidecar
- Audio keeper (silent loop)
- Window-at-point daemon (spawned by sidecar)
- Dwell-blob daemon (spawned by sidecar)
- Plus the keypad MCP adapter + sidecar for K11 binding

A `launchd` plist (or just a `start.sh` script) would let "boot the AirPods experience" be one command.

### 6. Demo / video capture

This is a showcase-class demo of the MCPAQL pattern: gaze-driven window focus on consumer hardware, no proprietary SDKs, all open source. Worth recording a screen capture for the public repo.

---

## Pitfalls / lessons learned

### TCC requires a real `.app` bundle for `CMHeadphoneMotionManager`

Bare CLI binaries with `-sectcreate __TEXT __info_plist` embedded plists don't satisfy TCC for headphone motion. macOS attributes the request to the responsible parent process (the terminal), not to the embedded plist. Solution: build a proper `.app` bundle with `Contents/MacOS/<binary>` + `Contents/Info.plist`, ad-hoc sign, launch via `open -W` (LaunchServices). Then TCC honors `NSMotionUsageDescription` and the call works without a permission prompt for most users (depending on prior grants).

See `server/Info.plist` for the minimum required plist.

### AirPods motion stream stops when no audio session is active

`CMHeadphoneMotionManager` only delivers samples while audio is being routed through the AirPods. With no audio playing, the stream pauses (silently — no error). Solution: a continuously-running silent-WAV loop via `afplay -v 0.001`. ~88 KB of zeros, looped forever, near-zero CPU and battery cost.

When deploying, this loop must be running before the server starts. We use a shell loop launched from the same script that starts everything else.

### `NSRunningApplication.activate(pid)` is app-level, not window-level

Activating a Chrome pid brings *some* Chrome window forward — typically the most recently active, which is rarely the one you're looking at. To target a specific window: query its frame via `CGWindowListCopyWindowInfo`, find the matching `AXUIElement` in the app's window list (match by frame proximity), call `AXUIElementPerformAction(win, kAXRaiseAction)`, then activate the app. This needs Accessibility permission.

`window-at-point.swift` implements this. It's used both for queries (no AX needed) and the focus action (AX needed).

### Don't reuse `move-cursor`-style cursor warping for X-mouse focus

Initial design had `MOUSE_FOLLOW=1` warp the cursor to the gaze point. That hijacks user mouse control and makes the experience worse. The right pattern: focus follows gaze; mouse follows hand. Independent.

`MOUSE_FOLLOW` is kept as an opt-in for debugging/visualization (e.g., to verify calibration math), but `BLOB_FOLLOW=1` is the production-quality visualization — a transparent click-through overlay window that shows where the system *thinks* you're looking, without taking over your real cursor.

### Drift mitigation: motion-gated smoothing + leaky integrator + manual recenter

AirPods Pro IMU drift is real and substantial — measured at 1-2°/min during this session. Three layers of mitigation:

1. **Motion-gated smoothing** (1-Euro flavor): smoothed pose update rate scales with rotation rate. When still, smoothed pose freezes — drift in raw pose doesn't propagate.
2. **Leaky drift integrator** with **per-sample cap**: when motion is small, apparent pose change is absorbed into the offset (subtracted from incoming poses). The cap (`MAX_ABSORB_PER_SAMPLE = 0.00005 rad/sample`) prevents over-absorption of breathing / posture micro-motion as drift.
3. **Manual recenter on hardware trigger**: a guided 3.5s alignment mode — blob locks to MAIN center, user moves head to align with blob, system captures aligned pose as the new reference. Triggered by SIGUSR1 (which is sent by XP-Pen K11).

Without all three, cursor/blob position is unusable past ~1 minute of use. With them, drift is contained to a level that occasional manual recenter handles cleanly.

### Region classification needs explicit seam + hysteresis

Naive "first region whose bbox contains the pose" was the original logic and it broke at the seam between two monitors:

- The two regions overlap in pose space (calibrations don't perfectly align with physical edges)
- First-match returns whichever region happens to be checked first
- Pose oscillating in the overlap zone gets classified as one then the other — flicker

Solution: compute an explicit seam yaw from calibration anchors (midpoint between MAIN's left edge yaw and LEFT's right edge yaw) and apply hysteresis. Once classified as MAIN, only switch to LEFT when yaw moves > `SEAM_YAW + SEAM_HYST` (default ±0.05 rad ≈ 2.9° each side, so ~5.7° dead band). And vice versa.

This is generalizable: any time a sensor straddles two discretely-classified regions, use seam + hysteresis, never just bbox-membership.

### Multi-device composition via signals

K11 on the keypad fires `kill -USR1 $(cat /tmp/airpods-sidecar.pid)`. The keypad sidecar doesn't know anything about AirPods; it just reads its passthrough table and runs the configured command. The AirPods sidecar's SIGUSR1 handler enters calibration mode.

This is the cheapest possible IPC — no new ports, no new daemons, no new protocols. Two MCPAQL adapters cooperating through the standard Unix signaling layer. The pattern generalizes: any hardware adapter can trigger any sidecar's "do this thing" entry point via a signal.

### Audio cues must avoid TTS when in a hot path

The original sidecar spoke the focused app's name on every focus event (spatial-panned). After short use, the constant chatter became annoying. Decision: visual blob is sufficient feedback; audio is reserved for events the user must act on (recenter prompts, stream-stopped warnings) and explicit drift warnings (later silenced too — drift is visible in cursor position).

Audio is a powerful but costly UX channel. Default to silence for normal operation; reserve it for state changes that matter.

---

## External context that lives outside this repo

### Dollhouse memories created in this work

Searchable via `mcp__dollhousemcp__mcp_aql_read` with `search_elements`:

- `airpods-mcpaql-adapter-recipe` — full architecture + TCC + audio-keeper
- `airpods-drift-mitigation-recipe` — three-layer drift defense
- `mcpaql-multi-device-composition` — K11 → SIGUSR1 → sidecar pattern
- `axraise-window-level-focus-pattern` — CGWindowList + AX_RAISE for specific windows
- `seam-hysteresis-region-classification` — boundary flicker fix

### Strategic context from the session

- Confirmed: the three-layer MCPAQL pattern works with non-HID bottom layers (Apple frameworks, in this case CoreMotion). The pattern is protocol-agnostic.
- The split between "MCP server / adapter" (sensor + reusable surface) and "sidecar" (user-specific experience) is the right architectural seam. Today most of our logic lives in the sidecar; the next pass is to promote shared primitives (calibration, pose query, recenter) into the MCP server's MCPAQL operations.
- Multi-device cooperation via signals is dirt-simple and sufficient for many cases. Doesn't require an event bus or service mesh.
- AirPods drift is fixable in software *enough* for usable gaze-driven focus, but absolute pixel-precise positioning is beyond the hardware's reliability budget. Window-level focus (which this build does) is the right target; sub-pixel cursor steering is not.
- This build is a **showcase artifact**, not a product. Per the project's framing, MCPAQL adapter projects exist to demonstrate what the pattern enables. Anyone with AirPods Pro + a Mac can run it.

---

## How to bring a fresh session up to speed

1. **Read these in order:**
   - `MCPAQL/examples/generated/airpods-mcp/HANDOFF.md` (this file)
   - `MCPAQL/examples/generated/airpods-mcp/README.md`
   - Sister project: `MCPAQL/examples/generated/shortcut-remote-mcp/HANDOFF.md`

2. **Verify state with live calls:**
   - `pgrep -fl airpods-mcp-server` — server alive
   - `nc -w 1 localhost 47833 | head -2` — hello + at least one pose line; if pose line missing, audio session is inactive
   - `pgrep -fl dwell-blob` — overlay alive
   - `cat /tmp/airpods-offsets.json` — current offsets

3. **Start everything from cold:**
   - Start audio keeper: `( while true; do afplay -v 0.001 /tmp/silent.wav; done ) &`
   - Start server: `open MCPAQL/examples/generated/airpods-mcp/server/airpods-mcp-server.app`
   - Calibrate: `node MCPAQL/examples/generated/airpods-mcp/calibrate/calibrate.js` (10 prompts, ~90s)
   - Start sidecar: `BLOB_FOLLOW=1 nohup node MCPAQL/examples/generated/airpods-mcp/sidecar/index.js > /tmp/airpods-sidecar.log 2>&1 &`
   - Start keypad sidecar (for K11 recenter): `nohup node MCPAQL/examples/generated/shortcut-remote-mcp/sidecar/index.js > /tmp/keypad-sidecar.log 2>&1 &`

4. **Search Dollhouse memories** for the architectural framing and gotchas (see list above).

---

## Critical reminders

- The MCPAQL examples repo is **public**. The license split (CC BY 4.0 spec / AGPL-3.0 code) is deliberate.
- Mick is the author of MCPAQL. This adapter is a showcase, not a product.
- **Drift is a fundamental AirPods limitation**, not a bug in our code. The mitigation stack handles it but doesn't eliminate it. Manual recenter on K11 is the production answer.
- **The audio keeper must always run**, otherwise head tracking dies silently after a few seconds of silence.
- **The .app bundle must be launched via `open`**, not invoked as a CLI directly. LaunchServices is what gives TCC the right responsible-process attribution.
- Mick uses voice transcription that occasionally inserts garbled phrases. When a sentence reads as nonsense, treat it as transcription noise.

---

## How to use this handoff

Same as the keypad adapter's: hand to a new Claude Code session, or to a human collaborator. Pair with `README.md` for full onboarding.

Goes stale; either keep updated as the work evolves or delete when superseded.
