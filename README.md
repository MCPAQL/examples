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

See [LICENSING](LICENSING.md) for details.
