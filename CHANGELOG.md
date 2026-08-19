# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This is a rolling examples collection and uses date-based versioning
(`YYYY.MM.DD`) rather than Semantic Versioning.

## [Unreleased]

### Added

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
