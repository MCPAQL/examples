# REA adapter validation

These files check the stage-1 REA adapter against a live REA 6.5.0: adapter vs raw parity on the same calls, and what the model sees in characters, up front and per call. The test plan is in [MCPAQL/examples#55](https://github.com/MCPAQL/examples/issues/55#issuecomment-6245593226).

| File | What it is |
|---|---|
| `footprint.json` | Static footprint figures, measured from REA's published catalog without running REA |
| `targets/` | Sources for the analysis targets and `build.sh`: a small C program, an optional Go program (also built as a Windows PE and a Linux ELF), a plist and a SQLite database, plus hand-built fixtures from `fixtures.mjs` for REA's other file inspectors (see below) |
| `parity-suite.mjs` | `mcpaql-parity` suite: the same calls on raw REA and on the adapter, in a native profile and an app-bundle profile |
| `measure-calls.mjs` | Records `tools/list`, request and response sizes for both arms, the adapter's batch form and introspection |
| `use-local-rea.mjs` | Points the adapter at a locally installed `rea` binary, so both arms run the same REA |
| `check-batching.mjs` | Batching checks on the adapter (spec §7 and §7.5): batch vs single calls, routing, halting, limits, progress and cancellation |
| `check-shaping.mjs` | Result-shaping checks against raw REA: the `analyze_function` handle, paging all 21 native facets (19 must match the full record; the 2 Swift facets do not apply to the C target), `_full_result`, duplicate-text dropping, retention and the budget switch |
| `results/` | Results of live runs, one directory per date; local paths are shortened to `~/rea-eval`. `permission-layer.md` and `permission-policy.tsv` record the host permission-layer checks |

## Run only in an isolated VM

Both scripts launch REA: once directly, and once as the adapter's child process. Run them in a disposable VM with no production credentials, never on a developer host. Nothing runs the targets or reaches a network. The parity suite calls the adapter's 10 CREATE operations too, so it writes:

- the CREATE operations' outputs, under `<targets>/parity-sandbox/official/` and `.../mcpaql/`, which the suite deletes at teardown;
- in the app profile, `extract_artifact`'s output under REA's temporary directory. Run that profile with `TMPDIR` inside a directory you delete afterwards.

`close_binary` is called without a snapshot path.

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

# 4. Parity. mcpaql-parity is from MCPAQL/tools. The native profile, then the app profile.
REA_PARITY_SESSION_REPORT=validation/parity-sessions.json \
  mcpaql-parity --suite validation/parity-suite.mjs --adapter adapter/dist/server.js \
  --report validation/parity-report.json --timeout-ms 600000 --max-total-timeout-ms 1800000
mkdir -p ~/rea-eval/tmp-app && TMPDIR=~/rea-eval/tmp-app REA_PARITY_PROFILE=app \
  mcpaql-parity --suite validation/parity-suite.mjs --adapter adapter/dist/server.js \
  --report validation/parity-report-app.json --timeout-ms 600000 --max-total-timeout-ms 1800000
rm -rf ~/rea-eval/tmp-app

# 5. Sizes.
node validation/measure-calls.mjs --rea "$REA_COMMAND" --out validation/calls.json

# 6. Batching. SPEC is an MCPAQL/spec checkout (for the batch response schema) and TOOLS an
#    MCPAQL/tools checkout with its dependencies installed (for ajv).
node validation/check-batching.mjs adapter validation/targets/build \
  "$SPEC/schemas/batch-operation.schema.json" "$TOOLS" validation/batching.json

# 7. Result shaping.
node validation/check-shaping.mjs adapter validation/targets/build/parity-native validation/shaping.json
```

Needs Node 24.15 or later, for REA's SQLite inspection, and `mcpaql-parity` from MCPAQL/tools `develop`: stdio upstream support and the `SAME_ERROR` class are not in a release yet. `build.sh` also needs `node` and `zip`.

Both arms run REA in the adapter directory. The environments differ: the raw arm sees the harness's whole environment, while the adapter passes REA only the variables on its passthrough list.

REA keeps one current binary per server process. The parity suite therefore opens the native target on each arm in `openSessions` and runs the same session-recording calls, in the same order, on both. `parity-sessions.json` records whether `open_binary`, `search_procedures` and `analyze_function` matched across arms, and whether the two Evidence bundles each arm exported in setup are byte-identical. The adapter returns `analyze_function` as a result handle, so the suite's adapter arm passes `_full_result: true` for it; `check-shaping.mjs` checks the handle.

Setup also collects, on each arm, the Evidence records that REA's compare and compose operations take as input: a second function analysis, the target's inventory, managed-member records, two JavaScript application analyses, two exported bundles and one recorded unknown. Each arm passes its own records. The app profile (`REA_PARITY_PROFILE=app`) opens the hand-built `parity.app` instead and runs only the five operations that read an app bundle.

Reading the report:

- `IDENTICAL`: byte-identical results. `STRUCTURAL_PARITY`: identical after the suite's volatile keys are masked (process ids, start and observation times, the connected client's name, and in the app profile `extract_artifact`'s random output directory).
- `SAME_ERROR`: both arms failed, and the adapter passed REA's own error through unchanged. It is kept apart from `IDENTICAL`: it shows faithful error passthrough, not that the operation works. Most come from a provider REA cannot use here (the Ghidra provider does not declare cursor, comment and bookmark operations; several decoders need Linux or a tool that is not installed) or from deliberate negative inputs.
- `SKIPPED`: no builder, usually because the input needs a toolchain or runtime evidence stage 1 excludes.

The fixtures are hand-built, small and synthetic. Notes in the report say when an input is a stand-in (a C binary carrying a cargo-auditable section or Electron's fuse sentinel), a negative input (a native PE given to the managed inspectors), or one of REA's own schema examples. The capture-style fixtures (HAR, pcap, sigrok recording, ELF core, and the browser-scenario example) are labeled fake-device: nothing was captured from a real device, so those results are not real-device parity.

In `calls.json`:

- `catalog` compares REA's live tool definitions with the committed catalog;
- `up_front` gives the tool-list sizes for both arms;
- each `calls` entry records whether REA's text content is exactly its `structuredContent`, which is what `drop_duplicate_text` result shaping relies on.
