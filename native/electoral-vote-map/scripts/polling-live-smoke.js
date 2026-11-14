// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createAdapter } from '../src/adapter.js';
const dispatch = createAdapter();
async function call(operation, params = {}) {
  const result = await dispatch('mcp_aql_read', { operation, params });
  assert.equal(result.success, true, JSON.stringify(result));
  return result.data;
}
const catalog = await call('list_poll_datasets');
assert.equal(catalog.datasets.length, 3);
for (const dataset of catalog.datasets) {
  assert.equal(dataset.status, 'available', JSON.stringify(dataset));
  assert.equal(dataset.source.mode, 'live');
}
const average = await call('get_poll_average', { dataset_id: 'president_2024', race_id: 'PA', as_of: '2024-11-04' });
assert.ok(average.poll_count > 0);
assert.ok(average.included_polls.every(r => r.kind === 'poll' && r.fieldwork_end <= '2024-11-04'));
const current = await call('get_poll_average', { dataset_id: 'senate_2026', race_id: 'AK', as_of: new Date().toISOString().slice(0, 10) });
assert.ok(current.included_polls.every(r => r.kind === 'poll'));
const scenario = await call('build_polling_scenario', {
  dataset_id: 'president_2024', as_of: '2024-11-04', race_ids: ['PA', 'MI', 'WI'],
  comparison_mode: 'hypothetical_cross_election', rating_thresholds: { toss_up_below: 2, likely_from: 5, safe_from: 10 },
  swing_points: -3, stale_policy: 'error', unavailable_policy: 'error', district_policy: 'preserve_districts',
});
assert.ok(scenario.changes.length > 0);
assert.equal(Object.values(scenario.map.totals).reduce((a, b) => a + b, 0), 538);
const roundTrip = await call('get_map', { map_url: scenario.map.map_url });
assert.deepEqual(roundTrip.totals, scenario.map.totals);
console.log(JSON.stringify({ checked_at: new Date().toISOString(), catalog, historical_poll_summary: average,
  current_senate_evidence: current, scenario }, null, 2));
