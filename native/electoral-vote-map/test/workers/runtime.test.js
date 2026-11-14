// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const html = await readFile(new URL('../fixtures/site.html', import.meta.url), 'utf8');
const csv = await readFile(new URL('../fixtures/polling.csv', import.meta.url), 'utf8');
const tokenA = 'test-alice-'.padEnd(48, 'a'), tokenB = 'test-bob-'.padEnd(48, 'b');
const bindings = {
  EVM_ENABLED: 'true', EVM_PUBLIC_ORIGIN: 'https://electoral.example', EVM_ALLOW_ANONYMOUS: 'false',
  EVM_CLIENT_TOKENS: JSON.stringify({ alice: tokenA, bob: tokenB }),
};
async function runtime(t, { vars = {}, persist, outbound, edgeLimit = 10_000 } = {}) {
  const requests = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'electoral-runtime-test', modules: true, scriptPath: fileURLToPath(new URL('../../.worker-build/worker.js', import.meta.url)),
    compatibilityDate: '2026-11-13', compatibilityFlags: ['nodejs_compat'], cf: false, port: 0,
    bindings: { ...bindings, ...vars },
    durableObjects: { ELECTORAL_COORDINATOR: { className: 'ElectoralCoordinator', useSQLite: true } },
    ...(persist ? { resourcePersistencePath: persist } : {}),
    ratelimits: { MCP_RATE_LIMITER: { namespace_id: '7201', simple: { limit: edgeLimit, period: 60 } } },
    outboundService: async request => {
      requests.push({ url: request.url, authorization: request.headers.get('authorization'), cookie: request.headers.get('cookie') });
      if (outbound) return outbound(request);
      return new RuntimeResponse(request.url === 'https://electoralvotemap.com/' ? html : csv);
    },
  }));
  t.after(() => mf.dispose());
  await mf.ready;
  const fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', '192.0.2.1');
    return mf.dispatchFetch(String(url), { ...init, headers });
  };
  const rpc = (method, params = {}, token = tokenA) => fetch('https://electoral.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const tool = async (operation, params = {}) => (await (await rpc('tools/call', { name: 'mcp_aql_read', arguments: { operation, params } })).json()).result;
  return { mf, fetch, rpc, tool, requests };
}
async function client(t, fetch, token = tokenA) {
  const client = new Client({ name: 'workerd-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('https://electoral.example/mcp'), { fetch, requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

test('real workerd runs concurrent SDK clients with the same MCP-AQL operations and fixed-source fetching', { timeout: 60_000 }, async t => {
  const app = await runtime(t);
  const clients = await Promise.all([client(t, app.fetch), client(t, app.fetch, tokenB)]);
  await Promise.all(clients.map(async c => {
    assert.deepEqual((await c.listTools()).tools.map(t => t.name), ['mcp_aql_read']);
    const invoke = (operation, params = {}) => c.callTool({ name: 'mcp_aql_read', arguments: { operation, params } });
    assert.equal((await invoke('introspect')).structuredContent.success, true);
    const scenarios = await invoke('list_scenarios');
    assert.equal(scenarios.structuredContent.success, true, JSON.stringify(scenarios));
    assert.equal(scenarios.structuredContent.data.scenarios.length, 7);
    const changed = await invoke('modify_map', { scenario_id: 'blue-wall', edits: [{ unit: 'MA', flip: true }] });
    assert.equal(changed.structuredContent.data.map.totals.rep, 279);
    const poll = await invoke('get_poll_average', { dataset_id: 'senate_2024', race_id: 'PA', as_of: '2024-11-02' });
    assert.equal(poll.structuredContent.data.poll_count, 2);
    assert.equal((await invoke('get_map', { invalid: true })).isError, true);
  }));
  assert.deepEqual(app.requests.map(r => r.url).sort(), ['https://electoralvotemap.com/', 'https://www.electoral-vote.com/evp2024/Senate/senate_polls.csv']);
  for (const request of app.requests) { assert.equal(request.authorization, null); assert.equal(request.cookie, null); }
});

test('daily quota is strict under concurrent workerd requests and persists after runtime recreation', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'evm-durable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await runtime(t, { vars: { EVM_DAILY_REQUEST_LIMIT: '3' }, persist: directory });
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.rpc('tools/list')));
  assert.equal(responses.filter(r => r.status === 200).length, 3);
  assert.equal(responses.filter(r => r.status === 429).length, 5);
  assert.equal(app.requests.length, 0);
  await app.mf.dispose();
  const restarted = await runtime(t, { vars: { EVM_DAILY_REQUEST_LIMIT: '3' }, persist: directory });
  assert.equal((await restarted.rpc('tools/list')).status, 429);
});

