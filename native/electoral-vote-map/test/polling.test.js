// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAdapter } from '../src/adapter.js';
import { createSiteClient } from '../src/site.js';
import { DATASETS, parsePollingCsv, createPollingClient, pollAverage, pollRecords, classifyLabel } from '../src/polling.js';

const fixture = await readFile(new URL('./fixtures/polling.csv', import.meta.url), 'utf8');
const fixtureHtml = await readFile(new URL('./fixtures/site.html', import.meta.url), 'utf8');
const dataset = DATASETS[1], parsed = parsePollingCsv(fixture, dataset, { mode: 'test_fixture' });
const baseQuery = { dataset_id: dataset.id, race_id: 'PA', as_of: '2024-11-02' };
const dispatch = createAdapter({ loadSite: createSiteClient({ fixtureHtml }), loadPolling: createPollingClient({ fixtureCsv: fixture }) });
const invoke = (operation, params) => dispatch('mcp_aql_read', { operation, params });
const scenario = {
  dataset_id: 'senate_2024', as_of: '2024-11-02', race_ids: ['PA', 'MI', 'WI', 'ME'],
  comparison_mode: 'hypothetical_cross_election', rating_thresholds: { toss_up_below: 2, likely_from: 5, safe_from: 10 },
  swing_points: -2, stale_policy: 'error', unavailable_policy: 'keep', district_policy: 'preserve_districts', scenario_id: 'blue-wall',
};
test('parser preserves record kinds, blanks, historical year and regular/special race identity', () => {
  assert.equal(parsed.records.length, 13);
  assert.equal(parsed.records.find(r => r.race_id === 'MI').kind, 'uncalled');
  assert.equal(parsed.records.find(r => r.race_id === 'WI').kind, 'election_call');
  assert.equal(parsed.records.find(r => r.race_id === 'DE').result_year, 2018);
  assert.equal(parsed.records.find(r => r.race_id === 'GA').shares.dem, null);
  assert.equal(parsed.records[0].shares.ind, null);
  assert.equal(parsed.records[0].candidate_matchup, null);
  assert.equal(parsed.records.find(r => r.race_id === 'NE-special').race_type, 'special');
  assert.equal(parsed.records.find(r => r.race_id === 'TX').kind, 'unknown');
  assert.equal(parsed.records[1].pollster, 'Example, University');
});
test('seven-day midpoint window includes boundary and excludes old/future polls and results', () => {
  const result = pollAverage(parsed, baseQuery);
  assert.equal(result.poll_count, 2);
  assert.deepEqual(result.average, { dem: 51, rep: 47, margin_dem_minus_rep: 4 });
  assert.equal(result.phase, 'pre_election');
  assert.equal(result.election_day, '2024-11-05');
  assert.equal(result.polling_status, 'fresh');
  assert.equal(result.age_days, 0);
  assert.deepEqual(result.included_polls.map(r => r.midpoint_day), [306, 299]);
  assert.equal(pollAverage(parsed, { ...baseQuery, as_of: '2024-11-05' }).phase, 'election_day');
});
test('post-election result does not replace or contaminate polling average', () => {
  const result = pollAverage(parsed, { ...baseQuery, as_of: '2024-11-20' });
  assert.equal(result.phase, 'post_election');
  assert.deepEqual(result.latest_record_kinds, ['historical_result']);
  assert.equal(result.counts.historical_result, 1);
  assert.equal(result.included_polls.every(r => r.kind === 'poll'), true);
  assert.equal(result.polling_status, 'fresh');
  assert.match(result.notes.join(' '), /not a point-in-time archive/);
});
test('staleness uses as-of minus fieldwork end, not distance between polls or retrieval time', () => {
  const result = pollAverage(parsed, { ...baseQuery, as_of: '2026-11-14', max_age_days: 30 });
  assert.equal(result.polling_status, 'stale');
  assert.ok(result.age_days > 700);
  assert.equal(result.poll_count, 2);
});
test('call-only, uncalled, fallback, missing shares and absent races never become polls', () => {
  for (const race_id of ['WI', 'MI', 'DE', 'GA', 'CA', 'TX']) {
    const result = pollAverage(parsed, { ...baseQuery, race_id });
    assert.equal(result.polling_status, 'no_usable_polls', race_id);
    assert.equal(result.average, null, race_id);
  }
  const missing = pollRecords(parsed, { ...baseQuery, race_id: 'CA' });
  assert.equal(missing.coverage, 'no_records_as_of');
});
test('invalid dates, malformed CSV, source header drift and invalid fieldwork fail explicitly', () => {
  for (const as_of of ['2024-02-30', '2024-1-01', 'yesterday']) assert.throws(() => pollRecords(parsed, { ...baseQuery, as_of }));
  for (const csv of [fixture.replace('Day,Len,State', 'Date,Length,State'), fixture.replace('306,3,Pennsylvania', '303,3,Pennsylvania'), fixture.replace('52,46', '101,46'), fixture.replace('Pennsylvania', 'Imaginary State'), fixture + '"unterminated']) {
    assert.throws(() => parsePollingCsv(csv, dataset, {}), { code: 'UPSTREAM_CONTRACT_CHANGED' });
  }
});
test('exact duplicate observations are removed and counted once; different races remain separate', () => {
  const duplicate = parsePollingCsv(fixture + fixture.split('\n')[1] + '\n', dataset, {});
  assert.equal(duplicate.records.length, parsed.records.length);
  assert.equal(duplicate.duplicate_rows_removed, 1);
  assert.equal(pollAverage(duplicate, baseQuery).poll_count, 2);
  assert.equal(pollAverage(duplicate, baseQuery).dataset_duplicate_rows_removed, 1);
});
test('year-crossing fieldwork preserves zero/negative midpoints and cutoff filtering', () => {
  const winter = fixture.split('\n')[0] + '\n' + [
    '-1,5,Pennsylvania,,50,48,,Jan 01,,,,,,,,Winter One-5',
    '0,7,Pennsylvania,,51,47,,Jan 03,,,,,,,,Winter Two-7',
    '4,3,Pennsylvania,,52,46,,Jan 05,,,,,,,,Winter Three-3',
  ].join('\n');
  const data = parsePollingCsv(winter, dataset, {});
  assert.equal(data.records[0].fieldwork_start, '2023-12-28');
  assert.equal(data.records[0].fieldwork_end, '2024-01-01');
  assert.deepEqual(data.records.map(r => r.midpoint_day), [-1, 0, 4]);
  assert.equal(pollAverage(data, { ...baseQuery, as_of: '2024-01-05' }).poll_count, 3);
  assert.equal(pollAverage(data, { ...baseQuery, as_of: '2024-01-05' }).average.margin_dem_minus_rep, 4);
  assert.equal(pollAverage(data, { ...baseQuery, as_of: '2024-01-01' }).poll_count, 1);
  assert.throws(() => parsePollingCsv(winter.replace('-1,5', '-2,5'), dataset, {}), { code: 'UPSTREAM_CONTRACT_CHANGED' });
});
test('source state identities are explicit for names that differ from postal-code order', () => {
  const cases = [['Alaska', 'AK'], ['Alabama', 'AL'], ['Pennsylvania', 'PA'], ['D.C.', 'DC'], ['District of Columbia', 'DC'], ['Wyoming', 'WY']];
  for (const [name, code] of cases) {
    const data = parsePollingCsv(fixture.replace('Pennsylvania', name), dataset, {});
    assert.equal(data.records.find(r => r.source_row === 2).state, code, name);
  }
});
test('reviewed keyword-collision labels remain polls while ambiguous/status labels stay excluded', () => {
  for (const label of ['Election Data Services', 'Primary Source Research']) {
    const data = parsePollingCsv(fixture.replace('Example Research-3', `${label}-3`), dataset, {});
    const summary = pollAverage(data, baseQuery);
    assert.equal(summary.poll_count, 2);
    assert.equal(summary.included_polls[0].classification_reason, 'reviewed_pollster_label');
    assert.equal(summary.included_polls[0].raw_label, `${label}-3`);
  }
  for (const label of ['Election estimate', 'Primary forecast', 'Average', 'Model', 'Exit poll estimate', 'Unofficial results', 'Unopposed', 'Runoff result']) assert.equal(classifyLabel(label).kind, 'unknown', label);
  for (const [label, kind] of [['Election 2024', 'historical_result'], ['Called for Example (D)', 'election_call'], ['Not called', 'uncalled'], ['Too close to call', 'uncalled']]) assert.equal(classifyLabel(label).kind, kind);
  const data = parsePollingCsv(fixture.replace('Example Research-3', 'Election Something Ambiguous-3'), dataset, {});
  const summary = pollAverage(data, baseQuery);
  assert.deepEqual(summary.excluded_unknown_labels, ['Election Something Ambiguous']);
  assert.equal(summary.excluded_unknown_records[0].classification_reason, 'ambiguous_non_poll_keyword');
  assert.equal(summary.excluded_unknown_records[0].classification_confidence, 'unresolved');
  assert.equal(summary.excluded_unknown_records[0].source_row, 2);
});
test('CSV supports quoted newlines and doubled quotes without dropping record identity', () => {
  const modified = fixture.replace('"Example, University-3"', '"Example, ""Quoted""\nUniversity-3"');
  const parsed = parsePollingCsv(modified, dataset, {});
  assert.equal(parsed.records[1].pollster, 'Example, "Quoted"\nUniversity');
});
test('catalog reports per-source failure, rather than silently returning no polls', async () => {
  const local = createAdapter({ loadPolling: async id => { if (id === 'senate_2026') throw new Error('source offline'); return parsed; } });
  const result = await local('mcp_aql_read', { operation: 'list_poll_datasets' });
  assert.equal(result.success, true);
  assert.deepEqual(result.data.datasets.map(d => d.status), ['available', 'available', 'unavailable']);
  assert.match(result.data.datasets[2].error.message, /offline/);
});
test('poll queries operate independently of the map site and reject unknown parameters', async () => {
  const local = createAdapter({ loadSite: () => { throw new Error('map offline'); }, loadPolling: async () => parsed });
  assert.equal((await local('mcp_aql_read', { operation: 'get_poll_average', params: baseQuery })).success, true);
  assert.equal((await invoke('get_poll_average', { ...baseQuery, arbitrary: true })).error.code, 'VALIDATION_UNKNOWN_PARAM');
  assert.equal((await invoke('get_state_polls', { dataset_id: 'president_2024', race_id: 'PA' })).error.code, 'VALIDATION_MISSING_PARAM');
});
test('scenario requires cross-election acknowledgment and explicit policy choices', async () => {
  const result = await invoke('build_polling_scenario', { ...scenario, comparison_mode: 'same_race_year' });
  assert.equal(result.success, false);
  for (const key of ['rating_thresholds', 'stale_policy', 'unavailable_policy', 'district_policy']) {
    const params = { ...scenario }; delete params[key];
    assert.equal((await invoke('build_polling_scenario', params)).error.code, 'VALIDATION_MISSING_PARAM');
  }
});
test('scenario applies swing/thresholds and leaves result-only states and districts unchanged', async () => {
  const result = await invoke('build_polling_scenario', scenario);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.map.ratings.PA, 'lean_dem');
  assert.equal(result.data.polling.evidence.find(e => e.race_id === 'PA').applied_margin, 2);
  assert.equal(result.data.polling.evidence.find(e => e.race_id === 'MI').decision, 'kept_base');
  assert.equal(result.data.map.ratings['ME-1'], 'safe_dem');
  assert.equal(result.data.polling.hypothetical, true);
  assert.match(result.data.map.map_url, /^https:\/\/electoralvotemap.com/);
  assert.match(result.data.polling.interpretation, /never substitute/);
});
test('missing data can explicitly become toss-up, but cannot acquire a poll margin', async () => {
  const result = await invoke('build_polling_scenario', { ...scenario, unavailable_policy: 'toss_up', district_policy: 'state_sweep' });
  assert.equal(result.success, true);
  assert.equal(result.data.map.ratings.WI, 'toss_up');
  assert.equal(result.data.polling.evidence.find(e => e.race_id === 'WI').applied_margin, null);
  assert.equal(result.data.map.ratings['ME-2'], result.data.map.ratings.ME);
  assert.equal((await invoke('build_polling_scenario', { ...scenario, unavailable_policy: 'error' })).success, false);
});
test('stale polls require explicit use; keep/toss/error decisions stay distinct', async () => {
  const params = { ...scenario, race_ids: ['PA'], as_of: '2026-11-14' };
  assert.equal((await invoke('build_polling_scenario', params)).success, false);
  const kept = await invoke('build_polling_scenario', { ...params, stale_policy: 'keep' });
  assert.equal(kept.data.polling.evidence[0].decision, 'kept_base');
  const tossed = await invoke('build_polling_scenario', { ...params, stale_policy: 'toss_up' });
  assert.equal(tossed.data.polling.evidence[0].applied_margin, null);
  const used = await invoke('build_polling_scenario', { ...params, stale_policy: 'use' });
  assert.equal(used.data.polling.evidence[0].decision, 'explicitly_used_stale_poll_average');
});
test('special races cannot be merged into one state and thresholds/units are validated', async () => {
  for (const patch of [
    { race_ids: ['NE', 'NE-special'] }, { race_ids: [] }, { race_ids: ['XX'] },
    { rating_thresholds: { toss_up_below: 5, likely_from: 2, safe_from: 10 } },
    { rating_thresholds: { toss_up_below: 2, likely_from: 5, safe_from: 10, unknown: 1 } },
    { swing_points: 101 },
  ]) assert.equal((await invoke('build_polling_scenario', { ...scenario, ...patch })).success, false, JSON.stringify(patch));
});
test('source client uses only fixed catalog URLs, coalesces reads and expires cache', async () => {
  let calls = 0, clock = new Date('2026-11-14T00:00:00Z');
  const load = createPollingClient({ now: () => clock, ttlMs: 1000, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, dataset.url); assert.equal(options.redirect, 'error'); return new Response(fixture);
  } });
  await Promise.all([load(dataset.id), load(dataset.id)]); assert.equal(calls, 1);
  clock = new Date(clock.getTime() + 1001); await load(dataset.id); assert.equal(calls, 2);
  await assert.rejects(load('https://evil.example'), { code: 'NOT_FOUND_RESOURCE' });
  const failed = createPollingClient({ fetchImpl: async () => new Response('offline', { status: 503 }) });
  await assert.rejects(failed(dataset.id), { code: 'UPSTREAM_UNAVAILABLE' });
});

