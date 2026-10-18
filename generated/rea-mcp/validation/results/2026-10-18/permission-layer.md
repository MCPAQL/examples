# Host permission layer: raw REA tools (2026-10-18)

Section 5 of the [test plan](https://github.com/MCPAQL/examples/issues/55#issuecomment-6245593226), for raw REA tools only. The adapter was not registered in the coding agent for this run: the VM's policy and its fail-closed guard matched only the raw REA tool names. Adapter cases follow once the policy covers it.

- **Setup:** an isolated macOS VM running Claude Code 2.1.292 headless, under a PreToolUse permission policy and a separate fail-closed guard.
- **Hook-level replays:** tool-call payloads were fed to the two hooks and evaluated, not executed.
- **Agent runs:** made only calls the policy allows or asks about. A headless session cannot approve an ask.
- **Snapshot:** this records the policy as it was on 2026-10-18, before it was tightened in response to these results.

## Policy decisions

`permission-policy.tsv` has the decision for each of REA's 207 tools. Each tool's decision was bracketed by checks that the policy was in force.

| Decision | Tools | Of the adapter's 131 stage-1 operations |
|---|---|---|
| allow | 173 | 129 |
| ask | 28 | 2: `close_binary`, `export_evidence_bundle` |
| deny | 6 (Android device install, push, start, stop, uninstall) | 0 |

- **Agreement with the adapter.** The two stage-1 operations the policy asks about are the two the adapter marks destructive and treats as `requires_confirmation`. They also halt a batch.
- **Allowed but left out of stage 1:** 44 tools, mostly device or network reads. They include `start_gdb_session`, which starts a debugger, and `observe_native_ui`, which reads a running app's UI. None were called.

## Through the coding agent

| Call | Policy | Observed |
|---|---|---|
| `list_unknowns` | allow | ran and returned REA's result |
| `close_binary` | ask | did not run. The model received `Requires approval: … policy requires confirmation for pattern 'mcp__rea__close_binary'` |
| Bash `npx rea-agents …` | ask | did not run, with the same kind of message |
| Any REA call with the policy not active | guard | denied: "policy not in force" |

The model always got a clear reason, and the guard log recorded each decision.

A first attempt asked the agent to run a fixed four-call script, including an install tool with empty arguments. The model declined it. A two-call version that stated its purpose ran as above.

## Shell launches

The guard and the policy both match command strings. 24 launch variants, plus 2 harmless control commands that were allowed as expected, were evaluated by the hooks with the policy confirmed in force before and after each. None was executed.

| Outcome | Variants |
|---|---|
| ask (REA rule) | 15 direct launches: `npx`, `npm exec`, `pnpm dlx`, `bunx`, `rea`, the installed `.bin` path, `node …/rea.mjs`, `env`, `command`, and the adapter started with the REA path in the same command |
| deny (general dangerous-command rules) | 3: `bash -c …`, `… \| sh`, `python3 -c …` |
| allow | 6: a quoted, split or variable-built name (3), `osascript -e 'do shell script …'`, the adapter started without the REA path in the command, `npx` of a packaged adapter |

Command-string matching cannot be complete. It is a tripwire, not a boundary, which supports MCPAQL/spec#277. Launching a wrapped server is also a way to launch its upstream, so the wrapper needs its own gating entry.

## Token footprint through the agent

Claude Code 2.1.292 defers MCP tool schemas.
- With all 207 REA tools registered, none of their definitions reached the context up front.
- The model fetched the two schemas it needed with a tool search before calling them.
- The 4-turn session used about 26,000 input tokens per turn, mostly the agent's own context.

In a host that defers tool loading, the adapter's up-front saving matters much less than in one that loads every schema. The per-call shaping savings still apply.

## Also found

One issue in the permission layer itself, separate from REA and from MCP-AQL, was reported privately to its maintainer.
