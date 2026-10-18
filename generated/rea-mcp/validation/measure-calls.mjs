// Records what the model would see, in characters, for the same REA workflow called raw and
// through the adapter: the up-front tool list, each request and response, and the adapter's
// batch form. Run it only inside an isolated VM: it launches REA twice.
//
//   node validation/measure-calls.mjs --rea /path/to/node_modules/.bin/rea \
//     [--adapter adapter] [--targets validation/targets/build] [--out validation/calls.json]
//
// Needs `npm install` and `npm run build` in the adapter directory; the MCP SDK is loaded
// from there. The adapter's schema must launch the same rea binary (validation/README.md).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};
const reaCommand = arg("rea");
const adapterDir = resolve(arg("adapter", join(here, "..", "adapter")));
const targets = resolve(arg("targets", join(here, "targets", "build")));
const outPath = resolve(arg("out", join(here, "calls.json")));
if (!reaCommand) throw new Error("Pass --rea /path/to/rea (npm install --omit=optional rea-agents@6.5.0).");

const sdk = (path) => import(pathToFileURL(join(adapterDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", path)).href);
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");

const CALL_OPTIONS = { timeout: 600_000, resetTimeoutOnProgress: true, maxTotalTimeout: 1_800_000, onprogress: () => undefined };
const chars = (value) => (value === undefined ? 0 : JSON.stringify(value).length);
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
};
const digest = (value) => createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));

async function connect(name, command, args, cwd) {
  const client = new Client({ name: `measure-${name}`, version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args, cwd, env: environment(), stderr: "inherit" }));
  return client;
}

const raw = await connect("raw", reaCommand, ["mcp"]);
const adapter = await connect("adapter", process.execPath, [join(adapterDir, "dist", "server.js")], adapterDir);
const target = (name) => join(targets, name);

// Up front: the tool list each host would load.
const modelVisible = (tools) => tools.reduce((sum, tool) => sum + chars({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }), 0);
const rawTools = (await raw.listTools()).tools;
const adapterTools = (await adapter.listTools()).tools;
const stage1 = new Set(JSON.parse(readFileSync(join(adapterDir, "src", "provenance.json"), "utf8")).operations.map((op) => op.source_tool_name ?? op.operation_name));

