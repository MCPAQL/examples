// Chief-specific Suite for the generic @mcpaql/tools parity runner.
//
// The adapter schema carries X-Project-Id as "${env:CHIEF_PROJECT_ID}"; the runner
// resolves it from the environment for the official side, and the adapter resolves it
// itself at connect time.

import type { Suite } from "../../../../../tools/dist/parity-runner.js";
import { OPERATIONS } from "./operations.js";
import { CHIEF_URL, setupFixtures, teardownFixtures, type Fixtures } from "./fixtures.js";

export const suite: Suite<Fixtures> = {
  name: "chief-mcp",
  upstreamUrl: CHIEF_URL,
  // The official side always needs the project header. The project-aware adapter
  // (chief-mcp-projects) has no static header, so the suite supplies it.
  upstreamHeaders: { "X-Project-Id": "${env:CHIEF_PROJECT_ID}" },
  tokenEnv: "CHIEF_API_KEY",
  operations: OPERATIONS,
  setupFixtures,
  teardownFixtures,
};

export default suite;