test('quarantine preserves accepted rows and bounded rejection reasons without claiming complete race coverage', () => {
  const damaged = fixture.replace('52,46', '101,46').replace('Michigan', 'Imaginary State');
  assert.throws(() => parsePollingCsv(damaged, dataset, {}), { code: 'UPSTREAM_CONTRACT_CHANGED' });
  const data = parsePollingCsv(damaged, dataset, {}, { row_policy: 'quarantine' });
  assert.equal(data.quality.accepted_row_count, 11);
  assert.equal(data.quality.rejected_row_count, 2);
  assert.equal(data.quality.total_row_count, 13);
  assert.deepEqual(data.quality.rejected_rows, [
    { source_row: 2, race_id: 'PA', reason: 'invalid_percentage' },
    { source_row: 7, race_id: null, reason: 'unknown_state_or_race' },
  ]);
  const view = pollRecords(data, { ...baseQuery, race_id: 'CA' });
  assert.equal(view.coverage, 'partial_dataset');
  assert.equal(view.quality.selected_race_coverage, 'uncertain');
  assert.throws(() => pollAverage(data, baseQuery), /incomplete_policy/);
  assert.equal(pollAverage(data, { ...baseQuery, incomplete_policy: 'use_accepted' }).poll_count, 2);
  // Reject diagnostics count all bad records but disclose only the first 100 references.
  const line = fixture.split('\n')[1].replace('52,46', '101,46');
  const many = parsePollingCsv(fixture + (line + '\n').repeat(110), dataset, {}, { row_policy: 'quarantine' });
  assert.equal(many.quality.rejected_row_count, 110);
  assert.equal(many.quality.rejected_rows.length, 100);
  assert.equal(many.quality.rejections_truncated, true);
});

