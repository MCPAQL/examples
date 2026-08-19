# MCP-AQL Examples

Example adapter configurations for MCP-AQL (Model Context Protocol - Advanced Agent API Adapter Query Language).

## Purpose

This repository contains **example adapter schemas** that demonstrate how to use MCP-AQL to wrap real-world APIs. These examples are non-normative reference material.

For **normative protocol specifications**, see the [spec repository](https://github.com/MCPAQL/spec).

## Examples

### Adapters

| Example | Description | API |
|---------|-------------|-----|
| [GitHub API Adapter](adapters/github-api-adapter.md) | Complete adapter for GitHub REST API v3 | GitHub REST API |

### Generated Golden Paths

| Example | Description | Source |
|---------|-------------|--------|
| [GitHub MCP Golden Path](generated/github-mcp/README.md) | End-to-end capture, discovery bundle, generated schema, adapter, and validation artifacts | GitHub MCP server |
| [Playwright MCP Golden Path](generated/playwright-mcp/README.md) | End-to-end capture, discovery bundle, generated schema, adapter, and validation artifacts | Playwright MCP server |

### Native Sensor Adapters

| Example | Description | Source |
|---------|-------------|--------|
| [AirPods Head-Tracking Adapter](generated/airpods-mcp/README.md) | Live head-pose streaming (~25 Hz yaw/pitch/roll) behind a CRUDE surface, with a WebSocket HUD and a gaze-driven window-focus sidecar. Runnable today: anyone with AirPods Pro and an Apple Silicon Mac can use it — prebuilt binaries are linked in its README. | AirPods Pro IMU via Apple's `CMHeadphoneMotionManager` |

## Current Transport Scope

The current golden-path tooling supports upstream source MCP servers over `streamable_http`.

The generated adapters themselves run as local MCP servers over `stdio`, so a typical demo flow today looks like:

1. start or expose the upstream MCP server over HTTP
2. generate or use the committed MCP-AQL adapter artifacts
3. run the generated adapter locally as a `stdio` MCP server
4. connect your MCP client to that generated adapter

Why this is cleaner right now:

- the upstream HTTP server can stay up independently of your MCP client lifecycle
- the local generated adapter can be started and stopped by your MCP host without also having to supervise the upstream source server
- this is especially helpful for stateful MCP servers like Playwright, where restarting the upstream process may reset browser state

## Structure

Each example adapter is a Markdown file with YAML front matter following the [Adapter Element Type Specification](https://github.com/MCPAQL/spec/blob/develop/docs/adapter/element-type.md). The front matter contains all operation mappings, and the Markdown body provides human-readable documentation.

## How to Use

1. Copy an example adapter as a starting point
2. Modify the `target`, `auth`, and `operations` sections for your API
3. Load the adapter schema in the [universal adapter runtime](https://github.com/MCPAQL/mcpaql-adapter)

## Related Repositories

| Repository | Purpose |
|------------|---------|
| [spec](https://github.com/MCPAQL/spec) | Protocol specification, schemas, conformance tests |
| [mcpaql-adapter](https://github.com/MCPAQL/mcpaql-adapter) | Reference adapter implementation |
| [adapter-generator](https://github.com/MCPAQL/adapter-generator) | Tool to generate adapters from API specs |

## License

- **Documentation**: CC BY 4.0
- **Code/schemas/tests**: AGPL-3.0

See [LICENSE](LICENSE), [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md), [NOTICE.md](NOTICE.md), and [TRADEMARKS.md](TRADEMARKS.md) for details.
