// Fixtures for the Chief parity suite.
//
// Read-only mode (default): ids are discovered through list calls; nothing is changed.
// Write mode (CHIEF_PARITY_WRITES=1): the suite creates its own records in a dedicated
// test project and deletes them in teardown. It refuses to run unless the configured
// project's name matches CHIEF_PARITY_PROJECT_NAME (default "MCPAQL Testing").

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CHIEF_URL = "https://mcp.chief.bot/mcp";
export const WRITE_MODE = process.env.CHIEF_PARITY_WRITES === "1";

// Set only by setupFixtures after the project guard passes in this process. Write
// operations check it, so reused fixture files (--reuse-fixtures) cannot bypass the guard.
let guardPassed = false;
export function writeGuardPassed(): boolean {
  return guardPassed;
}
export const TEST_PREFIX = "mcpaql-parity";

// Chief requires a schedule or trigger on every action. This one fires at most on the
// 31st at 03:00 UTC; the suite disables or deletes every action it creates within minutes.
// Chief's upload_file opens the path on Chief's own host, so assets cannot be created over
// remote MCP. Upload these two files to the test project through the web app instead:
// the first is kept across runs, the second is deleted by delete_asset (re-upload to retest).
export const FIXTURE_ASSET = `${"mcpaql-parity"}-fixture.txt`;
export const DISPOSABLE_ASSET = `${"mcpaql-parity"}-disposable.txt`;

export const RARE_SCHEDULE = { hour: "3", weekday: "*", month_day: "31", timezone: "UTC" };

export interface Fixtures {
  writeMode: boolean;
  projectId?: string;
  projectName?: string;
  projectDescription?: string;
  memberEmail?: string;
  memberUserId?: string;
  chatId?: string;
  messageId?: string;
  deleteChatId?: string;
  actionId?: string;
  assetId?: string;
  disposableAssetId?: string;
  labelId?: string;
  memoryId?: string;
  sessionId?: string;
  skillId?: string;
}

