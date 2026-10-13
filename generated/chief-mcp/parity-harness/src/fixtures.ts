// Read-only fixture discovery for the Chief parity suite. Every call here is a list
// or get against the account under test; nothing is created, changed, or deleted.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CHIEF_URL = "https://mcp.chief.bot/mcp";

export interface Fixtures {
  projectId?: string;
  chatId?: string;
  messageId?: string;
  actionId?: string;
  assetId?: string;
  labelId?: string;
  memoryId?: string;
  sessionId?: string;
  skillId?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Env var ${name} is required.`);
  return value;
}

// Most Chief list results return `data` keyed by a typed id (chat_id, action_id, ...);
// list_messages returns `messages` keyed by plain `id`.
async function firstId(
  client: Client,
  tool: string,
  idKey: string,
  args: Record<string, unknown> = {},
  listKey = "data",
): Promise<string | undefined> {
  const result = await client.callTool({ name: tool, arguments: { ...args } });
  if (result.isError) return undefined;
  const structured = result.structuredContent as Record<string, Array<Record<string, unknown>> | undefined> | undefined;
  const value = structured?.[listKey]?.[0]?.[idKey];
  return typeof value === "string" ? value : undefined;
}

export async function setupFixtures(): Promise<Fixtures> {
  const client = new Client({ name: "chief-parity-fixtures", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(CHIEF_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${requireEnv("CHIEF_API_KEY")}`,
        "X-Project-Id": requireEnv("CHIEF_PROJECT_ID"),
      },
    },
  });
  await client.connect(transport);
  try {
    const fixtures: Fixtures = { projectId: process.env.CHIEF_PROJECT_ID };
    fixtures.chatId = await firstId(client, "list_chats", "chat_id", { limit: 1 });
    if (fixtures.chatId) fixtures.messageId = await firstId(client, "list_messages", "id", { chat_id: fixtures.chatId }, "messages");
    fixtures.actionId = await firstId(client, "list_actions", "action_id", { limit: 1 });
    fixtures.assetId = await firstId(client, "list_assets", "asset_id", { limit: 1 });
    fixtures.labelId = await firstId(client, "list_labels", "label_id", { limit: 1 });
    fixtures.memoryId = await firstId(client, "list_memories", "memory_id", { limit: 1 });
    fixtures.sessionId = await firstId(client, "list_sessions", "session_id", { limit: 1 });
    fixtures.skillId = await firstId(client, "list_skills", "skill_id", { limit: 1 });
    const found = Object.entries(fixtures).filter(([, v]) => v).map(([k]) => k);
    console.log(`[chief-mcp] fixtures discovered: ${found.join(", ") || "none"}`);
    return fixtures;
  } finally {
    await client.close();
  }
}

export async function teardownFixtures(): Promise<void> {
  // Nothing to clean up: fixtures are discovered, never created.
}