test('quarantine never masks structural errors, limits or invalid UTF-8 downloads', async () => {
  for (const text of [fixture + '\n"unterminated', fixture.replace('Day,Len', 'Date,Length'), fixture + '\n1,2,3', 'x'.repeat(2097153)]) {
    assert.throws(() => parsePollingCsv(text, dataset, {}, { row_policy: 'quarantine' }), { code: 'UPSTREAM_CONTRACT_CHANGED' });
  }
  const load = createPollingClient({ fetchImpl: async () => new Response(new Uint8Array([0xff, 0xfe])) });
  await assert.rejects(load(dataset.id, { row_policy: 'quarantine' }), { code: 'UPSTREAM_UNAVAILABLE' });
});

test('partial polling maps require explicit use, keep or toss and preserve quality in evidence', async () => {
  const local = createAdapter({ loadSite: createSiteClient({ fixtureHtml }), loadPolling: createPollingClient({ fixtureCsv: fixture.replace('52,46', '101,46') }) });
  const call = (operation, params) => local('mcp_aql_read', { operation, params });
  const params = { ...scenario, row_policy: 'quarantine', race_ids: ['PA'] };
  assert.equal((await call('get_state_polls', baseQuery)).error.code, 'UPSTREAM_CONTRACT_CHANGED');
  const catalog = await call('list_poll_datasets', { row_policy: 'quarantine' });
  assert.equal(catalog.data.datasets[1].status, 'partial');
  assert.equal((await call('get_state_polls', { ...baseQuery, row_policy: 'quarantine' })).data.quality.coverage, 'partial');
  assert.equal((await call('get_poll_average', { ...baseQuery, row_policy: 'quarantine' })).success, false);
  assert.equal((await call('build_polling_scenario', params)).success, false);
  for (const incomplete_policy of ['keep', 'toss_up', 'use_accepted']) {
    const result = await call('build_polling_scenario', { ...params, incomplete_policy });
    assert.equal(result.success, true, JSON.stringify(result));
    const evidence = result.data.polling.evidence[0];
    assert.equal(evidence.quality.rejected_row_count, 1);
    assert.equal(result.data.polling.incomplete_policy, incomplete_policy);
    if (incomplete_policy === 'use_accepted') assert.ok(evidence.average);
    else { assert.equal(evidence.average, null); assert.equal(evidence.applied_margin, null); }
    if (incomplete_policy === 'keep') assert.equal(result.data.changes.length, 0);
    if (incomplete_policy === 'toss_up') assert.equal(result.data.map.ratings.PA, 'toss_up');
  }
});

