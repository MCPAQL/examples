// Diagnostic: compare what the upstream MCP server returns with vs without the
// X-MCP-Toolsets header. Run with: GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) node probe-toolsets.mjs
// Useful when investigating "why is the adapter missing operations" against
// header-gated upstreams. Not part of the parity harness itself.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const token = (await exec("gh", ["auth", "token"])).stdout.trim();

async function probe(headers, label) {
  const t = new StreamableHTTPClientTransport(new URL("https://api.githubcopilot.com/mcp/"), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
  });
  const c = new Client({ name: "probe", version: "0" });
  await c.connect(t);
  const r = await c.listTools();
  console.log(`${label}: ${r.tools.length} tools`);
  await c.close();
  return r.tools.map((t) => t.name);
}

const baseline = await probe({}, "no headers (default)");
const withAll = await probe({ "X-MCP-Toolsets": "all" }, "X-MCP-Toolsets: all");
const onlyInAll = withAll.filter((n) => !baseline.includes(n));
console.log(`\nDelta when toolsets=all: +${onlyInAll.length} tools`);
console.log("Sample:", onlyInAll.slice(0, 30).join(", "));
