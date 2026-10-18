// VM-only: result-shaping checks for the REA adapter, using analysis calls only. Run it only
// in an isolated VM: it launches REA twice. Compares the adapter (with result_shaping) against
// raw REA, each with its own session: the analyze_function handle, lossless paging of every
// native facet through the continuation, _full_result, duplicate-text dropping, retention.
// Usage: node validation/check-shaping.mjs <adapterDir> <native target> <out.json>
// (`rea` must be on PATH; the adapter must launch the same rea, see use-local-rea.mjs.)
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [adapterDir, target, outPath] = process.argv.slice(2).map((arg) => resolve(arg));
const sdk = (p) => import(pathToFileURL(join(adapterDir, "node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href);
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
const OPTS = { timeout: 600000, resetTimeoutOnProgress: true, onprogress: () => {} };
const connect = async (command, args, extra = {}) => { const c = new Client({ name: "shaping", version: "0" }); await c.connect(new StdioClientTransport({ command, args, cwd: adapterDir, env: { ...env, ...extra }, stderr: "ignore" })); return c; };
const envelope = (r) => JSON.parse(r.content[0].text);
const results = {};
const check = (name, pass, detail) => { results[name] = { pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) }; console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`); };
function firstDiff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) { const d = firstDiff(a[key], b[key], `${path}.${key}`); if (d) return d; }
  }
  return { path: path || "(root)", raw: JSON.stringify(a)?.slice(0, 160), adapter: JSON.stringify(b)?.slice(0, 160) };
}
const raw = await connect("rea", ["mcp"]);
const shaped = await connect(process.execPath, [join(adapterDir, "dist", "server.js")]);
const rawCall = async (name, args) => (await raw.callTool({ name, arguments: args }, undefined, OPTS));
const aql = async (client, tool, operation, params) => envelope(await client.callTool({ name: tool, arguments: { operation, params } }, undefined, OPTS));
try {
  await rawCall("open_binary", { path: target });
  await aql(shaped, "mcp_aql_create", "open_binary", { path: target });
  const search = await rawCall("search_procedures", { pattern: "parity_checksum", mode: "literal" });
  await aql(shaped, "mcp_aql_read", "search_procedures", { pattern: "parity_checksum", mode: "literal" });
  const procedure = search.structuredContent.normalized_result[0].value;

  // 1. Same call sequence on both arms: raw full, adapter shaped, then adapter _full_result vs raw again.
  const full = (await rawCall("analyze_function", { procedure })).structuredContent;
  const handled = await aql(shaped, "mcp_aql_read", "analyze_function", { procedure });
  check("handle_is_evidence_id", handled.data?.handle === full.evidence_id && handled._meta?.shaped?.returned_chars < 20000, { original: handled._meta?.shaped?.original_chars, returned: handled._meta?.shaped?.returned_chars });
  const keep = ["evidence_id", "operation", "subject", "parameters", "confidence", "authority", "limitations"];
  check("handle_keeps_summary_paths", keep.every((k) => JSON.stringify(handled.data.structured_content[k]) === JSON.stringify(full[k])) && Object.keys(handled.data.structured_content).length === keep.length);
  const fullAgainRaw = (await rawCall("analyze_function", { procedure })).structuredContent;
  const fullFlag = await aql(shaped, "mcp_aql_read", "analyze_function", { procedure, _full_result: true });
  // Not a check: REA derives evidence_id from the session's call history, so a repeat differs.
  results.repeat_changes_evidence_id = { value: full.evidence_id !== fullAgainRaw.evidence_id, first_diff: firstDiff(full, fullAgainRaw) };
  check("full_result_matches_raw", firstDiff(fullAgainRaw, fullFlag.data?.structured_content) === null && !fullFlag._meta, firstDiff(fullAgainRaw, fullFlag.data?.structured_content));

  // 2. Lossless paging: every native facet of the handle, paged to the end, equals the raw record's section.
  const facets = ["procedure", "pseudocode", "assembly", "comments", "callers", "callees", "incoming_references", "outgoing_references", "unresolved_calls", "referenced_strings", "referenced_names", "basic_blocks", "native_api"];
  const facetResults = {};
  let pagedChars = 0;
  for (const facet of facets) {
    const items = [];
    let text = null;
    let offset = 0;
    let pages = 0;
    for (;;) {
      const params = { ...handled.data.continuation.params, view: { kind: "native", facet, limit: 64, offset } };
      const page = await shaped.callTool({ name: handled.data.continuation.tool, arguments: { operation: handled.data.continuation.operation, params } }, undefined, OPTS);
      pagedChars += JSON.stringify(page).length;
      const body = envelope(page);
      pages += 1;
      if (!body.success || body.data?.is_error) { facetResults[facet] = { error: JSON.stringify(body.data?.content ?? body.error).slice(0, 300) }; break; }
      const item = body.data.structured_content.normalized_result.item;
      const coverage = body.data.structured_content.normalized_result.coverage;
      // Arrays page by item; text facets ({ text, unit }) page by code unit. Follow next_offset either way.
      if (Array.isArray(item)) items.push(...item);
      else if (item && typeof item === "object" && typeof item.text === "string") text = { ...item, text: (text?.text ?? "") + item.text };
      else text = item;
      if (coverage?.exhausted !== false || coverage.next_offset == null || pages > 200) { facetResults[facet] = { pages, coverage }; break; }
      offset = coverage.next_offset;
    }
    if (facetResults[facet].error) continue;
    const expected = full.normalized_result[facet];
    const got = text !== null && !Array.isArray(expected) ? text : items;
    // Text facets return { text, unit }; compare the text itself when the raw section is a string.
    const comparable = typeof expected === "string" && got && typeof got === "object" && "text" in got ? got.text : got;
    facetResults[facet].lossless = JSON.stringify(comparable) === JSON.stringify(expected);
    if (!facetResults[facet].lossless) facetResults[facet].diff = firstDiff(expected, comparable);
  }
  const checked = Object.entries(facetResults).filter(([, v]) => v.lossless !== undefined);
  check("facets_lossless", checked.length > 0 && checked.every(([, v]) => v.lossless), Object.fromEntries(Object.entries(facetResults).map(([k, v]) => [k, v.lossless ?? v.error])));
  results.facet_details = facetResults;
  results.sizes = { raw_analyze_function_chars: JSON.stringify(full).length, handle_response_chars: JSON.stringify(handled).length, all_facets_paged_chars: pagedChars };

  // 3. Duplicate-text dropping keeps the structured record intact.
  const rawInfo = await rawCall("procedure_info", { procedure });
  const info = await aql(shaped, "mcp_aql_read", "procedure_info", { procedure });
  check("drop_duplicate_text_lossless", info.data?.content?.length === 0 && JSON.stringify(info.data.structured_content) === JSON.stringify(rawInfo.structuredContent), { raw_chars: JSON.stringify(rawInfo).length, shaped_chars: JSON.stringify(info).length });

  // 4. Retention: retained Evidence does not outlive the session.
  await rawCall("close_binary", { overwrite: false });
  await aql(shaped, "mcp_aql_create", "close_binary", { overwrite: false });
  const after = await aql(shaped, handled.data.continuation.tool, handled.data.continuation.operation, handled.data.continuation.params);
  check("handle_invalid_after_close", after.success === false || after.data?.is_error === true, JSON.stringify(after.error?.details?.content ?? after.data?.content).match(/evidence_[a-z_]+/)?.[0]);
} finally {
  await Promise.allSettled([raw.close(), shaped.close()]);
}

// 5. MCPAQL_RESULT_BUDGET_CHARS=0 turns handles off.
{
  const off = await connect(process.execPath, [join(adapterDir, "dist", "server.js")], { MCPAQL_RESULT_BUDGET_CHARS: "0" });
  try {
    await aql(off, "mcp_aql_create", "open_binary", { path: target });
    const search = await aql(off, "mcp_aql_read", "search_procedures", { pattern: "parity_checksum", mode: "literal" });
    const procedure = search.data.structured_content.normalized_result[0].value;
    const r = await aql(off, "mcp_aql_read", "analyze_function", { procedure });
    check("budget_zero_disables_handles", r.data?.handle === undefined && r.data?.structured_content?.raw_result !== undefined);
    await aql(off, "mcp_aql_create", "close_binary", { overwrite: false });
  } finally {
    await off.close();
  }
}

writeFileSync(outPath, JSON.stringify({ checked_at: new Date().toISOString(), results }, null, 2));
const failed = Object.entries(results).filter(([, r]) => r.pass === false).map(([name]) => name);
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