test('duplicate policies preserve every row reference and separate dataset, race and window counts', async () => {
  const lines = fixture.split('\n');
  const repeated = fixture + lines[1] + '\n' + lines[1] + '\n' + lines[7] + '\n';
  const data = parsePollingCsv(repeated, dataset, {});
  const collapsed = pollAverage(data, baseQuery);
  assert.equal(collapsed.poll_count, 2);
  assert.equal(collapsed.average.margin_dem_minus_rep, 4);
  assert.equal(collapsed.dataset_indistinguishable_rows, 3);
  assert.equal(collapsed.race_duplicate_rows, 2);
  assert.equal(collapsed.included_duplicate_rows, 2);
  assert.deepEqual(collapsed.included_polls[0].source_rows, [2, 15, 16]);
  assert.deepEqual(collapsed.duplicate_groups[0].source_rows, [2, 15, 16]);
  const kept = pollAverage(data, { ...baseQuery, duplicate_policy: 'keep_all' });
  assert.equal(kept.poll_count, 4);
  assert.equal(kept.average.margin_dem_minus_rep, 5);
  assert.equal(kept.dataset_duplicate_rows_removed, 0);
  assert.equal(kept.included_duplicate_rows, 2);
  assert.deepEqual(kept.included_polls.map(r => r.source_row), [2, 15, 16, 3]);
  const earlier = pollAverage(data, { ...baseQuery, as_of: '2024-10-26', duplicate_policy: 'keep_all' });
  assert.equal(earlier.race_duplicate_rows, 0);
  assert.equal(earlier.included_duplicate_rows, 0);
  assert.equal(earlier.dataset_indistinguishable_rows, 3);
  assert.equal(pollRecords(data, { ...baseQuery, race_id: 'NE-special' }).race_duplicate_rows, 0);
  const local = createAdapter({ loadSite: createSiteClient({ fixtureHtml }), loadPolling: createPollingClient({ fixtureCsv: repeated }) });
  const result = await local('mcp_aql_read', { operation: 'build_polling_scenario', params: { ...scenario, race_ids: ['PA'], duplicate_policy: 'keep_all' } });
  assert.equal(result.data.polling.duplicate_policy, 'keep_all');
  assert.equal(result.data.polling.evidence[0].poll_count, 4);
});

