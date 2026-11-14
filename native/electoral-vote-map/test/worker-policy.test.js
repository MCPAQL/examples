// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { ElectoralCoordinator } from '../src/worker.js';
import { readWorkerConfig, authenticatedClient, networkIdentity, boundedBody, takeBudget, readUsage, MAX_WORKER_BODY } from '../src/worker-policy.js';
import { memoryStorage } from './helpers/storage.js';

const a = 'a'.repeat(48), b = 'b'.repeat(48);
const env = { EVM_ENABLED: 'true', EVM_PUBLIC_ORIGIN: 'https://electoral.example', EVM_CLIENT_TOKENS: JSON.stringify({ alice: a, bob: b }) };
const config = readWorkerConfig(env);
const request = (token = a, headers = {}) => new Request('https://electoral.example/healthz', { headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '192.0.2.1', ...headers } });

test('Worker policy defaults to private authentication, strict bounded limits and distinct client identities', () => {
  assert.throws(() => readWorkerConfig({ EVM_PUBLIC_ORIGIN: env.EVM_PUBLIC_ORIGIN }));
  assert.equal(config.dailyLimit, 10_000);
  assert.equal(config.clientDailyLimit, 1000);
  assert.equal(authenticatedClient(request(), config), 'alice');
  assert.equal(authenticatedClient(request(b), config), 'bob');
  assert.throws(() => authenticatedClient(request('invalid'), config), { status: 401 });
  for (const patch of [{ EVM_DAILY_REQUEST_LIMIT: '0' }, { EVM_CLIENT_DAILY_REQUEST_LIMIT: '0' }, { EVM_MAX_CONCURRENT: '65' }, { EVM_PUBLIC_ORIGIN: 'http://electoral.example' }, { EVM_CLIENT_TOKENS: JSON.stringify({ a, b: a }) }, { EVM_ALLOW_ANONYMOUS: 'yes' }, { EVM_OPERATOR_CLIENT_IDS: '["missing"]' }, { EVM_OPERATOR_CLIENT_IDS: '["alice","alice"]' }]) assert.throws(() => readWorkerConfig({ ...env, ...patch }));
});

test('IPv6 interface rotation shares a /64 while IPv4-mapped addresses retain their own IPv4 identity', () => {
  assert.equal(networkIdentity('2001:db8:1234:5678::1'), networkIdentity('2001:db8:1234:5678:abcd:1:2:3'));
  assert.notEqual(networkIdentity('2001:db8:1234:5678::1'), networkIdentity('2001:db8:1234:5679::1'));
  assert.equal(networkIdentity('::ffff:192.0.2.1'), networkIdentity('192.0.2.1'));
  for (const ip of [null, 'untrusted', '256.0.0.1', '2001:zzzz::1']) assert.throws(() => networkIdentity(ip), { status: 403 });
});

test('daily quotas are atomic across concurrent requests and survive a new loader', async () => {
  const storage = memoryStorage(), limits = { ...config, dailyLimit: 3 };
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => takeBudget(storage, limits, 'alice', 1000)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal((await storage.get('request-budget')).count, 3);
  await assert.rejects(takeBudget(storage, limits, 'bob', 2000), { status: 429 });
  await takeBudget(storage, limits, 'bob', 86_401_000);
  assert.equal((await storage.get('request-budget')).count, 1);
  assert.doesNotMatch(JSON.stringify(await storage.get('request-budget')), new RegExp(a));
});

test('one credential cannot drain another client allowance or shared quota by retrying rejected requests', async () => {
  const storage = memoryStorage(), limits = { ...config, perMinute: 4, perClientPerMinute: 2 };
  for (let i = 0; i < 2; i++) await takeBudget(storage, limits, 'alice', 1000);
  for (let i = 0; i < 20; i++) await assert.rejects(takeBudget(storage, limits, 'alice', 1000), { status: 429 });
  for (let i = 0; i < 2; i++) await takeBudget(storage, limits, 'bob', 1000);
  assert.equal((await storage.get('request-budget')).count, 4);
  await assert.rejects(takeBudget(storage, limits, null, 1000), { status: 429 });
});

