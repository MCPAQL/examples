// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real MCP stdio handshake, discovery, scenario change and errors', async () => {
  const client = new Client({ name: 'electoral-demo-test', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))], env: { ...process.env, EVM_TEST_FIXTURE: fileURLToPath(new URL('./fixtures/site.html', import.meta.url)) }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['mcp_aql_read']);
    assert.equal(tools[0].annotations.readOnlyHint, true);
    assert.match(tools[0].description, /introspect/);
    const invoke = async (operation, params = {}) => client.callTool({ name: 'mcp_aql_read', arguments: { operation, params } });
    const intro = await invoke('introspect');
    assert.equal(intro.structuredContent.success, true);
    const catalog = await invoke('list_scenarios');
    assert.equal(catalog.structuredContent.data.scenarios.length, 7);
    const changed = await invoke('modify_map', { scenario_id: 'blue-wall', edits: [{ unit: 'MA', flip: true }] });
    assert.equal(changed.structuredContent.data.map.totals.rep, 279);
    assert.match(changed.structuredContent.data.map.map_url, /^https:\/\/electoralvotemap.com\/\?map=2028:/);
    const invalid = await invoke('get_map', { arbitrary: 'not allowed' });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, 'VALIDATION_UNKNOWN_PARAM');
  } finally { await transport.close(); }
});