test('source references survive blank records and quoted multiline CSV fields', () => {
  const data = parsePollingCsv(fixture.replace('306,3,Pennsylvania', '\n306,3,Pennsylvania'), dataset, {});
  assert.equal(data.records[0].source_row, 3);
  assert.deepEqual(data.records[0].source_rows, [3]);
});

test('polling failures cool down and strict/quarantine policy changes share one fetch', async () => {
  let calls = 0, clock = new Date('2026-11-14T00:00:00Z');
  const load = createPollingClient({ now: () => clock, failureTtlMs: 1000, fetchImpl: async () => { calls++; return new Response('offline', { status: 503 }); } });
  for (let i = 0; i < 5; i++) await assert.rejects(load(dataset.id));
  assert.equal(calls, 1);
  clock = new Date(clock.getTime() + 1001);
  await assert.rejects(load(dataset.id));
  assert.equal(calls, 2);
  calls = 0;
  const partial = createPollingClient({ fetchImpl: async () => { calls++; return new Response(fixture.replace('52,46', '101,46')); } });
  await assert.rejects(partial(dataset.id));
  assert.equal((await partial(dataset.id, { row_policy: 'quarantine' })).quality.rejected_row_count, 1);
  await assert.rejects(partial(dataset.id));
  assert.equal(calls, 1);
});

