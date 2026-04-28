#!/usr/bin/env node
// JIT-generated MCP-AQL adapter for Hanvon Ugee Shortcut Remote (0x28bd:0x0202).
// Hand-built but follows the shape that adapter-generator emits, with native-hid transport.

import HID from "node-hid";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

// ---------- Live HUD: HTTP + WebSocket on 127.0.0.1:<port> ----------
// Disabled if SHORTCUT_REMOTE_HUD_PORT=0; default is 47832. Bind always 127.0.0.1.
const HUD_PORT = Number(process.env.SHORTCUT_REMOTE_HUD_PORT ?? 47832);
const wsClients = new Set();
let hudUrl = null;
if (HUD_PORT > 0) {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getHudHtml());
    } else if (req.url === "/xppen-mappings.json") {
      const data = getXppenMappings();
      if (!data) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ server: httpServer, path: "/events" });
  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("close", () => wsClients.delete(ws));
    ws.on("error", () => wsClients.delete(ws));
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
};

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

const transport = new StdioServerTransport();
await server.connect(transport);

// Optional: open the HID device at startup so HUD WebSocket events flow without
// requiring an MCP call. Useful when running standalone for sidecar consumption.
if (process.env.SHORTCUT_REMOTE_AUTO_OPEN === "1") {
  try {
    ensureOpened();
    process.stderr.write(`[hid] auto-opened device at startup\n`);
  } catch (err) {
    process.stderr.write(`[hid] auto-open failed: ${err.message}\n`);
  }
}

const cleanShutdown = () => {
  try { state.device?.close(); } catch {}
  process.exit(0);
};
process.on("SIGINT", cleanShutdown);
process.on("SIGTERM", cleanShutdown);
