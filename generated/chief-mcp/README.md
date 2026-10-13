# Chief MCP Golden Path

Pipeline output for wrapping the [Chief](https://chief.bot) MCP server (`https://mcp.chief.bot/mcp`) as an MCP-AQL adapter.

Artifacts:

- `server-config.json`: source MCP connection config used by `mcpaql-interrogate`
- `capture/`: raw and normalized discovery artifacts
- `schema-overrides.json`: reviewed endpoint and danger-level corrections
- `schema/`: generated MCP-AQL adapter schema and provenance sidecars
- `adapter/`: generated runnable TypeScript MCP-AQL adapter package
- `parity-harness/`: read-only parity suite for `mcpaql-parity`
- `validation/`: saved conformance, differential, and parity reports

## Credentials

Chief scopes most calls to a project, so the adapter needs two values:

| Env var | Sent as | Notes |
|---|---|---|
| `CHIEF_API_KEY` | `Authorization: Bearer <key>` | Chief also accepts the key as `X-API-Key`; the adapter uses Bearer. |
| `CHIEF_PROJECT_ID` | `X-Project-Id` | Without it, project-scoped tools fail with `tenancy.middleware.missing_project_header`. |

The project id is not committed. `server-config.json` and the generated schema carry `"${env:CHIEF_PROJECT_ID}"`, which the interrogator, the generated adapter, and the parity runner resolve from the environment.

## Token Footprint

Captured 2026-10-13. Sizes are serialized JSON characters from `tools/list`.

| Surface | Tools | Characters |
|---|---|---|
| Chief MCP upstream | 60 | 63,520 |
| Generated MCP-AQL adapter | 5 | 3,766 |
| `introspect` (all operations) | — | 16,362 |
| `introspect` (one operation) | — | 1,618 |

Per call, the adapter's result is now about the same size as Chief's own (9,017 vs ~9,050 characters for `list_skills` with `limit: 3`). Generated adapters used to attach the full provenance record and pretty-printed JSON to every result (24,320 characters for the same call); adapter-generator#46 removed both.

The adapter's tool list is about 94% smaller. On the upstream side, `outputSchema` accounts for 28,809 characters (45%), `inputSchema` for 21,266, and descriptions for 8,523. Hosts that load every tool schema eagerly get the full saving; hosts that defer tool schemas already avoid most of the upstream cost.

## Endpoint Review

The interrogator flagged 10 operations for review. `schema-overrides.json` records the decision and reason for each:

| Operation | Endpoint | Danger level |
|---|---|---|
| `attach_label`, `detach_label` | UPDATE | reversible |
| `enable_skill`, `disable_skill`, `enable_action`, `disable_action` | UPDATE | reversible |
| `regenerate_share_link` | UPDATE | dangerous (old link stops working) |
| `set_chat_visibility` | UPDATE | dangerous (can widen access) |
| `upload_file` | CREATE | reversible |
| `send_message` | EXECUTE | dangerous (visible to other members) |

Result: READ 22, CREATE 10, UPDATE 16, DELETE 11, EXECUTE 1.

## Parity

`parity-harness/` has two modes.

**Read-only (default).** Runs all 22 READ operations against Chief and the adapter, discovering fixture ids through list calls. Safe against any project. Result on 2026-10-13 (`validation/parity-summary.json`, run against a populated project): 21 IDENTICAL, 1 STRUCTURAL_PARITY, 0 divergent or erroring.

**Write mode (`CHIEF_PARITY_WRITES=1`).** Runs against a dedicated test project and refuses to start unless the project named by `CHIEF_PROJECT_ID` is called `MCPAQL Testing` (override with `CHIEF_PARITY_PROJECT_NAME`). Setup sweeps leftovers from interrupted runs, then creates its own label, memory, skill, action (on a rare schedule, disabled immediately), and two chats. Teardown deletes every record carrying the `mcpaql-parity` prefix and every chat in the test project. Creates and `send_message` are compared pairwise; updates and deletes run through the adapter and are verified against the official server. The run spends a few short model turns.

Result on 2026-10-13 (`validation/parity-summary-writes.json`): 22 IDENTICAL, 34 STRUCTURAL_PARITY, 0 divergent or erroring, 4 SKIPPED:

| Skipped | Reason |
|---|---|
| `create_project` | Opt-in (see below); passed separately through both adapters |
| `create_project_invitation`, `delete_project_invitation` | Sends a real invitation email |
| `upload_file` | Chief opens the given path on its own host (it is meant for Chief's local `chief-mcp stdio` mode), so a remote caller cannot upload; confirmed: `open file: no such file or directory` |

Session operations need a recorded session in the test project, made with the Chief desktop app (Live Session). Each run consumes one through `delete_session`.

`create_project` is permanent because Chief has no `delete_project` in MCP or the web app. It runs only when `CHIEF_PARITY_CREATE_PROJECT=<name>` is set; it passed on 2026-10-13 through both adapters.

**Asset fixtures.** Because `upload_file` cannot work remotely, upload two files to the test project through Chief's web app (Library → Upload files): `mcpaql-parity-fixture.txt` (kept; used by `get_asset`, `update_asset`, `attach_label`, `detach_label`) and `mcpaql-parity-disposable.txt` (deleted by `delete_asset`; one is consumed per run, so upload one per adapter run, with different contents because Chief deduplicates uploads by content).

Upstream behaviors the suite accounts for:

- `get_chat` does not return the chat title; renames are verified through `list_chats`.
- `get_asset` does not return labels; label attach and detach are verified through `list_assets`.
- `get_share_link` succeeds with `is_shared: false` after revocation instead of erroring.
- Actions require a schedule or a trigger; the suite uses a schedule that fires at most on the 31st and disables or deletes each action within minutes.
- `list_skills` pages through 100+ system skills before project skills; teardown follows the cursor.

Raw parity reports stay local (`parity-harness/.gitignore`) because their `detail` fields can quote account data. `npm run summarize` and `npm run summarize:writes` write the committable summaries.

## Regenerating

```bash
cd ../../../tools && npm run build
cd ../adapter-generator && npm run build
cd ../examples/generated/chief-mcp

export CHIEF_API_KEY=<your_chief_api_key>
export CHIEF_PROJECT_ID=<your_chief_project_id>

node ../../../tools/dist/cli.js --config server-config.json --out capture
node ../../../adapter-generator/dist/schema-cli.js --input capture/discovery-bundle.json --overrides schema-overrides.json --out schema
node ../../../adapter-generator/dist/generate-cli.js --input schema/adapter-schema.json --provenance schema/adapter-provenance.json --out adapter

(cd adapter && npm install && npm run build)

node ../../../tools/dist/conformance-cli.js --command node --args "[\"dist/server.js\"]" --cwd adapter --schema-root ../../../spec/schemas > validation/conformance-report.json
node ../../../tools/dist/diff-cli.js --bundle capture/discovery-bundle.json --schema schema/adapter-schema.json --command node --args "[\"dist/server.js\"]" --cwd adapter > validation/differential-report.json

cd parity-harness
npm install && npm run build
npm run parity && npm run summarize
# With CHIEF_PROJECT_ID pointing at the "MCPAQL Testing" project:
npm run parity:writes && npm run summarize:writes
```

Requires the `${env:VAR}` header support in `MCPAQL/tools` and `MCPAQL/adapter-generator`.

## Known Limitations

- Session operations need a recording in the test project; asset operations need the two fixture files (see Parity).
- The adapter keeps a singleton upstream connection and needs a restart if it drops.
- This is a point-in-time capture. Regenerate the capture, schema, and validation reports together when Chief changes its MCP surface.
