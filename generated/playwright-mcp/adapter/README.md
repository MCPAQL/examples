# Playwright MCP

Generated MCP-AQL adapter package for the official Playwright MCP server.

## What This Package Is

This package is a local MCP-AQL adapter that runs over `stdio`.

It is designed to sit between:

- your MCP client, which launches this adapter locally
- an upstream Playwright MCP server, which this generated adapter connects to over HTTP at `http://localhost:8931/mcp`

See [../README.md](../README.md#starting-the-source-server) for the Docker command that starts the upstream Playwright MCP HTTP server.

## Quick Start

1. Start the upstream Playwright MCP server in HTTP mode.
2. Install dependencies in this directory.
3. Build the adapter.
4. Point your MCP client at `dist/server.js`.

```bash
npm install
npm run build
node dist/server.js
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

## Surface Summary

- Upstream Playwright MCP tools captured: `21`
- Registered adapter endpoint tools: `2`
- Wrapped upstream operations: `21`
- Synthetic adapter operation: `1` (`introspect`)
- Endpoint shape: CRUDE only

Additional companion files in this package:

- [surface-summary.json](./surface-summary.json) - counts plus rough context-size estimates
- [OPERATION-GUIDE.md](./OPERATION-GUIDE.md) - human-oriented operation and introspection summary

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
