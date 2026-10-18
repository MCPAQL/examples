// mcpaql-parity suite for the REA stage-1 adapter. Run it only inside an isolated VM: it
// launches REA twice, once directly (the official arm) and once through the adapter.
//
//   REA_COMMAND=/path/to/node_modules/.bin/rea \
//   REA_ANALYSIS_PROVIDER=ghidra GHIDRA_INSTALL_DIR=... JAVA_HOME=... \
//   mcpaql-parity --suite validation/parity-suite.mjs --adapter adapter/dist/server.js \
//     --report validation/parity-report.json --timeout-ms 600000 --max-total-timeout-ms 1800000
//
// REA keeps one current binary per server process, so each arm opens the native target in
// openSessions and runs the same session-recording calls, in the same order, on both arms.
// Only analysis calls are made: nothing runs the targets, reaches a network or writes
// outside REA's own workspace. See validation/README.md.

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const targets = process.env.REA_PARITY_TARGETS ?? join(here, "targets", "build");
const reaCommand = process.env.REA_COMMAND;
const SESSION_CALL_OPTIONS = { timeout: 600_000, resetTimeoutOnProgress: true, maxTotalTimeout: 1_800_000, onprogress: () => undefined };

const target = (name) => join(targets, name);

// Operations the adapter returns as a result handle (schema-overrides.json result_shaping).
// Parity compares full results, so the adapter arm asks for them; validation/check-shaping.mjs
// checks the handles themselves.
const UNSHAPED = new Set(["analyze_function"]);
const unshaped = (args) => (fixtures, variant) => {
  const built = typeof args === "function" ? args(fixtures, variant) : args;
  return built && variant === "mcpaql" ? { ...built, _full_result: true } : built;
};

async function callArm(clients, variant, endpoint, operation, params) {
  if (variant === "official") {
    const result = await clients.official.callTool({ name: operation, arguments: params }, undefined, SESSION_CALL_OPTIONS);
    return { ok: !result.isError, payload: result.structuredContent ?? result.content };
  }
  const adapterParams = UNSHAPED.has(operation) ? { ...params, _full_result: true } : params;
  const result = await clients.mcpaql.callTool({ name: `mcp_aql_${endpoint}`, arguments: { operation, params: adapterParams } }, undefined, SESSION_CALL_OPTIONS);
  const envelope = JSON.parse(result.content?.find((item) => item.type === "text")?.text ?? "null");
  const data = envelope?.data;
  return {
    ok: envelope?.success === true && data?.is_error !== true && !result.isError,
    payload: data?.structured_content ?? data?.content ?? envelope?.error,
  };
}

async function onBothArms(clients, endpoint, operation, params) {
  const [official, mcpaql] = await Promise.all([
    callArm(clients, "official", endpoint, operation, params),
    callArm(clients, "mcpaql", endpoint, operation, params),
  ]);
  if (!official.ok || !mcpaql.ok) {
    throw new Error(`${operation} failed: official=${JSON.stringify(official.payload)?.slice(0, 300)} mcpaql=${JSON.stringify(mcpaql.payload)?.slice(0, 300)}`);
  }
  return {
    official: official.payload,
    mcpaql: mcpaql.payload,
    same: JSON.stringify(official.payload) === JSON.stringify(mcpaql.payload),
  };
}

const read = (name, args, note) => ({ name, category: "PURE_READ", args: typeof args === "function" ? args : () => args, note });
const skip = (name, note) => ({ name, category: "SKIP", args: () => null, note });
const procedure = (fixtures) => (fixtures.procedure ? { procedure: fixtures.procedure } : null);
const ifTarget = (name, args) => () => (existsSync(target(name)) ? args : null);

