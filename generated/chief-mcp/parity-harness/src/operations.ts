// Chief parity operations.
//
// READ operations always run. Write operations run only in write mode
// (CHIEF_PARITY_WRITES=1) against the guarded test project; otherwise they are SKIP.
//
// Creates and send_message are PAIRED_WRITE: each side performs its own write and the
// masked responses are compared. Updates and deletes are ONESHOT_WRITE: the adapter
// performs the write and the official server verifies the effect.

import type { Category, OperationSpec, VerifySpec } from "../../../../../tools/dist/parity-runner.js";
import { RARE_SCHEDULE, TEST_PREFIX, WRITE_MODE, type Fixtures } from "./fixtures.js";

type Op = OperationSpec<Fixtures>;
type Args = Record<string, unknown> | null;

const read = (name: string, args: (f: Fixtures) => Args, category: Category = "TEST_REPO_READ"): Op => ({
  name,
  category,
  args: (f) => args(f),
});

const need = <K extends keyof Fixtures>(f: Fixtures, key: K, build: (v: string) => Record<string, unknown>): Args => {
  const value = f[key];
  return typeof value === "string" && value ? build(value) : null;
};

export const READ_OPERATIONS: Op[] = [
  read("list_projects", () => ({}), "PURE_READ"),
  read("list_chats", () => ({ limit: 5 }), "PURE_READ"),
  read("list_actions", () => ({ limit: 5 }), "PURE_READ"),
  read("list_assets", () => ({ limit: 5 }), "PURE_READ"),
  read("list_labels", () => ({ limit: 5 }), "PURE_READ"),
  read("list_memories", () => ({ limit: 5 }), "PURE_READ"),
  read("list_sessions", () => ({ limit: 5 }), "PURE_READ"),
  read("list_skills", () => ({ limit: 5 }), "PURE_READ"),
  read("list_project_members", (f) => need(f, "projectId", (project_id) => ({ project_id }))),
  read("list_chat_members", (f) => need(f, "chatId", (chat_id) => ({ chat_id }))),
  read("list_messages", (f) => need(f, "chatId", (chat_id) => ({ chat_id }))),
  read("get_chat", (f) => need(f, "chatId", (chat_id) => ({ chat_id }))),
  read("get_share_link", (f) => need(f, "chatId", (chat_id) => ({ chat_id }))),
  read("get_message", (f) => (f.chatId && f.messageId ? { chat_id: f.chatId, message_id: f.messageId } : null)),
  read("get_action", (f) => need(f, "actionId", (action_id) => ({ action_id }))),
  read("get_asset", (f) => need(f, "assetId", (asset_id) => ({ asset_id }))),
  read("get_label", (f) => need(f, "labelId", (label_id) => ({ label_id }))),
  read("get_memory", (f) => need(f, "memoryId", (memory_id) => ({ memory_id }))),
  read("get_session", (f) => need(f, "sessionId", (session_id) => ({ session_id }))),
  read("get_session_transcript", (f) => need(f, "sessionId", (session_id) => ({ session_id, limit: 5 }))),
  read("get_skill", (f) => need(f, "skillId", (skill_id) => ({ skill_id }))),
  read("search_knowledge_base", () => ({ query: "project overview", max_results: 3 }), "PURE_READ"),
];

const paired = (name: string, args: (f: Fixtures, variant: "official" | "mcpaql") => Args): Op => ({
  name,
  category: "PAIRED_WRITE",
  args,
});

const oneshot = (name: string, args: (f: Fixtures) => Args, verify: VerifySpec<Fixtures>): Op => ({
  name,
  category: "ONESHOT_WRITE",
  args: (f) => args(f),
  verify,
});

const skip = (name: string, note: string): Op => ({ name, category: "SKIP", args: () => null, note });

const field = (key: string, expected: (f: Fixtures) => unknown) =>
  (result: { ok: boolean; payload: unknown }, f: Fixtures) => {
    if (!result.ok || !result.payload || typeof result.payload !== "object") return false;
    const payload = result.payload as Record<string, unknown>;
    const record = (Object.values(payload).find((v) => v && typeof v === "object" && !Array.isArray(v) && key in (v as object)) ?? payload) as Record<string, unknown>;
    return record[key] === expected(f);
  };

const OK_PROMPT = "Reply with the single word: ok";

