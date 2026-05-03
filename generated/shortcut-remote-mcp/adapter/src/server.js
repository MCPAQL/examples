#!/usr/bin/env node
// JIT-generated MCP-AQL adapter for Hanvon Ugee Shortcut Remote (0x28bd:0x0202).
// Hand-built but follows the shape that adapter-generator emits, with native-hid transport.

import HID from "node-hid";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { watch, statSync, existsSync, unlinkSync } from "node:fs";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, "schema.json"), "utf8"));
const provenance = JSON.parse(readFileSync(join(__dirname, "provenance.json"), "utf8"));
const HUD_HTML_PATH = join(__dirname, "hud.html");
// Initial cached read for a fast first request; per-request read below picks up later changes.
let _hudHtmlCache = readFileSync(HUD_HTML_PATH, "utf8");
function getHudHtml() {
  // Re-read on every request so edits to hud.html are live without a server restart.
  try { _hudHtmlCache = readFileSync(HUD_HTML_PATH, "utf8"); } catch {}
  return _hudHtmlCache;
}
const XPPEN_MAPPINGS_PATH = join(__dirname, "xppen-mappings.json");
function getXppenMappings() {
  try { return JSON.parse(readFileSync(XPPEN_MAPPINGS_PATH, "utf8")); } catch { return null; }
}

// ---------- Unified loopback HTTP server on 127.0.0.1:<port> ----------
// Hosts three concerns on one process so HID singleton + HUD + MCP coexist:
//   GET  /                       → HUD HTML
//   GET  /xppen-mappings.json    → mappings consumed by the HUD
//   WS   /events                 → broadcast to HUD + sidecar + kill switch
//   POST/GET/DELETE /mcp         → streamable-HTTP MCP transport (stateful, per-session)
// Bind is always 127.0.0.1; loopback trust model means no auth here. If you
// ever expose this beyond loopback, add OAuth — see MCPAQL/adapter-generator#30.
const HUD_PORT = Number(process.env.SHORTCUT_REMOTE_HUD_PORT ?? 47832);
const wsClients = new Set();
let hudUrl = null;
// One transport+Server per MCP session. The Server class is single-init by
// design, so each session needs its own. Shared device state (HID handle, ring
// buffer, press waiters) lives at module scope and is referenced by the
// per-session handlers via closure — exactly what we want for a singleton
// device fan-out across multiple concurrent clients.
const mcpTransports = new Map(); // sessionId -> StreamableHTTPServerTransport

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function mcpJsonError(res, status, code, message, id = null) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }));
}

// ---------- HUD-driven server controls ----------
// Replaces the old menu-bar Kill Switch app. The HUD has buttons that POST
// here. We respond first, then schedule the actual lifecycle operation a
// few ticks later so the response flushes before the process dies.

const LAUNCHD_LABEL = "org.mcpaql.shortcut-remote";
const LAUNCHD_TARGET = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
const SERVER_STARTED_AT = Date.now();

function controlOk(res, body) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleControlRestart(req, res) {
  process.stderr.write(`[control] restart requested via HUD\n`);
  controlOk(res, { action: "restart", note: "kicking back through launchd" });
  // Detached child outlives this process; launchctl kickstart -k SIGKILLs us
  // and brings the job up fresh.
  setTimeout(() => {
    spawn("/bin/launchctl", ["kickstart", "-k", LAUNCHD_TARGET], { stdio: "ignore", detached: true }).unref();
  }, 100);
}

async function handleControlStop(req, res) {
  process.stderr.write(`[control] stop requested via HUD\n`);
  controlOk(res, { action: "stop", note: "clean exit; launchd will not restart (RunAtLoad still applies at next login)" });
  setTimeout(() => cleanShutdown(), 100);
}

async function handleControlDisable(req, res) {
  process.stderr.write(`[control] DISABLE requested via HUD — will not restart at next login\n`);
  controlOk(res, {
    action: "disable",
    note: "Disabled. To re-enable: launchctl enable " + LAUNCHD_TARGET + " && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/" + LAUNCHD_LABEL + ".plist",
  });
  // Disable first (so KeepAlive doesn't restart us) then bootout. Run as a
  // detached shell so it survives our death.
  setTimeout(() => {
    const cmd = `/bin/launchctl disable ${LAUNCHD_TARGET} && /bin/launchctl bootout ${LAUNCHD_TARGET}`;
    spawn("/bin/sh", ["-c", cmd], { stdio: "ignore", detached: true }).unref();
  }, 100);
}

// ---------- Voice command pipeline ----------
// SuperWhisper (or any other STT) POSTs transcribed text here. The adapter
// broadcasts the receive event for the HUD, then spawns `claude -p` with a
// smart prompt. Claude connects back to this same MCP server (already in
// ~/.claude.json) and calls mcpaql_update tools to reconfigure. Each tool
// call broadcasts its own change event — so the HUD shows the live diff.
//
// Body shape: either plain text (Content-Type: text/plain) or JSON
//   { "text": "set wheel to volume up volume down" }
//
// Throttle: only one voice command in flight at a time. Late ones get 429.

let voiceCommandInFlight = false;

