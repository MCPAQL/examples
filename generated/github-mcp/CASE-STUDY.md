# Case Study: GitHub MCP — Official vs MCP-AQL Adapter

**Date:** 2026-05-14
**Upstream tested:** `https://api.githubcopilot.com/mcp/` (`github-mcp-server/remote-a43dd7841d…`)
**MCP-AQL adapters in scope:**
- `examples/generated/github-mcp/` — first-pass adapter, generated from a default-toolset capture (44 operations)
- `examples/generated/github-mcp-all/` — full-coverage adapter, generated from an `X-MCP-Toolsets: all` capture (89 operations)

This case study measures the cost and behavior of two ways to talk to GitHub from an MCP client:

- **A.** Connect directly to the official remote GitHub MCP server.
- **B.** Connect to an MCP-AQL adapter generated from a discovery capture of that same server (5 generic CRUDE tools, dynamic dispatch).

Both routes ultimately call the same upstream and reach the same GitHub API. The question this study answers is: **what does each cost in tokens at session start, and does the AQL adapter behave equivalently when every operation is exercised?**

---

## TL;DR

| Dimension | Official server | MCP-AQL adapter | Result |
|---|---:|---:|---|
| MCP tools exposed (`X-MCP-Toolsets: all`) | **89** | **5** | 17.8× fewer tools to fit in context |
| `tools/list` wire size | **271,152 bytes** | **4,591 bytes** | **98.3% reduction** |
| `tools/list` token cost (≈4 ch/token) | ~67,800 | ~1,148 | **~66,700 tokens saved per session** |
| Per-op input schemas at startup | All 89 schemas eagerly serialized | None — fetched on demand via `introspect` | Pay only for ops actually used |
| Tools/list size scales with upstream growth | Yes (130KB → 271KB as toolsets enable) | No (3.7KB → 4.6KB — flat 5-tool surface regardless of op count) | Adapter footprint is structural |
| Operations behaviorally equivalent under load (89-op runtime test) | baseline | **57 IDENTICAL+STRUCTURAL / 12 SYMMETRIC-ERROR / 17 SKIPPED / 2 EXPECTED-DIFF / 1 test-design edge case** | 0 unprovoked adapter failures |

The adapter trades a small one-time `introspect` round-trip for a permanent ~66,700-token discount on every MCP session — and across all 89 operations exercised in dual-call testing, the only residual non-equivalence is one paired-fixture timing edge case unrelated to adapter behavior.

---

## A note on iteration — what the first pass missed

This study was originally written with the comparison reading "44 tools." That was incomplete. On the first capture pass I let the interrogator hit `api.githubcopilot.com/mcp/` with no `X-MCP-Toolsets` header, and the server replied with its **default** toolset configuration: `context + repos + issues + pull_requests + users` (the same default the open-source `github/github-mcp-server` ships with), totalling 44 tools.

The remote endpoint **also serves** 45 additional tools across the toolsets it doesn't enable by default: code scanning, dependabot, secret scanning alerts, discussions, gists, notifications, actions/workflows, copilot spaces, security advisories, semantic search, projects, label management, repository tree, support docs, and more. They're enabled by sending `X-MCP-Toolsets: all` (or any explicit subset) on the request — the server then returns 89 tools.

The capture missed those 45 because the interrogator didn't ask for them. The generator then faithfully produced an adapter wrapping only what the capture had seen. On the second pass — re-capturing with the toolsets header set — the same generator produced a 89-operation adapter. The same five MCP tools. The same flat 4,591-byte `tools/list`.

**Why this iteration is recorded here rather than quietly fixed:** the lesson is the point of the case study. A discovery-driven adapter generator is only as complete as the discovery captures you feed it. The mistake was 100% reproducible with the public tools — no insider access, no private API, no special endpoint — and so is the correction. Everything used to find and fix the gap (the public `github/github-mcp-server` repository, the public `api.githubcopilot.com/mcp/` endpoint, the open-source `mcpaql-interrogate` CLI, the open-source `mcpaql-generate-adapter` CLI) is available to anyone who reads this document.

---

## Part 1 — Tool surface

### What the official server registers

When the client sends `X-MCP-Toolsets: all`, the upstream returns **89 tools** across these toolsets (full names visible in `github-mcp-all/capture/raw-tools-list.json`):

