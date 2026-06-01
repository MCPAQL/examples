#!/usr/bin/env node
// Open-window press listener: spawns the adapter, waits up to 90 seconds for the FIRST
// button press, then prints the decoded event and exits. Use to verify the JIT adapter
// catches a real physical press end-to-end.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
      }
    } catch {}
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params: params ?? {} };
  return new Promise((resolveP, rejectP) => {
    pending.set(id, (response) => response.error ? rejectP(new Error(JSON.stringify(response.error))) : resolveP(response.result));
    child.stdin.write(JSON.stringify(msg) + "\n");
  });
}

const exit = (code) => { try { child.kill("SIGKILL"); } catch {} ; setTimeout(() => process.exit(code), 100); };
process.on("SIGINT", () => exit(130));

(async () => {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "press-listener", version: "0.1.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Force the device open by calling get_device_info first.
  await rpc("tools/call", { name: "mcp_aql_read", arguments: { operation: "get_device_info" } });

  console.log("\n========================================================");
  console.log("  ADAPTER READY — PRESS ANY BUTTON ON THE REMOTE NOW");
  console.log("  (waiting up to 90 seconds for the first press)");
  console.log("========================================================\n");

  const result = await rpc("tools/call", { name: "mcp_aql_read", arguments: { operation: "wait_for_button_press", params: { timeout_ms: 90000 } } });

  // Result is wrapped in MCP CallToolResult shape: { content: [{type:"text", text: <json> }] }
  const text = result?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text);

  console.log("\n========== RESULT ==========");
  console.log(JSON.stringify(parsed, null, 2));

  // Pull recent events for context too.
  const recent = await rpc("tools/call", { name: "mcp_aql_read", arguments: { operation: "get_recent_events", params: { limit: 20 } } });
  const recentText = JSON.parse(recent.content[0].text);
  console.log("\n========== RECENT EVENTS ==========");
  console.log(JSON.stringify(recentText, null, 2));

  exit(parsed?.data?.timed_out ? 2 : 0);
})().catch((err) => { console.error("press-listener failed:", err); exit(1); });
