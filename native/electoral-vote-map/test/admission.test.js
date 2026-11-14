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
  for (let i = 0; i < 20; i++) assert.equal(gate.enter('a').status, 429);
  // Neither the concurrency rejection nor repeated per-IP rejections spend
  // remaining global quota. Other IPs can still use their own allowance.
  const third = gate.enter('c');
  assert.equal(typeof third.release, 'function'); third.release();
  const fourth = gate.enter('d');
  assert.equal(typeof fourth.release, 'function'); fourth.release();
  // The global bucket limits distributed clients too.
  assert.equal(gate.enter('e').status, 429);
  time += 60_000;
  const restored = gate.enter('c');
  assert.equal(typeof restored.release, 'function'); restored.release();
});

test('client identity table fails closed at its bound and expires idle identities', () => {
  let time = 0;
  const gate = createAdmission({ requestsPerMinute: 2, maxClients: 1, now: () => time });
  gate.enter('a').release();
  for (let i = 0; i < 20; i++) assert.equal(gate.enter('b').status, 429);
  // Full-table rejections leave the existing client's remaining token intact.
  const existing = gate.enter('a');
  assert.equal(typeof existing.release, 'function'); existing.release();
  time += 60_000;
  const next = gate.enter('b');
  assert.equal(typeof next.release, 'function'); next.release();
});

test('concurrency rejections reserve neither quota nor a new identity slot', () => {
  const gate = createAdmission({ requestsPerMinute: 2, perIpPerMinute: 1, maxConcurrent: 1, maxClients: 2, now: () => 0 });
  const first = gate.enter('a');
  for (let i = 0; i < 20; i++) assert.equal(gate.enter('b').status, 503);
  assert.equal(gate.enter('c').status, 503);
  first.release();
  const next = gate.enter('c');
  assert.equal(typeof next.release, 'function'); next.release();
  assert.equal(gate.enter('d').status, 429);
});

test('one exhausted client cannot spend the default global reserve', () => {
  const gate = createAdmission({ now: () => 0 });
  for (let i = 0; i < 60; i++) gate.enter('noisy').release();
  for (let i = 0; i < 120; i++) assert.equal(gate.enter('noisy').status, 429);
  for (let i = 0; i < 60; i++) {
    const ticket = gate.enter('other');
    assert.equal(typeof ticket.release, 'function'); ticket.release();
  }
  assert.equal(gate.enter('third').status, 429, 'genuinely admitted traffic still exhausts the shared quota');
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
