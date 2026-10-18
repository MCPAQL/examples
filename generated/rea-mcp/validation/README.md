# REA adapter validation

These files check the stage-1 REA adapter against a live REA 6.5.0: adapter vs raw parity on the same calls, and what the model sees in characters, up front and per call. The test plan is in [MCPAQL/examples#55](https://github.com/MCPAQL/examples/issues/55#issuecomment-6245593226).

| File | What it is |
|---|---|
| `footprint.json` | Static footprint figures, measured from REA's published catalog without running REA |
| `targets/` | Sources for the analysis targets (a small C program, an optional Go program, a plist and a SQLite database) and `build.sh` |
| `parity-suite.mjs` | `mcpaql-parity` suite: the same calls on raw REA and on the adapter |
| `measure-calls.mjs` | Records `tools/list`, request and response sizes for both arms, the adapter's batch form and introspection |
| `use-local-rea.mjs` | Points the adapter at a locally installed `rea` binary, so both arms run the same REA |
| `check-batching.mjs` | Batching checks on the adapter (spec §7 and §7.5): batch vs single calls, routing, halting, limits, progress and cancellation |

## Run only in an isolated VM

Both scripts launch REA: once directly, and once as the adapter's child process. Run them in a disposable VM with no production credentials, never on a developer host. Only analysis operations are called. Nothing runs the targets, reaches a network, or writes outside REA's own workspace; `close_binary` is called without a snapshot path.

## Steps

```bash
# 1. REA without its optional native dependencies and without its agent skill.
mkdir -p ~/rea-eval && cd ~/rea-eval && npm install --omit=optional rea-agents@6.5.0
export REA_COMMAND=~/rea-eval/node_modules/.bin/rea
export REA_ANALYSIS_PROVIDER=ghidra GHIDRA_INSTALL_DIR=/path/to/ghidra JAVA_HOME=/path/to/jdk
export MCPAQL_UPSTREAM_TIMEOUT_MS=600000 MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS=1800000

# 2. Targets, built from source in the VM.
generated/rea-mcp/validation/targets/build.sh

# 3. The adapter, pointed at the same rea binary. Do not commit the schema change.
cd generated/rea-mcp/adapter && npm install && npm run build && cd ..
node validation/use-local-rea.mjs "$REA_COMMAND"

# 4. Parity. mcpaql-parity is from MCPAQL/tools.
REA_PARITY_SESSION_REPORT=validation/parity-sessions.json \
  mcpaql-parity --suite validation/parity-suite.mjs --adapter adapter/dist/server.js \
  --report validation/parity-report.json --timeout-ms 600000 --max-total-timeout-ms 1800000

# 5. Sizes.
node validation/measure-calls.mjs --rea "$REA_COMMAND" --out validation/calls.json

# 6. Batching. The schema is from MCPAQL/spec; ajv comes from an MCPAQL/tools checkout.
node validation/check-batching.mjs adapter validation/targets/build \
  ../spec/schemas/batch-operation.schema.json ../tools validation/batching.json
```

Needs Node 24.15 or later, for REA's SQLite inspection, and `mcpaql-parity` from MCPAQL/tools `develop`; stdio upstream support is not in a release yet.

Both arms run REA in the adapter directory. The environments differ: the raw arm sees the harness's whole environment, while the adapter passes REA only the variables on its passthrough list.

REA keeps one current binary per server process. The parity suite therefore opens the native target on each arm in `openSessions` and runs the same session-recording calls, in the same order, on both. `parity-sessions.json` records whether `open_binary`, `search_procedures` and `analyze_function` matched across arms. Operations without an argument builder in the suite are reported as SKIPPED.

In `calls.json`:

- `catalog` compares REA's live tool definitions with the committed catalog;
- `up_front` gives the tool-list sizes for both arms;
- each `calls` entry records whether REA's text content is exactly its `structuredContent`, which is what `drop_duplicate_text` result shaping relies on.
