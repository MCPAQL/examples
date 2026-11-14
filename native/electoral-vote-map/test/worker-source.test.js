// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { durableSourceFetch } from '../src/worker-source.js';
import { createSiteClient } from '../src/site.js';
import { createPollingClient, DATASETS } from '../src/polling.js';
import { HOME } from '../src/map.js';
import { sourceTime } from '../src/source-timing.js';
import { memoryStorage } from './helpers/storage.js';

test('durable source cache coalesces, chunks bounded values and survives recreation', async () => {
  const storage = memoryStorage(); let calls = 0;
  const text = 'x'.repeat(2 * 1024 * 1024);
  const options = { now: () => 1000, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, HOME); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, undefined);
    return new Response(text);
  } };
  const fetchImpl = durableSourceFetch(storage, options);
  const responses = await Promise.all([fetchImpl(HOME), fetchImpl(HOME)]);
  assert.equal(calls, 1);
  assert.equal(await responses[0].text(), text);
  assert.equal(await responses[1].text(), text);
  const restarted = durableSourceFetch(storage, options);
  const cached = await restarted(HOME);
  assert.equal(await cached.text(), text);
  assert.equal(sourceTime(cached), '1970-01-01T00:00:01.000Z');
  assert.equal(calls, 1);
  await assert.rejects(restarted('https://attacker.example'));
});

test('failed sources keep a durable cooldown across restarts and never serve stale successes', async () => {
  const storage = memoryStorage(); let time = 0, calls = 0;
  const options = { now: () => time, fetchImpl: async () => { calls++; return new Response(calls === 1 ? 'good' : 'failed', { status: calls === 1 ? 200 : 503 }); } };
  assert.equal(await (await durableSourceFetch(storage, options)(HOME)).text(), 'good');
  time = 300_001;
  assert.equal((await durableSourceFetch(storage, options)(HOME)).status, 503);
  assert.equal((await durableSourceFetch(storage, options)(HOME)).status, 503);
  assert.equal(calls, 2);
  time += 30_001;
  assert.equal((await durableSourceFetch(storage, options)(HOME)).status, 503);
  assert.equal(calls, 3);
});

test('oversize and invalid-UTF8 sources are rejected before storage and remain unavailable', async () => {
  for (const body of [new Uint8Array([0xff]), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const storage = memoryStorage(); let calls = 0;
    const load = durableSourceFetch(storage, { fetchImpl: async () => { calls++; return new Response(body); } });
    assert.equal((await load(HOME)).status, 503);
    assert.equal((await load(HOME)).status, 503);
    assert.equal(calls, 1);
  }
});

test('restored map and polling clients preserve original retrieval time and do not extend cache freshness', async () => {
  const html = await readFile(new URL('./fixtures/site.html', import.meta.url), 'utf8');
  const csv = await readFile(new URL('./fixtures/polling.csv', import.meta.url), 'utf8');
  let time = Date.parse('2026-11-14T00:00:00Z'), calls = 0;
  const storage = memoryStorage();
  const options = { now: () => time, fetchImpl: async url => { calls++; return new Response(url === HOME ? html : csv); } };
  const create = () => {
    const fetchImpl = durableSourceFetch(storage, options), now = () => new Date(time);
    return [createSiteClient({ fetchImpl, now }), createPollingClient({ fetchImpl, now })];
  };
  let [site, polls] = create();
  const first = await site(); await polls(DATASETS[1].id);
  assert.equal(calls, 2);
  time += 240_000;
  [site, polls] = create();
  assert.equal((await site()).source.retrieved_at, first.source.retrieved_at);
  assert.equal((await polls(DATASETS[1].id)).source.retrieved_at, first.source.retrieved_at);
  assert.equal(calls, 2);
  time += 60_001;
  assert.notEqual((await site()).source.retrieved_at, first.source.retrieved_at);
  assert.notEqual((await polls(DATASETS[1].id)).source.retrieved_at, first.source.retrieved_at);
  assert.equal(calls, 4);
});
