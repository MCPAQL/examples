# GitHub MCP Golden Path

This directory contains the first end-to-end MCP server -> MCP-AQL adapter pipeline output for the official GitHub MCP server.

Expected artifacts:

- `server-config.json` - source MCP connection config used by `mcpaql-interrogate`
- `capture/` - raw and normalized discovery artifacts
- `schema/` - generated MCP-AQL adapter schema and provenance sidecars
- `adapter/` - generated runnable TypeScript MCP-AQL adapter package

The generated outputs are intended to be reproducible from the committed config plus a valid GitHub token.