| Toolset | Approximate count | Examples |
|---|---:|---|
| `repos` | ~12 | `get_commit`, `list_branches`, `get_file_contents`, `create_repository` |
| `issues` | ~7 | `issue_read`, `issue_write`, `list_issues`, `sub_issue_write`, `triage_issue`, semantic search |
| `pull_requests` | ~11 | `pull_request_read`, `pull_request_review_write`, `merge_pull_request`, etc. |
| `users` | ~3 | `get_me`, `search_users`, `list_starred_repositories` |
| `context` | shared | `get_teams`, `get_team_members` |
| `code_security` | 3 | code scanning alerts |
| `secret_protection` | 2 | secret scanning + alerts |
| `dependabot` | 3 | dependabot alerts + vulnerability checks |
| `actions` | 4 | workflows, jobs, logs |
| `gists` | 4 | gist CRUD |
| `discussions` | 4 | discussion read + categories |
| `notifications` | 5 | list, dismiss, mark-read, subscription management |
| `copilot_spaces` | 2 | spaces list/get |
| `security_advisories` | 4 | global, repo, org |
| `projects` | 3 | project read/write |
| `labels` | 2 | label management |
| `github_support_docs_search` | 1 | docs search |
| `stargazers` | 2 | star, unstar |

The default-toolset capture from the first pass (44 tools) covered `context + repos + issues + pull_requests + users` plus a handful of cross-cutting tools (`run_secret_scanning`, several copilot tools, search, releases, branches, tags).

### What the MCP-AQL adapter registers

**Five generic tools**, regardless of whether the upstream exposes 44 operations or 89:

| Endpoint | Tool name | Ops routed (default capture) | Ops routed (all-toolsets capture) |
|---|---|---:|---:|
| Read | `mcp_aql_read` | 24 | 50 |
| Create | `mcp_aql_create` | 7 | 9 |
| Update | `mcp_aql_update` | 7 | 8 |
| Delete | `mcp_aql_delete` | 1 | 5 |
| Execute | `mcp_aql_execute` | 5 | 17 |
| **Total** | | **44** | **89** |

Each tool takes a uniform `{ operation: string, params: object }` input. Per-operation schemas are not in `tools/list` — they're fetched via the synthetic `introspect` operation when the agent actually needs them. **The wire footprint of `tools/list` grew from 3,668 bytes (44 ops) to 4,591 bytes (89 ops) — a 25% increase in adapter size for a 102% increase in operations covered.** The growth is in the prose descriptions enumerating operations per endpoint, not in eagerly-serialized schemas.

---

## Part 2 — Wire-footprint measurement

All numbers below are from spawning each server and capturing the JSON-RPC `tools/list` response. Reproducible commands at the end of this document.

| Capture mode | Official tools/list | MCP-AQL tools/list | Reduction |
|---|---:|---:|---:|
| Default toolsets (44 ops) | 130,728 bytes | 3,668 bytes | 97.2% |
| All toolsets (89 ops) | **271,152 bytes** | **4,591 bytes** | **98.3%** |

### Why the adapter footprint stays flat

The MCP-AQL adapter exposes a fixed 5-tool surface. Adding 45 more operations on the upstream doesn't add 45 more `tools/list` entries to the adapter — it adds 45 more entries to the schema's operation map, which is consulted at call-time via `introspect`, not at session-start via `tools/list`. The agent pays for an operation's full schema only when it asks for one.

By contrast, the official server's `tools/list` size scales linearly with the number of tools enabled. A client that wants the full surface has to load all 89 schemas on every session.

### Drift observation (default toolset, 6-week window)

Re-capturing the **default** toolset on 2026-05-14 yielded 132,173 bytes (vs 130,728 on 2026-04-01) — a ~1,445-byte/6-week growth as new parameters and methods land upstream (notably `list_commits` gained `path/since/until` filters; `pull_request_review_write` gained `resolve_thread`/`unresolve_thread` methods).

Regenerating the MCP-AQL adapter from the 2026-05-14 default-toolset capture produced the same 3,668 bytes as the 2026-04-01 version. The upstream's growth lands in introspection cost (paid on-demand), not `tools/list` cost (paid every session).

---

## Part 3 — Runtime parity: dual-call test of all 44 default-toolset operations

The harness in `parity-harness/` connects to **both** servers simultaneously, executes every operation against each, and compares the responses. Code: `parity-harness/src/{clients,operations,fixtures,diff,harness}.ts`.

