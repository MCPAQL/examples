# Playwright MCP

Generated MCP-AQL adapter package for the official Playwright MCP server.

## What This Package Is

This package is a local MCP-AQL adapter that runs over `stdio`.

It is designed to sit between:

- your MCP client, which launches this adapter locally
- an upstream Playwright MCP server, which this generated adapter connects to over HTTP at `http://localhost:8931/mcp`

## Adapter Shape

- Upstream Playwright MCP tools captured: `21`
- Registered MCP-AQL endpoint tools: `2`
- Wrapped upstream operations: `21`
- Synthetic adapter operation: `1` (`introspect`)

This adapter currently exposes a `CRUDE` endpoint surface only:

- `READ`
- `EXECUTE`

In this documentation, `CRUDE` means `Create`, `Read`, `Update`, `Delete`, and `Execute`.

For the current Playwright capture there are no generated `CREATE`, `UPDATE`, or `DELETE` endpoint buckets. That does not mean Playwright lacks state-changing actions. The source tool surface is dominated by read-only inspection plus browser-interaction workflows, so the first-pass adapter groups it into `READ` and `EXECUTE`.

The upstream Playwright MCP URL is configurable per launch with `MCPAQL_TARGET_BASE_URL`, or by editing the generated runtime schema at `src/schema.json`.

Additional companion files in this package:

- [surface-summary.json](./surface-summary.json) - counts plus rough context-size estimates
- [OPERATION-GUIDE.md](./OPERATION-GUIDE.md) - human-oriented operation and introspection summary

## Quick Start

1. Start the upstream Playwright MCP server in HTTP mode (see [../README.md](../README.md#starting-the-source-server) for the Docker command).
2. Install dependencies in this directory.
3. Build the adapter.
4. Point your MCP client at `dist/server.js`.

```bash
npm install
npm run build
node dist/server.js
```

To point the adapter at a different upstream Playwright MCP server for a one-off run:

```bash
MCPAQL_TARGET_BASE_URL=http://your-host:8931/mcp node dist/server.js
```

Example client config shape:

Replace the `args` path below with the absolute path to this repository on your machine.

```json
{
  "mcpServers": {
    "playwright-mcpaql": {
      "command": "node",
      "args": [
        "/absolute/path/to/generated/playwright-mcp/adapter/dist/server.js"
      ]
    }
  }
}
```

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
