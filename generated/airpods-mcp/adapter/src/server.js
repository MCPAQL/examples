#!/usr/bin/env node
// MCP-AQL adapter for AirPods Pro head-tracking on macOS.
//
// This is the SPEC-LEVEL adapter — speaks stdio MCP via @modelcontextprotocol/sdk,
// exposes a CRUDE operation surface, and rebroadcasts the live pose stream as
// HTTP + WebSocket for high-rate consumers (sidecars, HUDs, dashboards).
//
// Bottom layer (data source) is a separate Swift .app bundle that wraps Apple's
// CMHeadphoneMotionManager and broadcasts pose JSON-lines over TCP. The .app split
// is required by macOS TCC for headphone motion permission.

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(join(__dirname, "schema.json"), "utf8"));
const provenance = JSON.parse(fs.readFileSync(join(__dirname, "provenance.json"), "utf8"));

const SOURCE_HOST = process.env.AIRPODS_SOURCE_HOST ?? "127.0.0.1";
const SOURCE_PORT = Number(process.env.AIRPODS_SOURCE_PORT ?? 47833);
const HUD_PORT    = Number(process.env.AIRPODS_HUD_PORT    ?? 47834);
const CAL_PATH      = process.env.AIRPODS_CALIBRATION_PATH ?? resolve(__dirname, "..", "..", "calibration.json");
const OFFSETS_PATH  = process.env.AIRPODS_OFFSETS_PATH     ?? "/tmp/airpods-offsets.json";
const RECENT_MAX  = Number(process.env.AIRPODS_RECENT_BUFFER_SIZE ?? 100);
const SIDECAR_PATH      = process.env.AIRPODS_SIDECAR_PATH      ?? resolve(__dirname, "..", "..", "sidecar", "index.js");
const SIDECAR_PID_FILE  = process.env.AIRPODS_SIDECAR_PID_FILE  ?? "/tmp/airpods-sidecar.pid";
const SIDECAR_LOG_PATH  = process.env.AIRPODS_SIDECAR_LOG_PATH  ?? "/tmp/airpods-sidecar.log";

// ---------- State ----------
const state = {
  sourceConnected: false,
  recentPoses: [],
  lastPoseAt: 0,
  poseWaiters: [],
  calibration: null,
  offsets: { yaw: 0, pitch: 0 },
};

function loadCalibration() {
  try {
    state.calibration = JSON.parse(fs.readFileSync(CAL_PATH, "utf8"));
  } catch {
    state.calibration = null;
  }
}
function loadOffsets() {
  try {
    const o = JSON.parse(fs.readFileSync(OFFSETS_PATH, "utf8"));
    state.offsets = { yaw: Number(o.offsetYaw) || 0, pitch: Number(o.offsetPitch) || 0 };
  } catch {
    state.offsets = { yaw: 0, pitch: 0 };
  }
}
function persistOffsets(extra = {}) {
  const payload = {
    offsetYaw: state.offsets.yaw,
    offsetPitch: state.offsets.pitch,
    capturedAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(OFFSETS_PATH, JSON.stringify(payload, null, 2));
}
function persistCalibration() {
  fs.writeFileSync(CAL_PATH, JSON.stringify(state.calibration, null, 2));
}
loadCalibration();
loadOffsets();
fs.watchFile(OFFSETS_PATH, { interval: 1000 }, () => loadOffsets());

// ---------- Source connection (Swift .app via TCP) ----------
let sourceSock = null;
let sourceBuf = "";
function connectSource() {
  sourceSock = net.connect(SOURCE_PORT, SOURCE_HOST);
  sourceSock.setKeepAlive(true);
  sourceSock.on("connect", () => {
    state.sourceConnected = true;
    process.stderr.write(`[adapter] motion source connected ${SOURCE_HOST}:${SOURCE_PORT}\n`);
  });
  sourceSock.on("data", (chunk) => {
    sourceBuf += chunk.toString("utf8");
    let nl;
    while ((nl = sourceBuf.indexOf("\n")) >= 0) {
      const line = sourceBuf.slice(0, nl);
      sourceBuf = sourceBuf.slice(nl + 1);
      if (line) handleSourceLine(line);
    }
  });
  sourceSock.on("close", () => {
    state.sourceConnected = false;
    process.stderr.write(`[adapter] motion source disconnected; reconnecting in 1s\n`);
    setTimeout(connectSource, 1000);
  });
  sourceSock.on("error", (err) => {
    process.stderr.write(`[adapter] source socket error: ${err.message}\n`);
  });
}
function handleSourceLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "pose") return;
  state.lastPoseAt = Date.now();
  state.recentPoses.push(msg);
  if (state.recentPoses.length > RECENT_MAX) state.recentPoses.shift();
  // Resolve any pending waiters
  if (state.poseWaiters.length > 0) {
    const waiters = state.poseWaiters.splice(0, state.poseWaiters.length);
    for (const w of waiters) w.resolve(msg);
  }
  hudBroadcast(msg);
}
connectSource();

