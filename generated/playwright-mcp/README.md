# Playwright MCP Golden Path

This directory contains the second end-to-end MCP server -> MCP-AQL adapter pipeline output, targeting the official Playwright MCP server over HTTP.

Expected artifacts:

- `server-config.json` - source MCP connection config used by `mcpaql-interrogate`
- `capture/` - raw and normalized discovery artifacts
- `schema/` - generated MCP-AQL adapter schema and provenance sidecars
- `adapter/` - generated runnable TypeScript MCP-AQL adapter package
- `validation/` - saved conformance and differential validation reports

The generated outputs are intended to be reproducible from the committed config plus a reachable Playwright MCP server at `http://localhost:8931/mcp`.

## Artifact Notes

- The current saved capture reflects Playwright MCP `0.0.41` observed on `2026-04-01`, with 21 tools and 30 warnings.
- This golden path is intentionally focused on the current HTTP capture path.
- Playwright also supports `stdio`, but source-side `stdio` capture is planned as a follow-on broadening of the pipeline rather than folded into this example.
- The generated schema currently exposes 3 `READ` operations and 18 `EXECUTE` operations.
- The committed artifacts should be regenerated if the upstream Playwright MCP tool surface changes.

## Known Limitations

- The generated adapter inherits the current first-pass classification heuristics, so action-oriented browser operations may remain conservatively mapped to `EXECUTE`.
- This example assumes a locally reachable Playwright MCP server in HTTP mode.

## Starting the Source Server

If you are using Docker, start a local Playwright MCP HTTP endpoint with:

```bash
docker run --rm --init -p 8931:8931 mcp/playwright:latest --headless --browser chromium --no-sandbox --host 0.0.0.0 --port 8931
```

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
