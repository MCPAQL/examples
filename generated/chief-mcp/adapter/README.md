# Chief MCP

Generated MCP-AQL adapter package for the Chief MCP server (mcp.chief.bot).

## Supported Endpoints

- READ: get_action, get_asset, get_chat, get_label, get_memory, get_message, get_session, get_session_transcript, get_share_link, get_skill, list_actions, list_assets, list_chat_members, list_chats, list_labels, list_memories, list_messages, list_project_members, list_projects, list_sessions, list_skills, search_knowledge_base
- CREATE: add_chat_member, create_action, create_chat, create_label, create_memory, create_project, create_project_invitation, create_share_link, create_skill, upload_file
- UPDATE: attach_label, detach_label, disable_action, disable_skill, enable_action, enable_skill, regenerate_share_link, set_chat_visibility, update_action, update_asset, update_chat, update_label, update_memory, update_project, update_session, update_skill
- DELETE: delete_action, delete_asset, delete_chat, delete_label, delete_memory, delete_message, delete_project_invitation, delete_session, delete_share_link, delete_skill, remove_chat_member
- EXECUTE: send_message

## Running

Requires Node.js 20 or newer.

Set `MCPAQL_TARGET_BASE_URL` if you want this adapter to connect to a different upstream server than the bundled `https://mcp.chief.bot/mcp`.

Set `CHIEF_API_KEY` and run:

Also set:

- `CHIEF_PROJECT_ID` (required): sent as the `X-Project-Id` header.

```bash
npm install
npm run start
```