// ---------- HUD HTTP + WebSocket ----------
const wsClients = new Set();
let hudUrl = null;
const httpServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<title>AirPods MCP-AQL Adapter</title>
<style>body{font:14px system-ui;padding:24px;max-width:720px}code{background:#eee;padding:2px 6px;border-radius:3px}pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow:auto}</style>
<h1>AirPods MCP-AQL Adapter</h1>
<p>Source: <code>${SOURCE_HOST}:${SOURCE_PORT}</code> (${state.sourceConnected ? "connected" : "disconnected"})</p>
<p>Live pose stream: <code>ws://127.0.0.1:${HUD_PORT}/events</code></p>
<p>Discovery: <code>${provenance.discovery_method}</code> (wraps <code>${provenance.source_framework}</code>)</p>
<p>Operations: <code>${Object.values(schema.operations).flat().map(o => o.name).join(", ")}</code></p>
<p>Open the WebSocket above to see live pose JSON. Standard MCP-AQL tools (<code>mcpaql_read</code>, <code>mcpaql_create</code>, <code>mcpaql_update</code>, <code>mcpaql_delete</code>) are available via stdio.</p>`);
  } else if (req.url === "/calibration.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state.calibration ?? {}, null, 2));
  } else if (req.url === "/offsets.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state.offsets, null, 2));
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      sourceConnected: state.sourceConnected,
      lastPoseAgeMs: state.lastPoseAt ? Date.now() - state.lastPoseAt : null,
      recentBuffer: state.recentPoses.length,
    }));
  } else {
    res.writeHead(404).end();
  }
});
const wss = new WebSocketServer({
  server: httpServer,
  path: "/events",
  // The HUD WS streams live head-pose telemetry. Binding the HTTP server to
  // 127.0.0.1 stops LAN hosts but NOT browsers: any web page the user visits
  // can open ws://127.0.0.1:<port>/events from JS and read head-tracking data.
  // The only legitimate consumer is the Node sidecar, which (like every
  // non-browser ws client) sends no Origin header; browsers ALWAYS send one.
  // The served HUD page is informational text only and never opens this
  // socket, so there is no legitimate browser client to allow. Reject any
  // Origin-bearing upgrade.
  verifyClient: (info) => !info.origin,
});
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
});
httpServer.on("error", (err) => process.stderr.write(`[hud] http error: ${err.message}\n`));
httpServer.listen(HUD_PORT, "127.0.0.1", () => {
  hudUrl = `http://127.0.0.1:${HUD_PORT}/`;
  process.stderr.write(`[hud] listening at ${hudUrl}\n`);
});
function hudBroadcast(msg) {
  if (!wsClients.size) return;
  const json = JSON.stringify(msg);
  // Drop clients on synchronous send failure (TCP RST without a clean close
  // event won't reach ws.on("error"), so without this they leak forever).
  for (const ws of wsClients) {
    try { ws.send(json); } catch { wsClients.delete(ws); }
  }
}

