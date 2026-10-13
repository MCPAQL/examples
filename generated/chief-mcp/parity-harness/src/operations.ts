// Chief parity operations. All 22 READ operations run against both the official server
// and the adapter. Writes are SKIP by default: the suite runs against a live account,
// so it never creates, changes, or deletes anything there.

import type { Category, OperationSpec } from "../../../../../tools/dist/parity-runner.js";
import type { Fixtures } from "./fixtures.js";

type Op = OperationSpec<Fixtures>;

const read = (name: string, args: (f: Fixtures) => Record<string, unknown> | null, category: Category = "TEST_REPO_READ"): Op => ({
  name,
  category,
  args: (f) => args(f),
});

const need = <K extends keyof Fixtures>(f: Fixtures, key: K, build: (v: string) => Record<string, unknown>) => {
  const value = f[key];
  return value ? build(value) : null;
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

const WRITE_NOTE = "write op not exercised: suite is read-only against a live Chief account";

export const WRITE_OPERATION_NAMES = [
  "add_chat_member", "create_action", "create_chat", "create_label", "create_memory", "create_project",
  "create_project_invitation", "create_share_link", "create_skill", "upload_file",
  "attach_label", "detach_label", "disable_action", "disable_skill", "enable_action", "enable_skill",
  "regenerate_share_link", "set_chat_visibility", "update_action", "update_asset", "update_chat",
  "update_label", "update_memory", "update_project", "update_session", "update_skill",
  "delete_action", "delete_asset", "delete_chat", "delete_label", "delete_memory", "delete_message",
  "delete_project_invitation", "delete_session", "delete_share_link", "delete_skill", "remove_chat_member",
  "send_message",
];

export const OPERATIONS: Op[] = [
  ...READ_OPERATIONS,
  ...WRITE_OPERATION_NAMES.map((name): Op => ({ name, category: "SKIP", args: () => null, note: WRITE_NOTE })),
];
