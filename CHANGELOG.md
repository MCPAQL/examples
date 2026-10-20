# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This is a rolling examples collection and uses date-based versioning
(`YYYY.MM.DD`) rather than Semantic Versioning.

## [Unreleased]

### Added

- REA (Reverse Engineer Anything) adapter example, stage 1: static analysis (`generated/rea-mcp/`)
  - Wraps the local stdio MCP server `rea-agents@6.5.0` using the adapter generator's stdio upstream
  - Captured offline from REA's published tool catalog with `mcpaql-import-catalog`, without running REA; classified from REA's own effect flags
  - Exposes 131 of 207 tools (121 READ, 10 CREATE). Runtime, device, UI, foreign-code, UPDATE, DELETE and EXECUTE operations are excluded and recorded in provenance
  - `tools/list` is 4,697 characters, against 660,806 model-visible characters for the same upstream tools
  - Regenerated with the adapter generator's batching and result-shaping runtime. Batching is available on READ and CREATE
  - Live-validation kit in `generated/rea-mcp/validation/` for an isolated VM: an `mcpaql-parity` suite (raw REA and the adapter, each with its own session), analysis targets built from source, and a harness that records tool-list, request and response sizes for both arms
  - Result shaping on for REA: duplicate text content is dropped, and `analyze_function` results over 20,000 characters become a summary and an `inspect_analysis_view` handle. Against a live REA, 19 of the 21 native facets paged through the handle matched the full record exactly; the two Swift facets do not apply to the C test target
  - Live results (2026-10-18, isolated VM): parity 23/23 identical, batching 19/19, shaping checks passing; an 11-call workflow takes 205,983 characters from REA (97,169 counting text content only) and 42,667 through the shaped adapter
  - Host permission-layer results for raw REA tools (`validation/results/2026-10-18/permission-layer.md`, `permission-policy.tsv`): the policy decision for each of REA's 207 tools, headless coding-agent runs, and which shell launches command-string matching catches
  - REA adapter passes `TMPDIR`, `REA_APKTOOL_COMMAND` and `REA_CAPINFOS_COMMAND` through to REA. Without `TMPDIR`, REA wrote its byte snapshots of the target under `/tmp`, which parity showed as a codesign output difference in `inspect_signature`

## [2026.10.14] - 2026-10-14

### Added

- Both Chief adapters are published to npm as `@mcpaql/chief-mcp` and `@mcpaql/chief-mcp-projects`, runnable with `npx -y` (generated with the adapter generator's `--package` option; config in each example's `package-config.json`)
- Project-aware Chief MCP adapter example (`generated/chief-mcp-projects/`)
  - Same upstream capture, generated with the adapter generator's `tenancy` block: the model lists projects, sees and switches the active one, and targets a project per call, instead of a project id pinned in client config
  - Needs only `CHIEF_API_KEY`; optional `CHIEF_PROJECT` sets the starting project
  - Shares the `chief-mcp` parity harness; 56 of 60 operations exercised with no divergence
- Chief MCP adapter example (`generated/chief-mcp/`)
  - 60 Chief MCP tools behind the five CRUDE endpoints; `tools/list` drops from 63,520 to 3,766 characters, with per-call results the same size as Chief's own
  - Reviewed `schema-overrides.json` for the ten operations the interrogator flagged, with a reason for each endpoint and danger level
  - Parity harness with a read-only mode and a write mode guarded to a dedicated test project; 56 of 60 operations exercised with no divergence
  - Chief's project id is supplied as `${env:CHIEF_PROJECT_ID}` and never committed
- Shortcut Remote JIT adapter example (`generated/shortcut-remote-mcp/`)
  - Just-in-time observational HID discovery of the undocumented XP-Pen Shortcut Remote keypad: capture raw input reports, derive the byte layout, emit a CRUDE adapter — no vendor SDK, no kernel extension, no protocol documentation
  - Single long-lived adapter process serving HID decode, layer state machine, wheel state, keystroke and shell dispatch, and a live WebSocket HUD from one port
  - Kill-switch tooling: menu-bar app sources, build and LaunchAgent install scripts, and a status/kill script that distinguishes the adapter from other device holders
  - Companion to the AirPods head-tracking adapter — the keypad provides the hardware recenter trigger documented in that example; the previously broken cross-link between the two now resolves
- Root README now links the AirPods head-tracking adapter (`generated/airpods-mcp/`) under a new Native Sensor Adapters section, so it is discoverable from the repository front page
- GitHub MCP all-toolset case study artifacts
  - Added the full 89-operation GitHub MCP generated adapter capture under `generated/github-mcp-all/`
  - Added the GitHub MCP parity harness and case study writeups with reproducibility commands and measured results

### Fixed

- `.lychee.toml`: `include_fragments` updated from the removed boolean form to the string form (`"full"`) required by current lychee, repairing the link-check workflow that had been failing on develop since early August

## [2026.05.15] - 2026-05-15

### Added

- AirPods MCP-AQL adapter example (`generated/airpods-mcp/`)
  - Three-layer reference implementation: Swift `.app` motion source (`CMHeadphoneMotionManager`), Node MCP-AQL adapter (CRUDE surface + live WebSocket HUD), and a sample sidecar that does gaze-driven X-mouse-style window focus
  - 10-anchor calibration capture, drift mitigation (motion-gated 1-Euro smoothing + capped leaky integrator + manual recenter), region classification with hysteresis to kill boundary flicker
  - Cross-adapter integration documented: SIGUSR1 or `mcpaql_update.recenter` from any hardware input (e.g., the shortcut-remote-mcp keypad)
  - Demonstrates the MCP-AQL pattern applied to a non-HID sensor source via a documented Apple framework
- Apple Mail adapter example (`adapters/apple-mail-adapter.md`)
  - First native-applescript transport adapter, demonstrating local macOS app automation via JXA
  - Complete CRUDE operations: list accounts, read messages, search, mark read/flagged/junk, delete, move, send
  - No API keys or network connectivity required
- GitHub API adapter example migrated from spec repository
  - `adapters/github-api-adapter.md` - Complete GitHub REST API v3 adapter
- Updated README.md with repository purpose and example index
- GitHub MCP golden-path generated example artifacts
  - Added `generated/github-mcp/` capture, schema, adapter, and validation outputs for the first MCP-server-to-MCP-AQL pipeline
  - Added regeneration and validation documentation for the generated example
- Playwright MCP golden-path generated example artifacts
  - Added `generated/playwright-mcp/` capture, schema, adapter, and validation outputs for the HTTP Playwright MCP pipeline
  - Added Docker-based startup, regeneration, and validation documentation for the generated example
- Generated adapter quick-start documentation improvements
  - Clarified the current transport model: upstream source capture over `streamable_http`, generated adapters running locally over `stdio`
  - Added first-time-user quick-start guidance for the Playwright generated adapter, including client configuration examples

### Changed

- Link checking for public MCPAQL repos
  - Removed the repo-wide GitHub exclusion from lychee now that `examples`, `spec`, `adapter-generator`, and `mcpaql-adapter` are all public
  - Re-enabled CI link checking for the public cross-repo references used throughout the examples documentation
- GitHub MCP golden-path public-readiness cleanup
  - Normalized the committed GitHub example to use env-var auth guidance instead of `gh auth token`
  - Refreshed saved capture, schema, adapter, and validation artifacts from the env-var-only auth path
- Public release sync polish
  - Fixed the root README licensing links to point at the repo's actual license and notice files
  - Marked the pending infrastructure session note as historical context so it does not read like current repository state