// ---------- Helpers ----------
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[Math.floor(s.length / 2)] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
async function captureSamples(n) {
  const samples = [];
  while (samples.length < n) {
    const sample = await new Promise((res) => {
      const t = setTimeout(() => res(null), 5000);
      const w = { resolve: (m) => { clearTimeout(t); res(m); } };
      state.poseWaiters.push(w);
    });
    if (!sample) break;
    samples.push(sample);
  }
  return samples;
}

// ---------- Operation handlers ----------
const handlers = {
  list_devices: async () => ({
    source: { host: SOURCE_HOST, port: SOURCE_PORT },
    connected: state.sourceConnected,
    framework: provenance.source_framework,
    platform: provenance.source_platform,
  }),
  is_streaming: async () => {
    const ageMs = state.lastPoseAt ? Date.now() - state.lastPoseAt : null;
    return {
      connected: state.sourceConnected,
      last_pose_age_ms: ageMs,
      streaming: state.sourceConnected && ageMs !== null && ageMs < 1000,
      audio_session_note: ageMs !== null && ageMs > 2000
        ? "Stream may be paused — verify an audio session is active (silent-WAV keeper recommended)."
        : null,
    };
  },
  get_pose: async () => {
    const last = state.recentPoses[state.recentPoses.length - 1];
    if (!last) return null;
    return { ...last, applied_offsets: state.offsets };
  },
  wait_for_pose: async (params = {}) => {
    const timeoutMs = Math.min(Math.max(Number(params.timeout_ms) || 5000, 50), 30000);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const idx = state.poseWaiters.findIndex((w) => w._t === t);
        if (idx >= 0) state.poseWaiters.splice(idx, 1);
        resolve({ timed_out: true });
      }, timeoutMs);
      state.poseWaiters.push({ _t: t, resolve: (msg) => { clearTimeout(t); resolve(msg); } });
    });
  },
  get_recent_poses: async (params = {}) => {
    const n = Math.min(Math.max(Number(params.count) || 25, 1), RECENT_MAX);
    return { count: Math.min(n, state.recentPoses.length), samples: state.recentPoses.slice(-n) };
  },
  get_calibration: async () => ({ calibration: state.calibration, offsets: state.offsets }),
  get_hud_url: async () => ({ http: hudUrl, websocket: `ws://127.0.0.1:${HUD_PORT}/events` }),
  get_provenance: async () => provenance,

  calibrate_point: async (params = {}) => {
    if (!params.id) throw new Error("calibrate_point requires { id: string }");
    const samples = Math.min(Math.max(Number(params.samples) || 25, 5), 200);
    const got = await captureSamples(samples);
    if (got.length === 0) throw new Error("No samples captured (motion source unavailable?)");
    const summary = {
      n: got.length,
      yaw:   { median: median(got.map((s) => s.yaw)),   min: Math.min(...got.map((s) => s.yaw)),   max: Math.max(...got.map((s) => s.yaw)) },
      pitch: { median: median(got.map((s) => s.pitch)), min: Math.min(...got.map((s) => s.pitch)), max: Math.max(...got.map((s) => s.pitch)) },
      roll:  { median: median(got.map((s) => s.roll)),  min: Math.min(...got.map((s) => s.roll)),  max: Math.max(...got.map((s) => s.roll)) },
    };
    if (!state.calibration) state.calibration = { captured_at: new Date().toISOString(), units: "radians", points: [] };
    state.calibration.points = state.calibration.points.filter((p) => p.id !== params.id);
    state.calibration.points.push({ id: params.id, summary, captured_at: new Date().toISOString() });
    state.calibration.captured_at = new Date().toISOString();
    persistCalibration();
    return { id: params.id, summary };
  },

  recenter: async (params = {}) => {
    const samples = Math.min(Math.max(Number(params.samples) || 20, 5), 200);
    const refId = params.reference_id ?? "main_center";
    if (!state.calibration) throw new Error("No calibration loaded; run calibrate_point first");
    const ref = state.calibration.points?.find((p) => p.id === refId);
    if (!ref) throw new Error(`No calibration anchor named '${refId}'`);
    const got = await captureSamples(samples);
    if (got.length === 0) throw new Error("No samples captured");
    const yawCur = median(got.map((s) => s.yaw));
    const pitchCur = median(got.map((s) => s.pitch));
    state.offsets = {
      yaw: ref.summary.yaw.median - yawCur,
      pitch: ref.summary.pitch.median - pitchCur,
    };
    persistOffsets({
      capturedPose: { yaw: yawCur, pitch: pitchCur },
      referencePose: { yaw: ref.summary.yaw.median, pitch: ref.summary.pitch.median },
      reference_id: refId,
      samples: got.length,
    });
    return { offsets: state.offsets, reference_id: refId };
  },

  set_offset: async (params = {}) => {
    if (params.offsetYaw === undefined || params.offsetPitch === undefined) throw new Error("set_offset requires { offsetYaw, offsetPitch } numbers");
    state.offsets = { yaw: Number(params.offsetYaw), pitch: Number(params.offsetPitch) };
    persistOffsets({ source: "set_offset" });
    return { offsets: state.offsets };
  },

  clear_offsets: async () => {
    state.offsets = { yaw: 0, pitch: 0 };
    persistOffsets({ source: "clear_offsets" });
    return { offsets: state.offsets };
  },

  is_sidecar_running: async () => {
    const pid = readSidecarPid();
    return { running: isSidecarPid(pid), pid };
  },

  start_sidecar: async (params = {}) => {
    const existing = readSidecarPid();
    if (isSidecarPid(existing)) {
      return { running: true, pid: existing, source: "existing", log_path: SIDECAR_LOG_PATH };
    }
    if (!fs.existsSync(SIDECAR_PATH)) {
      throw new Error(`sidecar entry not found at ${SIDECAR_PATH}`);
    }
    const env = { ...process.env };
    if (params.blob_follow !== false) env.BLOB_FOLLOW = "1";
    if (params.mouse_follow) env.MOUSE_FOLLOW = "1";
    // The adapter and sidecar use DIFFERENT env var names for the same
    // settings: adapter reads AIRPODS_HUD_PORT / AIRPODS_CALIBRATION_PATH,
    // sidecar reads AIRPODS_HUD_URL / AIRPODS_CAL_PATH. Cloning process.env
    // alone does not bridge that — an adapter started with a custom HUD port
    // or calibration path would spawn a sidecar that defaults to
    // ws://127.0.0.1:47834 and ../calibration.json (wrong HUD / stale cal).
    // Derive the sidecar vars from THIS adapter's active settings, but let an
    // explicitly-set value win. (AIRPODS_OFFSETS_PATH is shared verbatim by
    // both, so it already propagates via the env clone.)
    if (!env.AIRPODS_HUD_URL) env.AIRPODS_HUD_URL = `ws://127.0.0.1:${HUD_PORT}/events`;
    if (!env.AIRPODS_CAL_PATH) env.AIRPODS_CAL_PATH = CAL_PATH;
    const out = fs.openSync(SIDECAR_LOG_PATH, "a");
    const err = fs.openSync(SIDECAR_LOG_PATH, "a");
    const proc = spawn("node", [SIDECAR_PATH], {
      env,
      detached: true,
      stdio: ["ignore", out, err],
      cwd: dirname(SIDECAR_PATH),
    });
    proc.unref();
    fs.writeFileSync(SIDECAR_PID_FILE, String(proc.pid));
    return { running: true, pid: proc.pid, source: "spawned", log_path: SIDECAR_LOG_PATH };
  },

  stop_sidecar: async () => {
    const pid = readSidecarPid();
    if (!pid || !isPidAlive(pid)) return { running: false, message: "no sidecar running" };
    if (!isSidecarPid(pid)) {
      // PID is live but not our sidecar — stale PID file, recycled PID.
      // Fail-safe: do not SIGTERM an unrelated process. Drop the stale file
      // so future calls don't keep tripping over it (mirrors stop.sh, which
      // rm's the file in every path).
      try { fs.unlinkSync(SIDECAR_PID_FILE); } catch {}
      return { running: false, message: `pid ${pid} is not the sidecar (stale/reused PID) — not killing`, pid };
    }
    try { process.kill(pid, "SIGTERM"); } catch (e) { return { running: false, error: String(e) }; }
    // Mirror stop.sh: clean up the PID file after a successful stop.
    try { fs.unlinkSync(SIDECAR_PID_FILE); } catch {}
    return { running: false, was_pid: pid };
  },
};