type Structured = Record<string, unknown>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Env var ${name} is required.`);
  return value;
}

async function connect(): Promise<Client> {
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
  return client;
}

async function call(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<Structured> {
  const result = await client.callTool({ name: tool, arguments: args });
  if (result.isError) {
    const text = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "unknown error";
    throw new Error(`${tool} failed: ${text}`);
  }
  return (result.structuredContent ?? {}) as Structured;
}

function list(structured: Structured, key = "data"): Array<Record<string, unknown>> {
  const value = structured[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Create responses carry the new id either at the top level or one object down.
function idOf(structured: Structured, key: string): string | undefined {
  const direct = str(structured[key]);
  if (direct) return direct;
  for (const value of Object.values(structured)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = str((value as Structured)[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

// Follows Chief's cursor pagination (has_more + last_id -> after_id).
async function listAll(client: Client, tool: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let afterId: string | undefined;
  for (let page = 0; page < 50; page++) {
    const structured = await call(client, tool, { limit: 100, ...(afterId ? { after_id: afterId } : {}) });
    out.push(...list(structured));
    afterId = str(structured.last_id);
    if (structured.has_more !== true || !afterId) break;
  }
  return out;
}

// Most Chief list results return `data` keyed by a typed id (chat_id, action_id, ...);
// list_messages returns `messages` keyed by plain `id`.
async function firstId(client: Client, tool: string, idKey: string, args: Record<string, unknown> = {}, listKey = "data") {
  try {
    return str(list(await call(client, tool, args), listKey)[0]?.[idKey]);
  } catch {
    return undefined;
  }
}

async function guardTestProject(client: Client, fixtures: Fixtures): Promise<void> {
  const expected = process.env.CHIEF_PARITY_PROJECT_NAME ?? "MCPAQL Testing";
  const project = list(await call(client, "list_projects")).find((p) => p.project_id === fixtures.projectId);
  if (!project || project.name !== expected) {
    throw new Error(`Write mode refused: CHIEF_PROJECT_ID is not the "${expected}" project.`);
  }
  fixtures.projectName = str(project.name);
  fixtures.projectDescription = str(project.description) ?? "";
}

async function discover(client: Client, fixtures: Fixtures): Promise<void> {
  fixtures.chatId ??= await firstId(client, "list_chats", "chat_id", { limit: 1 });
  if (fixtures.chatId) fixtures.messageId ??= await firstId(client, "list_messages", "id", { chat_id: fixtures.chatId }, "messages");
  fixtures.actionId ??= await firstId(client, "list_actions", "action_id", { limit: 1 });
  fixtures.assetId ??= await firstId(client, "list_assets", "asset_id", { limit: 1 });
  fixtures.labelId ??= await firstId(client, "list_labels", "label_id", { limit: 1 });
  fixtures.memoryId ??= await firstId(client, "list_memories", "memory_id", { limit: 1 });
  fixtures.sessionId ??= await firstId(client, "list_sessions", "session_id", { limit: 1 });
  fixtures.skillId ??= await firstId(client, "list_skills", "skill_id", { limit: 1 });
}

async function createWriteFixtures(client: Client, fixtures: Fixtures): Promise<void> {
  const members = list(await call(client, "list_project_members", { project_id: fixtures.projectId }));
  fixtures.memberEmail = str(members[0]?.email);
  fixtures.memberUserId = str(members[0]?.user_id);

  fixtures.labelId = idOf(await call(client, "create_label", { name: `${TEST_PREFIX} label` }), "label_id");
  fixtures.memoryId = idOf(await call(client, "create_memory", {
    content: `${TEST_PREFIX} memory`, category: "fact", importance: 1,
  }), "memory_id");
  fixtures.skillId = idOf(await call(client, "create_skill", {
    name: `${TEST_PREFIX}-skill`, content: `${TEST_PREFIX} skill body`, scope: "project", category: "skill",
  }), "skill_id");
  fixtures.actionId = idOf(await call(client, "create_action", {
    name: `${TEST_PREFIX} action`, prompt: `${TEST_PREFIX} action prompt`, schedule: RARE_SCHEDULE,
  }), "action_id");
  await call(client, "disable_action", { action_id: fixtures.actionId });

  // Chats run a model turn each; keep them to two plus the suite's own sends.
  const chat = await call(client, "create_chat", {
    chat: { prompt: "Reply with the single word: ok" }, wait_for_response: true, timeout_seconds: 120,
  });
  fixtures.chatId = idOf(chat, "chat_id");
  await call(client, "set_chat_visibility", { chat_id: fixtures.chatId, visibility: "restricted" });
  const second = await call(client, "create_chat", {
    chat: { prompt: "Reply with the single word: ok" }, wait_for_response: false,
  });
  fixtures.deleteChatId = idOf(second, "chat_id");
  fixtures.messageId = await firstId(client, "list_messages", "id", { chat_id: fixtures.chatId }, "messages");

  const assets = await listAll(client, "list_assets");
  fixtures.assetId = str(assets.find((a) => a.filename === FIXTURE_ASSET)?.asset_id);
  fixtures.disposableAssetId = str(assets.find((a) => a.filename === DISPOSABLE_ASSET)?.asset_id);
}

export async function setupFixtures(): Promise<Fixtures> {
  const client = await connect();
  try {
    const fixtures: Fixtures = { writeMode: WRITE_MODE, projectId: process.env.CHIEF_PROJECT_ID };
    if (WRITE_MODE) {
      // The project-aware adapter picks its project from CHIEF_PROJECT; it must be the guarded one.
      const adapterProject = process.env.CHIEF_PROJECT;
      if (adapterProject && adapterProject !== fixtures.projectId) {
        throw new Error("Write mode refused: CHIEF_PROJECT differs from CHIEF_PROJECT_ID.");
      }
      await guardTestProject(client, fixtures);
      // Clear anything an interrupted earlier run left behind.
      await teardownFixtures(fixtures);
      try {
        await createWriteFixtures(client, fixtures);
      } catch (error) {
        await teardownFixtures(fixtures);
        throw error;
      }
      guardPassed = true;
    }
    await discover(client, fixtures);
    const found = Object.entries(fixtures).filter(([k, v]) => v && k !== "writeMode").map(([k]) => k);
    console.log(`[chief-mcp] ${WRITE_MODE ? "write" : "read-only"} mode; fixtures: ${found.join(", ") || "none"}`);
    return fixtures;
  } finally {
    await client.close();
  }
}

// Write mode only. Deletes everything the suite could have created: records whose name
// or content carries TEST_PREFIX, and every chat in the guarded test project (chat titles
// are model-generated, so they cannot be matched by prefix).
export async function teardownFixtures(fixtures: Fixtures): Promise<void> {
  if (!fixtures.writeMode) return;
  const client = await connect();
  const failures: string[] = [];
  const attempt = async (tool: string, args: Record<string, unknown>) => {
    try {
      await call(client, tool, args);
    } catch (e) {
      failures.push((e as Error).message);
    }
  };
  try {
    await guardTestProject(client, { ...fixtures });
    const has = (r: Record<string, unknown>, ...keys: string[]) => keys.some((k) => String(r[k] ?? "").includes(TEST_PREFIX));
    for (const r of await listAll(client, "list_labels")) if (has(r, "name")) await attempt("delete_label", { label_id: r.label_id });
    for (const r of await listAll(client, "list_memories")) if (has(r, "content")) await attempt("delete_memory", { memory_id: r.memory_id });
    for (const r of await listAll(client, "list_skills")) if (has(r, "name", "content")) await attempt("delete_skill", { skill_id: r.skill_id });
    for (const r of await listAll(client, "list_actions")) if (has(r, "name")) await attempt("delete_action", { action_id: r.action_id });
    for (const r of await listAll(client, "list_chats")) await attempt("delete_chat", { chat_id: r.chat_id });
    if (fixtures.projectName) {
      await attempt("update_project", {
        project_id: fixtures.projectId,
        project: { name: fixtures.projectName, description: fixtures.projectDescription ?? "" },
      });
    }
    console.log(`[chief-mcp] teardown complete${failures.length ? ` with ${failures.length} failure(s)` : ""}`);
    for (const f of failures) console.warn(`[chief-mcp] teardown: ${f}`);
  } finally {
    await client.close();
  }
}