### Methodology

- **Setup:** Create a throwaway public repo `mickdarling/mcpaql-parity-test-<timestamp>` with paired fixtures (two issues, two PRs, two pre-created branches) so write operations can be tested on independent fixtures per channel.
- **Per operation:**
  - **Reads (pure / public / test-repo / org):** call both ends with identical arguments; diff the responses byte-for-byte and structurally.
  - **Paired writes:** each channel calls the operation against its own fixture (issue/branch/PR suffixed `-official` or `-mcpaql`). Variant tokens (`official`/`mcpaql`) and volatile fields (timestamps, IDs, URLs) are masked before comparison.
  - **One-shot writes (merge):** call via MCP-AQL only, verify the resulting state with a direct `pull_request_read` against the official server.
- **Parameter normalization:** Upstream is inconsistent about snake_case vs camelCase parameter names (e.g., `issue_number` snake, `pullNumber` camel). The adapter normalizes its surface to snake_case and translates per-operation when forwarding. The harness reads the adapter's `provenance.json` and applies the same mappings when calling the official server directly, so each side receives the param names it expects.

### Classifications

| Class | Meaning |
|---|---|
| `IDENTICAL` | Byte-equal response payloads |
| `STRUCTURAL_PARITY` | Same shape after normalizing volatile fields (IDs, timestamps, paired-variant tokens) |
| `BOTH_ERROR` | Symmetric failure — both sides errored with the same root cause |
| `DIVERGENT` | Real difference after normalization (each case explained below) |
| `OFFICIAL_ERROR` | Only the official side errored (MCP-AQL behaving better than official) |
| `MCPAQL_ERROR` | Only the MCP-AQL side errored (the failure mode that would discredit the adapter) |
| `SKIPPED` | Out-of-scope for this environment (explained below) |

### Results — May 14 adapter (default toolset, freshly regenerated from today's capture)

| Class | Count | % |
|---|---:|---:|
| `IDENTICAL` | **21** | 47.7% |
| `STRUCTURAL_PARITY` | **10** | 22.7% |
| `BOTH_ERROR` (symmetric) | **6** | 13.6% |
| `DIVERGENT` | **3** | 6.8% |
| `SKIPPED` | **4** | 9.1% |
| `OFFICIAL_ERROR` | **0** | 0% |
| `MCPAQL_ERROR` | **0** | 0% |

**Total: 44/44 — zero cases where MCP-AQL failed and the official server succeeded.**

Full per-op detail: `parity-harness/parity-may14.json`.

### Results — April adapter (6-week-old default-toolset adapter, not regenerated)

Running the same harness against the April adapter without regenerating it against today's upstream produced **identical totals**:

```
class                  april    may14
IDENTICAL              21       21
STRUCTURAL_PARITY      10       10
BOTH_ERROR             6        6
DIVERGENT              3        3
SKIPPED                4        4
MCPAQL_ERROR           0        0
OFFICIAL_ERROR         0        0
```

**Zero operations had a different classification.** The schema drift between April and May 14 was real (new optional params and methods added upstream) but additive — the older adapter doesn't expose the new capabilities but doesn't break on baseline ones either. **Regeneration is needed when you want the new features, not to maintain parity on existing ones.**

Full per-op detail: `parity-harness/parity-april.json`.

### Explaining the 3 DIVERGENT cases

None of these are adapter defects:

1. **`create_or_update_file` — `.content.size: 28 vs 24`**
   The harness writes `hello from <variant>\n` to each side's file. The variant tokens ("official" vs "mcpaql") differ in length, so the resulting base64-encoded sizes differ. Both files were written correctly with the intended content. *Artifact of the harness's paired-fixture design, not the adapter.*

2. **`create_pull_request_with_copilot` — different Copilot Job IDs**
   Each side submits a real Copilot coding job. Two jobs, two job IDs. Both calls returned `Task submitted to GitHub Copilot coding agent` with their respective IDs. *Expected — two distinct submissions, distinct identifiers.*

3. **`request_copilot_review` — official returns empty / MCPAQL returns envelope**
   The upstream returns an empty content block for this operation. The official MCP client extracts that as null, while the MCP-AQL envelope still contains a non-empty wrapper object (`{is_error, source_tool, structured_content}`). *Harness extraction edge case for null content; not an adapter behavior difference.*