// The live catalog against the committed one, by name and by model-visible definition.
const committed = JSON.parse(gunzipSync(readFileSync(join(here, "..", "capture", "rea-mcp-tool-catalog-6.5.0.json.gz"))).toString("utf8")).catalog;
const committedByName = new Map(committed.map((tool) => [tool.name, tool]));
const visible = (tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
const catalog = {
  live_tools: rawTools.length,
  committed_tools: committed.length,
  missing_live: committed.filter((tool) => !rawTools.some((live) => live.name === tool.name)).map((tool) => tool.name),
  extra_live: rawTools.filter((tool) => !committedByName.has(tool.name)).map((tool) => tool.name),
  changed_model_visible: rawTools.filter((tool) => committedByName.has(tool.name) && digest(visible(tool)) !== digest(visible(committedByName.get(tool.name)))).map((tool) => tool.name),
};

const upFront = {
  raw_all: { tools: rawTools.length, wire_chars: chars(rawTools), model_visible_chars: modelVisible(rawTools) },
  raw_stage1: { tools: rawTools.filter((tool) => stage1.has(tool.name)).length, model_visible_chars: modelVisible(rawTools.filter((tool) => stage1.has(tool.name))) },
  adapter: { tools: adapterTools.length, wire_chars: chars(adapterTools), model_visible_chars: modelVisible(adapterTools) },
};

// Per call. A raw result carries the record twice, as text and as structuredContent; the
// duplicate fields say how often the text is exactly the structured record.
function describeRaw(result) {
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("") ?? "";
  let parsedSame = false;
  try { parsedSame = result.structuredContent !== undefined && digest(JSON.parse(text)) === digest(result.structuredContent); } catch { /* not JSON */ }
  return {
    ok: !result.isError,
    response_chars: chars(result),
    text_chars: text.length,
    structured_chars: chars(result.structuredContent),
    text_is_exact_structured: result.structuredContent !== undefined && text === JSON.stringify(result.structuredContent),
    text_is_same_record: parsedSame,
  };
}

function describeAdapter(result) {
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  let envelope;
  try { envelope = JSON.parse(text); } catch { envelope = undefined; }
  return { ok: envelope?.success === true && envelope?.data?.is_error !== true, response_chars: chars(result), text_chars: text.length };
}

const fixtures = {};
const workflows = {
  native_function: [
    ["create", "open_binary", () => ({ path: target("parity-native") })],
    ["read", "binary_overview", () => ({})],
    ["read", "search_procedures", () => ({ pattern: "parity_checksum", mode: "literal", case_sensitive: false })],
    ["read", "procedure_info", () => ({ procedure: fixtures.procedure })],
    ["read", "analyze_function", () => ({ procedure: fixtures.procedure })],
    ["read", "procedure_pseudo_code", () => ({ procedure: fixtures.procedure })],
    ["read", "procedure_callers", () => ({ procedure: fixtures.procedure })],
    ["read", "xrefs", () => ({})],
  ],
  artifacts: [
    ["read", "inspect_plist", () => ({ path: target("parity.plist") })],
    ["read", "inspect_sqlite_database", () => ({ path: target("parity.sqlite") })],
    ...(existsSync(target("parity-go")) ? [["read", "inspect_go_binary", () => ({ path: target("parity-go") })]] : []),
  ],
};

const findProcedure = (value) => {
  const text = JSON.stringify(value) ?? "";
  return text.match(/"(_?parity_checksum)"/)?.[1];
};

const calls = [];
for (const [workflow, steps] of Object.entries(workflows)) {
  for (const [endpoint, operation, params] of steps) {
    const args = params();
    let started = Date.now();
    const rawResult = await raw.callTool({ name: operation, arguments: args }, undefined, CALL_OPTIONS);
    const rawMs = Date.now() - started;
    if (operation === "search_procedures") fixtures.procedure = findProcedure(rawResult.structuredContent ?? rawResult.content);
    started = Date.now();
    const adapterArgs = { operation, params: args };
    const adapterResult = await adapter.callTool({ name: `mcp_aql_${endpoint}`, arguments: adapterArgs }, undefined, CALL_OPTIONS);
    calls.push({
      workflow,
      operation,
      raw: { request_chars: chars({ name: operation, arguments: args }), ms: rawMs, ...describeRaw(rawResult) },
      adapter: { request_chars: chars({ name: `mcp_aql_${endpoint}`, arguments: adapterArgs }), ms: Date.now() - started, ...describeAdapter(adapterResult) },
    });
    console.log(`[measure] ${workflow}/${operation}: raw ${calls.at(-1).raw.response_chars} chars, adapter ${calls.at(-1).adapter.response_chars} chars`);
  }
}

// The same native reads as one adapter batch, against the session opened above.
const batchOperations = workflows.native_function
  .filter(([endpoint, operation]) => endpoint === "read" && operation !== "search_procedures")
  .map(([, operation, params]) => ({ operation, params: params() }));
const batchArgs = { operations: batchOperations };
const batchStarted = Date.now();
const batchResult = await adapter.callTool({ name: "mcp_aql_read", arguments: batchArgs }, undefined, CALL_OPTIONS);
const batch = {
  operations: batchOperations.map((entry) => entry.operation),
  request_chars: chars({ name: "mcp_aql_read", arguments: batchArgs }),
  ms: Date.now() - batchStarted,
  ...describeAdapter(batchResult),
  summary: (() => { try { return JSON.parse(batchResult.content[0].text).summary; } catch { return undefined; } })(),
};

// Introspection the model fetches before calling these operations through the adapter.
const introspection = {};
for (const operation of new Set(Object.values(workflows).flat().map(([, name]) => name))) {
  const result = await adapter.callTool({ name: "mcp_aql_read", arguments: { operation: "introspect", params: { query: "operations", name: operation } } });
  introspection[operation] = result.content?.[0]?.text?.length ?? 0;
}

await Promise.allSettled([
  raw.callTool({ name: "close_binary", arguments: { overwrite: false } }, undefined, CALL_OPTIONS),
  adapter.callTool({ name: "mcp_aql_create", arguments: { operation: "close_binary", params: { overwrite: false } } }, undefined, CALL_OPTIONS),
]);
await Promise.allSettled([raw.close(), adapter.close()]);

writeFileSync(outPath, JSON.stringify({
  measured_at: new Date().toISOString(),
  method: "Serialized JSON characters of MCP tools/list entries, tools/call requests (name + arguments) and results, from a live REA 6.5.0 in an isolated VM, called directly and through the adapter.",
  procedure: fixtures.procedure ?? null,
  catalog,
  up_front: upFront,
  calls,
  batch,
  introspection_chars: introspection,
}, null, 2));
console.log(`[measure] wrote ${outPath}`);
