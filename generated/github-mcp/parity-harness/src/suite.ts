// GitHub-specific Suite that wraps this directory's operations + fixtures
// for the generic @mcpaql/tools parity runner.
//
// Usage from the project root:
//   mcpaql-parity --suite examples/generated/github-mcp/parity-harness/dist/suite.js \
//                 --adapter examples/generated/github-mcp-all/adapter/dist/server.js \
//                 --report parity-all.json

import type { Suite } from "../../../../../tools/dist/parity-runner.js";
import { OPERATIONS, type Fixtures } from "./operations.js";
import { setupFixtures, teardownFixtures } from "./fixtures.js";

const owner = process.env.GH_TEST_OWNER || "mickdarling";
const testOrg = process.env.GH_TEST_ORG || "DollhouseMCP";

export const suite: Suite<Fixtures> = {
  name: "github-mcp",
  upstreamUrl: "https://api.githubcopilot.com/mcp/",
  // upstreamHeaders may be overridden by the adapter's bundled schema.json — the runner
  // prefers schema.headers when present so the official side matches the toolset surface
  // the adapter was generated against.
  upstreamHeaders: { "X-MCP-Toolsets": "all" },
  tokenEnv: "GITHUB_PERSONAL_ACCESS_TOKEN",
  operations: OPERATIONS,
  setupFixtures: () => setupFixtures({
    owner,
    publicOwner: "octocat",
    publicRepo: "Hello-World",
    testOrg,
  }),
  teardownFixtures,
};

export default suite;
