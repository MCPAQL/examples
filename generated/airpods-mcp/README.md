# airpods-mcp

**MCP-AQL adapter for AirPods Pro head-tracking on macOS.**

A reference implementation of the MCP-AQL pattern applied to a non-HID sensor source: AirPods Pro's IMU, accessed via Apple's `CMHeadphoneMotionManager`. Companion to `shortcut-remote-mcp/` (HID-based JIT-discovered adapter); this one wraps a documented Apple framework instead.

Showcase artifact, not a product. Anyone with AirPods Pro + a Mac can run it.

---

## What it does

Streams head-pose data (yaw, pitch, roll, quaternion, rotation rate) from AirPods at ~25 Hz, behind a clean **MCP-AQL CRUDE surface** (`mcpaql_read`, `mcpaql_create`, `mcpaql_update`, `mcpaql_delete`) and a **live WebSocket HUD**. A bundled sidecar uses that data for **gaze-driven X-mouse-style window focus**: turn your head toward a window, that window gets keyboard focus.

Includes:

- A 10-anchor calibration capture (5 points per monitor)
- Drift mitigation (motion-gated 1-Euro smoothing + capped leaky integrator + manual recenter on hardware trigger)
- Window-level focus via `CGWindowListCopyWindowInfo` + `AXRaiseAction`
- A transparent click-through overlay blob that visualizes where the system thinks you're looking
- Optional multi-device composition: any external process can trigger recenter via `mcpaql_update.recenter` or `SIGUSR1` to the sidecar PID. (Example wiring with the [`shortcut-remote-mcp`](../shortcut-remote-mcp/) keypad adapter is documented below.)

---

## Architecture (three layers)

```
┌──────────────────────────────────────────────────────────────────┐
│ Layer 3 — your sidecar (consumer)                                │
│   sidecar/index.js — calibration interp, dwell, focus, blob      │
└──────────────────┬───────────────────────────────────────────────┘
                   │ WebSocket (live pose) and/or stdio MCP-AQL
┌──────────────────┴───────────────────────────────────────────────┐
│ Layer 2 — MCP-AQL adapter (the spec showcase)                    │
│   adapter/src/server.js — CRUDE ops, HUD, calibration storage    │
└──────────────────┬───────────────────────────────────────────────┘
                   │ TCP JSON-line stream
┌──────────────────┴───────────────────────────────────────────────┐
│ Layer 1 — motion source (Apple framework wrap)                   │
│   server/airpods-mcp-server.app — CMHeadphoneMotionManager       │
└──────────────────────────────────────────────────────────────────┘
```

The split between Layer 1 and Layer 2 is forced by macOS TCC: `CMHeadphoneMotionManager` requires a real `.app` bundle launched by LaunchServices to receive permission. The adapter is a separate Node process so the spec-grade MCP-AQL surface stays clean and reusable; the sidecar is a separate process again so user-specific behavior doesn't pollute the adapter.

You can use any of these three layers in isolation:
- Want raw pose data only? Connect to the motion source's TCP socket on `127.0.0.1:47833`.
- Want a clean MCP-AQL interface? Run the adapter; talk to it via stdio MCP or the HUD WebSocket.
- Want gaze-driven window focus out of the box? Run the sidecar.

---

## Operations (MCP-AQL CRUDE surface)

Schema: `adapter/src/schema.json`. Discover at runtime via:

```
mcpaql_read { operation: "introspect", params: { query: "operations" } }
```

| Endpoint | Operation | Description |
|---|---|---|
| read | `list_devices` | Status of motion source connection |
| read | `is_streaming` | Live health check (also detects audio-session-paused state) |
| read | `get_pose` | Latest pose sample |
| read | `wait_for_pose` | Block until next sample arrives |
| read | `get_recent_poses` | Ring buffer of last N samples |
| read | `get_calibration` | Persisted anchors + current offsets |
| read | `get_hud_url` | Live HUD URL (HTTP + WebSocket) |
| read | `get_provenance` | Adapter metadata, framework reference, TCC requirements |
| read | `is_sidecar_running` | Whether the bundled sidecar is currently alive (via PID file + signal 0) |
| create | `calibrate_point` | Capture current pose, save as named anchor |
| update | `recenter` | Atomic capture + offset against `main_center` |
| update | `set_offset` | Manual yaw/pitch offset override |
| delete | `clear_offsets` | Zero offsets |
| execute | `start_sidecar` | Spawn the bundled gaze-driven sidecar (idempotent) |
| execute | `stop_sidecar` | Terminate the sidecar referenced by its PID file |