const VOICE_SYSTEM_PROMPT = `You are managing a live MCP-AQL adapter for an XP-Pen Shortcut Remote keypad.

The user has spoken a voice command (transcribed below). Use the **shortcut-remote** MCP server's mcpaql_update tools to reconfigure the keypad. After making changes, ALWAYS call \`post_annotation\` with a one-line summary so the user sees what happened in the HUD.

# Action shapes for set_wheel_binding (cw / ccw can each be one of):

1. **Keystroke** — \`{ mac_code: number, modifiers: string[], label: string }\`
   Use for: things that are literally a keyboard shortcut in the active app (zoom, copy, undo, browser tab nav, arrow keys, etc.). Modifiers are a subset of \`["command", "option", "control", "shift"]\` — **always include the array, even if empty**.

2. **AppleScript** — \`{ applescript: "<code>", label: string }\`
   Use for: system-level actions that AREN'T keystrokes — volume, brightness, mute, music transport, app launching, anything where a key code wouldn't reach the right handler. PREFER this shape for system controls; mac_code F-keys (111, 109, etc.) often don't reach volume on most setups.

3. **Shell command** — \`{ command: "/path/to/bin", args: ["..."], label: string }\`
   Use for: launching binaries (\`/usr/bin/open\`, custom CLI tools). Rarely needed; AppleScript can usually do this via \`do shell script\`.

# AppleScript recipes for common system actions:

- **Volume up by 6%:** \`set volume output volume ((output volume of (get volume settings)) + 6)\`
- **Volume down by 6%:** \`set volume output volume ((output volume of (get volume settings)) - 6)\`
- **Mute toggle:** \`set volume with output muted (not (output muted of (get volume settings)))\`
- **Brightness up/down:** \`tell application "System Events" to key code 144\` (up) / 145 (down) — these ARE the magic NX codes for brightness.
- **Music next/prev:** \`tell application "Music" to next track\` / \`previous track\`

# Common mac_code values (for keystroke shape):

- Zoom in/out: 24 = \`=\`, 27 = \`-\` (with command)
- Page up/down: 116, 121
- Arrows: 123 left, 124 right, 125 down, 126 up
- Browser tab nav: 33 = \`[\`, 30 = \`]\` (with command + shift)
- Undo/redo: 6 = \`z\` (with command, optionally with shift)

# DollhouseMCP (optional — only when the user mentions it)

The **dollhousemcp** MCP server is also available. If the user mentions a persona, skill, agent, or other Dollhouse element by name, you may use it. Allowed Dollhouse tools (read / create / update only):

- \`mcp__dollhousemcp__mcp_aql_read\` — discover elements AND **activate** them (in DollhouseMCP, activating an element is a read-state operation, not a mutation).
- \`mcp__dollhousemcp__mcp_aql_create\` — create new elements when synthesizing a configuration.
- \`mcp__dollhousemcp__mcp_aql_update\` — modify an existing element's parameters.

You do NOT have access to Dollhouse delete or execute. If the user asks for either, post an annotation explaining it's not enabled in the voice loop and stop.

Voice commands may combine wheel/keypad reconfiguration AND a Dollhouse element ("switch the wheel to brightness AND activate focus-mode persona"). Do BOTH, then post ONE annotation summarising both changes.

# Be brief

Make the change, post the annotation, exit. Don't ask follow-ups.`;

// Kickoff helper: broadcast received-event, spawn `claude -p`, manage the
// in-flight flag and the done-event broadcast. Returns true if accepted, false
// if rejected (e.g., a voice command already in flight). Used by both the
// HTTP /voice-command handler and the SuperWhisper recordings-folder watcher.
function triggerVoiceCommand(text, source) {
  text = String(text ?? "").trim();
  if (!text) return { accepted: false, reason: "empty text" };
  if (voiceCommandInFlight) return { accepted: false, reason: "command in flight" };
  voiceCommandInFlight = true;
  process.stderr.write(`[voice] received (${source}): ${text}\n`);
  const ts = Date.now();
  const recvEv = { ts, kind: "voice_command_received", text, source };
  pushEvent(recvEv);
  hudBroadcast(recvEv);
  broadcastAnnotation({ text: "Asking Claude…", fields: { voice: text }, style: "info" }, "voice-pipeline");
  const claudeBin = process.env.VOICE_CLAUDE_BIN ?? "/opt/homebrew/bin/claude";
  // --allowedTools: claude -p has no human in the loop to approve tool calls,
  // so without an explicit allowlist Claude responds with text only and never
  // actually calls set_wheel_binding. We name the MCP tools explicitly:
  //   - shortcut-remote: read + update (this adapter's own ops)
  //   - dollhousemcp:    read + create + update (delete/execute deferred per
  //                       MCPAQL/examples#34 — execute opens agentic chain-
  //                       spawning and needs deliberate gating; delete is too
  //                       easy to mis-transcribe)
  // Every other tool still goes through normal permission checks (and any
  // PreToolUse hooks the user has configured), so a malicious or confused LLM
  // cannot escape the configured surface.
  const ALLOWED_TOOLS = (
    process.env.VOICE_ALLOWED_TOOLS ??
    [
      "mcp__shortcut-remote__mcpaql_read",
      "mcp__shortcut-remote__mcpaql_update",
      "mcp__dollhousemcp__mcp_aql_read",
      "mcp__dollhousemcp__mcp_aql_create",
      "mcp__dollhousemcp__mcp_aql_update",
    ].join(" ")
  );
  // Argv ordering matters: --allowedTools is variadic and will swallow the
  // prompt if it follows. Put the prompt right after -p (so claude consumes
  // it as the print prompt) and the allowlist at the end.
  const child = spawn(
    claudeBin,
    [
      "-p",
      `${VOICE_SYSTEM_PROMPT}\n\n---\n\nUser voice command:\n${text}`,
      "--allowedTools", ALLOWED_TOOLS,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdoutBuf = "", stderrBuf = "";
  child.stdout.on("data", (d) => { stdoutBuf += d.toString("utf8"); });
  child.stderr.on("data", (d) => { stderrBuf += d.toString("utf8"); });
  child.on("error", (err) => {
    voiceCommandInFlight = false;
    process.stderr.write(`[voice] claude spawn failed: ${err.message}\n`);
    broadcastAnnotation({ text: "Claude failed to start", fields: { error: err.message, hint: "Is the `claude` CLI installed? Try `which claude`." }, style: "error" }, "voice-pipeline");
  });
  child.on("close", (code) => {
    voiceCommandInFlight = false;
    const trimmed = stdoutBuf.trim().slice(0, 800);
    process.stderr.write(`[voice] claude exit ${code}; stdout=${stdoutBuf.length}b stderr=${stderrBuf.length}b\n`);
    const doneEv = { ts: Date.now(), kind: "voice_command_done", exit_code: code, response: trimmed, source: "voice-pipeline" };
    pushEvent(doneEv);
    hudBroadcast(doneEv);
    if (code !== 0) {
      broadcastAnnotation({ text: `Claude exited with code ${code}`, fields: { stderr: stderrBuf.trim().slice(0, 300) }, style: "error" }, "voice-pipeline");
    } else if (trimmed) {
      broadcastAnnotation({ text: trimmed, fields: { voice: text }, style: "info" }, "claude");
    }
  });
  return { accepted: true };
}

async function handleVoiceCommand(req, res) {
  let bodyText = "";
  await new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { bodyText = Buffer.concat(chunks).toString("utf8"); resolve(); });
    req.on("error", resolve);
  });
  let text = bodyText.trim();
  if (text.startsWith("{")) {
    try { const j = JSON.parse(text); if (typeof j.text === "string") text = j.text.trim(); } catch {}
  }
  const r = triggerVoiceCommand(text, req.headers["x-source"] ?? "http");
  if (r.accepted) return controlOk(res, { received: true, text });
  if (r.reason === "empty text") return controlOk(res.writeHead(400, { "Content-Type": "application/json" }), { error: "empty voice command" });
  return controlOk(res.writeHead(429, { "Content-Type": "application/json" }), { error: "voice command in flight; try again in a moment" });
}

