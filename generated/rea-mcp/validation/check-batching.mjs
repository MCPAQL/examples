// VM-only: batching checks (spec section 7 and 7.5) against the REA adapter, using
// analysis calls only.
// Usage: node validation/check-batching.mjs <adapterDir> <targetsDir> <spec/schemas/batch-operation.schema.json>
//          <directory with ajv and ajv-formats installed, e.g. an MCPAQL/tools checkout> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [adapterDir, targets, schemaPath, ajvDir, outPath] = process.argv.slice(2);
const sdk = (p) => import(pathToFileURL(join(adapterDir, "node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href);
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");
const require = createRequire(join(ajvDir, "package.json"));
const Ajv2020 = require("ajv/dist/2020").default;
const ajv = new Ajv2020({ strict: false, allErrors: true });
require("ajv-formats").default(ajv);
const validateBatch = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

const native = join(targets, "parity-native");
const OPTS = { timeout: 600000, resetTimeoutOnProgress: true, onprogress: () => {} };
const results = {};
const check = (name, pass, detail) => { results[name] = { pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) }; console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 300)}`); };

async function adapter(extraEnv = {}) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)), ...extraEnv };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(adapterDir, "dist", "server.js")], cwd: adapterDir, env, stderr: "pipe" });
  let log = "";
  transport.stderr?.on("data", (chunk) => { log += chunk.toString(); });
  const client = new Client({ name: "batch-checks", version: "0" });
  await client.connect(transport);
  return { client, log: () => log };
}
const envelope = (result) => JSON.parse(result.content.find((item) => item.type === "text").text);
const call = async (client, tool, args, opts = OPTS) => envelope(await client.callTool({ name: tool, arguments: args }, undefined, opts));
const procedure = "_parity_checksum";

// 1. Read batch equals the individual calls, in order.
{
  const { client } = await adapter();
  await call(client, "mcp_aql_create", { operation: "open_binary", params: { path: native } });
  const search = await call(client, "mcp_aql_read", { operation: "search_procedures", params: { pattern: "parity_checksum", mode: "literal", case_sensitive: false } });
  const address = search.data.structured_content.normalized_result[0].address;
  const entries = [
    { operation: "binary_overview", params: {} },
    { operation: "procedure_info", params: { procedure } },
    { operation: "procedure_pseudo_code", params: { procedure } },
    { operation: "xrefs", params: { address } },
  ];
  const singles = [];
  for (const entry of entries) singles.push(await call(client, "mcp_aql_read", entry));
  const batch = await call(client, "mcp_aql_read", { operations: entries });
  check("read_batch_matches_singles", batch.results?.length === 4 && batch.results.every((item, i) => item.index === i && item.operation === entries[i].operation && JSON.stringify(item.result) === JSON.stringify(singles[i])), batch.summary);
  check("read_batch_schema_valid", validateBatch(batch), validateBatch.errors?.slice(0, 3));
  check("read_batch_summary", batch.summary?.total === 4 && batch.summary.succeeded === 4 && batch.summary.failed === 0, batch.summary);

  // 2. Routing: a CREATE operation inside a READ batch is refused and never runs.
  const routed = await call(client, "mcp_aql_read", { operations: [entries[1], { operation: "open_binary", params: { path: native } }, entries[3]] });
  check("routing_wrong_endpoint_refused", routed.results?.[1]?.result?.error?.code === "VALIDATION_WRONG_ENDPOINT" && routed.results[0].result.success && routed.results[2].result.success, routed.summary);

  // 3. Halting (7.5): close_binary needs confirmation, so the batch halts before it.
  const halted = await call(client, "mcp_aql_create", { operations: [
    { operation: "open_binary", params: { path: native } },
    { operation: "close_binary", params: { overwrite: false } },
    { operation: "open_binary", params: { path: native } },
  ] });
  check("halt_before_confirmation_operation", halted.halted_at?.index === 1 && halted.halted_at.operation === "close_binary" && halted.halted_at.result?.error?.code === "VALIDATION_SINGLE_CALL_REQUIRED", halted.halted_at);
  check("halt_pending_operations", halted.pending_operations?.length === 1 && halted.pending_operations[0].index === 2 && halted.summary?.halted === 1 && halted.summary?.pending === 1, { pending: halted.pending_operations, summary: halted.summary });
  check("halt_schema_valid", validateBatch(halted), validateBatch.errors?.slice(0, 3));
  const stillOpen = await call(client, "mcp_aql_read", { operation: "procedure_info", params: { procedure } });
  check("halt_left_session_open", stillOpen.success === true && stillOpen.data?.is_error !== true);

  // 4. Limits and malformed requests.
  const big = await call(client, "mcp_aql_read", { operations: Array.from({ length: 26 }, () => ({ operation: "list_architectures", params: {} })) });
  check("limit_26_refused", big.error?.code === "VALIDATION_BATCH_SIZE", big.error);
  const empty = await call(client, "mcp_aql_read", { operations: [] });
  check("empty_batch_refused", empty.error?.code === "VALIDATION_BATCH_SIZE", empty.error);
  const ambiguous = await call(client, "mcp_aql_read", { operation: "list_architectures", operations: [{ operation: "list_architectures" }] });
  check("operation_and_operations_refused", ambiguous.error?.code === "VALIDATION_AMBIGUOUS_REQUEST", ambiguous.error);

  // 5. EXECUTE: not listed in stage 1, and introspection advertises the exclusion.
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  check("no_execute_endpoint", !tools.includes("mcp_aql_execute"), tools);
  const intro = await call(client, "mcp_aql_read", { operation: "introspect", params: { query: "operations" } });
  const capabilities = JSON.stringify(intro).match(/"capabilities":\{[^}]*\}/)?.[0];
  check("introspect_batch_capabilities", /"batch":true/.test(capabilities ?? "") && /"batch_excluded_endpoints":\["EXECUTE"\]/.test(capabilities ?? ""), capabilities);

  await call(client, "mcp_aql_create", { operation: "close_binary", params: { overwrite: false } });
  await client.close();
}

// 6. MCPAQL_MAX_BATCH_OPERATIONS is honored.
{
  const { client } = await adapter({ MCPAQL_MAX_BATCH_OPERATIONS: "3" });
  const four = await call(client, "mcp_aql_read", { operations: Array.from({ length: 4 }, () => ({ operation: "list_architectures", params: {} })) });
  check("env_max_batch_honored", four.error?.code === "VALIDATION_BATCH_SIZE" && /1 to 3/.test(four.error.message), four.error);
  await client.close();
}

// 7. Progress across a batch with a cold analysis is monotonic and reaches the total.
{
  const { client } = await adapter();
  await call(client, "mcp_aql_create", { operation: "open_binary", params: { path: native } });
  const events = [];
  const started = Date.now();
  const batch = envelope(await client.callTool({ name: "mcp_aql_read", arguments: { operations: [
    { operation: "binary_overview", params: {} },
    { operation: "procedure_info", params: { procedure } },
  ] } }, undefined, { timeout: 600000, resetTimeoutOnProgress: true, onprogress: (p) => events.push({ ...p, t: Date.now() - started }) }));
  const monotonic = events.every((event, i) => i === 0 || event.progress > events[i - 1].progress);
  check("progress_monotonic", monotonic && events.length > 0, { count: events.length, first: events[0], last: events.at(-1), ms: Date.now() - started });
  check("progress_cold_batch_ok", batch.summary?.succeeded === 2, batch.summary);
  await call(client, "mcp_aql_create", { operation: "close_binary", params: { overwrite: false } });
  await client.close();
}

// 8. Cancelling mid-batch stops before the next entry.
{
  const { client, log } = await adapter();
  await call(client, "mcp_aql_create", { operation: "open_binary", params: { path: native } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("parity cancel test"), 2000);
  let rejected;
  try {
    await client.callTool({ name: "mcp_aql_read", arguments: { operations: [
      { operation: "binary_overview", params: {} },
      { operation: "procedure_info", params: { procedure } },
      { operation: "procedure_pseudo_code", params: { procedure } },
    ] } }, undefined, { timeout: 600000, signal: controller.signal, onprogress: () => {} });
  } catch (error) {
    rejected = error.message;
  }
  clearTimeout(timer);
  // Let the upstream finish reporting before reading its log.
  await new Promise((resolve) => setTimeout(resolve, 15000));
  const ran = [...log().matchAll(/"tool":"([a-z_]+)"[^\n]*"msg":"MCP tool execution completed"/g)].map((m) => m[1]);
  check("cancel_rejects_call", Boolean(rejected), rejected);
  check("cancel_stops_before_next_entry", !ran.includes("procedure_info") && !ran.includes("procedure_pseudo_code"), ran);
  const after = await call(client, "mcp_aql_read", { operation: "list_architectures", params: {} });
  check("adapter_usable_after_cancel", after.success === true, after.error);
  await call(client, "mcp_aql_create", { operation: "close_binary", params: { overwrite: false } }).catch(() => undefined);
  await client.close();
}

writeFileSync(outPath, JSON.stringify({ checked_at: new Date().toISOString(), results }, null, 2));
const failed = Object.entries(results).filter(([, r]) => !r.pass).map(([name]) => name);
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
