# REA MCP Golden Path (stage 1: static analysis)

Pipeline output for wrapping [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) as an MCP-AQL adapter. REA is published as the `rea-agents` npm package, pinned here to **6.5.0**.

REA is a local stdio MCP server with 207 reverse-engineering tools. Some of them run targets, inject Frida scripts, drive browsers and native UIs, or change attached Android devices. This adapter is staged:

| Stage | Scope | Status |
|---|---|---|
| 1 | Static analysis: READ and CREATE operations with no network, device, UI or foreign-code effects | this package |
| 2 | UPDATE and DELETE: provider annotations, bookmarks, updating unknowns | planned |
| 3 | EXECUTE: runtime capture, instrumentation, device control. Denied by default and enabled per deployment with confirmation | planned |

Stage 1 exposes **131 of REA's 207 tools**: 121 READ and 10 CREATE. The other 76 are left out of the adapter entirely: they are not listed, introspectable or callable. Each one is recorded with its reason in `schema/adapter-provenance.json`, under `excluded_operations`.

Use REA for analysis you are authorized to do; see REA's [DISCLAIMER.md](https://github.com/morluto/rea/blob/main/DISCLAIMER.md).

Artifacts:

- `server-config.json`: the stdio launch config, pinned to `rea-agents@6.5.0`.
- `capture/`:
  - REA's published tool catalog (`rea-mcp-tool-catalog-6.5.0.json.gz`);
  - the discovery bundle built from it offline with `mcpaql-import-catalog` (`discovery-bundle.json.gz`). REA was not run.
  - warnings and capture metadata.
- `schema-overrides.json`: the reviewed endpoint and danger-level corrections, the stage-1 exclusions and the child environment passthrough.
- `schema/`: the generated MCP-AQL adapter schema and provenance sidecars.
- `adapter/`: the generated, runnable TypeScript MCP-AQL adapter package.
- `validation/footprint.json`: measured footprint figures.

## Run it only in an isolated environment

REA is not a sandbox. Analysis providers run with your user's permissions, and analyzed targets can carry prompt injection. Run this adapter, and REA, in a disposable VM or container with no production credentials.

"READ, safe" means no effects on the target or the system. It does not mean the data is harmless: `inspect_plist`, `inspect_sqlite_database`, `inspect_with_objdump` and similar tools read any file your user can read. A prompt-injected target could steer those reads toward secrets, and the results go to your model provider.

```bash
cd adapter
npm install
npm run start
```

On the first call, the adapter starts `npx -y rea-agents@6.5.0 mcp` as a child process and keeps it running. REA sessions (an opened binary, retained Evidence) persist across calls until `close_binary` is called or the adapter exits.

`npx` resolves REA's dependency tree fresh, not from REA's lockfile. That includes the optional `frida` dependency, whose install script downloads a native binding, even though stage 1 excludes every Frida operation. To avoid that, install REA into the environment first and point the launch at the local binary:

1. Run `npm install --omit=optional rea-agents@6.5.0`.
2. Edit `target.stdio` in `adapter/src/schema.json` to launch that `rea` binary with the `mcp` argument.

### Analysis provider and tools

Use **Ghidra** for stage 1: `REA_ANALYSIS_PROVIDER=ghidra` with `GHIDRA_INSTALL_DIR` and `JAVA_HOME`. With the Hopper provider, `open_binary` launches the Hopper app, which may come to the foreground, and runs REA's bridge inside it. That is a UI effect stage 1 otherwise excludes.

Several operations work only when REA is told where a local tool is. The adapter passes these variables through to REA when they are set. The `*_COMMAND`, `*_PYTHON`, `*_JAR` and `*_DIRECTORY` values name programs REA will run, so set them only from trusted configuration:

| Variable | Enables |
|---|---|
| `REA_TSHARK_COMMAND`, `REA_TSHARK_PRLIMIT_COMMAND` | `inspect_packet_fields`, `inspect_packet_capture` |
| `REA_SIGROK_COMMAND`, `REA_SIGROK_PRLIMIT_COMMAND` | `inspect_signal_decoders`, `decode_signal_recording` |
| `REA_WABT_BIN_DIRECTORY` | `inspect_wasm_artifact` |
| `REA_PWNTOOLS_PYTHON` | `inspect_binary_layout`, `inspect_recorded_crash` |
| `REA_BINWALK_COMMAND`, `REA_UNBLOB_COMMAND` | `inspect_firmware_regions`, `extract_firmware` |
| `REA_WAKARU_COMMAND` | `recover_javascript_sources` |
| `REA_JADX_MCP_JAR` | the Android class, method and reference operations |
| `REA_OBJDUMP_COMMAND`, `REA_RIZIN_COMMAND` | objdump- and rizin-based inspection |
| `REA_APKTOOL_COMMAND` | `inspect_apktool_client`, `decode_android_resources` |
| `REA_CAPINFOS_COMMAND` | `inspect_pcap_client`, `inspect_pcap_capture` |

