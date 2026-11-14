#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAdapter } from './adapter.js';
import { createSiteClient } from './site.js';
import { createPollingClient } from './polling.js';
import { createMcpServer } from './mcp.js';
import { readTransportConfig, startHttpServer } from './http.js';

try {
  const config = readTransportConfig(process.env, process.argv.slice(2));
  // Explicit fixture switches are for deterministic tests; all results label that mode.
  const fixtureHtml = process.env.EVM_TEST_FIXTURE ? await readFile(process.env.EVM_TEST_FIXTURE, 'utf8') : undefined;
  const fixtureCsv = process.env.EVM_POLL_TEST_FIXTURE ? await readFile(process.env.EVM_POLL_TEST_FIXTURE, 'utf8') : undefined;
  const dispatch = createAdapter({ loadSite: createSiteClient({ fixtureHtml }), loadPolling: createPollingClient({ fixtureCsv }) });
  const running = config.transport === 'stdio'
    ? createMcpServer(dispatch)
    : await startHttpServer({ dispatch, ...config });
  if (config.transport === 'stdio') await running.connect(new StdioServerTransport());
  else console.error(`Electoral Vote Map MCP listening on ${running.url}`);
  const shutdown = () => { void running.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(`Electoral Vote Map startup failed: ${error.message}`);
  process.exitCode = 1;
}
