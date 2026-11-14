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

## Cloudflare deployment follow-up

The current executable is a Node stdio/HTTP(S) server. A Workers deployment needs a Fetch-handler entry point using the SDK's web-standard transport and the same MCP-AQL server factory/dispatch. Supplying a Wrangler file alone would not make the Node listener a Worker.

Before public hosting:

1. Create an independent Worker and hostname, with no Maker Perks secrets or storage bindings. Keep it read-only and omit OAuth/storage components unless authentication actually needs them.
2. Apply edge rate limits before parsing or source work. Disable unused preview/direct routes so they cannot bypass the selected protection. Use authenticated identities where available; IP limits can group shared networks.
3. Coordinate source refreshes and quotas across locations, using a Durable Object or equivalent. Preserve fixed URLs, five-minute cache freshness, failure cooldowns, deadlines, size limits and fail-closed parsing. Protect the original public sites from refresh amplification.
4. Set a measured CPU ceiling, a strict pilot admission quota, and a kill switch. Configure provider spending limits and alerts before enabling public traffic; choose their account scope carefully because Maker Perks shares the provider. Edge rate limiting alone is not a spending cap.
5. Verify actual deployed runtime behavior with concurrent clients, invalid authentication, malformed/slow/oversized bodies, spoofed origins/IP headers, upstream outages, distributed quota exhaustion and secret-redaction checks. Confirm a rollback path and collect aggregate usage counters without recording tokens or complete tool inputs.

Cloudflare's [rate-limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) is approximate and local to each location. Its documentation recommends Durable Objects for strict limits across locations. [Workers resource and spending limits](https://developers.cloudflare.com/workers/platform/limits/) are distinct controls; availability and account settings must be checked at deployment time. A budget alert alone does not reject traffic.

No public electoral endpoint or provider settings are created by these changes.