function readSidecarPid() {
  try {
    const raw = fs.readFileSync(SIDECAR_PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}
function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
// Identity check, mirroring stop.sh: a stale SIDECAR_PID_FILE whose PID the OS
// recycled to an unrelated process would otherwise be reported as "running"
// and SIGTERM'd by stop_sidecar. Confirm the live PID is actually the sidecar
// before treating it as ours. Fail-safe: if ps can't confirm, it isn't ours.
function isSidecarPid(pid) {
  if (!pid || !isPidAlive(pid)) return false;
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return cmd.includes("sidecar/index.js");
  } catch { return false; }
}

// ---------- MCP plumbing ----------
const TOOL_NAME_BY_ENDPOINT = {
  CREATE: "mcpaql_create",
  READ:   "mcpaql_read",
  UPDATE: "mcpaql_update",
  DELETE: "mcpaql_delete",
  EXECUTE:"mcpaql_execute",
};
const TOOL_BY_OPERATION = new Map();
for (const [endpoint, ops] of Object.entries(schema.operations)) {
  for (const op of ops ?? []) {
    TOOL_BY_OPERATION.set(op.name, { endpoint: endpoint.toUpperCase(), definition: op });
  }
}

function buildIntrospectionOps() {
  return Object.entries(schema.operations).map(([endpoint, ops]) => ({
    endpoint: endpoint.toUpperCase(),
    operations: (ops ?? []).map((op) => ({
      name: op.name, description: op.description, params: op.params ?? {}, danger_level: op.danger_level ?? "safe",
    })),
  }));
}
function buildIntrospection(params = {}) {
  if (params.query === "operations") {
    if (params.name) {
      const item = TOOL_BY_OPERATION.get(params.name);
      return item
        ? { success: true, data: { operation: { ...item.definition, endpoint: item.endpoint } } }
        : { success: false, error: { code: "NOT_FOUND_OPERATION", message: `Unknown operation: ${params.name}` } };
    }
    return { success: true, data: { _protocol: { version: schema.version, mode: "crude" }, operations: buildIntrospectionOps() } };
  }
  if (params.query === "types") {
    return { success: true, data: { types: [
      { name: "PoseSample", kind: "object", description: "One pose sample: quaternion + euler (rad) + rotation rate + ts." },
      { name: "CalibrationAnchor", kind: "object", description: "Named pose anchor with median/min/max per axis." },
      { name: "Offsets", kind: "object", description: "Yaw/pitch radians to add to raw poses for calibration alignment." },
    ] } };
  }
  return { success: false, error: { code: "VALIDATION_INVALID_QUERY", message: `Unknown query: ${params.query}` } };
}

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
          params:    { type: "object", description: "Operation parameters." },
        },
        required: ["operation"],
      },
      annotations: { readOnlyHint: endpoint === "read", destructiveHint: endpoint === "delete" },
    })),
}));

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};
  const operation = typeof args.operation === "string" ? args.operation : "";
  const params = (args.params && typeof args.params === "object") ? args.params : {};
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

const transport = new StdioServerTransport();
await server.connect(transport);

const cleanShutdown = () => {
  try { sourceSock?.end(); } catch {}
  try { httpServer.close(); } catch {}
  process.exit(0);
};
process.on("SIGINT", cleanShutdown);
process.on("SIGTERM", cleanShutdown);
