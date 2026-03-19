# GitHub MCP Golden Path

This directory contains the first end-to-end MCP server -> MCP-AQL adapter pipeline output for the official GitHub MCP server.

Expected artifacts:

- `server-config.json` - source MCP connection config used by `mcpaql-interrogate`
- `capture/` - raw and normalized discovery artifacts
- `schema/` - generated MCP-AQL adapter schema and provenance sidecars
- `adapter/` - generated runnable TypeScript MCP-AQL adapter package
- `validation/` - saved conformance and differential validation reports

The generated outputs are intended to be reproducible from the committed config plus a valid GitHub token.

## Artifact Notes

- `capture/warnings.json` is the capture-time warning list emitted during interrogation and normalization.
- `schema/schema-build-report.json` intentionally carries those warnings forward alongside the schema-builder operation summary so reviewers can see both the original warnings and the reviewed output in one place.
- `capture/capture-metadata.json` records the upstream GitHub MCP server identity observed during capture. When that upstream server revision changes, this golden-path example should be refreshed.
- The current saved capture reflects the GitHub MCP server observed on `2026-03-19`, including the newly surfaced `run_secret_scanning` tool. Expect operation counts and warnings to move when the upstream server changes.

## Known Limitations

- The generated adapter keeps a singleton upstream connection and currently expects a restart if that upstream connection is dropped.
- This example is intentionally saved as a point-in-time artifact. If GitHub changes its MCP surface, the checked-in capture, schema, and validation reports should be regenerated together.

## Regenerating

From this directory, rebuild the pipeline with:

```bash
cd ../../../tools
npm run build

cd ../adapter-generator
npm run build

cd ../examples/generated/github-mcp
export GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token)

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
