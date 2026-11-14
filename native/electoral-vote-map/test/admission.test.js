// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmission } from '../src/admission.js';
import { createSiteClient } from '../src/site.js';

test('admission bounds bursts, separates IPs, refills and releases concurrency exactly once', () => {
  let time = 0;
  const gate = createAdmission({ requestsPerMinute: 4, perIpPerMinute: 2, maxConcurrent: 1, now: () => time });
  const first = gate.enter('a');
  assert.equal(gate.enter('b').status, 503);
  first.release(); first.release();
  const second = gate.enter('a');
  assert.equal(typeof second.release, 'function'); second.release();
  assert.equal(gate.enter('a').status, 429);
  // The global bucket limits distributed clients too.
  assert.equal(gate.enter('c').status, 429);
  time += 60_000;
  const restored = gate.enter('c');
  assert.equal(typeof restored.release, 'function'); restored.release();
});

test('client identity table fails closed at its bound and expires idle identities', () => {
  let time = 0;
  const gate = createAdmission({ maxClients: 1, now: () => time });
  gate.enter('a').release();
  assert.equal(gate.enter('b').status, 429);
  time += 60_000;
  const next = gate.enter('b');
  assert.equal(typeof next.release, 'function'); next.release();
});

test('map source failures coalesce and cool down without serving stale success as fresh', async () => {
  let calls = 0, time = 0;
  const load = createSiteClient({ now: () => new Date(time), failureTtlMs: 1000, fetchImpl: async () => { calls++; return new Response('offline', { status: 503 }); } });
  await Promise.all(Array.from({ length: 5 }, () => assert.rejects(load(), { code: 'UPSTREAM_UNAVAILABLE' })));
  await assert.rejects(load());
  assert.equal(calls, 1);
  time += 1001;
  await assert.rejects(load());
  assert.equal(calls, 2);
});
