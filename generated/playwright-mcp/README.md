# Playwright MCP Golden Path

This directory contains the second end-to-end MCP server -> MCP-AQL adapter pipeline output, targeting the official Playwright MCP server over HTTP.

Expected artifacts:

- `server-config.json` - source MCP connection config used by `mcpaql-interrogate`
- `capture/` - raw and normalized discovery artifacts
- `schema/` - generated MCP-AQL adapter schema and provenance sidecars
- `adapter/` - generated runnable TypeScript MCP-AQL adapter package
- `validation/` - saved conformance and differential validation reports

The generated outputs are intended to be reproducible from the committed config plus a reachable Playwright MCP server at `http://localhost:8931/mcp`.

You can point the generated adapter at a different upstream Playwright MCP server without editing code by setting `MCPAQL_TARGET_BASE_URL` when you launch the adapter.

## Quick Start

This example has two layers:

1. the upstream Playwright MCP server, which this example currently expects over `streamable_http`
2. the generated MCP-AQL adapter, which you run locally as a `stdio` MCP server

If you just want to try the adapter locally, the shortest path is:

1. start Playwright MCP over HTTP
2. install the generated adapter dependencies
3. build the generated adapter
4. point your MCP client at the generated adapter's `dist/server.js`

Copy-pasteable local demo path:

```bash
docker run --rm --init -p 8931:8931 mcp/playwright:latest --headless --browser chromium --no-sandbox --host 0.0.0.0 --port 8931

# in a second terminal
cd adapter
npm install
npm run build
node dist/server.js
```

## Prerequisites

- Node.js 20 or newer
- Docker, if you want the easiest local HTTP setup for Playwright MCP
- an MCP client that can launch a local `stdio` server

## Artifact Notes

- The current saved capture reflects Playwright MCP `0.0.41` observed on `2026-04-01`, with 21 tools and 30 warnings.
- This golden path is intentionally focused on the current HTTP capture path.
- Playwright also supports `stdio`, but source-side `stdio` capture is planned as a follow-on broadening of the pipeline rather than folded into this example.
- The generated schema currently exposes 3 `READ` operations and 18 `EXECUTE` operations.
- The adapter compresses the upstream 21-tool Playwright surface into 2 CRUDE endpoint tools: `mcp_aql_read` and `mcp_aql_execute`, with 21 wrapped operations plus a synthetic `introspect` operation discoverable through the adapter.
- In this documentation, `CRUDE` means `Create`, `Read`, `Update`, `Delete`, and `Execute`.
- For the current Playwright capture there are no generated `CREATE`, `UPDATE`, or `DELETE` endpoint buckets. That does not mean Playwright has no state-changing actions. It means the current first-pass classifier treats browser interactions as workflow-style `EXECUTE` operations instead of resource-style CRUD mutations.
- See [adapter/surface-summary.json](./adapter/surface-summary.json) for counts and rough context-size estimates, and [adapter/OPERATION-GUIDE.md](./adapter/OPERATION-GUIDE.md) for a human-oriented summary of the adapter surface.
- The committed artifacts should be regenerated if the upstream Playwright MCP tool surface changes.
- The adapter schema currently records the transport family as `http`, while the discovery bundle preserves the MCP transport subtype as `streamable_http`.

## Known Limitations

- The generated adapter inherits the current first-pass classification heuristics, so action-oriented browser operations may remain conservatively mapped to `EXECUTE`.
- This example assumes a reachable Playwright MCP server in HTTP mode.
- The easiest runtime override is `MCPAQL_TARGET_BASE_URL=http://your-host:8931/mcp node dist/server.js`.
- The bundled default upstream URL still lives in `schema/adapter-schema.json` and the runtime copy at `adapter/src/schema.json`.

## Why HTTP First

The generated adapter itself runs locally over `stdio`, but this example currently expects the upstream Playwright MCP server over `streamable_http`.

That is the cleaner path right now because the upstream Playwright process can stay up independently while your local MCP host starts and stops the generated adapter process as needed.

## Starting the Source Server

If you are using Docker, start a local Playwright MCP HTTP endpoint with:

```bash
docker run --rm --init -p 8931:8931 mcp/playwright:latest --headless --browser chromium --no-sandbox --host 0.0.0.0 --port 8931
```

That exposes the upstream MCP server at `http://localhost:8931/mcp`, which matches [server-config.json](./server-config.json).

## Installing and Running the Generated Adapter

From this directory:

```bash
cd adapter
npm install
npm run build
node dist/server.js
```

That starts the generated MCP-AQL adapter as a local `stdio` MCP server.

To point the adapter at a different Playwright MCP server for a one-off run:

```bash
cd adapter
npm install
npm run build
MCPAQL_TARGET_BASE_URL=http://your-host:8931/mcp node dist/server.js
```

## Connecting an MCP Client

Point your MCP client at the generated adapter, not directly at the upstream HTTP server.

Example client config shape:

Replace the `args` path below with the absolute path to this repository on your machine.

```json
{
  "mcpServers": {
    "playwright-mcpaql": {
      "command": "node",
      "args": [
        "/absolute/path/to/generated/playwright-mcp/adapter/dist/server.js"
      ]
    }
  }
}
```

In that setup:

- your MCP client speaks `stdio` to the generated adapter
- the generated adapter speaks `streamable_http` to the upstream Playwright MCP server at `http://localhost:8931/mcp`

## What This Example Supports Today

- upstream source capture: `streamable_http`
- generated adapter runtime: `stdio`
- upstream auth for this Playwright example: `none`
- adapter surface shape: CRUDE endpoint tools only
- upstream 21 tools become 2 registered adapter endpoint tools (`mcp_aql_read`, `mcp_aql_execute`)

Source-side `stdio` capture is planned next, but it is not part of the current golden path yet.

## Regenerating

From this directory, rebuild the pipeline with:

```bash
cd ../../../tools
npm run build

cd ../adapter-generator
npm run build

cd ../examples/generated/playwright-mcp

node ../../../tools/dist/cli.js --config server-config.json --out capture
node ../../../adapter-generator/dist/schema-cli.js --input capture/discovery-bundle.json --overrides schema-overrides.json --out schema
node ../../../adapter-generator/dist/generate-cli.js --input schema/adapter-schema.json --provenance schema/adapter-provenance.json --out adapter

cd adapter
npm install
npm run build
cd ..

node ../../../tools/dist/conformance-cli.js --command node --args "[\"dist/server.js\"]" --cwd adapter --schema-root ../../../spec/schemas > validation/conformance-report.json
node ../../../tools/dist/diff-cli.js --bundle capture/discovery-bundle.json --schema schema/adapter-schema.json --command node --args "[\"dist/server.js\"]" --cwd adapter > validation/differential-report.json
```
