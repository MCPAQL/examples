# GitHub MCP-AQL Parity Suite

This directory is a **suite** for the generic `mcpaql-parity` test runner (in `@mcpaql/tools`). It defines:

- `src/operations.ts` — the 89 operations to test, each with an argument builder
- `src/fixtures.ts` — throwaway-repo setup and teardown (creates issues, PRs, branches, gists, etc.)
- `src/suite.ts` — wraps the above into a `Suite<Fixtures>` exported as `suite` and the default export

## Running

```bash
# Build the suite
npm install && npm run build

# Run parity against the default-toolset (44-op) adapter
GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) npm run parity:default

# Run parity against the all-toolsets (89-op) adapter
GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) npm run parity:all
```

Or invoke the CLI directly:

```bash
mcpaql-parity \
  --suite ./dist/suite.js \
  --adapter ../../github-mcp-all/adapter/dist/server.js \
  --report parity-all.json
```

## Writing your own suite

A suite is any JS module that exports an object matching the `Suite<F>` interface from `@mcpaql/tools`:

```ts
import type { Suite } from "@mcpaql/tools";

interface MyFixtures { /* whatever your operations need */ }

export const suite: Suite<MyFixtures> = {
  name: "my-server",
  upstreamUrl: "https://example.com/mcp/",
  upstreamHeaders: { "X-Optional-Header": "value" }, // optional
  tokenEnv: "MY_TOKEN",                              // env var holding the bearer token
  operations: [
    { name: "get_me", category: "PURE_READ", args: () => ({}) },
    // ...
  ],
  setupFixtures: async () => ({ /* … */ }),
  teardownFixtures: async (fixtures) => { /* … */ },
};
```

The runner reads the operations list from the **adapter's bundled `schema.json`**, then looks each up in your suite's `operations` array. Any operation the adapter exposes that your suite doesn't cover surfaces as `SKIPPED: "no suite arg builder"` in the report — so the harness cannot silently hide gaps.

For categories, fixture timing, and classification semantics, see `tools/src/parity-runner.ts`.
