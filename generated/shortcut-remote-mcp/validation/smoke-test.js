#!/usr/bin/env node
// Spawns the adapter as a child process over stdio, sends MCP JSON-RPC requests,
// and prints the responses. Proves the adapter actually works end-to-end.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "..", "adapter", "src", "server.js");

const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });

let nextId = 1;
const pending = new Map();
let buf = "";

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else {
        process.stderr.write(`[server-msg] ${line}\n`);
      }
    } catch (err) {
      process.stderr.write(`[parse-err] ${line}\n`);
    }
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(`[server-stderr] ${chunk}`));

function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params: params ?? {} };
  return new Promise((resolveP, rejectP) => {
    pending.set(id, (response) => {
      if (response.error) rejectP(new Error(JSON.stringify(response.error)));
      else resolveP(response.result);
    });
    child.stdin.write(JSON.stringify(msg) + "\n");
  });
}

function callTool(name, args) {
  return rpc("tools/call", { name, arguments: args });
}

function pretty(label, obj) {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  // 1. MCP handshake.
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "shortcut-remote-smoke", version: "0.1.0" },
  });
  pretty("initialize.result", init);

  // Send the required initialized notification.
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2. List tools.
  const tools = await rpc("tools/list", {});
  pretty("tools/list", tools);

  // 3. Introspect.
  const introspect = await callTool("mcp_aql_read", { operation: "introspect", params: { query: "operations" } });
  pretty("introspect", introspect);

  // 4. List devices.
  const devs = await callTool("mcp_aql_read", { operation: "list_devices" });
  pretty("list_devices", devs);

  // 5. Device info (will open the device).
  const info = await callTool("mcp_aql_read", { operation: "get_device_info" });
  pretty("get_device_info", info);

  // 6. Battery (may need a few seconds for first heartbeat).
  await new Promise((r) => setTimeout(r, 3500));
  const battery = await callTool("mcp_aql_read", { operation: "get_battery_status" });
  pretty("get_battery_status", battery);

  // 7. Wait for a button press (15s window — Mick presses a button).
  console.log("\n>>> PRESS ANY BUTTON ON YOUR SHORTCUT REMOTE NOW (15 second window)...");
  const press = await callTool("mcp_aql_read", { operation: "wait_for_button_press", params: { timeout_ms: 15000 } });
  pretty("wait_for_button_press", press);

  // 8. Recent events.
  const recent = await callTool("mcp_aql_read", { operation: "get_recent_events", params: { limit: 20 } });
  pretty("get_recent_events", recent);

  child.kill("SIGKILL");
  setTimeout(() => process.exit(0), 200);
}

process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });
process.on("SIGINT", () => { try { child.kill("SIGKILL"); } catch {} ; process.exit(130); });

main().catch((err) => {
  console.error("smoke-test failed:", err);
  child.kill("SIGKILL");
  process.exit(1);
});
