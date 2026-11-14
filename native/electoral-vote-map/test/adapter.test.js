// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAdapter, OPERATIONS, TYPES } from '../src/adapter.js';
import { createSiteClient, parseSite } from '../src/site.js';
import { decode, mapUrl, parseUrl } from '../src/map.js';

const fixture = await readFile(new URL('./fixtures/site.html', import.meta.url), 'utf8');
const loadSite = createSiteClient({ fixtureHtml: fixture });
const data = await loadSite();
const dispatch = createAdapter({ loadSite });
async function call(operation, params = {}) {
  const result = await dispatch('mcp_aql_read', { operation, params });
  assert.equal(result.success, true, JSON.stringify(result));
  return result.data;
}
const a = 'https://electoralvotemap.com/?map=2028:ERREDEEDDSDDERERDRRDDFDTFFRERERRRFRFEFEDDRDFDFRRERFDDERR';
const b = 'https://electoralvotemap.com/?map=2028:ERREDEEDDSDDERERDRRDDFDTFFRERERRRFRFEFEDDRDFDFRRDRFDDERR&ev=2032';

test('discover current forecast and six site-owned scenarios, each round-trips to 538 votes', async () => {
  const catalog = await call('list_scenarios');
  assert.equal(catalog.scenarios.length, 7);
  assert.equal(catalog.source.mode, 'test_fixture');
  const expected = { 'blue-wall': [270, 268, 0], 'sun-belt': [275, 263, 0], battlegrounds: [226, 219, 93], 'dem-sweep': [319, 219, 0], 'gop-expands': [192, 346, 0], tie: [269, 269, 0] };
  for (const scenario of catalog.scenarios) {
    assert.deepEqual((await call('get_map', { map_url: scenario.map_url })).totals, scenario.totals);
    assert.equal(Object.values(scenario.totals).reduce((a, b) => a + b), 538);
    if (expected[scenario.id]) assert.deepEqual([scenario.totals.dem, scenario.totals.rep, scenario.totals.toss_up], expected[scenario.id]);
  }
});
test('user URLs separate Texas Likely→Safe change from the allocation effect', async () => {
  const result = await call('compare_maps', { left_url: a, right_url: b });
  assert.deepEqual(result.changes, [{ unit: 'TX', from: 'likely_dem', to: 'safe_dem' }]);
  assert.deepEqual([result.left.totals.dem, result.left.totals.rep], [406, 132]);
  assert.deepEqual([result.right.totals.dem, result.right.totals.rep], [400, 138]);
  assert.equal(result.allocation_changed, true);
  assert.equal(result.electoral_vote_delta.dem, -6);
});
test('flips preserve rating strength and do not modify the base or shared site data', async () => {
  const before = await call('get_map', { scenario_id: 'blue-wall' });
  const result = await call('modify_map', { scenario_id: 'blue-wall', edits: [{ unit: 'MA', flip: true }, { unit: 'VT', flip: true }, { unit: 'SC', flip: true }, { unit: 'TN', flip: true }] });
  assert.deepEqual(result.changes.map(x => x.unit), ['MA', 'SC', 'TN', 'VT']);
  assert.deepEqual([result.map.totals.dem, result.map.totals.rep], [276, 262]);
  assert.deepEqual(await call('get_map', { scenario_id: 'blue-wall' }), before);
});
test('Maine and Nebraska statewide edits count two votes; districts remain distinct', async () => {
  const before = await call('get_map', { scenario_id: 'blue-wall' });
  const result = await call('modify_map', { scenario_id: 'blue-wall', edits: [{ unit: 'ME', rating: 'safe_rep' }] });
  assert.equal(before.totals.dem - result.map.totals.dem, 2);
  assert.equal(result.map.ratings['ME-1'], before.ratings['ME-1']);
  const units = await call('list_units');
  assert.equal(units.units.find(x => x.unit === 'NE').current_ev, 2);
});
test('all supported third party codes survive the codec without silent toss-up conversion', () => {
  for (const code of ['OPQ', 'ABC', 'GHI']) {
    const encoded = code.repeat(19).slice(0, 56);
    const map = { ratings: decode(encoded, data), electoral_allocation: 'current' };
    assert.deepEqual(parseUrl(mapUrl(map, data), data), map);
  }
});
test('malformed/unsupported/foreign URLs and duplicate parameters fail closed', async () => {
  for (const url of [a.replace('https:', 'http:'), a.replace('electoralvotemap.com', 'evil.example'), `${a}&map=2028:D`, `${a}&ev=2040`, `${a}:newsom-vance`, `${a}&unknown=x`, `${a}#m=2028:D`, a.replace('2028:', '2024:'), a.replace('ERRE', 'XRRE'), 'not a URL']) {
    assert.equal((await dispatch('mcp_aql_read', { operation: 'get_map', params: { map_url: url } })).success, false, url);
  }
});
test('invalid edits and contradictory bases are rejected', async () => {
  for (const edits of [[], [{ unit: 'MA', flip: false }], [{ unit: 'XX', rating: 'safe_dem' }], [{ unit: 'MA', rating: 'safe_dem', flip: true }], [{ unit: 'MA', rating: 'safe_dem', surprise: true }], [{ unit: 'MA', rating: 'safe_dem' }, { unit: 'MA', flip: true }]]) {
    assert.equal((await dispatch('mcp_aql_read', { operation: 'modify_map', params: { edits } })).success, false);
  }
  assert.equal((await dispatch('mcp_aql_read', { operation: 'get_map', params: { scenario_id: 'current', map_url: a } })).success, false);
});
const researchParams = {
  scenario_id: 'blue-wall', metric: 'senate_delegation', election_year: 2026,
  rows: [{ state: 'ME', dem: 1, rep: 1, other: 0, status: 'certified', source_urls: ['https://www.senate.gov/'] }],
  as_of: '2026-11-14T00:00:00Z', mapping_rule: 'state_plurality', tie_policy: 'toss_up', district_policy: 'preserve_districts',
};
test('research briefing supplies external search handoff with scope, not invented facts', async () => {
  const brief = await call('get_research_brief', { metric: 'house_seats_won', election_year: 2026, states: ['MA', 'GA'] });
  assert.deepEqual(brief.queries.map(x => x.state), ['MA', 'GA']);
  assert.match(brief.research_owner, /own web\/search/);
});
test('researched map carries sources and assumptions; district policy controls a state sweep', async () => {
  const result = await call('apply_election_results', researchParams);
  assert.deepEqual(result.changes, [{ unit: 'ME', from: 'safe_dem', to: 'toss_up' }]);
  assert.equal(result.research.verification, 'client_supplied_not_independently_verified');
  assert.deepEqual(result.research.rows[0].source_urls, ['https://www.senate.gov/']);
  const sweep = await call('apply_election_results', { ...researchParams, district_policy: 'state_sweep' });
  assert.deepEqual(sweep.changes.map(x => x.unit), ['ME', 'ME-1', 'ME-2']);
  const kept = await call('apply_election_results', { ...researchParams, tie_policy: 'keep' });
  assert.deepEqual(kept.changes, []);
});
test('research rejects missing rules, zero race counts, bad sources and invalid timestamps', async () => {
  const cases = [
    { ...researchParams, tie_policy: 'error' }, { ...researchParams, district_policy: null },
    { ...researchParams, as_of: 'yesterday' }, { ...researchParams, mapping_rule: 'actual_election' },
    ...[
      { dem: 0, rep: 0 }, { source_urls: [] }, { source_urls: ['file:///etc/passwd'] },
      { dem: 1.2 }, { state: 'DC' }, { state: 'ME-1' }, { status: 'made-up' }, { unknown: true },
    ].map(patch => ({ ...researchParams, rows: [{ ...researchParams.rows[0], ...patch }] })),
    { ...researchParams, rows: [researchParams.rows[0], researchParams.rows[0]] },
  ];
  const missingRule = { ...researchParams }; delete missingRule.mapping_rule; cases.push(missingRule);
  for (const params of cases) assert.equal((await dispatch('mcp_aql_read', { operation: 'apply_election_results', params })).success, false, JSON.stringify(params));
});
test('strict MCP-AQL errors, alias precedence, unicode and payload limits work offline', async () => {
  const offline = createAdapter({ loadSite: () => { throw new Error('Network must not be called for introspection'); } });
  for (const op of OPERATIONS) assert.equal((await offline('mcp_aql_read', { operation: 'introspect', params: { name: op.name } })).success, true);
  for (const type of TYPES) assert.equal((await offline('mcp_aql_read', { operation: 'introspect', params: { query: 'types', name: type.name } })).success, true);
  assert.equal((await offline('mcp_aql_update', { operation: 'introspect' })).error.code, 'VALIDATION_WRONG_ENDPOINT');
  assert.equal((await offline('mcp_aql_read', { operation: 'introspect', params: { query: 'operations', unknown: true } })).error.code, 'VALIDATION_UNKNOWN_PARAM');
  assert.equal((await offline('mcp_aql_read', { operation: 'introspect', params: null })).success, false);
  assert.equal((await offline('mcp_aql_read', { operation: 'introspect', parameters: { query: 'types' }, params: { query: 'operations' } })).data.operations.length, OPERATIONS.length);
  assert.equal((await offline('mcp_aql_read', { operation: 'introspect', params: { name: '\ud800' } })).error.code, 'VALIDATION_INVALID_ENCODING');
  assert.equal((await offline('mcp_aql_read', { operation: 'introspect', params: { name: 'x'.repeat(1048577) } })).error.code, 'VALIDATION_PAYLOAD_TOO_LARGE');
});
test('live source requests are fixed-origin and concurrent requests share one fetch', async () => {
  let calls = 0;
  const load = createSiteClient({ fetchImpl: async (url, options) => { calls++; assert.equal(url, 'https://electoralvotemap.com/'); assert.equal(options.redirect, 'error'); return new Response(fixture); } });
  const results = await Promise.all([load(), load(), load()]);
  assert.equal(calls, 1); assert.equal(results[0].source.mode, 'live');
  const failed = createSiteClient({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(failed(), { code: 'UPSTREAM_UNAVAILABLE' });
});
test('source ordering/allocations/schema drift is rejected rather than guessed', () => {
  for (const html of [fixture.replace('"AK": {', '"ZZ": {'), fixture.replace('"toWin": 270', '"toWin": 269'), '<html>No map</html>', fixture.replace('"ev": 3', '"ev": -3')]) {
    assert.throws(() => parseSite(html, {}), { code: 'UPSTREAM_CONTRACT_CHANGED' });
  }
});
