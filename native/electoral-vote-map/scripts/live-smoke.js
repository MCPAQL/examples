// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createAdapter } from '../src/adapter.js';
const dispatch = createAdapter();
const catalog = await dispatch('mcp_aql_read', { operation: 'list_scenarios' });
assert.equal(catalog.success, true, JSON.stringify(catalog));
assert.equal(catalog.data.source.mode, 'live');
for (const scenario of catalog.data.scenarios) {
  assert.equal(Object.values(scenario.totals).reduce((a, b) => a + b, 0), 538);
  const roundTrip = await dispatch('mcp_aql_read', { operation: 'get_map', params: { map_url: scenario.map_url } });
  assert.equal(roundTrip.success, true);
  assert.deepEqual(roundTrip.data.totals, scenario.totals);
}
const modified = await dispatch('mcp_aql_read', { operation: 'modify_map', params: {
  scenario_id: 'blue-wall', edits: [{ unit: 'MA', flip: true }, { unit: 'VT', flip: true }, { unit: 'SC', flip: true }, { unit: 'TN', flip: true }],
} });
assert.equal(modified.success, true, JSON.stringify(modified));
console.log(JSON.stringify({ retrieved_at: catalog.data.source.retrieved_at, scenarios: catalog.data.scenarios.map(({ id, name, totals, map_url }) => ({ id, name, totals, map_url })), modified }, null, 2));