test('duplicate groups retain each raw label and restore it for records and contributing polls', async () => {
  const first = fixture.split('\n')[1];
  const labels = ['Example Research-3', 'Example Research', '  Example Research-3  '];
  const text = fixture + first.replace(labels[0], labels[1]) + '\n' + first.replace(labels[0], labels[2]) + '\n';
  const data = parsePollingCsv(text, dataset, {});
  const provenance = labels.map((raw_label, i) => ({ source_row: [2, 15, 16][i], raw_label }));
  assert.deepEqual(data.records[0].source_labels, provenance);
  const collapsed = pollAverage(data, baseQuery);
  assert.equal(collapsed.poll_count, 2);
  assert.deepEqual(collapsed.included_polls[0].source_labels, provenance);
  assert.deepEqual(collapsed.duplicate_groups[0].source_labels, provenance);
  const kept = pollAverage(data, { ...baseQuery, duplicate_policy: 'keep_all' });
  assert.equal(kept.poll_count, 4);
  assert.deepEqual(kept.included_polls.slice(0, 3).map(r => r.raw_label), labels);
  assert.deepEqual(kept.included_polls.slice(0, 3).map(r => r.source_labels), provenance.map(row => [row]));
  const local = createAdapter({ loadPolling: createPollingClient({ fixtureCsv: text }) });
  const result = await local('mcp_aql_read', { operation: 'get_state_polls', params: { ...baseQuery, duplicate_policy: 'keep_all' } });
  assert.equal(result.success, true);
  assert.deepEqual(result.data.records.slice(0, 3).map(r => r.raw_label), labels);
});
