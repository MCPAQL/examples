# Playwright Adapter Operation Guide

This file summarizes the generated Playwright MCP-AQL adapter surface in a compact, human-readable way.

## Surface Snapshot

- Upstream Playwright MCP tools captured: `21`
- MCP-AQL endpoint tools exposed by the adapter: `2`
- Wrapped upstream operations exposed through those endpoint tools: `21`
- Synthetic adapter-only operations: `1` (`introspect`)
- Total operations discoverable through adapter introspection: `22`

## Approximate Context Size

These are rough estimates based on `chars / 4`, intended only to give a sense of relative prompt footprint:

- Upstream `tools/list` surface: `1307` chars, about `327` tokens
- Adapter registered MCP tool surface: `704` chars, about `176` tokens
- Adapter introspection catalog: `3274` chars, about `819` tokens

The adapter reduces the top-level registered tool surface from 21 tools down to 2 CRUDE endpoint tools, but the full operation catalog still needs to be discoverable through `introspect`.

## Registered Endpoint Tools

- `mcp_aql_read`
  - Used for `introspect`, `browser_console_messages`, `browser_network_requests`, and `browser_snapshot`
- `mcp_aql_execute`
  - Used for the remaining browser interaction and workflow operations

This adapter currently exposes CRUDE-style endpoint tools only. It does not emit a single-endpoint adapter surface.

## What `introspect` Is For

The generated adapter expects clients to discover operation details through:

```json
{ "operation": "introspect", "params": { "query": "operations" } }
```

You can then ask for a single operation:

```json
{ "operation": "introspect", "params": { "query": "operations", "name": "browser_click" } }
```

Or inspect the wrapped result type:

```json
{ "operation": "introspect", "params": { "query": "types", "name": "WrappedToolResult" } }
```

## How To Think About This Adapter

- The adapter is a CRUDE wrapper over a browser-automation MCP server, not a browser-specific DSL.
- Read-only observational operations are intentionally grouped under `READ`.
- Browser state changes and interaction steps are currently grouped conservatively under `EXECUTE`.
- The absence of `CREATE`, `UPDATE`, and `DELETE` buckets reflects current classification, not a claim that the underlying Playwright tools never change state.
- Parameter names exposed by the adapter are normalized to `snake_case`, but the runtime maps them back to the upstream Playwright names before proxying.

## Playwright-Specific Notes

- This example was captured from Playwright MCP `0.0.41`.
- The adapter defaults to an upstream server at `http://localhost:8931/mcp`.
- You can override that per launch with `MCPAQL_TARGET_BASE_URL=http://your-host:8931/mcp node dist/server.js`.
- The Playwright tool surface is stateful: many operations depend on prior navigation, tabs, refs, or page state established earlier in the same session.
- The discovery bundle records the upstream MCP transport as `streamable_http`, while the generated adapter schema currently records the broader transport family as `http`.