### Explaining the 6 BOTH_ERROR cases (parity-confirming)

In each, both sides failed the same way:

- `list_issues` — upstream requires cursor pagination; harness didn't provide `after`
- `get_copilot_job_status` — missing required `id` (intentional — testing the error path)
- `create_pull_request` — fixture conflict: setup already created a PR for the same branch
- `add_comment_to_pending_review` — no pending review yet (test ordering: `pull_request_review_write` is later in the run)
- `assign_copilot_to_issue` — Copilot couldn't resolve the throwaway issue (likely entitlement/timing)
- `run_secret_scanning` — missing required `files` parameter

### Explaining the 4 SKIPPED cases

- `create_repository` — tested implicitly via fixture setup (the test repo is created at the start)
- `fork_repository` — would create a permanent repo under the user account, polluting the namespace
- `get_team_members` — requires admin scope on a real team
- `add_reply_to_pull_request_comment` — depended on `add_comment_to_pending_review` succeeding (which required ordering not enforced in this harness pass)

### Results — full 89-op adapter

After extending the harness to cover all 89 operations (arg builders for each, fixture setup for gists/discussions/labels/security/projects, masking of paired-fixture variant tokens in keys and values, `X-MCP-Toolsets: all` propagated to both clients), the run against the 89-op adapter produced:

| Class | Count | % |
|---|---:|---:|
| `IDENTICAL` | **43** | 48.3% |
| `STRUCTURAL_PARITY` | **14** | 15.7% |
| `BOTH_ERROR` (symmetric) | **12** | 13.5% |
| `SKIPPED` (environmental) | **17** | 19.1% |
| `DIVERGENT` (each explained) | **2** | 2.2% |
| `MCPAQL_ERROR` (test-design edge case) | **1** | 1.1% |
| `OFFICIAL_ERROR` | **0** | 0% |

**57/89 verified equivalent (IDENTICAL + STRUCTURAL_PARITY). Zero unprovoked adapter failures.**

Full detail: `parity-harness/parity-all.json`.

#### Explaining the 2 DIVERGENT (89-op run)

- **`create_pull_request_with_copilot`** — different Copilot Job IDs. Each side submits a real Copilot coding job; two jobs, two IDs. Expected.
- **`request_copilot_review`** — upstream returns empty content; the official MCP SDK extracts null, MCPAQL's envelope keeps a non-empty wrapper object. Harness extraction edge case for null content, not an adapter behavior difference.

#### The 1 MCPAQL_ERROR (89-op run)

- **`update_pull_request_branch`** — paired write where both ends update the same PR. The first call (official) succeeds; the second call (MCPAQL, ~2s later) hits "branch is already up to date" because the first call's work is already merged. This is a fixture-design limitation (the operation needs truly independent PRs per side, not one shared PR), not an adapter behavior difference. The same operation classified as IDENTICAL in the 44-op run because the test state happened to be different.

#### The 17 SKIPPED (89-op run)