test('coordinator keeps distinct credential quotas behind one proxy without charging rejected clients globally', { timeout: 60_000 }, async t => {
  const app = await runtime(t, { vars: { EVM_REQUESTS_PER_MINUTE: '4', EVM_CLIENT_REQUESTS_PER_MINUTE: '2' } });
  for (let i = 0; i < 2; i++) assert.equal((await app.rpc('tools/list')).status, 200);
  for (let i = 0; i < 8; i++) assert.equal((await app.rpc('tools/list')).status, 429);
  for (let i = 0; i < 2; i++) assert.equal((await app.rpc('tools/list', {}, tokenB)).status, 200);
  assert.equal((await app.rpc('tools/list', {}, tokenB)).status, 429);
});

test('per-client daily exhaustion persists across recreation and leaves another client quota available', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'evm-client-daily-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vars = { EVM_CLIENT_DAILY_REQUEST_LIMIT: '2', EVM_OPERATOR_CLIENT_IDS: '["alice"]' };
  const app = await runtime(t, { vars, persist: directory });
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.rpc('tools/list')));
  assert.equal(responses.filter(r => r.status === 200).length, 2);
  assert.equal(responses.filter(r => r.status === 429).length, 6);
  await app.mf.dispose();
  const restarted = await runtime(t, { vars, persist: directory });
  assert.equal((await restarted.rpc('tools/list')).status, 429);
  assert.equal((await restarted.rpc('tools/list', {}, tokenB)).status, 200);
  const usage = await restarted.fetch('https://electoral.example/admin/usage', { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(usage.status, 200);
  const summary = await usage.json();
  assert.equal(summary.admitted, 3);
  assert.equal(summary.highest_client_admissions, 2);
  assert.doesNotMatch(JSON.stringify(summary), /alice|bob|test-alice|test-bob/);
  assert.equal((await restarted.fetch('https://electoral.example/admin/usage', { headers: { authorization: `Bearer ${tokenB}`, 'x-evm-client-id': 'alice' } })).status, 403);
});