// ---------- SuperWhisper recordings-folder watcher ----------
// SuperWhisper 2.13 dropped the per-mode `script` UI, so we get the transcript
// out by watching the standard recordings folder. Each completed transcription
// writes a meta.json with `modeName` and `rawResult`. We only act on the
// "Shortcut Remote command" mode and ignore everything else.
//
// As a side effect of this watcher firing, we also restore SuperWhisper's
// previous mode (saved by tools/k11-voice-trigger.sh) and clear the K11 lock
// — those used to live in the per-mode script we no longer have.

const SW_RECORDINGS_DIR = process.env.SW_RECORDINGS_DIR
  ?? join(process.env.HOME ?? "/", "Documents", "superwhisper", "recordings");
const SW_VOICE_MODE_NAME = process.env.SW_VOICE_MODE_NAME ?? "Shortcut Remote command";
const SW_LOCK_FILE = "/tmp/sr-voice-recording";
const SW_PREV_MODE_FILE = "/tmp/sr-prev-mode";
const seenMetaPaths = new Set();

function processSuperWhisperMeta(metaPath, attempt = 0) {
  if (seenMetaPaths.has(metaPath)) return;
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (err) {
    if (attempt < 30) {
      // File might be mid-write (truncated JSON). Try again shortly.
      setTimeout(() => processSuperWhisperMeta(metaPath, attempt + 1), 1000);
      return;
    }
    process.stderr.write(`[sw-watch] couldn't parse ${metaPath} after ${attempt}s: ${err.message}\n`);
    seenMetaPaths.add(metaPath);
    return;
  }
  if (meta.modeName !== SW_VOICE_MODE_NAME) {
    // Not our mode — ignore permanently.
    seenMetaPaths.add(metaPath);
    return;
  }
  const text = String(meta.rawResult ?? meta.result ?? "").trim();
  if (!text) {
    // Transcript not written yet. SuperWhisper creates meta.json early with
    // an empty rawResult and fills it in after transcription completes; the
    // gap can be several seconds. Retry up to 30s before giving up.
    if (attempt < 30) {
      setTimeout(() => processSuperWhisperMeta(metaPath, attempt + 1), 1000);
      return;
    }
    process.stderr.write(`[sw-watch] empty transcript in ${metaPath} after ${attempt}s; giving up\n`);
    seenMetaPaths.add(metaPath);
    return;
  }
  seenMetaPaths.add(metaPath);
  process.stderr.write(`[sw-watch] new transcript from "${meta.modeName}" (waited ${attempt}s): ${text.slice(0, 80)}…\n`);
  triggerVoiceCommand(text, "sw-recordings-watch");

  // Cleanup the K11 helper's leftovers.
  try { unlinkSync(SW_LOCK_FILE); } catch {}
  try {
    const prev = readFileSync(SW_PREV_MODE_FILE, "utf8").trim();
    if (prev) {
      spawn("/usr/bin/open", [`superwhisper://mode?key=${prev}`], { stdio: "ignore", detached: true }).unref();
      unlinkSync(SW_PREV_MODE_FILE);
      process.stderr.write(`[sw-watch] restored SuperWhisper mode: ${prev}\n`);
    }
  } catch {}
}

function startSuperWhisperWatcher() {
  if (!existsSync(SW_RECORDINGS_DIR)) {
    process.stderr.write(`[sw-watch] ${SW_RECORDINGS_DIR} not found; voice pipeline disabled\n`);
    return;
  }
  process.stderr.write(`[sw-watch] watching ${SW_RECORDINGS_DIR} for "${SW_VOICE_MODE_NAME}" recordings\n`);
  // Non-recursive watch on the parent dir — we get notified on each new
  // subdirectory. For each new subdir, set up a brief secondary watch for its
  // meta.json (which appears after transcription completes, ~seconds later).
  // Avoids the cost of recursive-watching the user's massive recordings backlog.
  watch(SW_RECORDINGS_DIR, (event, filename) => {
    if (!filename) return;
    const subdirPath = join(SW_RECORDINGS_DIR, filename);
    let stat;
    try { stat = statSync(subdirPath); } catch { return; }
    if (!stat.isDirectory()) return;
    waitForMetaJson(subdirPath);
  });
}

function waitForMetaJson(dirpath) {
  const metaPath = join(dirpath, "meta.json");
  // If meta.json is already there (recording was very short, or we missed
  // the initial create), process it immediately.
  if (existsSync(metaPath)) {
    setTimeout(() => processSuperWhisperMeta(metaPath), 100);
    return;
  }
  // Otherwise watch the dir until meta.json shows up, with a 2-minute timeout
  // to avoid leaking watchers on cancelled recordings.
  let watcher;
  try {
    watcher = watch(dirpath, (event, fname) => {
      if (fname !== "meta.json") return;
      try { watcher.close(); } catch {}
      setTimeout(() => processSuperWhisperMeta(metaPath), 100);
    });
  } catch (err) {
    process.stderr.write(`[sw-watch] couldn't watch ${dirpath}: ${err.message}\n`);
    return;
  }
  setTimeout(() => { try { watcher.close(); } catch {} }, 120000);
}

function handleControlStatus(req, res) {
  controlOk(res, {
    label: LAUNCHD_LABEL,
    pid: process.pid,
    uptime_ms: Date.now() - SERVER_STARTED_AT,
    hud_url: hudUrl,
    current_layer: state.currentLayer,
    current_layer_label: ["I", "II", "III", "IV"][state.currentLayer - 1] ?? null,
    wheel_value: state.wheelValue,
    open_sessions: mcpTransports.size,
    device_open: state.device !== null,
  });
}

async function handleMcpRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  try {
    if (req.method === "POST") {
      let body;
      try { body = await readJsonBody(req); }
      catch (err) { return mcpJsonError(res, 400, -32700, `Invalid JSON: ${err.message}`); }
      if (sessionId && mcpTransports.has(sessionId)) {
        return await mcpTransports.get(sessionId).handleRequest(req, res, body);
      }
      if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            mcpTransports.set(sid, transport);
            process.stderr.write(`[mcp] session opened: ${sid}\n`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && mcpTransports.delete(sid)) {
            process.stderr.write(`[mcp] session closed: ${sid}\n`);
          }
        };
        const server = createMcpServer();
        await server.connect(transport);
        return await transport.handleRequest(req, res, body);
      }
      return mcpJsonError(res, 400, -32000, "Bad Request: missing or unknown mcp-session-id");
    }
    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !mcpTransports.has(sessionId)) {
        return mcpJsonError(res, 400, -32000, "Bad Request: missing or unknown mcp-session-id");
      }
      return await mcpTransports.get(sessionId).handleRequest(req, res);
    }
    res.writeHead(405, { "Allow": "GET, POST, DELETE" }).end();
  } catch (err) {
    process.stderr.write(`[mcp] handleRequest error: ${err?.message ?? err}\n`);
    if (!res.headersSent) mcpJsonError(res, 500, -32603, "Internal MCP transport error");
  }
}

