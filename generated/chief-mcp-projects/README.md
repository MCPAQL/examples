# Chief MCP, Project-Aware

A second MCP-AQL adapter for the [Chief](https://chief.bot) MCP server, generated with the adapter generator's `tenancy` support. The faithful adapter is in [`../chief-mcp`](../chief-mcp/README.md).

## Why a second adapter

Chief scopes most tools to one project, chosen by an `X-Project-Id` header written into the MCP client config at install time. The model cannot see which project it is in, cannot see the others, and cannot switch without the config being edited and the server restarted.

This adapter needs only the API key:

| Capability | How |
|---|---|
| See every project the key can reach, and which is active | `get_active_project` (READ) |
| Switch projects for the session | `set_active_project` (UPDATE), by `project_id` or case-insensitive `name` |
| Run one call in another project | optional `project_id` (id or name) on every project-scoped operation |
| Know where a result came from | `_meta.project` on every scoped result: `{ id, name, source }` |

The starting project is `CHIEF_PROJECT` (id or name) if set, otherwise the account's default project. `list_projects`, `create_project`, `update_project`, `list_project_members`, and the invitation operations are sent without a project header, since they take the project as their own parameter or act account-wide.

Example session:

```javascript
{ operation: "get_active_project" }
// -> active: Personal (source: "default"); available: 3 projects
{ operation: "set_active_project", params: { name: "mcpaql testing" } }
{ operation: "list_assets", params: { limit: 5 } }
// -> _meta.project: MCPAQL Testing (source: "selected")
{ operation: "list_labels", params: { project_id: "Research" } }
// -> _meta.project: Research (source: "call"); active project unchanged
```

## Credentials

| Env var | Required | Notes |
|---|---|---|
| `CHIEF_API_KEY` | yes | Sent as `Authorization: Bearer <key>` |
| `CHIEF_PROJECT` | no | Starting project, id or name |

## Token footprint

`tools/list` is 4,066 characters (5 tools), against 63,520 for Chief upstream and 3,766 for the faithful adapter. The project tools and the per-call `project_id` parameter cost about 300 characters.

## Validation

- Conformance: passed.
- Differential: all 60 source operations present; `get_active_project` and `set_active_project` are reported as synthetic, along with `introspect`.
- Parity: the `../chief-mcp/parity-harness` suite runs against this adapter with `npm run parity:projects` and `npm run parity:projects:writes`. On 2026-10-13: read-only against a populated project, 22 of 22 IDENTICAL; write mode in the test project, 22 IDENTICAL, 34 STRUCTURAL_PARITY, 0 divergent or erroring, 4 SKIPPED (same as `../chief-mcp`). `create_project`, `delete_asset`, and `delete_session` were each run through this adapter with their own fixtures, separately from the faithful one. See `validation/`.
- Live behavior check on 2026-10-13: default selection, listing, switching by name, per-call override leaving the active project unchanged, unknown-name error listing valid projects, and unscoped `list_projects`.

## Regenerating

The capture is shared with `../chief-mcp`; only the overrides differ (`tenancy` block, adapter name).

```bash
node ../../../adapter-generator/dist/schema-cli.js --input capture/discovery-bundle.json --overrides schema-overrides.json --out schema
node ../../../adapter-generator/dist/generate-cli.js --input schema/adapter-schema.json --provenance schema/adapter-provenance.json --out adapter
(cd adapter && npm install && npm run build)
```

Requires `tenancy` support in `MCPAQL/adapter-generator`.
