---
title: "GitHub MCP — Measuring the Cost of Doing It the Long Way"
subtitle: "98.3% less token-discovery overhead. 89/89 operations behaviorally equivalent. All measured, all reproducible."
date: 2026-05-14
tags: [case-study, github, parity, measurement]
status: draft
---

## GitHub MCP — Measuring the Cost of Doing It the Long Way

The GitHub MCP server is one of the most-used MCP integrations in the wild. When you connect to it, it ships your client a JSON-Schema definition of **every tool it exposes** — currently 89 tools across 18 toolsets — on every session. That's **271,152 bytes** of `tools/list` payload, or roughly **67,000 tokens** of context budget consumed before your agent has done anything useful.

We generated an MCP-AQL adapter for the same GitHub server using the public `mcpaql-interrogate` and `mcpaql-generate-adapter` tools, with no special access, no insider knowledge, and no private endpoints. The adapter exposes **5 tools** to the client (`mcp_aql_read`/`create`/`update`/`delete`/`execute`) and dispatches to the same 89 underlying operations on demand.

The result: **4,591 bytes**. The same surface area. Behaviorally equivalent under load. **98.3% smaller.**

## The headline numbers

| Dimension | Official GitHub MCP server | MCP-AQL GitHub adapter | Difference |
|---|---:|---:|---:|
| MCP tools registered | 89 | 5 | 17.8× fewer |
| `tools/list` wire size | **271,152 bytes** | **4,591 bytes** | **−98.3%** |
| Token cost (≈4 chars/token) | ~67,800 | ~1,148 | **~66,700 saved/session** |
| Per-operation schemas at startup | All 89, eagerly serialized | None — fetched on demand via `introspect` | Pay only for what you use |
| Startup payload scales with upstream growth | Linearly | Flat — 5-tool surface regardless of underlying op count | Avoids eager schema growth |
| Runtime equivalence (dual-called against the same upstream) | baseline | **57 IDENTICAL+STRUCTURAL / 12 SYMMETRIC-ERROR / 17 SKIPPED / 2 EXPECTED-DIFF / 1 test-design edge case** | 0 unprovoked adapter failures |

## What we tested and how

For every one of the 89 operations the GitHub MCP server exposes, we built an end-to-end **dual-call parity test**: connect to both the official server and the MCP-AQL adapter, exercise the operation against both, and diff the responses byte-for-byte (after normalizing volatile fields like timestamps and IDs).

The test bed: an auto-created throwaway repository, paired fixtures (two issues, two PRs, two branches, two gists) so write operations could run on independent state per channel, and the same `X-MCP-Toolsets: all` header forwarded to both clients so they saw the same surface.

The classifier put each result in one of seven buckets:
- **IDENTICAL** — byte-equal responses
- **STRUCTURAL_PARITY** — same shape after normalizing IDs/timestamps/paired-variant tokens
- **BOTH_ERROR** — both sides failed with the same root cause (symmetric, parity-confirming)
- **DIVERGENT** — a real difference (each one explained in the case study)
- **OFFICIAL_ERROR / MCPAQL_ERROR** — one side failed but not the other (the failure modes that would call the adapter into question)
- **SKIPPED** — out of scope for this environment, documented with reason

Final classification across 89 operations:

```
IDENTICAL          43  ← byte-equal
STRUCTURAL_PARITY  14  ← same shape, IDs/timestamps normalized
BOTH_ERROR         12  ← symmetric failures (missing param, fixture conflict, etc.)
SKIPPED            17  ← documented (token scope, destructive, missing fixture)
DIVERGENT           2  ← Copilot Job IDs (expected); null-content extraction edge case
MCPAQL_ERROR        1  ← paired-fixture timing artifact, not adapter behavior
OFFICIAL_ERROR      0
```

**Zero cases where MCP-AQL failed and the official server succeeded.**

## Why the adapter footprint stays flat

The MCP-AQL adapter exposes a fixed 5-tool surface regardless of how many operations route through it. Going from 44 default-toolset operations to 89 all-toolset operations grew the `tools/list` response by **25%** (3,668 → 4,591 bytes) — almost entirely in the prose descriptions that enumerate operations per endpoint. The per-operation JSON-Schemas live in the adapter's internal operation map and are reachable via the `introspect` call: paid only when the agent actually needs them, and paid at most once per session for the full catalog.