if (HUD_PORT > 0) {
  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getHudHtml());
    } else if (url === "/xppen-mappings.json") {
      const data = getXppenMappings();
      if (!data) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } else if (url === "/mcp" || url.startsWith("/mcp?")) {
      await handleMcpRequest(req, res);
    } else if (url === "/control/restart" && req.method === "POST") {
      await handleControlRestart(req, res);
    } else if (url === "/control/stop" && req.method === "POST") {
      await handleControlStop(req, res);
    } else if (url === "/control/disable" && req.method === "POST") {
      await handleControlDisable(req, res);
    } else if (url === "/control/status" && req.method === "GET") {
      handleControlStatus(req, res);
    } else if (url === "/voice-command" && req.method === "POST") {
      await handleVoiceCommand(req, res);
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ server: httpServer, path: "/events" });
  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("close", () => wsClients.delete(ws));
    ws.on("error", () => wsClients.delete(ws));
    // Snapshot current state to a freshly-connected client so HUD comes up
    // in sync (no need to wait for the next event).
    try {
      const ts = Date.now();
      ws.send(JSON.stringify({ ts, kind: "layer_change", layer: state.currentLayer, source: "snapshot" }));
      ws.send(JSON.stringify({ ts, kind: "wheel_state", value: state.wheelValue, source: "snapshot" }));
      ws.send(JSON.stringify({ ts, kind: "wheel_binding_change", binding: state.wheelBinding, source: "snapshot" }));
      if (state.lastAnnotation !== null) {
        ws.send(JSON.stringify({ ts, kind: "annotation", payload: state.lastAnnotation, source: "snapshot" }));
      }
    } catch {}
  });
  httpServer.on("error", (err) => {
    process.stderr.write(`[hud] http server error: ${err.message}\n`);
  });
  httpServer.listen(HUD_PORT, "127.0.0.1", () => {
    hudUrl = `http://127.0.0.1:${HUD_PORT}/`;
    process.stderr.write(`[hud] listening at ${hudUrl}\n`);
  });
}
function hudBroadcast(event) {
  if (wsClients.size === 0) return;
  const json = JSON.stringify(event);
  for (const ws of wsClients) {
    try { ws.send(json); } catch {}
  }
}

const VENDOR_ID = schema.target.vendor_id;
const PRODUCT_ID = schema.target.product_id;
const MIN_USAGE_PAGE = schema.target.interface_filter.min_usage_page;

const TOOL_NAME_BY_ENDPOINT = {
  CREATE: "mcpaql_create",
  READ: "mcpaql_read",
  UPDATE: "mcpaql_update",
  DELETE: "mcpaql_delete",
  EXECUTE: "mcpaql_execute",
};

const TOOL_BY_OPERATION = new Map();
for (const [endpoint, ops] of Object.entries(schema.operations)) {
  for (const op of ops ?? []) {
    TOOL_BY_OPERATION.set(op.name, { endpoint: endpoint.toUpperCase(), definition: op });
  }
}

// ---------- Device state ----------
const RING_CAPACITY = 1000;
const LAYER_COUNT = 4; // XP-Pen Shortcut Remote has 4 layers (I/II/III/IV)
const state = {
  device: null,
  devicePath: null,
  deviceInfo: null,
  lastButtonReport: null,
  lastBatteryReport: null,
  lastPrimaryBitmap: 0,
  lastSecondaryBitmap: 0,
  events: [], // ring buffer
  pressWaiters: [],
  // Current layer (1..LAYER_COUNT). The adapter is the single source of truth
  // for layer state — K1/K2 advance/retreat, broadcasts go to HUD + sidecar +
  // any MCP client subscribing via get_recent_events. MCP clients can also
  // read it via get_current_layer or change it via set_current_layer.
  currentLayer: 1,
  // Wheel value: integer counter advanced by CW ticks, retreated by CCW ticks.
  // The adapter does not synthesize keystrokes for the wheel — wheel + K11
  // (wheel-center button) are reserved as an AI input surface. MCP clients can
  // read the value, mutate it, and post back annotations to be displayed in
  // the HUD overlay (so the LLM's interpretation is visible to the user in
  // real time as they spin the knob).
  wheelValue: 0,
  // Most recent annotation posted by an MCP client (broadcast on the WS as
  // an `annotation` event, surfaced in the HUD overlay). Cleared by passing
  // an empty payload. Free-form structure: { text?, fields?, style? }.
  lastAnnotation: null,
  // Mutable wheel binding. null = pure AI input surface (no synthesis;
  // wheel_state events go to LLM via MCP). Object form:
  //   { cw: { mac_code, modifiers, label }, ccw: {...}, label: "human label" }
  // When set, CW/CCW ticks fire the bound keystroke immediately AND continue
  // emitting wheel_state events so the LLM can still observe. The intent: an
  // LLM (or the user) can repurpose the wheel at runtime without touching code.
  wheelBinding: null,
};

// ---------- Keystroke / shell dispatch (formerly the sidecar) ----------
// Folded into the adapter on 2026-05-02. Same osascript path that needs
// macOS Accessibility permission; granted to /opt/homebrew/bin/node (or
// whatever runs this server) — one-time prompt, then it just works.

const HUD_PAGE_URL = `http://127.0.0.1:${Number(process.env.SHORTCUT_REMOTE_HUD_PORT ?? 47832)}/`;

// Hard-wired actions (always fire, regardless of layer):
//   K1  → focus an already-open HUD tab (via WS broadcast that triggers a
//         reload), else `/usr/bin/open` to launch a new tab.
//   K7  → SuperWhisper default mode (Opt+Cmd+3 — dictates to cursor).
//   K8  → Escape.
//   K11 → Triggers the SuperWhisper "Shortcut Remote command" mode and starts
//         recording. SuperWhisper 2.10 has no per-mode hotkeys, but it does
//         support a `superwhisper://` URL scheme: fire `mode?key=custom` to
//         switch, then `record` to start. The mode itself has its `script`
//         field set to a shell heredoc that curl-POSTs the transcript to
//         /voice-command (see ~/Documents/superwhisper/modes/custom.json).
//         Also still emits `command_request` event for other consumers.
const HARDWIRED_ACTIONS = {
  K1:  { kind: "open_hud", label: `K1 → Open / focus HUD (${HUD_PAGE_URL})` },
  K7:  { mac_code: 20, modifiers: ["option", "command"], label: "K7 → SuperWhisper (Opt+Cmd+3)" },
  K8:  { mac_code: 53, modifiers: [], label: "K8 → Escape" },
  K11: {
    command: join(__dirname, "..", "..", "tools", "k11-voice-trigger.sh"),
    args: [],
    label: "K11 → SuperWhisper voice command (one-shot mode)",
  },
};
// Layer-action keys: handled separately (advance layer); no synthesis.
const LAYER_ACTION_KEYS = new Set(["K2"]);
const LAYER_LABEL_BY_NUM = { 1: "I", 2: "II", 3: "III", 4: "IV" };

