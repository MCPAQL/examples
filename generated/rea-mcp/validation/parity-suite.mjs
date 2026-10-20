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
// REA_PARITY_PROFILE=app runs a second, smaller pass with the hand-built parity.app open
// instead, for the operations that read an app bundle; its report covers only those.
// Only analysis calls are made: nothing runs the targets, reaches a network or writes
// outside REA's own workspace. See validation/README.md.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const targets = process.env.REA_PARITY_TARGETS ?? join(here, "targets", "build");
const profile = process.env.REA_PARITY_PROFILE ?? "native";
if (!["native", "app"].includes(profile)) throw new Error(`REA_PARITY_PROFILE must be native or app, not ${profile}`);
const reaCommand = process.env.REA_COMMAND;
// REA's committed tool catalog, for the input examples its schemas carry.
const reaTools = JSON.parse(gunzipSync(readFileSync(join(here, "..", "capture", "rea-mcp-tool-catalog-6.5.0.json.gz"))).toString()).catalog;
// CREATE operations write only here, one directory per arm; teardown deletes it.
const sandbox = join(targets, "parity-sandbox");
const inSandbox = (variant, name) => join(sandbox, variant, name);
// REA_PARITY_TARGETS can move the sandbox, and setup and teardown delete it, so refuse any
// location outside this checkout or ~/rea-eval.
function assertSandboxIsSafe() {
  const inside = (root) => {
    const rel = relative(resolve(root), resolve(sandbox));
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && rel.split(sep).at(-1) === "parity-sandbox";
  };
  if (!inside(join(here, "..", "..", "..")) && !inside(join(homedir(), "rea-eval"))) {
    throw new Error(`Refusing to use ${sandbox} as the CREATE sandbox: it must be under this checkout or ~/rea-eval.`);
  }
}
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