These are also passed through: `REA_ANALYSIS_PROVIDER`, `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `REA_GHIDRA_STARTUP_TIMEOUT_MS`, `REA_HOPPER_STARTUP_TIMEOUT_MS`, `REA_MCP_INPUT_SCHEMA_PROFILE`, `REA_LOG_LEVEL` and `TMPDIR`. Without `TMPDIR`, REA writes its byte snapshots of the target under `/tmp` instead of the user's own temporary directory. Apart from these and the MCP SDK's default set, nothing from the adapter's environment reaches REA. On macOS and Linux that set is `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER`; on Windows it is larger and includes `APPDATA`, `LOCALAPPDATA`, `TEMP`, `SYSTEMROOT` and `USERPROFILE` (`getDefaultEnvironment()` in the SDK's stdio client). EVM inspection works on Linux x64 only.

Some static operations parse or run more than their names suggest. All of them are fine in an isolated VM:

- `inspect_artifact` and `extract_artifact` mount DMGs read-only. This is kernel-level filesystem parsing.
- `inspect_recorded_crash` with `include_debugger_context` runs GDB/pwndbg on a core file in batch mode, with auto-load and debuginfod off.
- `inspect_binary_layout` may emulate PLT stubs in Unicorn.

### Timeouts

Native analysis with a cold Ghidra start can take minutes. The adapter's per-call deadline defaults to 60 s and is reset by upstream progress notifications. For native work, set a longer deadline and a hard cap:

```bash
MCPAQL_UPSTREAM_TIMEOUT_MS=600000 MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS=1800000 npm run start
```

## Gate the host, not just the adapter

**Confirm CREATE operations in the host.** `close_binary` and `export_evidence_bundle` are marked `destructive` in the schema, because they can overwrite a caller-chosen path. The generated adapter does not enforce that flag yet (MCPAQL/adapter-generator#48), so the host's approval of `mcp_aql_create` calls is the gate.

**Gate the shell too.** The adapter gates only its own path. REA also ships a CLI, and its agent skill tells agents to run `npx rea-agents@latest …`. A host that allows shell commands should deny direct REA invocations in the same policy, for example:

- `npx * rea-agents*`, `npx rea-agents*`, `npm exec * rea-agents*`, `bunx rea-agents*`, `pnpm dlx rea-agents*`, `yarn dlx rea-agents*`;
- `rea *`;
- any command that registers REA directly with an MCP client.

Install REA without its skill: use `--skill=false`, or skip REA's setup entirely. See MCPAQL/spec#277.

## Token Footprint

Measured 2026-10-17 from REA's own SDK `listTools()` catalog: the CI artifact `rea-test-runtime` from the 6.5.0 release commit, committed here as `capture/rea-mcp-tool-catalog-6.5.0.json.gz`. Sizes are serialized JSON characters. For the adapter, `tools/list` and `introspect` were served by the generated adapter with its upstream command replaced by `/usr/bin/false`, so REA never ran. The adapter figures were re-measured on 2026-10-18 after regenerating with batching and result shaping.

| Surface | Tools | Characters |
|---|---|---|
| REA upstream, all tools (sum of tool definitions in `tools/list`) | 207 | 3,087,725 |
| REA upstream, all tools, model-visible (name + description + inputSchema) | 207 | 792,163 |
| REA upstream, the 131 stage-1 tools, model-visible | 131 | 660,806 |
| Generated MCP-AQL adapter (`tools/list`) | 2 | 4,697 |
| `introspect` operation list (names and descriptions) | — | 72,688 |
| `introspect` detail for every one of the 131 operations | — | 170,809 |

`outputSchema` makes up 73% of REA's `tools/list`. Hosts that build Anthropic API tool definitions don't send it to the model, so the model-visible figures are the relevant ones there.

A public benchmark ([aicodeking/leanrea](https://github.com/aicodeking/leanrea), `bench/BENCHMARK.md`) measured about 369k tokens of extra context with every REA tool loaded in Claude Code. That works out to about 2.15 characters per token for these schemas.

**Up front**, the adapter's tool list is about 99% smaller than the matching upstream tools. That is the saving hosts that load every tool schema eagerly will see. Hosts that defer tool schemas, such as Claude Code with tool search, already avoid most of the upstream cost up front.

**Per operation**, the detail the model fetches through `introspect` is about the same size as the upstream schema for typical operations:

| Workflow | Upstream schemas | Adapter introspection |
|---|---|---|
| Native function: open, search, analyze, pseudocode, xrefs, close | 9,176 | 8,582 |
| Go / Rust / artifact inspection | 4,611 | 4,670 |
| Electron feature trace | 64,601 | 14,774 |

The Electron saving is partly lossy. Adapter introspection currently flattens structured parameters, such as nested objects, arrays and unions, to their top-level type (MCPAQL/adapter-generator#55, #47, #19). Per-session savings beyond the up-front list come from batching (MCPAQL/adapter-generator#64) and result shaping (#65), both on in this adapter; see below.

**Per call**, measured against a live REA 6.5.0 with Ghidra 12.1.4 in an isolated VM on 2026-10-18 (`validation/results/2026-10-18/`). The workflow opens the native target, then runs an overview, a function search, `procedure_info`, `analyze_function`, pseudocode, callers and cross-references, and inspects a plist, a SQLite database and a Go binary: 11 calls. Sizes are serialized `tools/call` results in characters:

| Arm | Characters |
|---|---|
| REA, full result (`content` text + `structuredContent`) | 205,983 |
| REA, `content` text only | 97,169 |
| Adapter, unshaped | 237,039 |
| Adapter, with result shaping | 42,667 |
| The six native reads as one adapter batch, shaped (unshaped: 206,856) | 27,082 |

- REA returns every record twice: its text content is exactly the JSON of its `structuredContent`, in 11 of 11 calls. Whether a host shows the model one copy or both decides which REA row applies.
- Unshaped, the adapter carries both copies inside its JSON envelope, about 15% more than REA's full result. `drop_duplicate_text` removes the copy without loss.
- `analyze_function` returns a 136,029-character result for one small function. Over the 20,000-character budget, the adapter returns a summary and a handle instead (3,094 characters), with a ready-to-call `inspect_analysis_view` continuation that pages the retained Evidence. REA defines 21 native facets. Paged back through the continuation, 19 match REA's full record exactly, including the six value-flow facets. The two Swift facets report "not recorded", as expected for a C binary, so they were not exercised. On this small target, four facets were empty and only the pseudocode took more than one page. Paging all 21 facets costs 235,577 characters, because each page repeats REA's Evidence metadata, so the handle pays off when the model needs the summary or a few facets. `params._full_result: true` returns the full record.
- Handles are only valid while the binary is open: after `close_binary`, REA rejects the handle's continuation with `evidence_integrity_mismatch`. A repeated `analyze_function` also gets a new `evidence_id`.
- Without the handle, the shaped adapter is about 20% above REA's text-only size: 39,573 characters against 33,053 for the other 10 calls. The difference is the adapter's envelope and MCP result framing.

## Endpoint Review

REA publishes per-tool effect flags: `executesForeignCode`, `mutatesDevice`, `mayDiscardData`, `mutatesTarget`, `changesUiState`, `writesFilesystem`, `accessesNetwork`, `launchesProcess` and others. The importer classifies every tool from these flags (MCPAQL/tools#41). Before the overrides, that gives 139 READ, 35 CREATE, 12 UPDATE and 21 EXECUTE. Without the flags, a name heuristic put 169 tools in EXECUTE.

`schema-overrides.json` then applies these reviewed corrections:

- **Cache-only writes to READ.** 23 inspection tools flagged `writesFilesystem` take no caller output path. REA writes only to owner-only temporary or provider-owned workspace directories for them, so they are READ/safe. Examples are `inspect_artifact`, `inspect_android_class` and `inspect_sqlite_database`.
- **Session state to CREATE or UPDATE:**
  - `open_binary`, `close_binary`, `import_evidence_bundle`, `import_managed_reconstruction` and `record_unknown` become CREATE.
  - `update_unknown` becomes UPDATE, which makes it stage 2.
- **Stage-3 reclassifications to EXECUTE/dangerous:** `start_frida_session`, `close_frida_session` (it may resume a paused process), `unload_frida_script` and `observe_web_execution`. REA's flags understate these four. They are recorded now and excluded in stage 1.
- **Excluded in stage 1:**
  - every tool REA marks as reaching a network or device, running foreign code, or changing UI state (62);
  - the rest of the adb, Frida, GDB and rizin-debugger runtime families;
  - `observe_native_ui`, which reads the accessibility tree of a running app;
  - all UPDATE, DELETE and EXECUTE operations.

## Reproduce

Build `mcpaql-import-catalog` from [MCPAQL/tools](https://github.com/MCPAQL/tools), and `mcpaql-schema-build` and `mcpaql-generate-adapter` from [MCPAQL/adapter-generator](https://github.com/MCPAQL/adapter-generator), from their `develop` branches. Neither package is published, so either run `npm run build` and use `node dist/<cli>.js`, or use `npx tsx src/<cli>.ts`.

```bash
# REA's catalog. Its provenance: CI artifact "rea-test-runtime" from run 38565969170
# (morluto/rea, rea-agents 6.5.0 release commit 3b79af28e).
gunzip -k capture/rea-mcp-tool-catalog-6.5.0.json.gz
shasum -a 256 capture/rea-mcp-tool-catalog-6.5.0.json   # 4dc9ecae7a6e57438f8ee57ca1f4fcfdb5764e0b880406ae8e114203a8e4bda8