function bitToKeyLabel(kind, bit) {
  if (kind === "primary") return `K${bit + 1}`;
  if (kind === "secondary") return `K${bit + 9}`;
  return null;
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
  if (HARDWIRED_ACTIONS[keyLabel]) return HARDWIRED_ACTIONS[keyLabel];
  if (LAYER_ACTION_KEYS.has(keyLabel)) return null;
  const mappings = getXppenMappings();
  if (!mappings) return null;
  const layerLabel = LAYER_LABEL_BY_NUM[layer];
  const layerEntry = mappings.layers?.[layerLabel];
  if (!layerEntry || layerEntry.enabled === false) return null;
  const keyEntry = layerEntry.keys?.[keyLabel];
  if (!keyEntry || !keyEntry.keystrokes || keyEntry.keystrokes.length === 0) return null;
  const ks = keyEntry.keystrokes;
  const main = ks.find((k) => !["Cmd", "Option", "Ctrl", "Shift"].includes(k.name));
  if (!main || typeof main.mac !== "number") return null;
  return {
    mac_code: main.mac,
    modifiers: modifiersFromKeystrokes(ks),
    label: `${keyLabel}@${layerLabel} → ${keyEntry.label ?? keyEntry.human_shortcut ?? `mac ${main.mac}`}`,
  };
}

async function synthesizeKey(action) {
  const mods = Array.isArray(action.modifiers) ? action.modifiers : [];
  const using = mods.length
    ? ` using {${mods.map((m) => `${m} down`).join(", ")}}`
    : "";
  const script = `tell application "System Events" to key code ${action.mac_code}${using}`;
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 5000 });
  } catch (err) {
    process.stderr.write(`[synth] failed for "${action.label}": ${err?.stderr ?? err.message}\n`);
    if (String(err.stderr ?? "").includes("not allowed assistive access")) {
      process.stderr.write("[synth] macOS Accessibility permission missing — grant to node via System Settings > Privacy & Security > Accessibility.\n");
    }
  }
}

function runShellCommand(action) {
  spawn(action.command, action.args, { stdio: "ignore", detached: true }).unref();
}

async function runAppleScript(action) {
  // System actions like volume / brightness / app control aren't keystrokes —
  // they need AppleScript. Action shape: { applescript: "<code>", label }.
  const script = String(action.applescript ?? "");
  if (!script) {
    process.stderr.write(`[applescript] empty script for "${action.label}"\n`);
    return;
  }
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 5000 });
  } catch (err) {
    process.stderr.write(`[applescript] failed for "${action.label}": ${err?.stderr ?? err.message}\n`);
  }
}

function performAction(action) {
  // Defense in depth: a malformed action object (e.g. an LLM-generated wheel
  // binding missing `modifiers`) must never crash the daemon. Catch sync
  // throws here; the async helpers handle their own errors.
  try {
    if (action.kind === "open_hud") return openOrFocusHud();
    if (action.applescript) return runAppleScript(action);
    if (action.command) return runShellCommand(action);
    if (typeof action.mac_code === "number") return synthesizeKey(action);
    process.stderr.write(`[synth] action for "${action.label}" has no recognized shape\n`);
  } catch (err) {
    process.stderr.write(`[synth] performAction error for "${action?.label ?? "?"}": ${err?.message ?? err}\n`);
  }
}

function openOrFocusHud() {
  // If any HUD tabs are currently connected on the /events WS, send them a
  // hud_focus event — the page reloads itself, which both refreshes state
  // and (in most browsers) gives a visible signal that K1 was pressed.
  // If nothing's listening, fall back to `open` to launch a fresh tab.
  if (wsClients.size > 0) {
    process.stderr.write(`[hud] focus broadcast to ${wsClients.size} client(s)\n`);
    hudBroadcast({ ts: Date.now(), kind: "hud_focus", source: "K1" });
    return;
  }
  process.stderr.write(`[hud] no clients connected; opening fresh tab\n`);
  spawn("/usr/bin/open", [HUD_PAGE_URL], { stdio: "ignore", detached: true }).unref();
}

function dispatchKeyPress(keyLabel) {
  const action = actionForKeyAtLayer(keyLabel, state.currentLayer);
  if (!action) return; // layer-action keys, unbound keys, wheel/K11 (AI surface) — all silent here
  process.stderr.write(`[synth] → ${action.label}\n`);
  performAction(action);
}

function broadcastWheelState(source) {
  const ts = Date.now();
  const ev = { ts, kind: "wheel_state", value: state.wheelValue, source };
  pushEvent(ev);
  hudBroadcast(ev);
  return ev;
}

function broadcastAnnotation(payload, source) {
  const ts = Date.now();
  state.lastAnnotation = payload;
  const ev = { ts, kind: "annotation", payload, source };
  pushEvent(ev);
  hudBroadcast(ev);
  return ev;
}

function broadcastWheelBindingChange(source) {
  const ts = Date.now();
  const ev = { ts, kind: "wheel_binding_change", binding: state.wheelBinding, source };
  pushEvent(ev);
  hudBroadcast(ev);
  return ev;
}

function broadcastCommandRequest(source) {
  const ts = Date.now();
  const ev = { ts, kind: "command_request", source };
  pushEvent(ev);
  hudBroadcast(ev);
  return ev;
}

function broadcastLayerChange(newLayer, source) {
  const ts = Date.now();
  state.currentLayer = newLayer;
  const ev = { ts, kind: "layer_change", layer: newLayer, source };
  pushEvent(ev);
  hudBroadcast(ev);
  return ev;
}

function advanceLayer(source) {
  return broadcastLayerChange((state.currentLayer % LAYER_COUNT) + 1, source);
}

function pushEvent(ev) {
  state.events.push(ev);
  if (state.events.length > RING_CAPACITY) state.events.splice(0, state.events.length - RING_CAPACITY);
}