// params is an object, or a function of the arm for arguments built from that arm's own results.
async function onBothArms(clients, endpoint, operation, params) {
  const paramsFor = typeof params === "function" ? params : () => params;
  const [official, mcpaql] = await Promise.all([
    callArm(clients, "official", endpoint, operation, paramsFor("official")),
    callArm(clients, "mcpaql", endpoint, operation, paramsFor("mcpaql")),
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

// For setup calls whose results only feed later builders: a failure leaves those builders
// without input, so they report SKIPPED (missing fixture), instead of stopping the run.
async function optionalOnBothArms(clients, endpoint, operation, params) {
  try {
    return await onBothArms(clients, endpoint, operation, params);
  } catch (error) {
    console.log(`[rea-mcp] setup call ${operation} failed: ${error.message.slice(0, 300)}`);
    return null;
  }
}

const read = (name, args, note) => ({ name, category: "PURE_READ", args: typeof args === "function" ? args : () => args, note });
const skip = (name, note) => ({ name, category: "SKIP", args: () => null, note });
// A write on each arm in turn; the harness masks the arm names in its sandbox paths.
const write = (name, args, note) => ({ name, category: "PAIRED_WRITE", args: typeof args === "function" ? args : () => args, note });
const findString = (value, pattern) => {
  if (typeof value === "string") return pattern.test(value) ? value : undefined;
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findString(item, pattern);
      if (found) return found;
    }
  }
  return undefined;
};
const unknownParams = (question, fixtures) => ({
  question,
  severity: "low",
  domain: "parity",
  required_authority: "analyst-inference",
  required_confidence: "inferred",
  required_environment: null,
  recommended_probes: [{ operation: "procedure_callers", rationale: "List the static callers first." }],
  relationships: [],
  supporting_evidence_ids: fixtures.evidence?.official ? [fixtures.evidence.official] : [],
});
// An input example from REA's own tool schema.
const example = (name) => { const tool = reaTools.find((entry) => entry.name === name); return tool?.inputSchema?.examples?.[0] ?? null; };
const procedure = (fixtures) => (fixtures.procedure ? { procedure: fixtures.procedure } : null);
const at = (fixtures) => (fixtures.address ? { address: fixtures.address } : null);
// Builds arguments from this arm's own evidence records (see openSessions); null if one is missing.
const fromRecords = (keys, build) => (fixtures, variant) => {
  const records = fixtures.records?.[variant];
  return records && keys.every((key) => records[key]) ? build(records, fixtures) : null;
};

// A 2x2 PNG of one color, in the form compare_web_screenshots takes.
function screenshot([r, g, b]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const row = [0, r, g, b, r, g, b];
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([...row, ...row]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length, media_type: "image/png", data_base64: png.toString("base64") };
}
const ifTarget = (name, args) => () => (existsSync(target(name)) ? args : null);

// The app profile: operations that need an app bundle as the current target.
function appOperations() {
  return [
    read("inspect_keyed_archive", { path: "Contents/Resources/parity.archive" }),
    read("decode_interface_builder", { detail: "summary" }, "hand-built nib-shaped keyed archive; no ibtool"),
    read("inspect_asset_catalog", {}, "the bundle has no asset catalog (building one needs actool)"),
    read("project_apple_application_graph", fromRecords(["inventory"], (r) => ({ inventory_evidence: [r.inventory] }))),
    // REA extracts into a fresh directory under os.tmpdir(); run this profile with TMPDIR inside
    // the sandbox you will delete (the adapter passes TMPDIR through).
    write("extract_artifact", {}),
  ];
}

async function openAppSession(fixtures, clients) {
  fixtures.sessions.push("official", "mcpaql");
  const opened = await onBothArms(clients, "create", "open_binary", { path: target("parity.app") });
  fixtures.records = { official: {}, mcpaql: {} };
  const inventory = await optionalOnBothArms(clients, "read", "inspect_artifact", {});
  for (const variant of ["official", "mcpaql"]) {
    fixtures.records[variant].inventory = inventory?.[variant]?.normalized_result?.substeps?.find?.((step) => step?.evidence?.operation === "inventory_artifact")?.evidence;
  }
  console.log("[rea-mcp] app session setup:", JSON.stringify({ open_binary_same: opened.same, inventory: Boolean(fixtures.records.official.inventory) }));
  return fixtures;
}

export const suite = {
  name: "rea-mcp",
  // The adapter's own REA child runs in the adapter directory, so the raw arm does too.
  upstreamStdio: { command: reaCommand ?? "rea", args: ["mcp"], cwd: join(here, "..", "adapter") },
  // Each arm runs its own REA process, so binary_session reports different pids, start and
  // observation times, and names the connected client: this harness on the raw arm, the adapter
  // on the other.
  // In the app profile, extract_artifact also names a fresh random directory on each arm.
  normalize: { extraVolatileKeyPatterns: [/(^|_)pid$/i, /^started_at$/i, /^observed_at$/i, /^client$/i, ...(profile === "app" ? [/^output_root$/i] : [])] },
  operations: profile === "app" ? appOperations() : [
    skip("open_binary", "opened on each arm in openSessions; compared in the session report"),
    skip("close_binary", "closed on each arm in closeSessions"),

    read("binary_overview", {}),
    read("list_architectures", {}),
    read("list_documents", {}),
    read("current_document", {}, "not declared by the Ghidra provider; both arms are expected to return the same error"),
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

    // Native session: addresses, names, bytes and call structure on the C target.
    read("inspect_native_instruction", at),
    read("resolve_native_call_targets", at),
    read("inspect_address_context", at),
    read("address_name", at),
    read("address_to_file_offset", at),
    read("resolve_containing_procedure", at),
    read("next_address", at),
    read("prev_address", at),
    read("comment", at),
    read("inline_comment", at),
    read("list_names", {}),
    read("list_bookmarks", {}),
    read("current_address", {}),
    read("current_procedure", {}),
    read("get_navigation_context", {}),
    read("read_bytes", (fixtures) => (fixtures.address ? { address: fixtures.address, length: 32 } : null)),
    read("search_bytes", { pattern: "70 61 72 69 74 79", limit: 10 }),
    read("inspect_native_data_type", (fixtures) => (fixtures.stringAddress ? { address: fixtures.stringAddress } : null)),
    read("procedure_address", procedure),
    read("read_function_instructions", procedure),
    read("procedure_references", (fixtures) => (fixtures.procedure ? { procedure: fixtures.procedure, direction: "incoming" } : null)),
    read("inspect_native_api", procedure),
    read("trace_native_values", (fixtures) => (fixtures.procedure ? { procedure: fixtures.procedure, max_depth: 1, max_functions: 4, limit: 50 } : null)),
    read("batch_decompile", (fixtures) => (fixtures.address ? { addresses: [fixtures.address] } : null)),
    read("get_call_graph", (fixtures) => (fixtures.address ? { address: fixtures.address, direction: "backward" } : null)),
    read("find_xrefs_to_name", (fixtures) => (fixtures.procedure ? { name: fixtures.procedure } : null)),
    read("trace_call_path", (fixtures) => (fixtures.procedure ? { start: "_main", goal: fixtures.procedure, direction: "forward" } : null)),
    read("trace_feature", { query: "authorization failed", case_sensitive: false }),
    read("trace_native_ui_action", (fixtures) => (fixtures.procedure ? { action: fixtures.procedure, max_depth: 2 } : null)),
    read("inspect_native_dispatch_metadata", { max_records: 20 }),
    read("get_objc_classes", {}),
    read("get_objc_protocols", {}),
    read("analyze_swift_types", {}),
    read("demangle_swift", { symbols: ["$sSiN", "$s4main5ParityV5countSivg"] }),
    read("inspect_native_load_image", {}, "DOS MZ and COM images only; the Mach-O target is expected to be reported as unsupported"),
    read("inspect_signature", {}),
    read("trace_dylib_resolution", {}),
    read("binary_session", {}),

    // File formats, from the hand-built fixtures in targets/ (fixtures.mjs and build.sh).
    read("inspect_binary_layout", ifTarget("parity-elf", { path: target("parity-elf"), detail: "summary" })),
    read("inspect_plist", ifTarget("parity.plist", { path: target("parity.plist") })),
    read("inspect_sqlite_database", ifTarget("parity.sqlite", { path: target("parity.sqlite") })),
    read("inspect_go_binary", ifTarget("parity-go", { path: target("parity-go") }), "needs the optional Go target"),
    read("inspect_pe_resources", ifTarget("parity-pe.exe", { path: target("parity-pe.exe") })),
    read("inspect_rust_binary", ifTarget("parity-audit", { path: target("parity-audit") }), "hand-built: a C binary with a cargo-auditable .dep-v0 section, not Rust"),
    read("inspect_electron_fuses", ifTarget("parity-fuses", { path: target("parity-fuses") }), "hand-built: a C binary carrying Electron's fuse sentinel, not Electron"),
    read("inspect_wasm_artifact", ifTarget("parity.wasm", { path: target("parity.wasm"), detail: "summary" })),
    read("inspect_evm_interface", ifTarget("parity-evm.hex", { path: target("parity-evm.hex"), encoding: "hex", detail: "summary" })),
    read("inspect_firmware_regions", ifTarget("parity-firmware.bin", { path: target("parity-firmware.bin") })),
    read("analyze_javascript_application", ifTarget("parity-js", { input_path: target("parity-js"), format: "directory", detail: "summary" })),
    read("compare_web_screenshots", { before: screenshot([255, 255, 255]), after: screenshot([255, 0, 0]) }),
    read("inspect_managed_artifact", ifTarget("parity-pe.exe", { path: target("parity-pe.exe"), detail: "summary" }), "negative input: a native PE with no CLI header"),
    read("inspect_managed_members", ifTarget("parity-pe.exe", { path: target("parity-pe.exe"), detail: "summary" }), "negative input: a native PE with no CLI header"),
    read("inspect_managed_native_boundaries", ifTarget("parity-pe.exe", { path: target("parity-pe.exe") }), "negative input: a native PE with no CLI header"),
    read("inspect_dart_aot", ifTarget("parity-elf", { path: target("parity-elf"), detail: "summary" }), "negative input: a Go ELF, not a Dart AOT snapshot"),
    read("identify_flutter_build", ifTarget("parity-elf", { path: target("parity-elf") }), "negative input: a Go ELF, not a Flutter app"),

    // Compare and compose: inputs are evidence records from this arm's own setup calls.
    read("compare_functions", fromRecords(["checksum", "compare"], (r) => ({ left: r.checksum, right: r.compare }))),
    read("build_call_path", fromRecords(["checksum", "compare"], (r, fixtures) => (fixtures.compareAddress && fixtures.address
      ? { functions: [r.compare, r.checksum], start: { address: fixtures.compareAddress }, goal: { address: fixtures.address } }
      : null))),
    read("compare_artifacts", fromRecords(["inventory"], (r) => ({ left: r.inventory, right: r.inventory })), "the native target's inventory compared with itself"),
    read("find_changed_behavior", fromRecords(["artifactComparison"], (r) => ({ comparisons: [r.artifactComparison] }))),
    read("project_android_application_graph", fromRecords(["inventory"], (r) => ({ inventory_evidence: [r.inventory] })), "negative input: a Mach-O inventory"),
    read("project_harmony_application_graph", fromRecords(["inventory"], (r) => ({ inventory_evidence: [r.inventory] })), "negative input: a Mach-O inventory"),
    read("compare_managed_members", fromRecords(["managedMembers", "managedMembers2"], (r) => ({ left: r.managedMembers, right: r.managedMembers2 })), "negative input: two native PEs, so no managed members"),
    read("project_managed_application_graph", fromRecords(["managedArtifact", "managedMembers", "managedBoundaries"],
      (r) => ({ managed_artifact: r.managedArtifact, managed_members: r.managedMembers, managed_native_boundaries: r.managedBoundaries })), "negative input: a native PE"),
    read("verify_managed_native_boundaries", fromRecords(["managedBoundaries", "checksum"],
      (r) => ({ managed_boundaries: r.managedBoundaries, native_observations: [r.checksum] })), "negative input: a native PE"),
    read("trace_javascript_semantics", fromRecords(["application"],
      (r) => ({ application: r.application, query: { seed: { kind: "literal", value: "authorization failed" }, direction: "forward-influence" } }))),
    read("trace_application_feature", fromRecords(["application"],
      (r) => ({ application: r.application, seed: { kind: "string", value: "authorization failed", match: "contains" } }))),
    read("compare_application_versions", fromRecords(["application", "application2"], (r) => ({ left: r.application, right: r.application2 }))),
    read("compare_javascript_export_shapes", fromRecords(["application", "application2"], (r) => ({
      left: r.application, left_module_path: "src/feature.js", left_export_name: "parityFeature",
      right: r.application2, right_module_path: "src/feature.js", right_export_name: "parityFeature",
    }))),

    // Evidence bundles and residual unknowns, from the bundles and the unknown recorded in openSessions.
    // Both arms read the raw arm's bundle files; openSessions checks the two arms wrote identical bytes.
    read("compare_bundles", (fixtures) => (fixtures.unknownId ? { left_bundle_path: inSandbox("official", "bundle-1.json"), right_bundle_path: inSandbox("official", "bundle-2.json") } : null)),
    read("verify_unknown_resolution", (fixtures) => (fixtures.unknownId ? { unknown_id: fixtures.unknownId } : null)),
    read("verify_reconstruction", fromRecords(["artifactComparison"], (r) => ({
      specification: { name: "parity", claims: [{ claim_id: "parity-inventory", title: "The inventory is unchanged", comparison_evidence_id: r.artifactComparison.evidence_id, kind: "structural-artifact", dimension: "overall" }] },
    }))),
    read("build_reconstruction_obligation_ledger", example("build_reconstruction_obligation_ledger"), "REA's schema example: an empty bundle"),
    read("evaluate_reconstruction_coverage", example("evaluate_reconstruction_coverage"), "REA's schema example: an empty bundle and one boundary"),
    read("compare_source_to_bundle", fromRecords(["application"], (r) => ({ ...example("compare_source_to_bundle"), application: r.application })), "REA's schema example reference graph against the JavaScript fixture"),
    read("trace_web_source_location", example("trace_web_source_location"), "REA's schema example; its manifest path does not exist"),

    // fake-device: recorded-capture stand-ins, hand-built. Nothing was captured from a device.
    read("inspect_recorded_crash", ifTarget("parity-core", { path: target("parity-core") }), "fake-device: hand-built ELF core"),
    read("inspect_web_network_capture", ifTarget("parity.har", { capture_path: target("parity.har"), format: "har" }), "fake-device: hand-built HAR"),
    read("inspect_pcap_capture", ifTarget("parity.pcap", { path: target("parity.pcap") }), "fake-device: hand-built pcap"),
    read("inspect_packet_capture", ifTarget("parity.pcap", { path: target("parity.pcap"), fields: ["ip.src", "udp.dstport"] }), "fake-device: hand-built pcap"),
    read("compare_web_captures", example("compare_web_captures"), "fake-device: REA's schema example of two recorded browser scenarios"),
    read("decode_signal_recording", ifTarget("parity.sr", { path: target("parity.sr"), decoders: "uart:rx=RX:baudrate=9600" }), "fake-device: hand-built sigrok recording"),

    // Local client discovery: reports which external decoders REA can find. Reads no capture.
    read("inspect_pcap_client", {}),
    read("inspect_apktool_client", {}),
    read("inspect_packet_fields", { kind: "protocols", query: "http", limit: 10 }),
    read("inspect_signal_decoders", { query: "uart", limit: 10 }),
    read("inspect_with_objdump", { operation: "architectures" }),

    // CREATE, sandboxed: every output path is under parity-sandbox/<arm>/, deleted at teardown.
    write("export_evidence_bundle", (fixtures, variant) => ({ path: inSandbox(variant, "export.json"), overwrite: false })),
    write("import_evidence_bundle", (fixtures, variant) => (fixtures.unknownId ? { path: inSandbox(variant, "bundle-1.json") } : null)),
    write("record_unknown", (fixtures) => unknownParams("Does parity_compare ever see an empty right-hand string?", fixtures)),
    write("extract_firmware", (fixtures, variant) => (existsSync(target("parity-firmware.bin")) ? { path: target("parity-firmware.bin"), output_directory: inSandbox(variant, "firmware-out") } : null)),
    write("recover_javascript_sources", (fixtures, variant) => (existsSync(target("parity-js")) ? { path: join(target("parity-js"), "src", "index.js"), output_directory: inSandbox(variant, "recovered-js") } : null)),
    write("export_web_scripts", (fixtures, variant) => (existsSync(target("parity.har")) ? { capture_path: target("parity.har"), output_directory: inSandbox(variant, "web-scripts") } : null), "negative input: a HAR, not a browser capture"),
  ],

  async setupFixtures() {
    if (!reaCommand) throw new Error("Set REA_COMMAND to the installed rea binary (npm install --omit=optional rea-agents@6.5.0).");
    if (!existsSync(target("parity-native"))) throw new Error(`No parity targets in ${targets}; run validation/targets/build.sh first.`);
    assertSandboxIsSafe();
    rmSync(sandbox, { recursive: true, force: true });
    for (const variant of ["official", "mcpaql"]) mkdirSync(join(sandbox, variant), { recursive: true });
    return { sessions: [] };
  },

  async openSessions(fixtures, clients) {
    if (profile === "app") return openAppSession(fixtures, clients);
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
    const strings = await onBothArms(clients, "read", "search_strings", { pattern: "authorization failed", mode: "literal", case_sensitive: false });
    fixtures.stringAddress = strings.official?.normalized_result?.find?.((entry) => entry?.address)?.address;

    // Evidence records that the compare and compose operations take as input, kept per arm.
    fixtures.records = { official: {}, mcpaql: {} };
    const retained = (payload) => (payload?.normalized_result?.parent_evidence_id
      ? { kind: "retained-evidence", evidence_id: payload.normalized_result.parent_evidence_id }
      : undefined);
    const keep = (key, result, pick = (payload) => payload) => {
      if (!result) return;
      fixtures.records.official[key] = pick(result.official);
      fixtures.records.mcpaql[key] = pick(result.mcpaql);
    };
    keep("checksum", analysis);
    const compareSearch = await optionalOnBothArms(clients, "read", "search_procedures", { pattern: "parity_compare", mode: "literal", case_sensitive: false });
    fixtures.compareAddress = compareSearch?.official?.normalized_result?.find?.((entry) => /^_?parity_compare$/.test(entry?.value))?.address;
    keep("compare", await optionalOnBothArms(clients, "read", "analyze_function", { procedure: "_parity_compare" }));
    keep("inventory", await optionalOnBothArms(clients, "read", "inspect_artifact", {}),
      (payload) => payload?.normalized_result?.substeps?.find?.((step) => step?.evidence?.operation === "inventory_artifact")?.evidence);
    keep("artifactComparison", await optionalOnBothArms(clients, "read", "compare_artifacts",
      (variant) => ({ left: fixtures.records[variant].inventory, right: fixtures.records[variant].inventory })));
    if (existsSync(target("parity-pe.exe"))) {
      keep("managedArtifact", await optionalOnBothArms(clients, "read", "inspect_managed_artifact", { path: target("parity-pe.exe") }));
      keep("managedMembers", await optionalOnBothArms(clients, "read", "inspect_managed_members", { path: target("parity-pe.exe") }));
      keep("managedBoundaries", await optionalOnBothArms(clients, "read", "inspect_managed_native_boundaries", { path: target("parity-pe.exe") }));
    }
    if (existsSync(target("parity-pe-stripped.exe"))) {
      keep("managedMembers2", await optionalOnBothArms(clients, "read", "inspect_managed_members", { path: target("parity-pe-stripped.exe") }));
    }
    if (existsSync(target("parity-js"))) {
      // The summary call retains the complete analysis; later calls refer to it by evidence id.
      keep("application", await optionalOnBothArms(clients, "read", "analyze_javascript_application", { input_path: target("parity-js"), format: "directory", detail: "summary" }),
        retained);
    }
    if (existsSync(target("parity-js-v2"))) {
      keep("application2", await optionalOnBothArms(clients, "read", "analyze_javascript_application", { input_path: target("parity-js-v2"), format: "directory", detail: "summary" }),
        retained);
    }

    // Two Evidence bundles, before and after one recorded unknown, written to the sandbox on each arm.
    await optionalOnBothArms(clients, "create", "export_evidence_bundle", (variant) => ({ path: inSandbox(variant, "bundle-1.json"), overwrite: false }));
    const unknown = await optionalOnBothArms(clients, "create", "record_unknown", unknownParams("Which caller supplies parity_checksum's input at run time?", fixtures));
    fixtures.unknownId = findString(unknown?.official, /^unk_[a-f0-9]{64}$/);
    await optionalOnBothArms(clients, "create", "export_evidence_bundle", (variant) => ({ path: inSandbox(variant, "bundle-2.json"), overwrite: false }));
    const sameBundles = ["bundle-1.json", "bundle-2.json"].map((name) => {
      const [official, mcpaql] = ["official", "mcpaql"].map((variant) => (existsSync(inSandbox(variant, name)) ? readFileSync(inSandbox(variant, name)) : null));
      return official !== null && mcpaql !== null && official.equals(mcpaql);
    });
    report.evidence_bundles = { same: sameBundles };

    report.search_procedures = { same: search.same };
    report.analyze_function = { same: analysis.same, evidence: fixtures.evidence };
    report.open_binary = { same: report.open_binary.same, official: report.open_binary.official, mcpaql: report.open_binary.mcpaql };
    console.log("[rea-mcp] session setup:", JSON.stringify({ procedure: fixtures.procedure, address: fixtures.address, stringAddress: fixtures.stringAddress, unknownId: fixtures.unknownId, sameBundles, evidence: fixtures.evidence, same: { open_binary: report.open_binary.same, search_procedures: search.same, analyze_function: analysis.same } }));
    if (process.env.REA_PARITY_SESSION_REPORT) writeFileSync(process.env.REA_PARITY_SESSION_REPORT, JSON.stringify(report, null, 2));
    return fixtures;
  },

  async closeSessions(fixtures, clients) {
    // close_binary without snapshot_path writes nothing; overwrite stays false.
    await Promise.allSettled(fixtures.sessions.map((variant) => callArm(clients, variant, "create", "close_binary", { overwrite: false })));
  },

  async teardownFixtures() {
    assertSandboxIsSafe();
    rmSync(sandbox, { recursive: true, force: true });
  },
};

export default suite;
