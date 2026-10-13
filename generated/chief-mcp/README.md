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

`parity-harness/` runs all 22 READ operations against both Chief and the adapter, discovering fixture ids through read-only list calls. It does not run CREATE, UPDATE, DELETE, or EXECUTE operations, because the suite runs against a live account; those 38 are reported as `SKIPPED`.

Result on 2026-10-13 (`validation/parity-summary.json`): 21 IDENTICAL, 1 STRUCTURAL_PARITY (`search_knowledge_base`, which differs only in volatile fields), 38 SKIPPED, 0 divergent or erroring.

Raw parity reports stay local (`parity-harness/.gitignore`) because their `detail` fields can quote account data. `npm run summarize` writes the committable summary.

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
npm run parity
npm run summarize
```

Requires the `${env:VAR}` header support in `MCPAQL/tools` and `MCPAQL/adapter-generator`.

## Known Limitations

- Write-side parity is not covered. A write suite needs a disposable Chief project.
- The adapter keeps a singleton upstream connection and needs a restart if it drops.
- This is a point-in-time capture. Regenerate the capture, schema, and validation reports together when Chief changes its MCP surface.