function decodeReport(buf) {
  // Vendor 12-byte report layout discovered observationally:
  //   [0]=report_id (0x02), [1]=type (0xf0=button/wheel, 0xf2=battery)
  //   [2]=primary button bitmap, [3]=secondary button bitmap
  //   [7]=wheel direction (0x01=cw, 0x02=ccw)
  const bytes = Array.from(buf);
  if (bytes[0] !== 0x02) return { kind: "unknown", bytes };
  if (bytes[1] === 0xf0) {
    const primary = bytes[2] ?? 0;
    const secondary = bytes[3] ?? 0;
    const wheel = bytes[7] ?? 0;
    return {
      kind: "io",
      primary_bitmap: primary,
      secondary_bitmap: secondary,
      wheel_direction: wheel === 0x01 ? "cw" : wheel === 0x02 ? "ccw" : "idle",
      buttons_pressed: bitmapToList(primary).map((b) => `primary_${b}`).concat(bitmapToList(secondary).map((b) => `secondary_${b}`)),
      bytes,
    };
  }
  if (bytes[1] === 0xf2) {
    return {
      kind: "battery",
      battery_percent: bytes[3] ?? null,
      charging: bytes[4] === 1,
      bytes,
    };
  }
  return { kind: "vendor_unknown", bytes };
}

function bitmapToList(byte) {
  const bits = [];
  for (let i = 0; i < 8; i++) if (byte & (1 << i)) bits.push(i);
  return bits;
}

