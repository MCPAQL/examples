<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- cspell:words PKCE CIMD DCR -->
# OAuth for the hosted Electoral Vote Map adapter

This is an opt-in Worker integration. The deployed pilot continues to require its
private bearer credential until the OAuth deployment is separately qualified.
The committed configuration has OAuth and public enrollment **disabled**. Stdio,
Node HTTP/HTTPS, the MCP-AQL operation catalog and the Maker Perks adapter are
unchanged. This feature belongs to [issue #75](https://github.com/MCPAQL/examples/issues/75);
[issue #72](https://github.com/MCPAQL/examples/issues/72) tracks public-launch gates.

## Established components

| Responsibility | Component |
| --- | --- |
| MCP OAuth discovery, audience-bound tokens, PKCE, refresh, revocation, client metadata | Cloudflare `@cloudflare/workers-oauth-provider` 1.2.4 |
| Browser-bound consent and upstream state | Cloudflare's `beginConsent`, `approveConsent`, `beginUpstream`, `finishUpstream` helpers |
| Google sign-in, discovery, code exchange, issuer/audience/nonce/expiry and signature checks | `openid-client` 6.9.0, with `enableNonRepudiationChecks` |
| Human verification on the consent page | Cloudflare Turnstile, validated with Siteverify |
| Authentication state | A dedicated Workers KV namespace, with metered access |
| Serialization, usage budgets and short-lived replay fences | A separate SQLite Durable Object, `oauth-global-v1` |

Cloudflare's library is the MCP authorization server. Google is the upstream
identity provider; Google tokens are discarded after identity verification. The
MCP server requests only `openid email`, with no Google API access. Account
identity is a SHA-256 digest of verified issuer and subject; email is checked
against a staged enrollment list and is not saved in grant metadata or props.
Neither OAuth clients nor signed-in accounts receive operator access.

The canonical resource is `https://electoral.mcpaql.org/mcp`. Both the root and
path-specific RFC 9728 discovery URLs are published. Client ID Metadata Documents
(CIMD) are enabled. Dynamic client registration (DCR) is disabled by default;
`EVM_OAUTH_DCR_ENABLED=true` enables `/oauth/register` for clients that require it.
Registrations expire after one day, allow at most 25 attempts/day, and share all authentication budgets. Qualify
each intended client before claiming compatibility; discovery support varies.
The library serves revocation at its advertised token endpoint, `/oauth/token`.

## Operator configuration

1. Create a **new Electoral-specific** Workers KV namespace and add its ID as an
   `OAUTH_KV` binding in the private deployment configuration. Do not reuse Maker
   Perks grants, keys, namespaces or secrets. Keep the existing electoral
   `ELECTORAL_COORDINATOR` namespace and `global-v1` ID intact.
2. Create a Google OAuth **Web application**. Configure the exact redirect URI
   `https://electoral.mcpaql.org/callback`, the consent screen, support contact,
   homepage and privacy details. Start in testing with named test accounts;
   configure Google's publishing/verification requirements before public signup.
3. Create a Turnstile widget restricted to `electoral.mcpaql.org`. Browser challenges
   belong only on `/authorize`; keep the MCP/token protocol endpoints free of
   interactive challenges. Retain the hostname-wide ingress WAF rule.
4. Store `EVM_OIDC_CLIENT_ID`, `EVM_OIDC_CLIENT_SECRET`,
   `EVM_TURNSTILE_SECRET`, and `EVM_OAUTH_ALLOWED_EMAILS` as Worker secrets via
   Wrangler's secure input or the Cloudflare dashboard. The email secret is a JSON
   array, for example `["pilot@example.com"]`. Set the public widget key in
   `EVM_TURNSTILE_SITE_KEY`. Never put secrets in git, issues, URLs or chat.
5. Retain `EVM_OIDC_ISSUER=https://accounts.google.com`, set
   `EVM_OAUTH_ENABLED=true`, keep `EVM_OAUTH_PUBLIC_SIGNUP=false` and
   `EVM_ALLOW_ANONYMOUS=false`. Missing configuration fails closed. An empty
   enrollment list admits nobody. Keep the named operator bearer secret for the
   separate `/admin/usage` endpoint.
6. Deploy the new `OAuthCoordinator` SQLite migration (`v2`) and the dedicated KV
   binding, preserving the existing `v1` object and source cache. Verify limiter
   namespaces 7202/7203 are independent in the account before deployment. The
   `global_fetch_strictly_public` compatibility flag is required for CIMD's SSRF
   defenses. Do not deploy an old private config without updating bindings,
   migrations, flags and disabled-by-default OAuth variables.
7. Perform the qualification below with the pilot accounts. Public enrollment
   requires a deliberate later change to `EVM_OAUTH_PUBLIC_SIGNUP=true` and all
   remaining launch gates in #72. This document does not authorize that change.

The OIDC issuer is operator-controlled, never a request parameter. A different
OIDC provider needs its own metadata, claims and UI qualification; the included
consent wording and deployment instructions target Google.

## Authentication and request ceilings

All OAuth routes remain behind `EVM_ENABLED`, the hostname WAF rule and a network
limiter (300 requests/minute/IP or IPv6 /64). Interactive/protocol routes also
have a 30/minute network limiter. These approximate edge limits mitigate ingress;
they are not global account or spending guarantees. Shared networks share them.

Human verification precedes consent-state KV writes and client metadata fetching;
simply opening the verification page does not create a consent record. Repeated
uses of one bearer token are also limited before its KV lookup, followed by the
stable-account admission limit after validation.
Named operators can inspect aggregate authentication counters at
`GET /admin/oauth-usage`, using the same private operator bearer as `/admin/usage`.
The response contains daily operation counts and active/queued work, without
account identifiers, grant details, emails or credentials.

The named authentication object admits at most 60 mutating protocol flows/minute,
1,000/day, eight queued/in-flight flows and 16 concurrent token validations.
Read-only discovery does not consume the mutating-flow budget.
Every library KV operation reserves its budget durably **before** reaching KV:
25,000 reads, 500 writes, 500 deletes and 500 lists per UTC day. Failed provider
operations still consume their reservation. Exhaustion fails closed; partially
completed logins must restart after recovery. These are adapter-specific limits,
not reserved account allowances. Maker Perks and other workloads still share
Cloudflare's free quotas. Monitor the account, including KV write capacity.

**Availability limitation:** unauthenticated protocol POSTs/callbacks consume the
shared flow allowance before human verification, and rotating well-formed invalid
tokens consume the shared KV-read allowance. An attacker who bypasses the coarse
network limits can lock out sign-in/token operations or MCP token validation
until the next UTC-day reset. These ceilings protect usage, not availability.
Address or explicitly accept this behavior under the public-launch gates before
open enrollment. The per-token limiter only bounds repeated use of one token;
it does not stop token rotation or distributed sources.

With the pinned provider, each valid token validation uses **one KV read**; a
well-formed unknown token also uses one. The workerd regression measures both
through the aggregate counters. Thus 10,000 MCP admissions need 10,000 validation
reads, leaving headroom in the 25,000 ceiling for sign-in and other operations;
rejected/retried requests still cost reads and can exhaust that headroom. No
positive-validation cache is introduced: it would require a defined revocation
delay and would not by itself solve signup/flow-budget denial of service.

Authentication forms/protocol bodies are limited to 16 KiB and a five-second
Worker reader deadline. OIDC and Turnstile requests require HTTPS, refuse
redirects, have a five-second deadline and a 256 KiB response limit. Provider
buffering means the Worker reader deadline is not an end-to-end upload deadline.
CIMD fetching uses Cloudflare's library and its own validation/limits.

Successful consent, upstream callbacks and code exchanges receive bounded
ten-minute durable replay fences containing hashes only. Authentication protocol
mutations serialize through one object; KV remains the library's token store.
Provider KV consistency, per-key write limits and crash boundaries still require
live qualification. Revocation is checked through the authorization server on
each MCP request; no separate edge token cache is introduced.
Replay fences are allocated only after successful consent, browser-bound upstream
state recovery, or code exchange. Invalid traffic cannot directly fill this table.
An aggregate active-fence count is included in `/admin/oauth-usage`.

Tokens expire after at most one hour; refresh grants and the absolute sign-in
window last at most seven days. Refresh cannot reset that window or the account's
MCP usage counters. Unchecking the offline option, or a client requesting only
`electoral:read`, issues no refresh token. Tokens stop renewing at the absolute
sign-in boundary, including its last minute (the provider's minimum token TTL).
Every signed-in account shares the existing per-client
minute/day/concurrency allowance across apps and refreshed tokens. Operators
retain separate static identities. OAuth defaults to at most 256 distinct
admitted identities/day; `EVM_MAX_DAILY_CLIENTS` can set 1–512. A full table rejects
new identities without charging existing users or global MCP admissions. This
bound is independent of enrollment and prevents unbounded quota-state growth.

## Qualification and rollout

The Linux workflow runs fixture OIDC/Turnstile endpoints in real workerd with
SQLite DOs and KV; it does not contact Google or bypass a real CAPTCHA. Tests
cover browser binding/CSRF, escaped client metadata, replay, audience, signature,
issuer, nonce, expiry, staged enrollment, refresh/revocation, private operator
separation and shared account quotas. Core tests cover atomic KV budgets,
transaction fences, body limits and the maximum durable quota record.

Before enabling the live OAuth pilot, verify:

- OAuth discovery, Google consent/sign-in, Turnstile, exact callback and enrolled
  account behavior in a real browser, including a rejected unenrolled account.
- One intended MCP client end to end, then a second app for the same account;
  prove shared admission accounting, refresh, revoke and reauthorize. Check
  whether each client needs CIMD or explicitly enabled DCR.
- Live KV read-after-write/per-key limits, callback/code replay and concurrent
  refresh behavior. An eventual-consistency unit fixture is not deployment proof.
- Kill switch, rate/budget failures, private operator usage, no credential leakage
  to public source requests, unchanged Maker Perks behavior and account usage.
- Google consent-screen production readiness, visible free-usage policy, privacy
  information, support contact and the public landing page before open enrollment.

To stop new authorization without changing Maker Perks, set
`EVM_OAUTH_ENABLED=false`; the named bearer pilot remains usable. Set
`EVM_ENABLED=false` to disable the entire electoral Worker. Do not delete quota
objects to recover an exhausted budget: that would reset the protections.

Primary references: [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/),
[OAuth provider library](https://github.com/cloudflare/workers-oauth-provider),
[openid-client](https://github.com/panva/openid-client),
[Turnstile Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
[Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/).