# Capture, without running the upstream.
mcpaql-import-catalog --config server-config.json --catalog capture/rea-mcp-tool-catalog-6.5.0.json --out capture \
  --server-name rea-agents --server-version 6.5.0

# Schema and adapter.
mcpaql-schema-build --input capture/discovery-bundle.json --out schema --overrides schema-overrides.json
mcpaql-generate-adapter --input schema/adapter-schema.json --provenance schema/adapter-provenance.json --out adapter
```

The catalog and the discovery bundle are committed gzipped because REA's full tool definitions are about 10 MB uncompressed. `adapter/LICENSE` and the `LICENSE-REA.md` files are added by hand, not generated.

## Validation status

- **Done, static:** generation and the up-front footprint, measured from the published catalog. Regenerating from the catalog gives a byte-identical bundle (apart from `captured_at`) and an identical schema, and the generated adapter typechecks.
- **Done, live** (2026-10-18, REA 6.5.0 with Ghidra 12.1.4 in an isolated macOS VM; `validation/results/2026-10-18/`):
  - **Parity:** 23 of 23 exercised operations give results identical to REA's, byte for byte. Extended on 2026-10-20 below.
  - **Catalog:** REA's live `tools/list` matches the committed catalog (207 tools, no changed model-visible definition).
  - **Batching** (spec §7, §7.5): 19 of 19 checks pass, covering batch vs single calls, routing, halting before `close_binary`, limits, progress and cancellation. Two of them need MCPAQL/spec#281.
  - **Result shaping:** these checks pass: the `analyze_function` handle; lossless paging of 19 of its 21 native facets (the two Swift facets do not apply to a C binary); `_full_result`; duplicate-text dropping; and the budget switch.
  - **Host permission layer, raw REA tools** (`permission-layer.md`): the policy asks about the same two stage-1 operations the adapter treats as `requires_confirmation`. In a headless coding agent, the allowed read ran and the asked-for calls did not. Shell-command matching caught direct REA launches but not every indirect one.
  - **Through a coding agent:** Claude Code 2.1.292 defers MCP tool schemas, so REA's tool definitions did not reach the context up front.
- **Done, live** (2026-10-20, same VM; `validation/results/2026-10-20/parity-coverage.md`):
  - **Parity, 119 of 131 operations:** 87 identical byte for byte, 2 identical apart from per-process fields, 1 compared in session setup, and 29 `SAME_ERROR`: both arms failed and the adapter passed REA's error through unchanged. None diverged, and none failed on one arm only.
  - The `SAME_ERROR` results are mostly operations the Ghidra provider does not declare or decoders that need Linux or an uninstalled tool, so they show error passthrough, not working operations.
  - Inputs are hand-built fixtures. Capture-style ones are labeled fake-device (recorded fixture), not real-device parity.
  - CREATE operations wrote only to a sandbox the suite deletes.
  - The 12 operations not run need an Android toolchain, WABT, a managed assembly, or runtime evidence from tools stage 1 excludes.
- **Not done:** the permission-layer and token checks with the adapter registered in the coding agent, and the other Evidence kinds `inspect_analysis_view` can page. Only `analyze_function` gets a handle until those kinds are verified the same way.

## Licenses

The generated adapter code is AGPL-3.0 (`adapter/LICENSE`). REA's tool names, descriptions and schemas appear in `capture/`, `schema/` and `adapter/src/`, and that REA-derived text keeps REA's MIT license (`LICENSE-REA.md` in each of those directories). REA is a separate project by its authors; this adapter is not affiliated with or endorsed by it.
