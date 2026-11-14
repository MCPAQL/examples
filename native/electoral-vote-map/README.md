# Electoral Vote Map MCP-AQL Demo

Connect an AI assistant to [Taegan Goddard's Electoral Vote Map](https://electoralvotemap.com/), discover the site's existing scenarios, explore alternatives conversationally, and open the resulting maps on the site.

This is a native, independently developed [MCP-AQL](https://github.com/MCPAQL/spec) example in the MCPAQL adapter collection. It does not imply endorsement by Goddard Media. It reads the site's public map payload and uses its share URL format; it does not require an upstream MCP server, account, or API key.

## Conversation flow

1. Connect the adapter and ask, “What scenarios are available?” The AI calls `list_scenarios` and presents their names, descriptions, totals, and clickable URLs.
2. Choose a scenario: “Start from Blue Wall returns. Flip Massachusetts and Vermont Republican, and South Carolina and Tennessee Democratic.” The AI supplies explicit unit edits to `modify_map`.
3. Open the returned URL. It is a complete map on Electoral Vote Map, ready to inspect and share.
4. Continue from that URL, or ask a research question: “What if states awarded their electoral votes to the party that won the most House seats in 2026?” The AI researches the counts using its own search tools, records sources, and passes them to `apply_election_results` with explicit conversion rules.

The AI chooses which states count as “unexpected” and which alternatives to explore. The adapter validates and calculates those choices. It contains no model or general web-search service.

## Run and connect

Requires Node.js 22 or later.

```sh
cd native/electoral-vote-map
npm ci
npm start
```

For an MCP client supporting local stdio servers, add this entry to its MCP configuration, replacing the absolute path:

```json
{
  "mcpServers": {
    "electoral-vote-map": {
      "command": "node",
      "args": ["/absolute/path/to/examples/native/electoral-vote-map/src/server.js"]
    }
  }
}
```

This version provides a local stdio server, matching the runnable examples in this repository. A remote ChatGPT connector requires a separately hosted MCP transport; that deployment is not included. The server returns URLs for people to open. Browser navigation and synchronization are future integration work, not implied by URL generation.

## Operations

All operations are discoverable through `mcp_aql_read`:

| Operation | Purpose |
|-----------|---------|
| `introspect` | Discover operations, complete parameter definitions, examples, and types; available offline |
| `list_scenarios` | Read the current site forecast and named What If scenarios, with URLs and calculated totals |
| `get_map` | Inspect a scenario ID or a supplied share URL |
| `list_units` | Discover state/district IDs and current/projected electoral votes |
| `modify_map` | Evaluate explicit ratings or D/R flips and return a new map URL |
| `compare_maps` | Separate rating changes from electoral-allocation changes |
| `get_research_brief` | Prepare a scoped congressional-results research handoff for the connected AI |
| `apply_election_results` | Calculate a hypothetical map from sourced, client-supplied congressional counts |

Discovery:

```json
{"operation":"introspect","params":{"query":"operations","name":"modify_map"}}
```

Explore state flips:

```json
{
  "operation": "modify_map",
  "params": {
    "scenario_id": "blue-wall",
    "edits": [
      {"unit":"MA","flip":true},
      {"unit":"VT","flip":true},
      {"unit":"SC","flip":true},
      {"unit":"TN","flip":true}
    ]
  }
}
```

Each edit uses either `flip: true` or a `rating` from the discoverable `Rating` enum. Flips preserve Safe/Likely/Lean strength. A toss-up or third-party assignment requires an explicit target rating. Unit IDs come from `list_units`. `ME` and `NE` each represent only the two statewide votes; their districts must be edited separately to sweep the state.

`scenario_id` and `map_url` are mutually exclusive; omit both to start from the current site map. `electoral_allocation: "projected_2032"` changes electoral weights independently of the presidential map's year. Projected weights retain the site's population-estimate attribution and are not finalized apportionment.

## Research to map

`get_research_brief` accepts a metric, research year and optional states. It gives the AI search queries, source guidance and a schema example. It does not claim to have researched those facts.

The supported metrics are `senate_races_won`, `senate_delegation`, and `house_seats_won`. Senate races won in an election and both sitting senators are different measures. A state with no Senate race is omitted, rather than represented as a zero-count tie. Independents must be classified explicitly.

`apply_election_results` requires:

- A `rows` array of `{state, dem, rep, other, status, source_urls}`. Counts are nonnegative integers. Each row records `certified`, `projected` or `partial` status and at least one HTTPS source URL.
- `election_year` and a UTC ISO 8601 `as_of` timestamp for the researched facts.
- `mapping_rule: "state_plurality"`: the party with the most supplied seats/races receives the state's electoral units under the selected district policy.
- `tie_policy`: `error`, `keep`, or `toss_up`.
- `district_policy`: `state_sweep` assigns Maine/Nebraska's districts too; `preserve_districts` changes their statewide units only.

Missing states and DC retain the base map. Sources are carried through but **not independently fetched or verified**; responses label them as client-supplied. Result maps are hypothetical assignments, not actual presidential results, calibrated probabilities, or legal changes to allocation rules. The map URL carries ratings and allocation only; keep the response with it to preserve research sources and assumptions.

## MCP-AQL alignment

The normative baseline is [spec v1.0.0-draft](https://github.com/MCPAQL/spec/blob/develop/docs/versions/v1.0.0-draft.md). The implementation uses:

- Standard `operation` / `params` envelopes and discriminated success/error results, including MCP `isError` for failures.
- Strict parameter validation, snake_case public inputs, discoverable domain types and the standard introspection response shapes.
- One READ endpoint. Calculating a changed map does not mutate a stored resource, the browser, or the upstream site; therefore `modify_map` and `apply_election_results` have READ semantics despite producing different URLs. No empty mutating endpoints are advertised.
- Documented fully concurrent requests, coalesced source reads, size/depth limits, and an explicit unsupported-capability declaration for optional batching, field selection and the execution safety loop.
- An optional `parameters` compatibility alias, with `params` values taking precedence. Omit optional parameters; explicit null is rejected.

The sole upstream request is a fixed-origin GET to the public homepage. Supplied map and research URLs are never fetched. The source response is limited to 2 MiB, has a 15-second timeout and a five-minute cache, and rejects redirects. Payload/ordering drift fails explicitly. No JavaScript from the site is executed. Site descriptions and research content are untrusted external data, not agent instructions.

The codec follows the published `evm-map` 1.29 format: 56 ordered electoral units, seven Democratic/Republican/toss-up rating positions, and additional party codes preserved on round-trip. This demo supports full homepage `?map=YEAR:CODE` share URLs with optional `&ev=2032`. Embed hashes, short links, historical pages, nominee suffixes and additional presentation parameters are rejected explicitly. County data and probability simulations are outside this first version.

## Verification

```sh
npm test
npm run smoke:live
npm audit --audit-level=low
node scripts/check-schemas.js /path/to/MCPAQL/spec/schemas
```

Run the MCPAQL tools validator as well, from the parent directory containing the `examples`, `spec`, and `tools` repositories. Build/install `tools` according to its package scripts first:

```sh
EVM_TEST_FIXTURE="$PWD/examples/native/electoral-vote-map/test/fixtures/site.html" \
node tools/dist/conformance-cli.js \
  --command node \
  --args "[\"$PWD/examples/native/electoral-vote-map/src/server.js\"]" \
  --schema-root "$PWD/spec/schemas"
```

`EVM_TEST_FIXTURE` is only for offline verification; all data responses clearly label fixture mode. Leave it unset for real use. The fixture is a minimal extract of public map data retrieved on November 14, 2026, attributed to Electoral Vote Map, and is not a live forecast feed.

The MCPAQL tools validator currently checks registration, the request envelope, and introspection schemas. The example's tests additionally exercise a real MCP stdio connection, both supplied map URLs, every published scenario, district accounting, edits, research conversion, validation errors and upstream failures. `check-schemas.js` checks every operation/type introspection variant against the supplied normative schemas. The live smoke test discovers scenarios from the actual site and round-trips their URLs.

The initial validation evidence is recorded under `validation/`: [live scenarios and modified map](validation/live-smoke.json), [MCPAQL tools checks](validation/mcpaql-tools.json), [spec schema checks and pinned revision](validation/spec-schemas.json), and [dependency audit](validation/dependency-audit.json). These files record one run; rerun the commands above to check current behavior and advisories.