test('per-client daily quota survives minute refills and restarts, then resets at UTC midnight', async () => {
  const storage = memoryStorage(), limits = { ...config, clientDailyLimit: 2 };
  await takeBudget(storage, limits, 'alice', 1000);
  await takeBudget(storage, limits, 'alice', 61_000);
  const before = await storage.get('request-budget');
  await assert.rejects(takeBudget(storage, { ...limits }, 'alice', 121_000), { status: 429, message: 'Client daily admission quota exhausted' });
  assert.deepEqual(await storage.get('request-budget'), before);
  await takeBudget(storage, limits, 'bob', 121_000);
  const usage = await readUsage(storage, limits, 121_000);
  assert.equal(usage.admitted, 3);
  assert.equal(usage.highest_client_admissions, 2);
  assert.doesNotMatch(JSON.stringify(usage), /alice|bob/);
  assert.equal((await readUsage(storage, limits, 86_401_000)).admitted, 0);
  await takeBudget(storage, limits, 'alice', 86_401_000);
  assert.equal((await storage.get('request-budget')).clients['client:alice'].count, 1);
});

test('legacy daily records migrate conservatively without granting fresh allowance', async () => {
  const storage = memoryStorage(), limits = { ...config, clientDailyLimit: 2 };
  await storage.put('request-budget', { day: '1970-01-01', count: 2, tokens: 10, updated: 1000, clients: { 'client:alice': { tokens: 10, updated: 1000 } } });
  await assert.rejects(takeBudget(storage, limits, 'alice', 61_000), { status: 429 });
  await takeBudget(storage, limits, 'bob', 61_000);
  assert.equal((await storage.get('request-budget')).count, 3);
  assert.equal((await storage.get('request-budget')).clients['client:bob'].count, 1);
});

test('usage requires an explicitly configured operator and strips caller identity headers', async () => {
  const calls = [];
  const bindings = { ...env, EVM_OPERATOR_CLIENT_IDS: '["alice"]', MCP_RATE_LIMITER: { limit: async () => ({ success: true }) }, ELECTORAL_COORDINATOR: {
    idFromName() { return 'id'; }, get() { return { async fetch(req) { calls.push(req); return new Response('{}'); } }; },
  } };
  const usageRequest = (token, extra = {}) => new Request('https://electoral.example/admin/usage', { headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '192.0.2.1', ...extra } });
  assert.equal((await worker.fetch(usageRequest(b, { 'x-evm-client-id': 'alice' }), bindings)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await worker.fetch(usageRequest(a), { ...bindings, EVM_OPERATOR_CLIENT_IDS: '[]' })).status, 403);
  assert.equal((await worker.fetch(usageRequest(a), bindings)).status, 200);
  assert.equal(calls[0].url, 'https://coordinator/admin/usage');
  assert.equal(calls[0].headers.get('x-evm-client-id'), 'alice');
  assert.equal(calls[0].headers.has('authorization'), false);
});

test('Worker body reader rejects invalid encoding, batches, oversize streams and slow bodies', async () => {
  const make = body => new Request('https://example/mcp', { method: 'POST', body, duplex: 'half' });
  await assert.rejects(boundedBody(make(new Uint8Array([0xff]))), { status: 400 });
  await assert.rejects(boundedBody(make('[]')), { status: 400 });
  await assert.rejects(boundedBody(make('x'.repeat(MAX_WORKER_BODY + 1))), { status: 413 });
  await assert.rejects(boundedBody(make(new ReadableStream({ start() {} })), 10), { status: 408 });
  assert.equal(await boundedBody(make('{"jsonrpc":"2.0"}')), '{"jsonrpc":"2.0"}');
});

