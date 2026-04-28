#!/usr/bin/env node
// Shortcut Remote sidecar — listens to the adapter's HUD WebSocket and synthesizes
// macOS keystrokes for configured passthrough buttons. Other button events (and
// wheel events) are not consumed here; the adapter's MCP layer / LLM still see them.
//
// Run: `node index.js`  (in a separate terminal from Claude Code)
// Stop: Ctrl+C
//
// First run will trigger a macOS Accessibility permission prompt for `osascript`
// (or whatever shell the script is launched from). Grant it once and synthesis works.

import WebSocket from "ws";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HUD_URL = process.env.SHORTCUT_REMOTE_HUD ?? "ws://127.0.0.1:47832/events";

// ---------- Passthrough table ----------
// Each key is "primary:<bit>" or "secondary:<bit>".
// Action fires on the *press* edge (transition from not-held to held).
// Mac key codes: https://eastmanreference.com/complete-list-of-applescript-key-codes
const PASSTHROUGH = {
  // K7 / K8 removed: device firmware sends Opt+Cmd+3 / Escape via interface 0 directly,
  // so our osascript synthesis was double-triggering. Firmware handles them now.
  // K11 (wheel-center) → SIGUSR1 to AirPods sidecar (starts calibration mode)
  "secondary:2": {
    command: "/bin/sh",
    args: [
      "-c",
      "PID=$(cat /tmp/airpods-sidecar.pid 2>/dev/null); [ -n \"$PID\" ] && kill -USR1 $PID && echo \"signaled airpods sidecar $PID\" || echo \"no airpods sidecar pid file\"",
    ],
    label: "K11 → AirPods calibration mode (SIGUSR1)",
  },
};

function runCommand(action) {
  spawn(action.command, action.args, { stdio: "ignore", detached: true }).unref();
}

function logEvent(msg) {
  const t = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${t}] ${msg}\n`);
}

async function synthesizeKey(action) {
  const using = action.modifiers.length
    ? ` using {${action.modifiers.map((m) => `${m} down`).join(", ")}}`
    : "";
  const script = `tell application "System Events" to key code ${action.mac_code}${using}`;
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 5000 });
  } catch (err) {
    logEvent(`! synthesis failed for "${action.label}": ${err?.stderr ?? err.message}`);
    if (String(err.stderr ?? "").includes("not allowed assistive access")) {
      logEvent("! macOS Accessibility permission missing for this terminal/Node — grant via System Settings > Privacy & Security > Accessibility.");
    }
  }
}

function handleEvent(ev) {
  if (ev.kind !== "button_press") return;
  const fired = [
    ...(ev.new_primary_bits ?? []).map((b) => `primary:${b}`),
    ...(ev.new_secondary_bits ?? []).map((b) => `secondary:${b}`),
  ];
  for (const key of fired) {
    const action = PASSTHROUGH[key];
    if (!action) continue;
    logEvent(`→ ${action.label}`);
    if (action.command) runCommand(action);
    else synthesizeKey(action);
  }
}

let ws;
function connect() {
  ws = new WebSocket(HUD_URL);
  ws.on("open", () => logEvent(`connected to ${HUD_URL}`));
  ws.on("message", (data) => {
    try { handleEvent(JSON.parse(data.toString())); } catch (err) { /* ignore parse errors */ }
  });
  ws.on("error", (err) => logEvent(`ws error: ${err.message}`));
  ws.on("close", () => {
    logEvent("disconnected — reconnecting in 1s");
    setTimeout(connect, 1000);
  });
}

logEvent("Shortcut Remote sidecar starting");
logEvent(`passthrough: ${Object.entries(PASSTHROUGH).map(([k, v]) => `${k}=${v.label}`).join(", ")}`);
connect();

process.on("SIGINT", () => { logEvent("shutting down"); ws?.close(); process.exit(0); });
process.on("SIGTERM", () => { logEvent("shutting down"); ws?.close(); process.exit(0); });
