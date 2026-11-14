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
- Named clients also have a persistent daily allowance, defaulting to 1,000 admissions. Minute refills and reconnects do not replenish it. UTC midnight resets both global and client daily counters. When upgrading legacy records without per-client counts, the existing global count is conservatively attributed to each existing client for that day; upgrading does not grant fresh allowance. New identities still receive their own allowance, subject to the global quota and 32-identity bound. OAuth onboarding and stable user identities are tracked in [issue #75](https://github.com/MCPAQL/examples/issues/75).
- At most 32 named authenticated client identities in its daily quota record; original bearer tokens are not stored or forwarded. Daily counts reset at UTC midnight. Authenticated clients sharing an IP receive independent allowances; anonymous users still share network limits and cannot be identified individually behind a shared proxy.
- A coordinated durable cache for exactly four public source URLs. Concurrent reads coalesce. Bounded chunks stay below storage value limits and are replaced transactionally. Successful retrievals expire after five minutes; failures have a 30-second durable cooldown. Restored parser caches preserve the original retrieval timestamp and expiry instead of claiming that old content was just downloaded.

The edge applies the Cloudflare rate-limit binding to named credentials or anonymous IPv4/IPv6 identities. IPv6 interface addresses within one /64 share a key; IPv4-mapped IPv6 is handled as IPv4. The edge uses Cloudflare's platform-supplied CF-Connecting-IP, never X-Forwarded-For. This trust assumption requires direct Cloudflare ingress; do not expose the same handler through an untrusted proxy that can supply that header.

Valid credentials have separate edge buckets even behind a common proxy. Invalid credentials and anonymous traffic use the network bucket. The Durable Object adds strict per-client limits for authenticated identities across locations. Different anonymous users behind one shared IP remain indistinguishable; prefix aggregation can group a household/network and is an abuse tradeoff, not identity verification.

Header size is bounded to 16 KiB. Declared oversized bodies are rejected at the edge. Other requests first reserve the coordinator's shared concurrency slot and consume their daily admission, before the edge reads or parses the body. A random single-use reservation is bound to the verified client, expires after ten seconds if abandoned, and cannot be consumed or released by another client. Body errors release the slot; admitted invalid bodies still consume the sender's daily allowance. Quota/concurrency rejections do not consume another allowance. The edge bounds reading to 1 MiB and five seconds, with fatal UTF-8 decoding and rejection of JSON batches, then forwards the bounded text with its reservation. The coordinator consumes the reservation once and rechecks the body before MCP dispatch. A coordinator recreation loses outstanding reservations, which fail closed; persistent quota history is retained.

The explicit reservation avoids depending on a provider streaming a service-binding body into the coordinator before buffering it. Successful MCP requests make two object calls (admission and dispatch); body failures make admission and release calls. These count as provider usage in addition to public edge invocations. The reading timeout is a Worker-reader deadline, not a total client-upload deadline. A real 6.5-second delayed upload did not demonstrate a 408 response; coordinator usage stayed at 28 admissions and zero active requests at one and four seconds, then rose to 29 after the completed request returned 200. This establishes that the observed delay did not occupy coordinator admission; it does not prove a total ingress upload deadline or bound provider buffering. Only content type/length, Accept, negotiated protocol version, verified client ID and private reservation ID reach the dispatch binding. Authorization, cookies, forwarded identity and caller-supplied internal identity/reservation headers are discarded.

### Operator usage and ingress protection

`EVM_OPERATOR_CLIENT_IDS` is a JSON array of explicitly authorized existing client IDs; it defaults to `[]`, disabling operator access. A bearer-authenticated operator can GET `/admin/usage`. Both the edge and private coordinator check operator membership; other clients cannot impersonate an operator through request headers. The response uses `Cache-Control: no-store` and exposes aggregate daily admissions/remaining quota, active-client count, highest client usage and current concurrency, without tokens, client IDs or request content. Operators can inspect accounting even after the MCP daily quota is exhausted.

Daily admissions are persisted. The response also includes bounded in-memory rejection counts by HTTP status and their start timestamp. These counters reset when the Durable Object is recreated, exclude edge/provider rejections and are not durable auditing or a complete alerting system. Rejections do not add a storage write each time. Use provider analytics for edge request/rejection visibility; do not enable request-header/body logging to obtain aggregate usage.

The application edge binding executes inside the Worker. It does not prevent rejected traffic from invoking the Worker. Before public launch, qualify a provider-side rule scoped only to `electoral.mcpaql.com` to limit ingress before Worker work, including invalid credentials, unsupported paths and uploads. Use machine-compatible blocking/rate-limit responses, not browser challenges on `/mcp`. Check rule availability and existing zone rules before applying it; do not replace a rule protecting Maker Perks. Provider DDoS protection and coarse network limits complement authenticated per-client limits but do not guarantee availability against distributed abuse. Keep anonymous access disabled and public onboarding blocked under #72 until the applicable ingress and distributed tests are complete.

### Proposed pilot profile

The committed `wrangler.jsonc` is an isolated deployment configuration, **disabled with no public routes**:

| Setting | Proposed value |
|---------|----------------|
| Worker | `electoral-vote-map-mcpaql` |
| Dedicated hostname for ingress isolation | `electoral.mcpaql.org`; not attached by the bootstrap configuration |
| Public traffic | Disabled (`EVM_ENABLED=false`) |
| Authentication | Required; separate named bearer credentials |
| Daily admitted MCP requests | 10,000 globally |
| Daily admitted requests per named client | 1,000 (`EVM_CLIENT_DAILY_REQUEST_LIMIT`) |
| Global token bucket | 120 capacity, 120/minute refill |
| Named-client token bucket | 60 capacity, 60/minute refill |
| Edge approximate limiter | 60/minute per credential or anonymous network identity |
| Concurrent coordinator requests | 16 |
| Edge CPU allowance | Workers Free enforces 10 ms per invocation; qualify cold/warm behavior before enabling traffic |
| Preview / workers.dev URLs | Disabled |
| Application request logging | Disabled; no request/token/body logging added |
| Operator usage access | Disabled by default; explicit `EVM_OPERATOR_CLIENT_IDS` required |

These are application controls, not a dollar-denominated hosting cap. Edge invocations, rejected traffic, object calls and storage still consume provider usage. The account dashboard showed **Workers Free** and **Durable Objects Free tier** on November 14, 2026. Free-tier exhaustion rejects operations rather than purchasing overages, but the account-wide allowances are shared with Maker Perks and the other Workers. The 10,000 admitted-request quota does not protect those allowances from rejected edge traffic. Keep this service without public routes until the shared availability risk is accepted or the deployment is placed in a separate account.

The bootstrap configuration omits a paid-plan CPU override; it cannot raise the Free plan's 10 ms edge allowance. Durable Object execution and storage have separate limits and still need deployed qualification. A paid-plan upgrade must be a separate operator decision, with measured CPU limits and spending controls for **both Workers and Durable Objects**. Those product spending policies also apply across the account; an exhausted cap could stop Maker Perks. No plan, account-level budget or provider setting is changed by this PR.

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

Before deployment, verify a valid Cloudflare CLI login and choose the correct account. Use a dedicated, least-privilege deployment identity for this Worker when automating deployment; never copy Maker Perks runtime secrets, grants or storage IDs. Mick renewed the local Wrangler login on November 14, 2026; read-only checks confirmed access to the account hosting Maker Perks and its active `mcpaql.com` zone. The proposed Worker name and custom-domain registration were unused. DNS-record reads and billing-policy API reads were denied by the CLI's permissions; the signed-in dashboard independently confirmed both products use the free tier. No Maker Perks secret values were requested or changed.

Bootstrap with `routes: []`, `workers_dev: false`, `preview_urls: false` and `EVM_ENABLED=false`. Verify those settings after upload. A successful bootstrap upload proves packaging and provider acceptance, not an accessible MCP endpoint. After the account/quota decision and DNS checks, attach the custom domain explicitly:

```json
{"routes":[{"pattern":"electoral.mcpaql.org","custom_domain":true}]}
```

Configure `EVM_CLIENT_TOKENS` as a **Worker secret**, containing a JSON object with 1–32 stable client IDs mapped to unique random bearer tokens of 32–256 allowed characters. IDs contain lowercase letters, digits, underscore or hyphen; `alice` and `bob` below are examples of separate identities, not shared-account credentials. Tokens must not be committed, logged or put in public `vars`.

```json
{"alice":"REPLACE_WITH_A_UNIQUE_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS"}
```

Use `wrangler secret put EVM_CLIENT_TOKENS` with secure stdin or the provider's secret UI. A token is compared as an Authorization Bearer header. For a deliberately anonymous public service, `EVM_ALLOW_ANONYMOUS=true` is an explicit operator decision; requests then consume network and global quotas. This implementation does not provide OAuth discovery. OAuth-requiring private ChatGPT clients need an appropriate gateway; clients supporting fixed Authorization headers can connect directly.

Before attaching any public route, verify the account plan, shared quotas or isolated account, and any applicable provider spending settings/alerts. Before setting `EVM_ENABLED=true`, verify the custom domain, disabled bypass routes, credentials and secret rotation, and the daily/rate/CPU profile. Validate the routed but disabled service first, then qualify a controlled authenticated pilot. Exercise real public routing, distributed quotas, slow/oversized requests and source outages, and measure actual CPU/usage. Keep the coordinator namespace and `global-v1` ID stable across deploys so quota/cache state is not reset.

### Kill switch and rollback

Keep the last known-good deployment/version and configuration in the deployment record. Set `EVM_ENABLED=false` and redeploy to stop admission before authentication, object calls or source fetches. If needed, remove the dedicated route or disable the Worker in the provider console. Roll back to a known-good disabled version first; do not delete/recreate the Durable Object namespace as a rollback shortcut, because that loses quota history. Record the deployed SHA/version, CPU measurements, budget settings, route checks and live qualification in #72 before enabling public use.

Cloudflare's [rate-limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) is approximate and local to each location. The Durable Object supplies coordinated application quotas; [Workers resource and spending limits](https://developers.cloudflare.com/workers/platform/limits/) are separate controls. A budget alert alone does not reject traffic.

The committed bootstrap configuration creates no public electoral endpoint and changes no account plan or spending policy. The authenticated pilot below uses an explicit deployment override; redeploying the bootstrap configuration disables it and removes its public route.

### Bootstrap deployment record

On November 14, 2026 at 21:29:58 UTC, Wrangler accepted source revision `76391812d3a55e862753229f53c5ae3c11f16867` as version `317a01dd-3d96-4dd4-aa29-04485f2de48a` of `electoral-vote-map-mcpaql`. The uploaded bundle was 744.91 KiB (154.32 KiB gzip); reported startup time was 32 ms. Startup time is not per-request CPU qualification.

Read-only provider checks confirmed `EVM_ENABLED=false`, `workers.dev` and preview URLs disabled, no custom domain, no Worker route in the `mcpaql.com` zone, and a new coordinator namespace. Rate-limit namespace `7201` was unused by all seven pre-existing Workers. No client secret was configured. Maker Perks' OAuth resource discovery returned HTTP 200, and its unauthenticated root returned the expected HTTP 401; no signed-in Maker Perks tool execution was tested. No existing Worker or account plan was changed. This records a disabled bootstrap upload, not successful deployed MCP execution or approval to enable public traffic.

### Authenticated pilot deployment

Mick chose the existing shared free account after the dashboard showed 311/100,000 Workers requests that day (0.311%), 15 Maker Perks production invocations over 24 hours with no runtime errors, and 163.81 MB of the 5 GB Durable Objects storage allowance (3.28%). Account isolation is not a prerequisite. Revisit capacity as usage grows; this decision does not authorize a paid-plan upgrade.

The original pilot endpoint was **`https://electoral.mcpaql.com/mcp`**. The abuse-hardening deployment moves it to `electoral.mcpaql.org` for the separate ingress rule described below. It requires a separate named bearer credential; anonymous access remains disabled. It has no OAuth discovery service. The secret was installed with secure stdin, without using Maker Perks data. The retained personal credential is stored locally in the ignored `.wrangler/pilot/credentials.json` with mode `0600`; never commit or publish that file. Temporary qualification credentials were removed, and their rejection was verified after provider propagation.

On November 14, 2026, source revision `dbdde79ec2cac700e874a70d8c03b2a8be81cced` was deployed with the custom-domain route and `EVM_ENABLED=true` override. Following credential rotation, the active version was `55bd80c6-165e-4236-b3ad-35ede42ee1e2` at 21:46:10 UTC. Limits match the proposed profile above: 10,000 daily admitted POSTs, 120/min global, 60/min per named client, and 16 concurrent coordinator requests. Provider reads confirmed the original coordinator namespace, no preview/workers.dev URLs, and no changes to Maker Perks' deployment. Pilot deployment configurations are local ignored files under `.wrangler/pilot/`; they copy the bootstrap configuration with an absolute `main`, the custom-domain route shown above, and explicit admission variables.

Deployed qualification results:

- The routed disabled service returned HTTP 503 before activation. Missing/invalid credentials and spoofed internal identity headers returned 401; a disallowed Origin returned 403.
- A temporary two-request daily profile verified independent named-client allowances, per-client 429 rejection, global daily 429 rejection and quota persistence across redeployment. Restoring the normal profile preserved the namespace and accounting history.
- The live kill switch was exercised: disabling returned 503; re-enabling recovered. Disabled version `552eac11-b6e3-431c-a6bb-2c8585880d9b` is a rollback reference. That historical version contains retired qualification credentials: rotate to the current credential set before ever re-enabling a historical rollback.
- At 21:45:09 UTC, two real SDK clients connected concurrently. Seven scenarios and all three live polling datasets were available. Pennsylvania had 10 historical presidential polls; the generated map round-tripped to 538 EV (222 Democratic, 238 Republican, 78 toss-up). The client ran on the operator's computer against the actual Cloudflare service; this is distinct from the earlier Linux CI and Puck checks.
- Unsupported GET, wrong content type, malformed UTF-8, JSON batch, oversized body, oversized headers and unknown path returned 405, 415, 400, 400, 413, 431 and 404 respectively. Authenticated health returned 200.
- Source retrieval timestamps survived the credential deployment without being refreshed. Eight temporary live trace events spanning edge and Durable Object execution reported 1–6 ms CPU, all outcomes `ok`, and no exceptions. This small sample is not a sustained-load or worst-case CPU guarantee. Full traces were discarded; no request headers, tokens or bodies were saved in the qualification record.

The existing Linux workerd tests cover injected source outages, failure expiry, concurrent admission and persistent storage. These failures were not induced against the public source sites. Cross-region quota load and a complete slow-upload deployment test remain follow-up qualification under [issue #72](https://github.com/MCPAQL/examples/issues/72); do not describe this pilot as exhaustive production load testing.

### Provider ingress isolation

The November 14 dashboard inspection found the `mcpaql.com` Free zone's sole rate-limit rule already protecting Maker Perks. Reusing it would share network counters with Maker Perks. The same account's `mcpaql.org` Free zone had an unused slot, allowing a separate electoral ingress rule without a plan upgrade or changing Maker Perks.

Rule `97e36a521a77461395ef429bc8afaab3` is active in `mcpaql.org`, matching only `(http.host eq "electoral.mcpaql.org")`: 120 requests per IP per 10 seconds, followed by a 10-second Block action. This is coarse ingress protection in addition to the stricter authenticated application limits. All clients behind one IP share this network allowance. It does not solve distributed address rotation, and it does not make rejected traffic free of all provider usage. There is no browser challenge on the MCP path. The old `.com` route must be removed during migration so it cannot bypass this rule; preview/workers.dev URLs must remain disabled. Verify live blocking and post-block recovery before describing this deployment step as qualified.