export const WRITE_OPERATIONS: Op[] = [
  // CREATE
  paired("add_chat_member", (f) => (f.chatId && f.memberEmail ? { chat_id: f.chatId, email: f.memberEmail } : null)),
  paired("create_action", (_f, v) => ({ name: `${TEST_PREFIX} ${v} action`, prompt: `${TEST_PREFIX} ${v} prompt`, schedule: RARE_SCHEDULE })),
  paired("create_chat", () => ({ chat: { prompt: OK_PROMPT }, wait_for_response: false })),
  paired("create_label", (_f, v) => ({ name: `${TEST_PREFIX} ${v} label` })),
  paired("create_memory", (_f, v) => ({ content: `${TEST_PREFIX} ${v} memory`, category: "fact", importance: 1 })),
  skip("create_project", "Chief MCP has no delete_project, so created projects cannot be cleaned up"),
  skip("create_project_invitation", "sends a real invitation email"),
  paired("create_share_link", (f) => need(f, "chatId", (chat_id) => ({ chat_id }))),
  paired("create_skill", (_f, v) => ({ name: `${TEST_PREFIX}-${v}-skill`, content: `${TEST_PREFIX} ${v} skill`, scope: "project", category: "skill" })),
  skip("upload_file", "path is resolved on Chief's host; remote HTTP upload is not supported upstream"),

  // UPDATE
  oneshot("attach_label", (f) => (f.assetId && f.labelId ? { asset_id: f.assetId, label_name: `${TEST_PREFIX} label renamed` } : null),
    { name: "get_asset", args: (f) => need(f, "assetId", (asset_id) => ({ asset_id })) }),
  oneshot("detach_label", (f) => (f.assetId && f.labelId ? { asset_id: f.assetId, label_id: f.labelId } : null),
    { name: "get_asset", args: (f) => need(f, "assetId", (asset_id) => ({ asset_id })) }),
  oneshot("disable_action", (f) => need(f, "actionId", (action_id) => ({ action_id })),
    { name: "get_action", args: (f) => need(f, "actionId", (action_id) => ({ action_id })), isExpected: field("enabled", () => false) }),
  oneshot("disable_skill", (f) => need(f, "skillId", (skill_id) => ({ skill_id })),
    { name: "get_skill", args: (f) => need(f, "skillId", (skill_id) => ({ skill_id })) }),
  oneshot("enable_action", (f) => need(f, "actionId", (action_id) => ({ action_id })),
    { name: "get_action", args: (f) => need(f, "actionId", (action_id) => ({ action_id })), isExpected: field("enabled", () => true) }),
  oneshot("enable_skill", (f) => need(f, "skillId", (skill_id) => ({ skill_id })),
    { name: "get_skill", args: (f) => need(f, "skillId", (skill_id) => ({ skill_id })) }),
  oneshot("regenerate_share_link", (f) => need(f, "chatId", (chat_id) => ({ chat_id })),
    { name: "get_share_link", args: (f) => need(f, "chatId", (chat_id) => ({ chat_id })) }),
  oneshot("set_chat_visibility", (f) => need(f, "chatId", (chat_id) => ({ chat_id, visibility: "restricted" })),
    { name: "get_chat", args: (f) => need(f, "chatId", (chat_id) => ({ chat_id })), isExpected: field("visibility", () => "restricted") }),
  oneshot("update_action", (f) => need(f, "actionId", (action_id) => ({ action_id, action: { name: `${TEST_PREFIX} action renamed`, prompt: `${TEST_PREFIX} prompt`, schedule: RARE_SCHEDULE, enabled: false } })),
    { name: "get_action", args: (f) => need(f, "actionId", (action_id) => ({ action_id })), isExpected: field("name", () => `${TEST_PREFIX} action renamed`) }),
  oneshot("update_asset", (f) => need(f, "assetId", (asset_id) => ({ asset_id, description: `${TEST_PREFIX} asset` })),
    { name: "get_asset", args: (f) => need(f, "assetId", (asset_id) => ({ asset_id })) }),
  oneshot("update_chat", (f) => need(f, "chatId", (chat_id) => ({ chat_id, chat: { title: `${TEST_PREFIX} chat` } })),
    // get_chat does not return the title; list_chats does.
    { name: "list_chats", args: () => ({ limit: 100 }), isExpected: (r, f) => r.ok && Array.isArray((r.payload as { data?: unknown[] })?.data)
      && ((r.payload as { data: Array<Record<string, unknown>> }).data).some((c) => c.chat_id === f.chatId && c.title === `${TEST_PREFIX} chat`) }),
  oneshot("update_label", (f) => need(f, "labelId", (label_id) => ({ label_id, label: { name: `${TEST_PREFIX} label renamed` } })),
    { name: "get_label", args: (f) => need(f, "labelId", (label_id) => ({ label_id })), isExpected: field("name", () => `${TEST_PREFIX} label renamed`) }),
  oneshot("update_memory", (f) => need(f, "memoryId", (memory_id) => ({ memory_id, memory: { content: `${TEST_PREFIX} memory updated` } })),
    { name: "get_memory", args: (f) => need(f, "memoryId", (memory_id) => ({ memory_id })), isExpected: field("content", () => `${TEST_PREFIX} memory updated`) }),
  oneshot("update_project", (f) => (f.projectId && f.projectName ? { project_id: f.projectId, project: { name: f.projectName, description: f.projectDescription ?? "" } } : null),
    { name: "list_projects", args: () => ({}) }),
  skip("update_session", "sessions come from Chief's recorder and cannot be created through MCP"),
  oneshot("update_skill", (f) => need(f, "skillId", (skill_id) => ({ skill_id, skill: { description: `${TEST_PREFIX} skill updated` } })),
    { name: "get_skill", args: (f) => need(f, "skillId", (skill_id) => ({ skill_id })), isExpected: field("description", () => `${TEST_PREFIX} skill updated`) }),

  // DELETE
  oneshot("delete_action", (f) => need(f, "actionId", (action_id) => ({ action_id })),
    { name: "get_action", args: (f) => need(f, "actionId", (action_id) => ({ action_id })), expect: "error" }),
  skip("delete_asset", "no asset can be created through remote MCP (see upload_file)"),
  oneshot("delete_chat", (f) => need(f, "deleteChatId", (chat_id) => ({ chat_id })),
    { name: "get_chat", args: (f) => need(f, "deleteChatId", (chat_id) => ({ chat_id })), expect: "error" }),
  oneshot("delete_label", (f) => need(f, "labelId", (label_id) => ({ label_id })),
    { name: "get_label", args: (f) => need(f, "labelId", (label_id) => ({ label_id })), expect: "error" }),
  oneshot("delete_memory", (f) => need(f, "memoryId", (memory_id) => ({ memory_id })),
    { name: "get_memory", args: (f) => need(f, "memoryId", (memory_id) => ({ memory_id })), expect: "error" }),
  oneshot("delete_message", (f) => (f.chatId && f.messageId ? { chat_id: f.chatId, message_id: f.messageId } : null),
    { name: "get_message", args: (f) => (f.chatId && f.messageId ? { chat_id: f.chatId, message_id: f.messageId } : null), expect: "error" }),
  skip("delete_project_invitation", "paired with create_project_invitation, which sends email"),
  skip("delete_session", "sessions come from Chief's recorder; never delete a real one"),
  oneshot("delete_share_link", (f) => need(f, "chatId", (chat_id) => ({ chat_id })),
    // After revocation Chief answers get_share_link successfully with is_shared: false.
    { name: "get_share_link", args: (f) => need(f, "chatId", (chat_id) => ({ chat_id })), isExpected: field("is_shared", () => false) }),
  oneshot("delete_skill", (f) => need(f, "skillId", (skill_id) => ({ skill_id })),
    { name: "get_skill", args: (f) => need(f, "skillId", (skill_id) => ({ skill_id })), expect: "error" }),
  oneshot("remove_chat_member", (f) => (f.chatId && f.memberUserId ? { chat_id: f.chatId, user_id: f.memberUserId } : null),
    { name: "list_chat_members", args: (f) => need(f, "chatId", (chat_id) => ({ chat_id })) }),

  // EXECUTE
  paired("send_message", (f) => need(f, "chatId", (chat_id) => ({ chat_id, message: { prompt: OK_PROMPT }, wait_for_response: false }))),
];

const READ_ONLY_NOTE = "write op not exercised: read-only mode (set CHIEF_PARITY_WRITES=1 against the test project)";

export const OPERATIONS: Op[] = [
  ...READ_OPERATIONS,
  ...(WRITE_MODE
    ? WRITE_OPERATIONS
    : WRITE_OPERATIONS.map((op): Op => ({ name: op.name, category: "SKIP", args: () => null, note: op.category === "SKIP" ? op.note : READ_ONLY_NOTE }))),
];
