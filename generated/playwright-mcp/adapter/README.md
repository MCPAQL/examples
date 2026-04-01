# Playwright MCP

Generated MCP-AQL adapter package for the official Playwright MCP server.

## Adapter Shape

- Upstream Playwright MCP tools captured: `21`
- Registered MCP-AQL endpoint tools: `2`
- Wrapped upstream operations: `21`
- Synthetic adapter operation: `1` (`introspect`)

This adapter currently exposes a `CRUDE` endpoint surface only:

- `READ`
- `EXECUTE`

In this documentation, `CRUDE` means `Create`, `Read`, `Update`, `Delete`, and `Execute`.

For the current Playwright capture there are no generated `CREATE`, `UPDATE`, or `DELETE` endpoint buckets. The source tool surface is dominated by read-only inspection plus browser-interaction workflows, so the first-pass adapter groups it into `READ` and `EXECUTE`.

The upstream Playwright MCP URL is configurable in the generated runtime schema at `src/schema.json`.

## Supported Endpoints

- READ: browser_console_messages, browser_network_requests, browser_snapshot
- EXECUTE: browser_close, browser_resize, browser_handle_dialog, browser_evaluate, browser_file_upload, browser_fill_form, browser_install, browser_press_key, browser_type, browser_navigate, browser_navigate_back, browser_take_screenshot, browser_click, browser_drag, browser_hover, browser_select_option, browser_tabs, browser_wait_for

## Running

Requires Node.js 20 or newer.

Run:

```bash
npm install
npm run build
node dist/server.js
```
