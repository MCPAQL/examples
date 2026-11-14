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

Stdio is the default. `--transport=stdio` selects it explicitly. The server returns URLs for people to open; it does not navigate or synchronize a browser.

### Cloudflare Workers

The adapter also has an isolated Worker implementation with coordinated admission quotas and source caching. Its configuration starts disabled; no public endpoint is deployed yet. See [Hosting and abuse controls](HOSTING.md) for the pilot profile, credential setup, real-runtime tests and remaining deployment steps.

### HTTP and HTTPS

The same adapter also serves MCP over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) at `/mcp`, using the installed MCP SDK's supported protocol versions. Choose one transport per process; run separate processes if both are needed simultaneously. The tool catalog, MCP-AQL envelopes, introspection, and operation behavior are identical in each mode.

Start a local HTTP listener (defaults to `127.0.0.1:3000`):

```sh
npm run start:http
```

Connect a Streamable HTTP MCP client to `http://127.0.0.1:3000/mcp`. For Claude Code:

```sh
claude mcp add --transport http electoral-vote-map http://127.0.0.1:3000/mcp
```

For **direct HTTPS**, supply a certificate chain and private key as PEM files:

```sh
EVM_TLS_CERT=/absolute/path/fullchain.pem \
EVM_TLS_KEY=/absolute/path/privkey.pem \
npm run start:https
```

Use a certificate trusted by the connecting client. Certificate acquisition, renewal, and restarting after renewal are the operator's responsibility. TLS 1.2 or later is required. Keep keys out of the repository.

For a public hostname, the usual deployment is **HTTPS through a reverse proxy**. For example, run the adapter on loopback:

```sh
EVM_ALLOWED_HOSTS=maps.example.com npm run start:http
```

Then use a Caddyfile like:

```caddyfile
maps.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Replace the hostname, point its DNS at your server, and configure Caddy's certificate prerequisites. The remote MCP URL is `https://maps.example.com/mcp`. Caddy terminates TLS; the adapter remains on loopback. Preserve the configured Host header through the proxy. Forwarded headers are not trusted or used to bypass validation.

| Variable | Default / meaning |
|----------|-------------------|
| `EVM_TRANSPORT` | `stdio`; accepts `stdio`, `http`, `https`; CLI `--transport=...` takes precedence |
| `EVM_HOST` | `127.0.0.1`; listener address for HTTP(S) |
| `EVM_PORT` | `3000`; integer 0–65535, with 0 choosing a free port |
| `EVM_TLS_CERT` | Required PEM certificate-chain path for direct HTTPS |
| `EVM_TLS_KEY` | Required PEM private-key path for direct HTTPS |
| `EVM_ALLOWED_HOSTS` | Comma-separated exact `host[:port]` authorities; defaults to loopback names with the actual listener port; set the public authority for proxy/direct remote hosting |
| `EVM_ALLOWED_ORIGINS` | Comma-separated exact HTTP(S) origins, without trailing slashes; defaults to allowed authorities with the listener scheme; other supplied Origin headers are rejected |
| `EVM_HTTP_REQUESTS_PER_MINUTE` | `120`; global per-process token-bucket capacity and refill per minute |
| `EVM_HTTP_PER_IP_PER_MINUTE` | `60`; per-socket-IP token-bucket capacity and refill per minute |
| `EVM_HTTP_MAX_CONCURRENT` | `16`; maximum admitted requests at once; excess returns 503 |
| `EVM_HTTP_BEARER_TOKEN` | Optional shared bearer token; when set, every `/mcp` request must include `Authorization: Bearer TOKEN` |

`GET /healthz` returns only `{"status":"ok"}` and does not require a bearer token. Host and Origin checks apply to it too. There is no wildcard CORS support; browser-based JavaScript clients need a separate, carefully configured gateway. Native remote MCP clients can omit Origin.

