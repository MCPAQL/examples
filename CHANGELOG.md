# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
