// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { authBudget, meteredKV, quotaIdentity, isOAuthIdentity, sessionValid, tokenLifetimes, authBody, usedTransaction } from '../src/worker-oauth-policy.js';
import { readWorkerConfig, takeBudget } from '../src/worker-policy.js';
import { memoryStorage } from './helpers/storage.js';

test('OAuth configuration fails closed and never permits anonymous access', () => {
  const env = { EVM_PUBLIC_ORIGIN: 'https://electoral.example', EVM_OAUTH_ENABLED: 'true' };
  assert.equal(readWorkerConfig(env).tokens.length, 0);
  assert.equal(readWorkerConfig(env).maxDailyClients, 256);
  for (const patch of [{ EVM_ALLOW_ANONYMOUS: 'true' }, { EVM_OAUTH_ENABLED: 'yes' }, { EVM_MAX_DAILY_CLIENTS: '513' }]) assert.throws(() => readWorkerConfig({ ...env, ...patch }));
});

test('stable pseudonymous quota identities distinguish issuers and subjects and survive app/token changes', () => {
  const id = quotaIdentity('https://accounts.google.com', 'user-one');
  assert.equal(isOAuthIdentity(id), true);
  assert.equal(id, quotaIdentity('https://accounts.google.com', 'user-one'));
  assert.notEqual(id, quotaIdentity('https://other.example', 'user-one'));
  assert.notEqual(id, quotaIdentity('https://accounts.google.com', 'user-two'));
  assert.equal(isOAuthIdentity('mick'), false);
  assert.equal(sessionValid({ quotaId: id, loginAt: 1000 }, 1000), true);
  assert.equal(sessionValid({ quotaId: 'mick', loginAt: 1000 }, 1000), false);
  assert.equal(sessionValid({ quotaId: id, loginAt: 1001 }, 1000), false);
  assert.equal(sessionValid({ quotaId: id, loginAt: 0 }, 7 * 86_400_000), false);
});

test('authentication KV writes have a durable atomic ceiling, including failed attempts and restarts', async () => {
  const storage = memoryStorage(); let writes = 0;
  const kv = meteredKV({ async put() { writes++; throw new Error('upstream unavailable'); } }, storage);
  await Promise.allSettled(Array.from({ length: 510 }, () => kv.put('opaque-key', 'opaque-value')));
  assert.equal(writes, 500);
  assert.equal((await storage.get('oauth-budget')).counts.write, 500);
  await assert.rejects(meteredKV({ put() { throw new Error('must not reach provider'); } }, storage).put('key', 'value'), { status: 503 });
  assert.doesNotMatch(JSON.stringify(await storage.get('oauth-budget')), /opaque/);
});

test('token lifetimes honor granted offline consent and the absolute seven-day sign-in boundary', () => {
  const props = { quotaId: quotaIdentity('https://issuer.example', 'one'), loginAt: 1000 };
  const end = props.loginAt + 7 * 86_400_000;
  assert.deepEqual(tokenLifetimes(props, ['electoral:read'], 1000), { accessTokenTTL: 3600, refreshTokenTTL: 0 });
  assert.deepEqual(tokenLifetimes(props, ['electoral:read', 'offline_access'], end - 61_000), { accessTokenTTL: 61, refreshTokenTTL: 61 });
  for (const time of [end - 59_000, end, end + 1000]) assert.equal(tokenLifetimes(props, ['electoral:read', 'offline_access'], time), null);
  assert.equal(tokenLifetimes(props, ['offline_access'], 1000), null);
});

test('authentication flow limits refill and reset at UTC midnight without erasing KV counts', async () => {
  const storage = memoryStorage();
  for (let i = 0; i < 60; i++) await authBudget(storage, 'flow', 1000);
  await assert.rejects(authBudget(storage, 'flow', 1000), { status: 429 });
  await authBudget(storage, 'write', 1000);
  await authBudget(storage, 'flow', 2000);
  assert.equal((await storage.get('oauth-budget')).counts.write, 1);
  await authBudget(storage, 'write', 86_401_000);
  assert.deepEqual((await storage.get('oauth-budget')).counts, { write: 1 });
});

test('one-time transaction fences survive recreation and expire without storing handles', async () => {
  const storage = memoryStorage();
  await usedTransaction(storage, 'secret-handle', false, 1000);
  await usedTransaction(storage, 'secret-handle', true, 1000);
  await assert.rejects(usedTransaction(storage, 'secret-handle', false, 2000), { status: 400 });
  assert.doesNotMatch(JSON.stringify(await storage.get('oauth-used')), /secret-handle/);
  await usedTransaction(storage, 'secret-handle', true, 601_000);
});

test('maximum OAuth client table stays within durable record limits and rejects new identities without charging quotas', async () => {
  const storage = memoryStorage(), config = readWorkerConfig({ EVM_PUBLIC_ORIGIN: 'https://electoral.example', EVM_OAUTH_ENABLED: 'true', EVM_MAX_DAILY_CLIENTS: '512', EVM_REQUESTS_PER_MINUTE: '1000' });
  for (let i = 0; i < 512; i++) await takeBudget(storage, config, quotaIdentity('https://issuer.example', String(i)), 1000);
  const before = await storage.get('request-budget');
  assert.ok(Buffer.byteLength(JSON.stringify(before)) < 128 * 1024);
  await assert.rejects(takeBudget(storage, config, quotaIdentity('https://issuer.example', 'extra'), 1000), { status: 429 });
  assert.deepEqual(await storage.get('request-budget'), before);
  await takeBudget(storage, config, quotaIdentity('https://issuer.example', '0'), 1000);
});

test('auth endpoints reject oversized or invalid UTF-8 forms independently of MCP body limits', async () => {
  await assert.rejects(authBody(new Request('https://example.com', { method: 'POST', body: 'x'.repeat(16_385) })), { status: 413 });
  await assert.rejects(authBody(new Request('https://example.com', { method: 'POST', body: new Uint8Array([255]) })), { status: 400 });
  assert.equal(await authBody(new Request('https://example.com', { method: 'POST', body: 'grant_type=refresh_token' })), 'grant_type=refresh_token');
});
