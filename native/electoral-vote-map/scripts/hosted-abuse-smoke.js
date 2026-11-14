// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';

// Operator-run qualification only. Use a temporary credential with a two-request
// daily allowance, after admitting its first request from another edge location.
// Never supply a personal/operator credential or print the supplied secret.
const token = process.env.EVM_QUALIFICATION_TOKEN;
assert.ok(token && /^[A-Za-z0-9._~+/=-]{32,256}$/.test(token), 'Temporary qualification credential required');
const samples = [];
for (const expected of [200, 429]) {
  const response = await fetch('https://electoral.mcpaql.org/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  assert.equal(response.status, expected, 'Unexpected admission status');
  if (expected === 200) assert.deepEqual(body.result?.tools?.map(tool => tool.name), ['mcp_aql_read']);
  else assert.equal(body.error, 'Client daily admission quota exhausted');
  samples.push({ status: response.status, edge_location: response.headers.get('cf-ray')?.match(/-([A-Z]{3})$/)?.[1] ?? 'unknown' });
}
console.log(JSON.stringify({ checked_at: new Date().toISOString(), samples, shared_client_daily_quota: true }));
