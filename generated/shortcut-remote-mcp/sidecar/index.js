#!/usr/bin/env node
// Shortcut Remote sidecar — listens to the adapter's HUD WebSocket and synthesizes
// macOS keystrokes for the active layer's bindings.
//
// The adapter owns layer state (1..4, advanced by K1 / retreated by K2) and
// broadcasts `layer_change` events. This sidecar mirrors that state and looks
// up per-layer keystrokes from `xppen-mappings.json` for K3-K11. K1/K2 are
// the layer-action keys (handled in the adapter, no synthesis here). K7/K8
// are hard-wired to SuperWhisper / Escape on every layer to keep muscle
// memory consistent regardless of which layer the device is on.
//
// Run: `node index.js`
// Stop: Ctrl+C / SIGTERM
//
// First run will trigger a macOS Accessibility permission prompt for `osascript`.
// Grant it once and synthesis works thereafter.

import WebSocket from "ws";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const HUD_WS = process.env.SHORTCUT_REMOTE_HUD ?? "ws://127.0.0.1:47832/events";
const HUD_PAGE = process.env.SHORTCUT_REMOTE_HUD_URL ?? "http://127.0.0.1:47832/";
const MAPPINGS_PATH = process.env.SHORTCUT_REMOTE_MAPPINGS
  ?? join(__dirname, "..", "adapter", "src", "xppen-mappings.json");

// ---------- Mapping load ----------
let mappings = null;
try {
  mappings = JSON.parse(readFileSync(MAPPINGS_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`[sidecar] failed to load mappings at ${MAPPINGS_PATH}: ${err.message}\n`);
  process.exit(1);
}

const LAYER_LABEL = { 1: "I", 2: "II", 3: "III", 4: "IV" };

// Map a (kind, bit) → K# label per the adapter's discovery:
//   primary bits 0-7 = K1..K8
//   secondary bits 0..2 = K9, K10, K11
function bitToKeyLabel(kind, bit) {
  if (kind === "primary") return `K${bit + 1}`;
  if (kind === "secondary") return `K${bit + 9}`;
  return null;
}

// ---------- Hard-wired bindings (consistent across all layers) ----------
// Per Mick (2026-05-02): K1 opens the HUD in the default browser, K7 fires
// SuperWhisper, K8 fires Escape — same on every layer regardless of what
// xppen-mappings.json says for those keys on each layer. Two action shapes
// are supported here: `{ command, args, label }` for shell invocation, or
// `{ mac_code, modifiers, label }` for keystroke synthesis.
const HARDWIRED = {
  K1: { command: "/usr/bin/open", args: [HUD_PAGE], label: `K1 → Open HUD (${HUD_PAGE})` },
  K7: { mac_code: 20, modifiers: ["option", "command"], label: "K7 → SuperWhisper (Opt+Cmd+3)" },
  K8: { mac_code: 53, modifiers: [], label: "K8 → Escape" },
};

// Keys whose semantic action is the layer change itself — emitted by the
// adapter as `layer_change` events; no keystroke from the sidecar. Only K2
// after the 2026-05-02 reassignment (K1 is now an Open-HUD action).
const LAYER_KEYS = new Set(["K2"]);

// ---------- Local layer mirror ----------
let currentLayer = 1; // 1..4; updated by `layer_change` events from the adapter

function logEvent(msg) {
  const t = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${t}] ${msg}\n`);
}

function modifiersFromKeystrokes(ks) {
  const out = [];
  for (const k of ks) {
    if (k.name === "Cmd") out.push("command");
    else if (k.name === "Option") out.push("option");
    else if (k.name === "Ctrl") out.push("control");
    else if (k.name === "Shift") out.push("shift");
  }
  return out;
}

function actionForKeyAtLayer(keyLabel, layer) {
  if (HARDWIRED[keyLabel]) return HARDWIRED[keyLabel];
  if (LAYER_KEYS.has(keyLabel)) return null; // adapter handles
  const label = LAYER_LABEL[layer];
  const layerEntry = mappings.layers?.[label];
  if (!layerEntry || layerEntry.enabled === false) return null;
  const keyEntry = layerEntry.keys?.[keyLabel];
  if (!keyEntry || !keyEntry.keystrokes || keyEntry.keystrokes.length === 0) return null;
  const ks = keyEntry.keystrokes;
  const main = ks.find((k) => !["Cmd", "Option", "Ctrl", "Shift"].includes(k.name));
  if (!main || typeof main.mac !== "number") return null;
  return {
    mac_code: main.mac,
    modifiers: modifiersFromKeystrokes(ks),
    label: `${keyLabel}@${label} → ${keyEntry.label ?? keyEntry.human_shortcut ?? `mac ${main.mac}`}`,
  };
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
      logEvent("! macOS Accessibility permission missing — grant via System Settings > Privacy & Security > Accessibility.");
    }
  }
}

function runCommand(action) {
  spawn(action.command, action.args, { stdio: "ignore", detached: true }).unref();
}

function performAction(action) {
  if (action.command) return runCommand(action);
  if (typeof action.mac_code === "number") return synthesizeKey(action);
  logEvent(`! action for "${action.label}" has no command or mac_code`);
}

function handleEvent(ev) {
  if (ev.kind === "layer_change") {
    if (typeof ev.layer === "number" && ev.layer >= 1 && ev.layer <= 4) {
      const prev = currentLayer;
      currentLayer = ev.layer;
      logEvent(`layer ${prev} → ${currentLayer} (source: ${ev.source ?? "?"})`);
    }
    return;
  }
  if (ev.kind !== "button_press") return;
  const fired = [
    ...(ev.new_primary_bits ?? []).map((b) => bitToKeyLabel("primary", b)),
    ...(ev.new_secondary_bits ?? []).map((b) => bitToKeyLabel("secondary", b)),
  ].filter(Boolean);
  for (const keyLabel of fired) {
    const action = actionForKeyAtLayer(keyLabel, currentLayer);
    if (!action) {
      if (LAYER_KEYS.has(keyLabel)) continue; // adapter-handled, expected silence
      logEvent(`. ${keyLabel}@${LAYER_LABEL[currentLayer]} — no binding`);
      continue;
    }
    logEvent(`→ ${action.label}`);
    performAction(action);
  }
}

let ws;
function connect() {
  ws = new WebSocket(HUD_WS);
  ws.on("open", () => logEvent(`connected to ${HUD_WS}`));
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
logEvent(`mappings: ${MAPPINGS_PATH}`);
logEvent(`hardwired: ${Object.entries(HARDWIRED).map(([k, v]) => `${k}=${v.label}`).join(", ")}`);
logEvent(`layer-action keys (no synthesis): ${[...LAYER_KEYS].join(", ")}`);
logEvent(`starting on layer ${currentLayer} (${LAYER_LABEL[currentLayer]})`);
connect();

process.on("SIGINT", () => { logEvent("shutting down"); ws?.close(); process.exit(0); });
process.on("SIGTERM", () => { logEvent("shutting down"); ws?.close(); process.exit(0); });