test('authenticated clients sharing a proxy have separate edge buckets; forwarded and internal headers cannot impersonate them', async () => {
  const counts = new Map();
  const bindings = { ...env, ELECTORAL_COORDINATOR: {}, MCP_RATE_LIMITER: { async limit({ key }) { counts.set(key, (counts.get(key) ?? 0) + 1); return { success: counts.get(key) <= 2 }; } } };
  assert.equal((await worker.fetch(request(), bindings)).status, 200);
  assert.equal((await worker.fetch(request(), bindings)).status, 200);
  assert.equal((await worker.fetch(request(a, { 'x-forwarded-for': '203.0.113.7', 'x-evm-client-id': 'bob' }), bindings)).status, 429);
  assert.equal((await worker.fetch(request(b), bindings)).status, 200);
  assert.deepEqual([...counts.keys()], ['client:alice', 'client:bob']);
});

test('kill switch, wrong origins, missing bindings and invalid auth fail closed without forwarding secrets', async () => {
  assert.equal((await worker.fetch(request(), { ...env, EVM_ENABLED: 'false' })).status, 503);
  assert.equal((await worker.fetch(request(), env)).status, 503);
  const calls = [];
  const bindings = { ...env, MCP_RATE_LIMITER: { limit: async () => ({ success: true }) }, ELECTORAL_COORDINATOR: {
    idFromName(name) { assert.equal(name, 'global-v1'); return 'id'; }, get() { return { async fetch(req) { calls.push(req); return Response.json(req.url.endsWith('/admit') ? { admission_id: '00000000-0000-4000-8000-000000000000' } : {}); } }; },
  } };
  assert.equal((await worker.fetch(request(a, { origin: 'https://attacker.example' }), bindings)).status, 403);
  const invalid = await worker.fetch(request('wrong'), bindings);
  assert.equal(invalid.status, 401);
  assert.ok(invalid.headers.has('www-authenticate'));
  const response = await worker.fetch(new Request('https://electoral.example/mcp', { method: 'POST', headers: { authorization: `Bearer ${a}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-connecting-ip': '192.0.2.1', 'x-evm-client-id': 'bob', 'x-forwarded-for': '203.0.113.1' }, body: '{}' }), bindings);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  for (const forwarded of calls) {
    assert.equal(forwarded.headers.get('x-evm-client-id'), 'alice');
    for (const header of ['authorization', 'cf-connecting-ip', 'x-forwarded-for']) assert.equal(forwarded.headers.has(header), false);
  }
  assert.doesNotMatch(await invalid.text(), new RegExp(a));
});

test('admission reservations expire, reject replay and cannot be consumed or released by another client', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const coordinator = new ElectoralCoordinator({ storage: memoryStorage() }, { ...env, EVM_MAX_CONCURRENT: '1' });
  const internal = (path, id = 'alice', admissionId) => new Request('https://coordinator/' + path, { method: 'POST', headers: { 'x-evm-client-id': id, ...(admissionId ? { 'x-evm-admission-id': admissionId } : {}) }, ...(path === 'mcp' ? { body: '{}' } : {}) });
  const first = await coordinator.fetch(internal('admit'));
  const { admission_id: id } = await first.json();
  assert.equal(coordinator.active, 1);
  assert.equal((await coordinator.fetch(internal('mcp', 'bob', id))).status, 503);
  await coordinator.fetch(internal('release', 'bob', id));
  assert.equal(coordinator.active, 1);
  t.mock.timers.tick(10_001);
  assert.equal(coordinator.active, 0);
  assert.equal((await coordinator.fetch(internal('mcp', 'alice', id))).status, 503);
  const second = await coordinator.fetch(internal('admit'));
  const { admission_id: secondId } = await second.json();
  await coordinator.fetch(internal('release', 'alice', secondId));
  assert.equal(coordinator.active, 0);
  assert.equal((await coordinator.fetch(internal('mcp', 'alice', secondId))).status, 503);
});
