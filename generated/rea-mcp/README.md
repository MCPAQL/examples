# REA MCP Golden Path (stage 1: static analysis)

Pipeline output for wrapping [REA (Reverse Engineer Anything)](https://github.com/morluto/rea), the `rea-agents` npm package pinned to **6.5.0**, as an MCP-AQL adapter.

REA is a local stdio MCP server with 207 reverse-engineering tools. Some of them run targets, inject Frida scripts, drive browsers and native UIs, or change attached Android devices. This adapter is staged:

| Stage | Scope | Status |
|---|---|---|
| 1 | Static analysis: READ and CREATE operations with no network, device, UI or foreign-code effects | this package |
| 2 | UPDATE and DELETE: provider annotations, bookmarks, unknowns | planned |
| 3 | EXECUTE: runtime capture, instrumentation, device control. Denied by default and enabled per deployment with confirmation | planned |

Stage 1 exposes **132 of REA's 207 tools**: 124 READ and 8 CREATE. The other 75 are left out of the adapter entirely. They are not listed, introspectable or callable. Each one is recorded with its reason in `schema/adapter-provenance.json` (`excluded_operations`).

Artifacts:

- `server-config.json`: the stdio launch config, pinned to `rea-agents@6.5.0`.
- `capture/`: the discovery bundle (gzipped), warnings and capture metadata. It was built offline from REA's published tool catalog with `mcpaql-import-catalog`; REA was not run.
- `schema-overrides.json`: the reviewed endpoint and danger-level corrections and the stage-1 exclusions.
- `schema/`: the generated MCP-AQL adapter schema and provenance sidecars.
- `adapter/`: the generated, runnable TypeScript MCP-AQL adapter package.
- `validation/footprint.json`: measured token-footprint figures.

## Run it only in an isolated environment

REA is not a sandbox. Analysis providers run with your user's permissions, and analyzed targets can carry prompt injection. Run this adapter, and REA, in a disposable VM or container with no production credentials.

```bash
cd adapter
npm install
npm run start
```

On the first call, the adapter starts `npx -y rea-agents@6.5.0 mcp` as a child process and keeps it running. REA sessions (an opened binary, retained Evidence) persist across calls until `close_binary` is called or the adapter exits.

The child gets a minimal environment plus only these variables, when they are set:

- `REA_ANALYSIS_PROVIDER`
- `GHIDRA_INSTALL_DIR`
- `JAVA_HOME`
- `REA_GHIDRA_STARTUP_TIMEOUT_MS`
- `REA_HOPPER_STARTUP_TIMEOUT_MS`
- `REA_MCP_INPUT_SCHEMA_PROFILE`
- `REA_LOG_LEVEL`

Native analysis with a cold Ghidra or Hopper start can take minutes. The adapter's per-call deadline defaults to 60 s and is reset by upstream progress notifications. For native work, set a longer deadline and a hard cap:

```bash
MCPAQL_UPSTREAM_TIMEOUT_MS=600000 MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS=1800000 npm run start
```

## Gate the shell too

The adapter gates only its own path. REA also ships a CLI, and its agent skill tells agents to run `npx rea-agents@latest …`. A host that allows shell commands should deny direct REA invocations in the same policy, for example:

- `npx * rea-agents*`, `npx rea-agents*`, `bunx rea-agents*`
- `rea *`
- any command that registers REA directly with an MCP client

Install REA's setup with `--skill=false`, or skip it entirely. See MCPAQL/spec#277.

## Token Footprint

Measured 2026-10-17 from REA's own SDK `listTools()` catalog: the CI artifact `rea-test-runtime` from the 6.5.0 release commit. Sizes are serialized JSON characters. For the adapter, `tools/list` and `introspect` were served by the generated adapter with its upstream command replaced by `/usr/bin/false`, so REA never ran.

| Surface | Tools | Characters |
|---|---|---|
| REA upstream, all tools (`tools/list`) | 207 | 3,087,725 |
| REA upstream, all tools, model-visible (name + description + inputSchema) | 207 | 792,163 |
| REA upstream, the 132 stage-1 tools, model-visible | 132 | 665,125 |
| Generated MCP-AQL adapter (`tools/list`) | 2 | 4,073 |
| `introspect` (all 132 operations) | — | 72,816 |

`outputSchema` makes up 73% of REA's `tools/list`. Hosts that build Anthropic API tool definitions don't send it to the model, so the model-visible figures are the relevant ones there. A public benchmark ([aicodeking/leanrea](https://github.com/aicodeking/leanrea), `bench/BENCHMARK.md`) measured about 369k tokens of extra context with every REA tool loaded in Claude Code, which works out to about 2.25 characters per token for these schemas.

**Up front**, the adapter's tool list is about 99% smaller than the matching upstream tools. That is the saving hosts that load every tool schema eagerly will see. Hosts that defer tool schemas, such as Claude Code with tool search, already avoid most of the upstream cost up front.

**Per operation**, the detail the model fetches through `introspect` is about the same size as the upstream schema for typical operations:

| Workflow | Upstream schemas | Adapter introspection |
|---|---|---|
| Native function: open, search, analyze, pseudocode, xrefs, close | 9,176 | 8,582 |
| Go / Rust / artifact inspection | 4,611 | 4,670 |
| Electron feature trace | 64,601 | 14,774 |

The Electron saving is partly lossy. Adapter introspection currently flattens structured parameters, such as nested objects, arrays and unions, to their top-level type (MCPAQL/adapter-generator#55, #47, #19). Per-session savings beyond the up-front list depend on batching and result shaping (MCPAQL/adapter-generator#57, #58).

## Endpoint Review

REA publishes per-tool effect flags (`executesForeignCode`, `mutatesDevice`, `mayDiscardData`, `mutatesTarget`, `changesUiState`, `writesFilesystem`, `accessesNetwork`, `launchesProcess` and others). The importer classifies every tool from these flags (MCPAQL/tools#41). Before stage-1 exclusions, that gives 139 READ, 35 CREATE, 12 UPDATE and 21 EXECUTE. Without the flags, a name heuristic put 169 tools in EXECUTE.

`schema-overrides.json` then applies these reviewed corrections:

- **Cache-only writes to READ:** 23 inspection tools flagged `writesFilesystem` take no caller output path. REA writes only provider-owned cache or workspace files for them, so they are READ/safe. Examples are `inspect_artifact`, `inspect_android_class` and `inspect_sqlite_database`.
- **Session lifecycle as CREATE:**
  - `open_binary`: reversible, because it starts a persistent provider session.
  - `close_binary`: destructive, because it drops unexported session state and may write a snapshot.
  - `import_evidence_bundle`: reversible, because it merges into the session.
- **Stage-3 reclassifications to EXECUTE/dangerous:** `start_frida_session`, `close_frida_session` (it may resume a paused process), `unload_frida_script` and `observe_web_execution`. The flags understate these. They are recorded now and excluded in stage 1.
- **Excluded in stage 1:**
  - every tool REA marks as reaching a network or device, running foreign code, or changing UI state (62);
  - the rest of the adb, Frida, GDB and rizin-debugger runtime families;
  - `observe_native_ui`, which reads the accessibility tree of a running app;
  - all UPDATE, DELETE and EXECUTE operations.

## Reproduce

```bash
# 1. REA's catalog: CI artifact "rea-test-runtime" from run 38565969170 (morluto/rea, rea-agents 6.5.0 release commit 3b79af28e).
gh run download 38565969170 -R morluto/rea -n rea-test-runtime -D rea-runtime
cp rea-runtime/.cache/mcp-tool-catalog.json rea-mcp-tool-catalog-6.5.0.json
shasum -a 256 rea-mcp-tool-catalog-6.5.0.json   # 4dc9ecae7a6e57438f8ee57ca1f4fcfdb5764e0b880406ae8e114203a8e4bda8

# 2. Capture (MCPAQL/tools), no upstream execution.
mcpaql-import-catalog --config server-config.json --catalog rea-mcp-tool-catalog-6.5.0.json --out capture \
  --server-name rea-agents --server-version 6.5.0

# 3. Schema and adapter (MCPAQL/adapter-generator).
mcpaql-schema-build --input capture/discovery-bundle.json --out schema --overrides schema-overrides.json
mcpaql-generate-adapter --input schema/adapter-schema.json --provenance schema/adapter-provenance.json --out adapter
```

The committed bundle is gzipped (`gunzip -k capture/discovery-bundle.json.gz`) because REA's full tool definitions are about 10 MB uncompressed.

## Validation status

- Generation and the footprint figures are static, measured from the published catalog.
- Parity against a live REA (`mcpaql-parity`) has not been run yet. It must run in an isolated VM with a real analysis provider (Ghidra or Hopper) and will be added under `validation/`.

## Licenses

The generated adapter is AGPL-3.0 (`adapter/LICENSE`). The REA tool definitions inside `capture/` come from REA's published catalog and are redistributed under REA's MIT license (`capture/LICENSE-REA.md`). REA is a separate project by its authors; this adapter is not affiliated with or endorsed by it.
