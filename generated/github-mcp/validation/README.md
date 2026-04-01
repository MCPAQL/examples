# Validation Reports

This directory stores the saved validation outputs for the generated GitHub MCP adapter.

- `conformance-report.json` checks that the generated adapter exposes the expected MCP-AQL tool surface and that its request, result, and introspection envelopes validate against the current spec schemas.
- `differential-report.json` compares the generated adapter's introspection surface to the captured GitHub MCP discovery bundle and finalized adapter schema.

## Notes

- `adapter_operation_count` is expected to be one higher than `source_operation_count` because the generated adapter injects a synthetic `introspect` operation.
- `missing_operations` and `extra_operations` intentionally exclude that synthetic `introspect` operation so the parity report focuses on wrapped upstream behavior.

## Re-running

From `generated/github-mcp/`, regenerate the saved reports with:

```bash
node ../../../tools/dist/conformance-cli.js --command node --args "[\"dist/server.js\"]" --cwd adapter --schema-root ../../../spec/schemas > validation/conformance-report.json
node ../../../tools/dist/diff-cli.js --bundle capture/discovery-bundle.json --schema schema/adapter-schema.json --command node --args "[\"dist/server.js\"]" --cwd adapter > validation/differential-report.json
```
