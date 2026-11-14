# Hosting and abuse controls

The Maker Perks adapter is configured on **Cloudflare Workers**, with the custom domain `makerperks.mcpaql.com`. Its [Wrangler configuration](https://github.com/MCPAQL/makerperks-adapter/blob/main/wrangler.jsonc) declares the Worker, separate OAuth/vault storage, and a per-IP rate-limit binding. This was checked on November 14, 2026. It is a hosting pattern to reuse; its secrets, OAuth grants and storage must stay separate from this electoral adapter.

## What can incur usage

The electoral adapter makes fixed-origin, unauthenticated reads of one map homepage and three polling CSVs. It has no model-provider integration, paid polling API, browser session, outbound credential, or user-supplied fetch URL. Inbound bearer authentication is optional and never forwarded upstream. Returned map and research URLs are parsed or recorded without fetching them.

Public traffic can still consume hosting CPU, requests, memory, transfer and source downloads. Authentication does not replace abuse limits, and rate limiting does not eliminate denial of service or guarantee a hosting bill.

## Implemented Node HTTP protections

- Global and socket-IP token buckets default to 120 and 60 requests per minute, respectively, with the same burst capacities. Admission rejection spends no quota or new identity slot; admitted requests consume both buckets, including later authentication/path failures. The identity table holds at most 1,024 clients and rejects new identities when full. Idle entries expire after 60 seconds, with a request-driven sweep at most once per second. Forwarded IP headers are ignored.
- At most 16 requests are admitted concurrently. Admission runs before authentication and body parsing, including failures and health requests. Rejections return 429 or 503 with Retry-After.
- Host and Origin allowlists, an optional bearer token, TLS support, a 1 MiB MCP body limit, a 16 KiB header limit, and reception timeouts bound individual requests.
- Source reads coalesce concurrently, cache successes for five minutes, and cache failures for 30 seconds. Strict/quarantine policy changes do not trigger separate downloads. No stale success is silently presented as fresh after a failed refresh.
- Only four source cache keys exist. Caller-supplied addresses, cookies and Authorization headers do not reach sources. Direct transport errors contain generic messages; no request-body or credential logging is added.

These controls apply per process and reset on restart. Behind a reverse proxy, the socket-IP bucket sees the proxy rather than individual users. Keep the origin private and enforce actual client identity at the edge. A multi-instance deployment needs coordinated quotas and caching; process-local buckets are not a worldwide usage cap.

### Known identity limitations

All users behind one proxy or tunnel share its socket-IP allowance. One noisy user can exhaust that shared allowance and block the others, even when the global bucket still has capacity. There is no trusted-proxy mode: accepting arbitrary forwarded identity headers would let callers bypass the limiter. Public deployment must apply individual-client limits at the trusted edge; changing the process limits alone does not establish per-user fairness.

The identity table keys exact socket addresses, with no IPv6 prefix aggregation. An attacker rotating many addresses, including within one IPv6 /64, can fill its 1,024 slots and temporarily deny new legitimate clients. Full-table rejections preserve existing clients' quota, but they do not prevent table saturation. Prefix aggregation or authenticated identities should be evaluated at the deployment edge under issue #72, with shared-network fairness considered. Cleanup is bounded and runs at most once per second; it does not guarantee availability against distributed traffic.

## Cloudflare Worker implementation

`src/worker.js` exposes `/mcp` over the SDK's web-standard Streamable HTTP transport and the same MCP-AQL server factory as stdio/Node. Each POST gets a separate MCP lifecycle with JSON responses. GET/DELETE return 405; no standalone SSE stream or OAuth service is advertised.

The dedicated Worker routes every location to one namespace-local Durable Object named `global-v1`. The object provides:

- Transactional daily admission accounting and global/client token buckets. Quotas survive restarts and deployments that preserve the namespace/ID. Initialization and MCP notifications count as admitted POSTs too; this is a request quota, not a count of tool calls. Quota and concurrency rejections do not spend another client's allowance.
- At most 32 named authenticated client identities in its daily quota record; original bearer tokens are not stored or forwarded. Daily counts reset at UTC midnight. Authenticated clients sharing an IP receive independent allowances; anonymous users still share network limits and cannot be identified individually behind a shared proxy.
- A coordinated durable cache for exactly four public source URLs. Concurrent reads coalesce. Bounded chunks stay below storage value limits and are replaced transactionally. Successful retrievals expire after five minutes; failures have a 30-second durable cooldown. Restored parser caches preserve the original retrieval timestamp and expiry instead of claiming that old content was just downloaded.

The edge applies the Cloudflare rate-limit binding to named credentials or anonymous IPv4/IPv6 identities. IPv6 interface addresses within one /64 share a key; IPv4-mapped IPv6 is handled as IPv4. The edge uses Cloudflare's platform-supplied CF-Connecting-IP, never X-Forwarded-For. This trust assumption requires direct Cloudflare ingress; do not expose the same handler through an untrusted proxy that can supply that header.

Valid credentials have separate edge buckets even behind a common proxy. Invalid credentials and anonymous traffic use the network bucket. The Durable Object adds strict per-client limits for authenticated identities across locations. Different anonymous users behind one shared IP remain indistinguishable; prefix aggregation can group a household/network and is an abuse tradeoff, not identity verification.

Header size is bounded to 16 KiB; body reading is bounded to 1 MiB and five seconds, with fatal UTF-8 decoding and rejection of JSON batches. Only content type, Accept, negotiated protocol version and the verified client ID reach the private object binding. Authorization, cookies, forwarded identity and caller-supplied internal identity headers are discarded. The coordinator rechecks request size and applies a concurrency bound before quota/storage work.

### Proposed pilot profile

The committed `wrangler.jsonc` is an isolated, **disabled** deployment configuration:

| Setting | Proposed value |
|---------|----------------|
| Worker | `electoral-vote-map-mcpaql` |
| Dedicated hostname | `electoral.mcpaql.com` |
| Public traffic | Disabled (`EVM_ENABLED=false`) |
| Authentication | Required; separate named bearer credentials |
| Daily admitted MCP requests | 10,000 globally |
| Global token bucket | 120 capacity, 120/minute refill |
| Named-client token bucket | 60 capacity, 60/minute refill |
| Edge approximate limiter | 60/minute per credential or anonymous network identity |
| Concurrent coordinator requests | 16 |
| CPU ceiling | 50 ms per invocation; qualify cold/warm production behavior before enabling traffic |
| Preview / workers.dev URLs | Disabled |
| Application request logging | Disabled; no request/token/body logging added |

These are application controls, not a dollar-denominated hosting cap. Edge invocations, rejected traffic, object calls and storage can still incur provider usage. Provider spending controls must cover Workers **and Durable Objects**, with scope checked so another service such as Maker Perks is not unexpectedly stopped. No account-level budget or provider setting is changed by this PR.

### Configure and qualify

Install the locked dependencies with lifecycle scripts disabled, then run:

```sh
npm ci --ignore-scripts
npm test
npm run test:worker
npm audit --audit-level=low
```

`test:worker` first uses Wrangler's deployment **dry run** to produce the actual Worker bundle, then runs it in Miniflare/workerd with real SQLite-backed Durable Objects. Sources are mocked with committed fixtures in these runtime tests; passing them is not evidence of a deployed endpoint. The harness tests concurrent MCP clients, persistent quotas, source-cache recreation, credential isolation, failures, concurrency recovery, oversized data and redaction. Unit tests additionally cover IPv6 rotation, chunk/value bounds, slow body timeout, UTF-8 errors and expiry. Miniflare is pinned to the same runtime version shipped by the pinned Wrangler toolchain.

The on-demand GitHub Actions workflow supports `live_smoke=true` to read only the four fixed public sources. It does not deploy anything. Independent Puck and CI live-source results are recorded in [issue #72](https://github.com/MCPAQL/examples/issues/72), including exact revisions. They validate sources and generated maps, not the Worker runtime or hosting approval.

Before deployment, restore a valid Cloudflare CLI login and choose the correct account. Use a dedicated, least-privilege deployment identity for this Worker when automating deployment; never copy Maker Perks runtime secrets, grants or storage IDs. A read-only `wrangler whoami --json` check found the current local CLI session expired on November 14, 2026; no new login, deployment, application-secret reads or account-settings changes were requested.

Configure `EVM_CLIENT_TOKENS` as a **Worker secret**, containing a JSON object with 1–32 stable client IDs mapped to unique random bearer tokens of 32–256 allowed characters. IDs contain lowercase letters, digits, underscore or hyphen; `alice` and `bob` below are examples of separate identities, not shared-account credentials. Tokens must not be committed, logged or put in public `vars`.

```json
{"alice":"REPLACE_WITH_A_UNIQUE_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS"}
```

Use `wrangler secret put EVM_CLIENT_TOKENS` with secure stdin or the provider's secret UI. A token is compared as an Authorization Bearer header. For a deliberately anonymous public service, `EVM_ALLOW_ANONYMOUS=true` is an explicit operator decision; requests then consume network and global quotas. This implementation does not provide OAuth discovery. OAuth-requiring private ChatGPT clients need an appropriate gateway; clients supporting fixed Authorization headers can connect directly.

Before setting `EVM_ENABLED=true`, verify the custom domain, disabled bypass routes, provider spending settings/alerts, credentials and secret rotation, and the daily/rate/CPU profile. Validate the deployed but disabled service first, then qualify a controlled authenticated pilot. Exercise real public routing, distributed quotas, slow/oversized requests and source outages, and measure actual CPU/usage. Keep the coordinator namespace and `global-v1` ID stable across deploys so quota/cache state is not reset.

### Kill switch and rollback

Keep the last known-good deployment/version and configuration in the deployment record. Set `EVM_ENABLED=false` and redeploy to stop admission before authentication, object calls or source fetches. If needed, remove the dedicated route or disable the Worker in the provider console. Roll back to a known-good disabled version first; do not delete/recreate the Durable Object namespace as a rollback shortcut, because that loses quota history. Record the deployed SHA/version, CPU measurements, budget settings, route checks and live qualification in #72 before enabling public use.

Cloudflare's [rate-limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) is approximate and local to each location. The Durable Object supplies coordinated application quotas; [Workers resource and spending limits](https://developers.cloudflare.com/workers/platform/limits/) are separate controls. A budget alert alone does not reject traffic.

No public electoral endpoint or provider settings have been created by these changes. #72 remains open for account setup, deployed qualification and enabling the service.