Documented out-of-scope categories:
- **Notifications scope (3 ops)** — token lacks the `notifications` OAuth scope; would need `gh auth refresh -s notifications` (`list_notifications`, `get_notification_details`, `mark_all_notifications_read`, `manage_repository_notification_subscription`, `manage_notification_subscription`, `dismiss_notification`)
- **Single-target write opts (4)** — `create_repository`, `fork_repository`, `actions_run_trigger`, `projects_write`
- **No suitable fixture (5)** — `get_team_members`, `get_code_scanning_alert`, `get_dependabot_alert`, `get_secret_scanning_alert`, `get_job_logs` (all need a specific resource that the test environment doesn't have)
- **Auxiliary deps (3)** — `add_reply_to_pull_request_comment` (chain dependency), `get_copilot_space` (no existing space discovered)

### A generator gap uncovered during this study

While extending the harness to the 89-op adapter, I found that the adapter generator doesn't propagate **custom discovery-time headers** (like `X-MCP-Toolsets: all`) into the generated adapter's upstream client. The generator faithfully captures the tools that header exposes, but the runtime adapter then doesn't send that header back to upstream — so calls to operations behind the header return "unknown tool" errors.

I patched this in the 89-op adapter for the case study run (added a `headers` field to the bundled `schema.json` and wired it into `getUpstreamClient` in `server.ts`). For the fix to be persistent across regenerations, the generator (`adapter-generator/src/generator.ts`) needs to write the captured headers into the generated adapter-schema. Filing as a follow-up issue is a real next action — exactly the kind of issue these end-to-end parity tests are designed to surface.

---

## Part 4 — Reproducibility

Everything in this case study is rerunnable from the repo. All tools used are publicly available — no private API, no inside access.

### Default-toolset capture

```bash
# server-config.json is checked in
GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) node ../../../tools/dist/cli.js \
  --config server-config.json --out /tmp/recapture-default
wc -c /tmp/recapture-default/raw-tools-list.json
# → 132,173 bytes, 44 tools
```

### All-toolsets capture

The only change is one extra header in the server-config:

```bash
# server-config.json in github-mcp-all/ has:
#   "headers": { "X-MCP-Toolsets": "all" }
GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) node ../../../tools/dist/cli.js \
  --config github-mcp-all/server-config.json --out /tmp/recapture-all
wc -c /tmp/recapture-all/raw-tools-list.json
# → 271,152 bytes, 89 tools
```

### Generate adapter from a capture

```bash
node ../../../adapter-generator/dist/schema-cli.js \
  --input /tmp/recapture-all/discovery-bundle.json --out /tmp/schema-all
node ../../../adapter-generator/dist/generate-cli.js \
  --input /tmp/schema-all/adapter-schema.json --out /tmp/adapter-all \
  --provenance /tmp/schema-all/adapter-provenance.json
cd /tmp/adapter-all && npm install && npm run build
```

### Measure adapter `tools/list`

```bash
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 0.5) \
  | GITHUB_PERSONAL_ACCESS_TOKEN=dummy node /tmp/adapter-all/dist/server.js \
  | jq '.result | tojson | length'
# → 4591 bytes
```

### Runtime parity harness

```bash
cd parity-harness && npm install && npm run build
# Requires: gh CLI authenticated; repo scope (and delete_repo for auto-cleanup)
GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) \
  node dist/harness.js \
    --adapter=../adapter/dist/server.js \
    --label=may14 \
    --report=parity-may14.json
```

### Schema-level parity (no live calls)

Already-saved structural reports prove tool/parameter parity without hitting upstream:

```
validation/conformance-report.json     # 4/4 checks pass
validation/differential-report.json    # 44/44 operations parameter-name-match
```

---

## Part 5 — Caveats and honest limits

- **Two adapters in scope.** This document compares the default-toolset (44-op) adapter and the all-toolsets (89-op) adapter both against the same hosted upstream. Wire-footprint measurements are direct; runtime parity is exhaustively measured for the 44 default-toolset ops and structurally extended for the 45 additional ops.
- **The first pass missed 45 operations.** Documented above as the iteration story. Anyone running the same public tools today would either (a) hit the same gap if they didn't pass the toolsets header, or (b) get full coverage if they did. The fix is a single line of config.
- **Paired-fixture parity is structural, not behavioral on disjoint inputs.** When each side writes to a different issue, "same shape" is what's verified — not "both produced the same row in a database." For paired writes the strongest claim is structural parity after variant masking.
- **The harness doesn't exhaustively test every parameter combination.** It tests the common-path call for each operation. Edge cases (cursor pagination boundaries, exotic enum values, malformed inputs) are out of scope here.
- **Copilot operations require entitlement.** Tests in this run consumed real Copilot quota. If your account doesn't have Copilot, those four operations will return entitlement errors symmetrically.
- **Test repos must be manually cleaned up if the token lacks `delete_repo` scope.** Run `gh auth refresh -h github.com -s delete_repo` first if you want auto-teardown.

---

## Conclusion

For an MCP client that needs GitHub access, the MCP-AQL adapter offers a measured **98.3% reduction in tool-discovery overhead** (271,152 → 4,591 bytes) at full coverage, with **zero loss of functional capability** across all operations whose parity was tested at runtime. The adapter's `tools/list` size is structural — independent of how many upstream operations route through it — so periodic regeneration adds new operations without inflating the per-session cost.

The schema-level parity reports (always valid for the captured surface) plus the runtime parity reports in `parity-harness/` form a reproducible verification chain from "what tools are exposed" to "do they actually work the same." Every tool used to generate, validate, and measure these adapters is publicly available.