test('malformed bodies consume the sender allowance before parsing and are visible only as aggregate rejections', { timeout: 60_000 }, async t => {
  const app = await runtime(t, { vars: { EVM_CLIENT_DAILY_REQUEST_LIMIT: '1', EVM_OPERATOR_CLIENT_IDS: '["alice"]' } });
  const malformed = await app.fetch('https://electoral.example/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }, body: '[]' });
  assert.equal(malformed.status, 400);
  assert.equal((await app.rpc('tools/list')).status, 429);
  assert.equal((await app.rpc('tools/list', {}, tokenB)).status, 200);
  const response = await app.fetch('https://electoral.example/admin/usage', { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const usage = await response.json();
  assert.equal(usage.admitted, 2);
  assert.equal(usage.transient.rejections_by_status['400'], 1);
  assert.equal(usage.transient.rejections_by_status['429'], 1);
  assert.equal(app.requests.length, 0);
});

test('streaming body reception occupies coordinated concurrency and times out before MCP parsing', { timeout: 60_000 }, async t => {
  const app = await runtime(t, { vars: { EVM_MAX_CONCURRENT: '1', EVM_OPERATOR_CLIENT_IDS: '["alice"]' } });
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{')); } });
  t.after(() => { try { controller.close(); } catch {} });
  const first = app.fetch('https://electoral.example/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }, body, duplex: 'half' });
  let active = 0;
  for (let i = 0; i < 20 && !active; i++) {
    const response = await app.fetch('https://electoral.example/admin/usage', { headers: { authorization: `Bearer ${tokenA}` } });
    active = (await response.json()).active_requests;
    if (!active) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(active, 1);
  assert.equal((await app.rpc('tools/list', {}, tokenB)).status, 503);
  assert.equal((await first).status, 408);
  assert.equal((await app.rpc('tools/list', {}, tokenB)).status, 200);
  assert.equal(app.requests.length, 0);
});

test('independent ingress Workers share strict global and client daily quotas through one coordinator', { timeout: 60_000 }, async t => {
  const base = {
    modules: true, scriptPath: fileURLToPath(new URL('../../.worker-build/worker.js', import.meta.url)),
    compatibilityDate: '2026-11-13', compatibilityFlags: ['nodejs_compat'],
    bindings: { ...bindings, EVM_DAILY_REQUEST_LIMIT: '3', EVM_CLIENT_DAILY_REQUEST_LIMIT: '2' },
    durableObjects: { ELECTORAL_COORDINATOR: { className: 'ElectoralCoordinator', scriptName: 'shared-coordinator', useSQLite: true } },
  };
  // Separate limiter namespaces simulate independent location-local edge buckets;
  // all three entry points still bind the same coordinator namespace and ID.
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, port: 0, workers: [
    { ...base, name: 'ingress-a', ratelimits: { MCP_RATE_LIMITER: { namespace_id: '7201', simple: { limit: 100, period: 60 } } } },
    { ...base, name: 'ingress-b', ratelimits: { MCP_RATE_LIMITER: { namespace_id: '7202', simple: { limit: 100, period: 60 } } } },
    { ...base, name: 'shared-coordinator' },
  ] }));
  t.after(() => mf.dispose());
  const edges = await Promise.all([mf.getWorker('ingress-a'), mf.getWorker('ingress-b')]);
  const rpc = (edge, token) => edge.fetch('https://electoral.example/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '192.0.2.1', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const alice = await Promise.all(Array.from({ length: 8 }, (_, i) => rpc(edges[i % 2], tokenA)));
  assert.equal(alice.filter(r => r.status === 200).length, 2);
  assert.equal(alice.filter(r => r.status === 429).length, 6);
  const bob = await Promise.all(edges.map(edge => rpc(edge, tokenB)));
  assert.equal(bob.filter(r => r.status === 200).length, 1);
  assert.equal(bob.filter(r => r.status === 429).length, 1);
});

test('durable source cache survives runtime recreation without relabeling retrieval time', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'evm-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await runtime(t, { persist: directory });
  const map = await app.tool('get_map');
  assert.equal(map.structuredContent.success, true, JSON.stringify(map));
  assert.equal(app.requests.length, 1);
  await app.mf.dispose();
  const restarted = await runtime(t, { persist: directory });
  const restored = await restarted.tool('get_map');
  assert.equal(restored.structuredContent.data.source.retrieved_at, map.structuredContent.data.source.retrieved_at);
  assert.equal(restarted.requests.length, 0);
});

test('source outages fail explicitly, coalesce and keep the cooldown across recreation', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'evm-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { persist: directory, outbound: () => new RuntimeResponse('offline', { status: 503 }) };
  const app = await runtime(t, options);
  const results = await Promise.all([app.tool('get_map'), app.tool('get_map')]);
  for (const result of results) assert.equal(result.structuredContent.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(app.requests.length, 1);
  await app.mf.dispose();
  const restarted = await runtime(t, options);
  assert.equal((await restarted.tool('get_map')).isError, true);
  assert.equal(restarted.requests.length, 0);
});

test('workerd concurrency rejection does not consume daily quota and recovers after a shared fetch finishes', { timeout: 60_000 }, async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const app = await runtime(t, { vars: { EVM_MAX_CONCURRENT: '1', EVM_DAILY_REQUEST_LIMIT: '2' }, outbound: async () => { entered(); await blocked; return new RuntimeResponse(html); } });
  const first = app.tool('get_map');
  await started;
  const busy = await app.rpc('tools/list');
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '1');
  release();
  assert.equal((await first).isError, false);
  assert.equal((await app.rpc('tools/list')).status, 200);
  assert.equal((await app.rpc('tools/list')).status, 429);
});

test('workerd rejects disabled service, bad credentials, origins, methods, encoding and oversized requests', { timeout: 60_000 }, async t => {
  const disabled = await runtime(t, { vars: { EVM_ENABLED: 'false' } });
  assert.equal((await disabled.rpc('tools/list')).status, 503);
  const app = await runtime(t);
  assert.equal((await app.rpc('tools/list', {}, 'wrong')).status, 401);
  const headers = { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await app.fetch('https://preview.example/mcp', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await app.fetch('https://electoral.example/mcp', { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: '{}' })).status, 403);
  assert.equal((await app.fetch('https://electoral.example/mcp', { headers })).status, 405);
  assert.equal((await app.fetch('https://electoral.example/mcp', { method: 'POST', headers, body: new Uint8Array([0xff]) })).status, 400);
  assert.equal((await app.fetch('https://electoral.example/mcp', { method: 'POST', headers, body: ' '.repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal((await app.fetch('https://electoral.example/mcp', { method: 'POST', headers: { ...headers, 'x-large': 'x'.repeat(17 * 1024) }, body: '{}' })).status, 431);
  assert.equal(app.requests.length, 0);
});

test('workerd rejects upstream redirects and preserves contract-failure error codes', { timeout: 60_000 }, async t => {
  const redirect = await runtime(t, { outbound: () => new RuntimeResponse('', { status: 302, headers: { location: 'https://attacker.example/' } }) });
  assert.equal((await redirect.tool('get_map')).structuredContent.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.deepEqual(redirect.requests.map(r => r.url), ['https://electoralvotemap.com/']);
  const invalid = await runtime(t, { outbound: () => new RuntimeResponse('<html>Maintenance</html>') });
  assert.equal((await invalid.tool('get_map')).structuredContent.error.code, 'UPSTREAM_CONTRACT_CHANGED');
  assert.equal((await invalid.tool('get_map')).structuredContent.error.code, 'UPSTREAM_CONTRACT_CHANGED');
  assert.equal(invalid.requests.length, 1);
});