function ensureOpened() {
  if (state.device) return state.device;
  const all = HID.devices();
  const matches = all.filter(
    (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID && (d.usagePage ?? 0) >= MIN_USAGE_PAGE,
  );
  // Dedupe by path.
  const seen = new Set();
  const unique = matches.filter((d) => (seen.has(d.path) ? false : (seen.add(d.path), true)));
  if (unique.length === 0) throw new Error(`No matching HID device found (vendor=0x${VENDOR_ID.toString(16)}, product=0x${PRODUCT_ID.toString(16)}, usage_page >= 0x${MIN_USAGE_PAGE.toString(16)})`);
  const target = unique[0];
  const dev = new HID.HID(target.path);
  state.device = dev;
  state.devicePath = target.path;
  state.deviceInfo = target;
  dev.on("data", (buf) => {
    const decoded = decodeReport(buf);
    const ts = Date.now();
    if (decoded.kind === "battery") {
      state.lastBatteryReport = { ts, ...decoded };
      hudBroadcast({ ts, kind: "battery", battery_percent: decoded.battery_percent, charging: decoded.charging, raw_hex: Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(" ") });
      return;
    }
    if (decoded.kind === "io") {
      state.lastButtonReport = { ts, ...decoded };
      const newPrimary = decoded.primary_bitmap & ~state.lastPrimaryBitmap;
      const newSecondary = decoded.secondary_bitmap & ~state.lastSecondaryBitmap;
      const wheelTick = decoded.wheel_direction !== "idle";
      const releasedPrimary = state.lastPrimaryBitmap & ~decoded.primary_bitmap;
      const releasedSecondary = state.lastSecondaryBitmap & ~decoded.secondary_bitmap;
      if (newPrimary || newSecondary || wheelTick) {
        const ev = {
          ts,
          kind: wheelTick ? "wheel" : "button_press",
          new_primary_bits: bitmapToList(newPrimary),
          new_secondary_bits: bitmapToList(newSecondary),
          wheel_direction: decoded.wheel_direction,
          held_primary_bits: bitmapToList(decoded.primary_bitmap),
          held_secondary_bits: bitmapToList(decoded.secondary_bitmap),
          raw_hex: Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(" "),
        };
        pushEvent(ev);
        hudBroadcast(ev);
        // Wheel ticks update the adapter's tracked wheel value and emit a
        // separate `wheel_state` event so HUD / MCP clients can render the
        // value without summing ticks themselves. If a wheel binding is set,
        // the corresponding CW/CCW keystroke also fires.
        if (wheelTick) {
          if (decoded.wheel_direction === "cw") state.wheelValue++;
          else if (decoded.wheel_direction === "ccw") state.wheelValue--;
          broadcastWheelState("device");
          if (state.wheelBinding) {
            const bound = decoded.wheel_direction === "cw" ? state.wheelBinding.cw
                        : decoded.wheel_direction === "ccw" ? state.wheelBinding.ccw
                        : null;
            if (bound) {
              try {
                process.stderr.write(`[wheel] → ${bound.label ?? "wheel keystroke"}\n`);
                performAction(bound);
              } catch (err) {
                process.stderr.write(`[wheel] dispatch error (binding will be cleared): ${err?.message ?? err}\n`);
                state.wheelBinding = null;
                broadcastWheelBindingChange("dispatch-error");
                broadcastAnnotation({
                  text: "Wheel binding cleared after dispatch error",
                  fields: { error: String(err?.message ?? err) },
                  style: "error",
                }, "adapter-self-heal");
              }
            }
          }
        }
        // K11 (secondary bit 2 = wheel-center button) press emits a
        // `command_request` event — placeholder hook for the future voice
        // command pipeline. Listeners (HUD, voice handler, LLM) act on this.
        if (newSecondary & 0b00000100) broadcastCommandRequest("K11");
        // K2 (primary bit 1) advances the layer (forward cycle 1→2→3→4→1).
        // K1 (primary bit 0) was reassigned 2026-05-02 to "open HUD"; handled
        // below by the inline keystroke/shell dispatcher.
        if (newPrimary & 0b00000010) advanceLayer("K2");
        // Inline keystroke/shell dispatch (formerly the sidecar). Fires once
        // per fresh press edge per key; respects HARDWIRED_ACTIONS,
        // LAYER_ACTION_KEYS, and the per-layer mapping. Wheel + K11 are not
        // dispatched here — they're the AI input surface.
        for (const b of bitmapToList(newPrimary)) dispatchKeyPress(`K${b + 1}`);
        for (const b of bitmapToList(newSecondary)) dispatchKeyPress(`K${b + 9}`);
        // Resolve any press waiters on a fresh button press (wheel ticks intentionally don't resolve `wait_for_button_press`).
        if ((newPrimary || newSecondary) && state.pressWaiters.length > 0) {
          const waiters = state.pressWaiters.splice(0, state.pressWaiters.length);
          for (const w of waiters) w.resolve(ev);
        }
      } else if (releasedPrimary || releasedSecondary) {
        const ev = {
          ts,
          kind: "button_release",
          released_primary_bits: bitmapToList(releasedPrimary),
          released_secondary_bits: bitmapToList(releasedSecondary),
          raw_hex: Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(" "),
        };
        pushEvent(ev);
        hudBroadcast(ev);
      }
      state.lastPrimaryBitmap = decoded.primary_bitmap;
      state.lastSecondaryBitmap = decoded.secondary_bitmap;
    }
  });
  dev.on("error", (err) => {
    pushEvent({ ts: Date.now(), kind: "error", message: String(err) });
  });
  return dev;
}

// ---------- Operation handlers ----------
const handlers = {
  list_devices: async () => {
    const all = HID.devices();
    const matches = all.filter((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
    const seen = new Set();
    const unique = matches.filter((d) => (seen.has(d.path) ? false : (seen.add(d.path), true)));
    return { count: unique.length, devices: unique };
  },
  get_device_info: async () => {
    ensureOpened();
    return {
      vendor_id_hex: `0x${VENDOR_ID.toString(16)}`,
      product_id_hex: `0x${PRODUCT_ID.toString(16)}`,
      ...state.deviceInfo,
      capabilities_inferred: {
        primary_buttons: 8,
        secondary_buttons_observed_min: 3,
        has_wheel: true,
        wheel_directions: ["cw", "ccw"],
      },
    };
  },
  get_battery_status: async () => {
    ensureOpened();
    if (!state.lastBatteryReport) return { available: false, hint: "No battery heartbeat received yet — wait a few seconds and retry." };
    const { ts, battery_percent, charging } = state.lastBatteryReport;
    return { available: true, ts, battery_percent, charging };
  },
  get_button_state: async () => {
    ensureOpened();
    return {
      primary_bitmap_hex: `0x${state.lastPrimaryBitmap.toString(16).padStart(2, "0")}`,
      secondary_bitmap_hex: `0x${state.lastSecondaryBitmap.toString(16).padStart(2, "0")}`,
      held_primary_bits: bitmapToList(state.lastPrimaryBitmap),
      held_secondary_bits: bitmapToList(state.lastSecondaryBitmap),
      latest_report: state.lastButtonReport,
    };
  },
  wait_for_button_press: async (params) => {
    ensureOpened();
    const timeoutMs = Math.max(100, Math.min(600000, Number(params?.timeout_ms ?? 30000)));
    return await new Promise((resolve) => {
      const waiter = { resolve: null };
      const timer = setTimeout(() => {
        const idx = state.pressWaiters.indexOf(waiter);
        if (idx >= 0) state.pressWaiters.splice(idx, 1);
        resolve({ timed_out: true, timeout_ms: timeoutMs });
      }, timeoutMs);
      waiter.resolve = (ev) => { clearTimeout(timer); resolve({ timed_out: false, event: ev }); };
      state.pressWaiters.push(waiter);
    });
  },
  get_recent_events: async (params) => {
    const limit = Math.max(1, Math.min(1000, Number(params?.limit ?? 50)));
    const sinceTs = Number(params?.since_ts ?? 0);
    const filtered = sinceTs ? state.events.filter((e) => e.ts >= sinceTs) : state.events;
    const slice = filtered.slice(-limit);
    return { count: slice.length, total_in_buffer: state.events.length, events: slice };
  },
  is_device_open: async () => ({
    open: state.device !== null,
    path: state.devicePath,
    pending_press_waiters: state.pressWaiters.length,
  }),
  get_hud_url: async () => ({
    enabled: hudUrl !== null,
    url: hudUrl,
    port: HUD_PORT,
    connected_clients: wsClients.size,
    note: hudUrl ? "Open this URL in a browser tab for live event visualization." : "HUD disabled (SHORTCUT_REMOTE_HUD_PORT=0).",
  }),
  release_device: async () => {
    if (!state.device) return { released: false, reason: "device was not open" };
    const waiters = state.pressWaiters.splice(0, state.pressWaiters.length);
    for (const w of waiters) w.resolve({ ts: Date.now(), aborted: true, reason: "device released" });
    try { state.device.close(); } catch {}
    state.device = null;
    state.devicePath = null;
    state.lastPrimaryBitmap = 0;
    state.lastSecondaryBitmap = 0;
    return { released: true, aborted_waiters: waiters.length };
  },
  get_current_layer: async () => ({
    layer: state.currentLayer,
    layer_count: LAYER_COUNT,
    layer_label: ["I", "II", "III", "IV"][state.currentLayer - 1] ?? String(state.currentLayer),
  }),
  set_current_layer: async (params) => {
    const requested = Number(params?.layer);
    if (!Number.isInteger(requested) || requested < 1 || requested > LAYER_COUNT) {
      throw new Error(`layer must be an integer 1..${LAYER_COUNT} (got ${params?.layer})`);
    }
    const prev = state.currentLayer;
    if (requested === prev) return { layer: requested, changed: false };
    broadcastLayerChange(requested, params?.source ?? "mcp");
    return { layer: requested, previous: prev, changed: true };
  },
  get_wheel_value: async () => ({ value: state.wheelValue }),
  set_wheel_value: async (params) => {
    const requested = Number(params?.value);
    if (!Number.isFinite(requested)) throw new Error(`value must be a finite number (got ${params?.value})`);
    const prev = state.wheelValue;
    state.wheelValue = requested;
    broadcastWheelState(params?.source ?? "mcp");
    return { value: requested, previous: prev };
  },
  reset_wheel_value: async (params) => {
    const prev = state.wheelValue;
    state.wheelValue = 0;
    broadcastWheelState(params?.source ?? "mcp:reset");
    return { value: 0, previous: prev };
  },
  get_wheel_binding: async () => ({ binding: state.wheelBinding }),
  set_wheel_binding: async (params) => {
    // Pass binding=null to clear (return to AI mode, no synthesis).
    // Otherwise: { binding: { cw: {mac_code, modifiers, label}, ccw: {...}, label } }
    const incoming = params?.binding ?? null;
    if (incoming !== null) {
      // Each side (cw/ccw) accepts one of three action shapes:
      //   { mac_code: number, modifiers?: string[], label?: string }       — keystroke
      //   { applescript: string, label?: string }                          — AppleScript (system actions)
      //   { command: string, args?: string[], label?: string }             — shell command
      const validSide = (a) => a == null || typeof a.mac_code === "number" || typeof a.applescript === "string" || typeof a.command === "string";
      if (!validSide(incoming.cw) || !validSide(incoming.ccw)) {
        throw new Error("binding.cw / binding.ccw must each be null or one of: { mac_code, modifiers?, label? }, { applescript, label? }, { command, args?, label? }");
      }
      if (incoming.cw == null && incoming.ccw == null) {
        throw new Error("binding must have at least one of cw or ccw set; pass binding=null to clear");
      }
    }
    const prev = state.wheelBinding;
    state.wheelBinding = incoming;
    broadcastWheelBindingChange(params?.source ?? "mcp");
    return { binding: incoming, previous: prev };
  },
  submit_voice_command: async (params) => {
    const text = String(params?.text ?? "").trim();
    if (!text) throw new Error("text is required");
    const r = triggerVoiceCommand(text, params?.source ?? "mcp");
    if (!r.accepted) throw new Error(r.reason ?? "rejected");
    return { accepted: true, text };
  },
  post_annotation: async (params) => {
    // Free-form payload broadcast as an `annotation` event for the HUD overlay.
    // Pass null/undefined/empty to clear. Recommended structure:
    //   { text: string, fields?: { [k]: string }, style?: "info"|"warn"|"error" }
    // but the adapter does not validate — the HUD does best-effort rendering.
    const payload = params?.payload ?? null;
    broadcastAnnotation(payload, params?.source ?? "mcp");
    return { posted: payload !== null, payload };
  },
};

// ---------- MCP plumbing ----------
function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function buildIntrospectionOps() {
  const out = [{ name: "introspect", endpoint: "READ", description: "Discover available operations." }];
  for (const [endpoint, ops] of Object.entries(schema.operations)) {
    for (const op of ops ?? []) out.push({ name: op.name, endpoint: endpoint.toUpperCase(), description: op.description });
  }
  return out;
}

function buildOperationDetails(name) {
  if (name === "introspect") {
    return {
      name: "introspect", endpoint: "READ", mcpTool: "mcpaql_read",
      description: "Discover available operations.",
      parameters: [
        { name: "query", type: "string", required: true, enum: ["operations", "types"] },
        { name: "name", type: "string", required: false },
      ],
    };
  }
  const item = TOOL_BY_OPERATION.get(name);
  if (!item) return null;
  return {
    name, endpoint: item.endpoint, mcpTool: TOOL_NAME_BY_ENDPOINT[item.endpoint],
    description: item.definition.description,
    parameters: Object.entries(item.definition.params ?? {}).map(([pn, p]) => ({
      name: pn, type: p.type, required: Boolean(p.required), description: p.description,
      default: p.default, enum: p.enum, minimum: p.minimum, maximum: p.maximum,
    })),
  };
}

function buildIntrospection(params) {
  if (params.query === "operations") {
    if (params.name) {
      const op = buildOperationDetails(params.name);
      return op
        ? { success: true, data: { operation: op } }
        : { success: false, error: { code: "NOT_FOUND_OPERATION", message: `Unknown operation: ${params.name}` } };
    }
    return { success: true, data: { _protocol: { version: schema.version, mode: "crude" }, operations: buildIntrospectionOps() } };
  }
  if (params.query === "types") {
    return { success: true, data: { types: [{ name: "ShortcutRemoteEvent", kind: "object", description: "Decoded HID event from the device." }] } };
  }
  return { success: false, error: { code: "VALIDATION_INVALID_QUERY", message: `Unknown query: ${params.query}` } };
}

function createMcpServer() {
  const server = new Server({ name: schema.name, version: schema.version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(schema.operations)
      .filter(([, ops]) => Array.isArray(ops) && ops.length > 0)
      .map(([endpoint, ops]) => ({
        name: TOOL_NAME_BY_ENDPOINT[endpoint.toUpperCase()],
        description: `${endpoint.toUpperCase()} operations for ${schema.description}\n\nSupported operations: ${ops.map((o) => o.name).join(", ")}\n\nDiscover params: { operation: "introspect", params: { query: "operations", name: "<op>" } }`,
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", description: "MCP-AQL operation name." },
            params: { type: "object", description: "Operation parameters." },
          },
          required: ["operation"],
        },
        annotations: { readOnlyHint: endpoint === "read", destructiveHint: false },
      })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    const operation = typeof args.operation === "string" ? args.operation : "";
    const params = args.params && typeof args.params === "object" ? args.params : {};
    if (operation === "introspect") return textResult(buildIntrospection(params));
    const item = TOOL_BY_OPERATION.get(operation);
    if (!item) return textResult({ success: false, error: { code: "NOT_FOUND_OPERATION", message: `Unknown operation: ${operation}` } });
    const expected = TOOL_NAME_BY_ENDPOINT[item.endpoint];
    if (toolName !== expected) return textResult({ success: false, error: { code: "VALIDATION_WRONG_ENDPOINT", message: `Operation '${operation}' must be called via ${expected}.` } });
    const fn = handlers[operation];
    if (!fn) return textResult({ success: false, error: { code: "NOT_IMPLEMENTED", message: `No handler for operation '${operation}'.` } });
    try {
      const data = await fn(params);
      return textResult({ success: true, data, _meta: { provenance: { discovery_method: provenance.discovery_method, generated_at: provenance.generated_at } } });
    } catch (err) {
      return textResult({ success: false, error: { code: "HANDLER_ERROR", message: err instanceof Error ? err.message : String(err) } });
    }
  });

  return server;
}

process.stderr.write(`[mcp] streamable-http endpoint ready; POST http://127.0.0.1:${HUD_PORT}/mcp to initialize a session\n`);

// Daemon mode: when running as a long-lived service (launchd, etc.), open the
// HID device at startup so HUD WebSocket events flow before any MCP client
// connects. Default ON for the streamable-HTTP shape; set
// SHORTCUT_REMOTE_AUTO_OPEN=0 to opt out.
if (process.env.SHORTCUT_REMOTE_AUTO_OPEN !== "0") {
  try {
    ensureOpened();
    process.stderr.write(`[hid] auto-opened device at startup\n`);
  } catch (err) {
    process.stderr.write(`[hid] auto-open failed: ${err.message}\n`);
  }
}

// SuperWhisper recordings watcher: replaces the per-mode `script` field that
// was removed in 2.13. Filters on modeName so unrelated dictations are ignored.
startSuperWhisperWatcher();

const cleanShutdown = async () => {
  try { state.device?.close(); } catch {}
  for (const t of mcpTransports.values()) {
    try { await t.close?.(); } catch {}
  }
  process.exit(0);
};
process.on("SIGINT", cleanShutdown);
process.on("SIGTERM", cleanShutdown);

// Last-resort safety net. Anything we forgot to wrap in try/catch lands here;
// we log loudly and stay alive so the HID handle doesn't get re-grabbed by
// a launchd-respawned process every time a malformed binding sneaks in.
process.on("uncaughtException", (err) => {
  process.stderr.write(`[adapter] uncaught: ${err?.stack ?? err}\n`);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[adapter] unhandled rejection: ${err?.stack ?? err}\n`);
});