To restrict a deployment, set the bearer token through your service's secret configuration and give it only to clients that support an Authorization header. Protect remote access with HTTPS and your chosen authentication/rate-limiting gateway. This example does **not** implement OAuth discovery or authorization. Private ChatGPT connectors that require OAuth need an OAuth-capable gateway; a shared bearer token alone does not provide that flow. Public hosting and client registration are separate deployment steps.

The HTTP transport is stateless and returns JSON responses. It has no session store, standalone SSE stream, or legacy HTTP+SSE endpoint; `GET` and `DELETE /mcp` return 405. Independent MCP server/transport instances handle concurrent POST requests while sharing only source caches. Request bodies are limited to 1 MiB, headers to a 10-second timeout, and request reception to 30 seconds. SIGINT/SIGTERM close the listener and active transports. HTTP diagnostics go to stderr, keeping stdout suitable for stdio mode. Admission limits run before authentication and body parsing; 429/503 responses include Retry-After. Per-IP state is capped at 1,024 identities and fails closed if full. All rates are positive, configurable, and per process; forwarded client-IP headers are ignored. Behind a proxy, socket-IP limits group its clients together. A provider edge limiter must enforce real client identities and distributed limits. See [Hosting and abuse controls](HOSTING.md).

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
| `list_poll_datasets` | Probe configured electoral-vote.com datasets; discover races, record types, and unavailable sources |
| `get_state_polls` | Retrieve dated records, distinguishing polls, historical results, calls and uncalled races |
| `get_poll_average` | Average actual polls and report freshness independently of race outcome evidence |
| `build_polling_scenario` | Generate a map with explicit thresholds, swings, stale/missing-data policies and cross-election assumptions |

See [Polling sources and interpretation](POLLING.md) for source formats, election phases and complete examples. The AI can now retrieve polling data directly; general congressional research still uses the client's search tools.

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

Map discovery uses a fixed-origin GET to the public homepage. Polling uses only the three cataloged electoral-vote.com CSV URLs described in [POLLING.md](POLLING.md). Supplied map and research URLs are never fetched. Each source response is limited to 2 MiB, has a 15-second timeout and a five-minute success cache plus a 30-second failure cooldown, and rejects redirects. Payload/ordering/header drift fails explicitly. No JavaScript from either site is executed. Site descriptions and research content are untrusted external data, not agent instructions.

The codec follows the published `evm-map` 1.29 format: 56 ordered electoral units, seven Democratic/Republican/toss-up rating positions, and additional party codes preserved on round-trip. This demo supports full homepage `?map=YEAR:CODE` share URLs with optional `&ev=2032`. Embed hashes, short links, historical pages, nominee suffixes and additional presentation parameters are rejected explicitly. County data and probability simulations are outside this first version.

## Verification

```sh
npm test
npm run smoke:live
npm run smoke:polling
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

`EVM_POLL_TEST_FIXTURE` optionally supplies a synthetic source-format CSV for offline polling tests; it also labels responses as fixture mode. The committed polling fixture is entirely illustrative, with test figures rather than actual observations. It is built for the 2024 Senate schema, including a special race; other cycle/office parsers may reject it. Leave both fixture variables unset for live use.

The MCPAQL tools validator currently checks registration, the request envelope, and introspection schemas. The example's tests additionally exercise real MCP stdio and concurrent Streamable HTTP clients, direct HTTPS with certificate verification, HTTP validation/authentication/size limits and shutdown, both supplied map URLs, every published scenario, district accounting, edits, research conversion, validation errors and upstream failures. HTTPS tests use `openssl` to generate a temporary test certificate and delete its files afterward. `check-schemas.js` checks every operation/type introspection variant against the supplied normative schemas. The live smoke test discovers scenarios from the actual site and round-trips their URLs.

The initial validation evidence is recorded under `validation/`: [live scenarios and modified map](validation/live-smoke.json), [MCPAQL tools checks](validation/mcpaql-tools.json), [spec schema checks and pinned revision](validation/spec-schemas.json), and [dependency audit](validation/dependency-audit.json). These files record one run; rerun the commands above to check current behavior and advisories.