export const suite = {
  name: "rea-mcp",
  // The adapter's own REA child runs in the adapter directory, so the raw arm does too.
  upstreamStdio: { command: reaCommand ?? "rea", args: ["mcp"], cwd: join(here, "..", "adapter") },
  operations: [
    skip("open_binary", "opened on each arm in openSessions; compared in the session report"),
    skip("close_binary", "closed on each arm in closeSessions"),

    read("binary_overview", {}),
    read("list_architectures", {}),
    read("list_documents", {}),
    skip("current_document", "not declared by the Ghidra provider"),
    read("list_segments", {}),
    read("list_procedures", {}),
    read("list_strings", {}),
    read("search_procedures", { pattern: "parity_", mode: "literal", case_sensitive: false }),
    read("search_strings", { pattern: "authorization failed", mode: "literal", case_sensitive: false }),
    read("procedure_info", procedure),
    read("procedure_assembly", procedure),
    read("procedure_pseudo_code", procedure),
    read("procedure_callers", procedure),
    read("procedure_callees", procedure),
    read("analyze_function", unshaped(procedure)),
    read("xrefs", (fixtures) => (fixtures.address ? { address: fixtures.address } : null)),
    read("inspect_macho", {}),
    read("inspect_artifact", {}),
    read("inspect_analysis_view", (fixtures, variant) => (fixtures.evidence?.[variant]
      ? { source: { kind: "retained-evidence", evidence_id: fixtures.evidence[variant] }, view: { kind: "native", facet: "assembly", limit: 8, offset: 0 } }
      : null)),
    read("list_unknowns", { limit: 50, offset: 0 }),
    read("get_evidence_bundle", { detail: "summary" }),
    read("inspect_plist", ifTarget("parity.plist", { path: target("parity.plist") })),
    read("inspect_sqlite_database", ifTarget("parity.sqlite", { path: target("parity.sqlite") })),
    read("inspect_go_binary", ifTarget("parity-go", { path: target("parity-go") }), "needs the optional Go target"),
  ],

  async setupFixtures() {
    if (!reaCommand) throw new Error("Set REA_COMMAND to the installed rea binary (npm install --omit=optional rea-agents@6.5.0).");
    if (!existsSync(target("parity-native"))) throw new Error(`No parity targets in ${targets}; run validation/targets/build.sh first.`);
    return { sessions: [] };
  },

  async openSessions(fixtures, clients) {
    const report = {};
    // Recorded first, so closeSessions closes whichever arm opened if the other fails.
    fixtures.sessions.push("official", "mcpaql");
    report.open_binary = await onBothArms(clients, "create", "open_binary", { path: target("parity-native") });

    // Both arms run the same session-recording calls, so later results stay comparable.
    const search = await onBothArms(clients, "read", "search_procedures", { pattern: "parity_checksum", mode: "literal", case_sensitive: false });
    // From normalized_result: the record also echoes the search pattern under parameters.
    const match = search.official?.normalized_result?.find?.((entry) => /^_?parity_checksum$/.test(entry?.value));
    fixtures.procedure = match?.value;
    fixtures.address = match?.address;
    if (!fixtures.procedure) throw new Error("search_procedures did not return parity_checksum; check the provider and target.");
    const analysis = await onBothArms(clients, "read", "analyze_function", { procedure: fixtures.procedure });
    fixtures.evidence = { official: analysis.official?.evidence_id, mcpaql: analysis.mcpaql?.evidence_id };

    report.search_procedures = { same: search.same };
    report.analyze_function = { same: analysis.same, evidence: fixtures.evidence };
    report.open_binary = { same: report.open_binary.same, official: report.open_binary.official, mcpaql: report.open_binary.mcpaql };
    console.log("[rea-mcp] session setup:", JSON.stringify({ procedure: fixtures.procedure, evidence: fixtures.evidence, same: { open_binary: report.open_binary.same, search_procedures: search.same, analyze_function: analysis.same } }));
    if (process.env.REA_PARITY_SESSION_REPORT) writeFileSync(process.env.REA_PARITY_SESSION_REPORT, JSON.stringify(report, null, 2));
    return fixtures;
  },

  async closeSessions(fixtures, clients) {
    // close_binary without snapshot_path writes nothing; overwrite stays false.
    await Promise.allSettled(fixtures.sessions.map((variant) => callArm(clients, variant, "create", "close_binary", { overwrite: false })));
  },

  async teardownFixtures() {},
};

export default suite;