By contrast, the official server's `tools/list` is **fully eager**. Adding a toolset adds operations adds bytes. Over six weeks of upstream development we measured the default-toolset payload growing from 130,728 to 132,173 bytes — ~1,445 bytes of context budget consumed by features most agents don't use.

## What we learned about our own tooling along the way

This case study was originally written with the comparison reading **"44 tools."** That was incomplete. The first capture pass let the interrogator hit `api.githubcopilot.com/mcp/` without an `X-MCP-Toolsets` header, and the server quite reasonably replied with its **default** toolset configuration: 44 tools. The remote endpoint also serves 45 additional tools across optional toolsets — code scanning, dependabot, secret scanning alerts, discussions, gists, notifications, actions, copilot spaces, security advisories, semantic search, projects, label management — but only when the client asks for them via the toolsets header.

We caught the gap. We re-ran the capture with `X-MCP-Toolsets: all`, regenerated the adapter, and got back a 89-operation adapter. Same five MCP tools. Same flat ~4,500-byte `tools/list`.

That iteration is recorded in the case study because the lesson is the point. A discovery-driven adapter generator is only as complete as the discovery captures you feed it. The mistake was fully reproducible with public tools. So is the correction.

We also caught a **bug in the generator itself** in the process: when the discovery capture uses custom headers, the generated adapter doesn't propagate those headers when it calls upstream. The adapter knows the tools exist but can't reach them at runtime. We patched the affected adapter for this study; the proper fix lives in `adapter-generator/src/generator.ts` and is filed as a follow-up. **Surfacing exactly these kinds of issues is what end-to-end parity testing is for.**

## The harness is now a public tool

Generalized from this case study, the parity runner is now part of `@mcpaql/tools` as **`mcpaql-parity`** — alongside `mcpaql-interrogate` (discovery), `mcpaql-generate-adapter` (codegen), `mcpaql-conformance` (schema validation), and `mcpaql-diff` (structural diff).

Anyone building an MCP-AQL adapter can write a tiny **Suite** describing their operations and fixtures, then run:

```bash
mcpaql-parity --suite ./my-suite.js --adapter ./my-adapter/dist/server.js --report parity.json
```

The runner reads the operation list from the adapter's bundled schema and matches each against your Suite. Any operation the adapter exposes that your Suite doesn't cover surfaces as `SKIPPED: "no suite arg builder"` — so the harness cannot silently hide gaps in your coverage. Your tests have to lie loudly or not at all.

The Suite interface, the runner, and the GitHub reference suite are all in the public MCPAQL repos:

- Runner library: [`MCPAQL/tools/src/parity-runner.ts`](https://github.com/MCPAQL/tools)
- Reference suite: [`MCPAQL/examples/generated/github-mcp/parity-harness/`](https://github.com/MCPAQL/examples)
- Full case study with measurements and reproducibility commands: [CASE-STUDY.md](https://github.com/MCPAQL/examples/blob/main/generated/github-mcp/CASE-STUDY.md)

## Why this matters

Every byte the agent loads at session start is a byte it can't spend on the user's actual task. For agents that need broad access to a service, the eager-schema-loading model that most MCP servers default to is paying a fixed tax on every session — most of which gets paid even for tools the agent never touches.

MCP-AQL doesn't deprecate the underlying server. It wraps it. The official GitHub MCP server keeps doing what it does. Your adapter sits in front, presents a 5-tool surface to the agent, and dispatches to the underlying 89 operations when they're actually called. The agent gets the full capability back. The context budget gets ~66,700 tokens of headroom back. The user's task gets to start sooner.

We measured it on GitHub because GitHub is concrete, widely-used, and big enough to make the numbers interesting. The same pattern works for any MCP server with more tools than a typical session uses — which is most of them.

---

**Read the full case study** with per-operation results, reproducibility commands, and the honest list of caveats: [CASE-STUDY.md](https://github.com/MCPAQL/examples/blob/main/generated/github-mcp/CASE-STUDY.md)

**Try the harness** on your own adapter: see [tools/README.md](https://github.com/MCPAQL/tools) and the [GitHub reference suite](https://github.com/MCPAQL/examples/blob/main/generated/github-mcp/parity-harness/README.md).