Pose units: radians. Convention: positive yaw = head turned **left**, positive pitch = head tilted **up** (CMHMM convention).

---

## Install / Run

### Prerequisites

- macOS 14+ (Sonoma or later) — verified on 15.7.4
- AirPods Pro (1st or 2nd gen), AirPods Max, AirPods 3rd gen, or AirPods 4 with ANC
- Xcode command-line tools (for `swiftc`)
- Node 20+

### Build motion source (one-time)

```sh
cd server
mkdir -p airpods-mcp-server.app/Contents/MacOS
swiftc server.swift -o airpods-mcp-server.app/Contents/MacOS/airpods-mcp-server
cp Info.plist airpods-mcp-server.app/Contents/Info.plist
codesign --force --sign - --identifier org.mcpaql.airpods-mcp airpods-mcp-server.app
```

(Or use the prebuilt `airpods-mcp-server.app/` if it's already in the repo.)

### Build sidecar Swift helpers (one-time)

```sh
cd sidecar
swiftc window-at-point.swift  -o window-at-point
swiftc dwell-blob.swift       -o dwell-blob
swiftc move-cursor.swift      -o move-cursor
swiftc speak-pan.swift        -o speak-pan       -framework AVFoundation
swiftc activate-pid.swift     -o activate-pid
swiftc focus-on-display.swift -o focus-on-display
```

### Install Node dependencies (one-time)

The adapter and the sidecar are separate packages; each needs its own install.

```sh
( cd adapter && npm install )
( cd sidecar && npm install )
```

### Run everything

```sh
# 1. Start motion-source audio keeper (silent WAV loop — required, see "Pitfalls")
python3 -c "import struct;sr=44100;d=b'\x00'*(sr*2);open('/tmp/silent.wav','wb').write(b'RIFF'+struct.pack('<I',36+len(d))+b'WAVE'+b'fmt '+struct.pack('<IHHIIHH',16,1,1,sr,sr*2,2,16)+b'data'+struct.pack('<I',len(d))+d)"
( while true; do afplay -v 0.001 /tmp/silent.wav; done ) > /dev/null 2>&1 &

# 2. Launch motion source (via LaunchServices, NOT direct CLI — TCC requires this)
open server/airpods-mcp-server.app

# 3. (First time only) Capture 10-point calibration with audio cues
node calibrate/calibrate.js

# 4. Start the MCP-AQL adapter (write the PID file like start.sh does)
( cd adapter && exec nohup node src/server.js > /tmp/airpods-adapter.log 2>&1 < /dev/null ) &
echo $! > /tmp/airpods-adapter.pid
disown

# 5. Start the sidecar (X-mouse focus + dwell blob)
BLOB_FOLLOW=1 nohup node sidecar/index.js > /tmp/airpods-sidecar.log 2>&1 < /dev/null &
echo $! > /tmp/airpods-sidecar.pid
disown
```

The PID files are not optional bookkeeping: `stop.sh`, the adapter's
`is_sidecar_running` / `stop_sidecar` operations, the `kill -USR1` recenter
below, and the keypad passthrough all read them. `start.sh` writes them for
you — these manual steps must too.

After step 5, head-pose-to-window-focus is live. Open the HUD at `http://127.0.0.1:47834/` to see live pose data and adapter status. Call `mcpaql_update.recenter` (or `kill -USR1 $(cat /tmp/airpods-sidecar.pid)` from any source) when you want to realign.

### Optional: hardware-button recenter via the shortcut-remote-mcp keypad

If you've also installed [`shortcut-remote-mcp`](../shortcut-remote-mcp/) (its own adapter), you can wire one of its keypad buttons to trigger recenter. Add this entry to your keypad sidecar's `PASSTHROUGH` table (e.g., `secondary:2` for the XP-Pen wheel-center button K11):

```js
"secondary:2": {
  command: "/bin/sh",
  args: ["-c", "PID=$(cat /tmp/airpods-sidecar.pid 2>/dev/null); [ -n \"$PID\" ] && kill -USR1 $PID"],
  label: "K11 → AirPods recenter (SIGUSR1)",
},
```

The keypad sidecar must support shell-command actions in its passthrough table (recent versions do; see its README). The two adapters cooperate via Unix signals + a PID file — neither knows about the other directly.

---

## Pitfalls

### Audio session keep-alive is mandatory

`CMHeadphoneMotionManager` only delivers samples while audio is being routed through the AirPods. The silent-WAV loop in step 1 is what keeps the stream alive when no music or call is active. Without it, motion data dies after a few seconds of silence — silently, with no error.

### `.app` bundle and `open` are mandatory

Bare CLI binaries with embedded `Info.plist` (via `-sectcreate`) get killed by TCC even when ad-hoc signed. macOS attributes the request to the responsible parent process (your terminal). Solution: real bundle layout (`Contents/MacOS/<binary>` + `Contents/Info.plist` with `NSMotionUsageDescription`), ad-hoc sign, launch via `open` so LaunchServices is the responsible launcher.

### IMU drift

AirPods Pro head-tracking has ~1–2°/min gyro drift during stationary use. This is hardware, not a bug. Three layers of mitigation are baked into the sidecar:

1. **Motion-gated 1-Euro smoothing** — smoothed pose freezes when rotation rate is below threshold
2. **Capped leaky drift integrator** — absorbs apparent pose drift during stillness, with a per-sample cap to avoid over-correcting on breathing/posture micro-motion
3. **Manual recenter** — bind a hardware button to send `SIGUSR1` to the sidecar PID; sidecar runs a guided alignment mode (locks blob to MAIN center, captures pose, applies offset)

Don't promise pixel precision. Window-level focus is the right target.

### Multi-display calibration

The 10-point calibration assumes two displays (main landscape + secondary portrait). For other layouts, edit `calibrate/calibrate.js`'s `POINTS` array and the sidecar's region/seam logic.

---

## Files

```
airpods-mcp/
├── README.md                      ← this file
├── HANDOFF.md                     ← session continuity / lessons / what's open
├── adapter/                       ← MCP-AQL spec layer (Node)
│   ├── package.json
│   └── src/
│       ├── server.js              ← MCP server, HUD, calibration ops, source bridge
│       ├── schema.json            ← CRUDE operation schema
│       └── provenance.json        ← discovery method, framework, TCC requirements
├── server/                        ← Motion source (Swift .app, Apple framework wrap)
│   ├── server.swift
│   ├── Info.plist                 ← NSMotionUsageDescription
│   └── airpods-mcp-server.app/    ← Built bundle (ad-hoc signed)
├── sidecar/                       ← Sample consumer: gaze-driven X-mouse focus
│   ├── index.js                   ← Smoothing, dwell, classification, focus, blob
│   ├── window-at-point.swift      ← AX-raise + window query daemon
│   ├── dwell-blob.swift           ← Transparent overlay window
│   ├── move-cursor.swift          ← Cursor-warp daemon (optional)
│   ├── speak-pan.swift            ← Spatial-audio cue helper
│   ├── activate-pid.swift         ← (legacy) app-level activator
│   └── focus-on-display.swift     ← (legacy) monitor-level activator
├── calibrate/
│   ├── calibrate.js               ← One-shot 10-point calibration capture
│   ├── recenter.js                ← Verbose recenter (development tool)
│   └── recenter-quick.js          ← Silent 1s recenter (hardware-trigger-bound)
└── calibration.json               ← Persisted calibration anchors
```

---

## Status

**Working** — verified end-to-end on macOS 15.7.4 with AirPods Pro and a 4K landscape + portrait dual-monitor setup.

Adapter layer was built after the sidecar/source layers. The sidecar consumes the adapter's HUD WebSocket (`ws://127.0.0.1:47834/events`) — the three-layer architecture is complete end-to-end. The only remaining direct TCP consumer of port 47833 is `calibrate/calibrate.js`, which is appropriate: calibration is a one-shot tool that runs alongside the stack rather than a runtime consumer.

See `HANDOFF.md` for session-continuity context, the full lessons file, and what's still open.

---

## License

MCPAQL examples repo: split license. Spec content under CC BY 4.0; code under AGPL-3.0. See repo root.
