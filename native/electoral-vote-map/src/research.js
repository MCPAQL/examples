// SPDX-License-Identifier: AGPL-3.0-only
import { knownFields, requireValue, UNIT_ORDER } from './map.js';
export const METRICS = ['senate_races_won', 'senate_delegation', 'house_seats_won'];
export function researchBrief(params, data) {
  const states = params.states || data.order.filter(u => u !== 'DC' && !u.includes('-'));
  requireValue(states.length > 0 && states.length <= 50 && new Set(states).size === states.length && states.every(u => UNIT_ORDER.includes(u) && u !== 'DC' && !u.includes('-')), 'states must be unique two-letter state IDs, excluding DC');
  return {
    metric: params.metric, election_year: params.election_year, states,
    research_owner: 'The connected AI uses its own web/search tools; this adapter does not contain a search service or model.',
    queries: states.map(state => ({ state, query: `${params.election_year} ${data.units[state].name} ${params.metric.replaceAll('_', ' ')} official election results Republican Democratic independent` })),
    source_guidance: [
      'Prefer state election offices for election winners, the House Clerk for House results, and Senate.gov for delegation membership.',
      'Distinguish Senate races won in an election from both sitting senators. Do not treat states with no Senate race as zero-seat ties.',
      'Record source URLs, a UTC as_of timestamp and whether each row is certified, projected or partial. Resolve independents explicitly; do not infer caucus affiliation.',
      'Research only the requested scope. Missing states keep the base map; DC has no voting House member or senators and remains unchanged.',
      'Ask for a mapping rule if ambiguous: this demo implements a hypothetical state plurality by seat/race count, not presidential results or vote-share swing.',
    ],
    next_operation: 'apply_election_results',
    required_decisions: {
      mapping_rule: 'state_plurality', tie_policy: ['error', 'keep', 'toss_up'],
      district_policy: ['state_sweep', 'preserve_districts'],
    },
    row_example: { state: 'MA', dem: 9, rep: 0, other: 0, status: 'certified', source_urls: ['https://www.sec.state.ma.us/'] },
    row_note: 'The row above illustrates the schema only; research the requested election and metric before supplying counts.',
  };
}
export function applyResults(base, params, data) {
  requireValue(params.mapping_rule === 'state_plurality', 'Only the explicit hypothetical state_plurality rule is supported');
  requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(params.as_of) && Number.isFinite(Date.parse(params.as_of)), 'as_of must be an ISO 8601 UTC timestamp');
  requireValue(params.rows.length > 0 && params.rows.length <= 50, 'rows must contain 1–50 researched states');
  const ratings = { ...base.ratings }, seen = new Set();
  for (const row of params.rows) {
    knownFields(row, ['state', 'dem', 'rep', 'other', 'status', 'source_urls'], 'result row');
    requireValue(typeof row.state === 'string' && data.order.includes(row.state) && row.state !== 'DC' && !row.state.includes('-'), `Invalid state: ${row.state}`);
    requireValue(!seen.has(row.state), `Duplicate result row: ${row.state}`); seen.add(row.state);
    const counts = ['dem', 'rep', 'other'].map(side => row[side]);
    requireValue(counts.every(n => Number.isSafeInteger(n) && n >= 0), 'Seat/race counts must be nonnegative integers');
    const total = counts.reduce((a, b) => a + b, 0);
    const max = params.metric === 'house_seats_won' ? 435 : 2;
    requireValue(total > 0 && total <= max && (params.metric !== 'senate_delegation' || total === 2), 'Counts are inconsistent with the requested congressional metric');
    requireValue(['certified', 'projected', 'partial'].includes(row.status), 'Each row needs a certified, projected or partial status');
    requireValue(Array.isArray(row.source_urls) && row.source_urls.length > 0 && row.source_urls.length <= 10 && row.source_urls.every(value => {
      if (typeof value !== 'string') return false;
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
    }), 'Each row requires 1–10 HTTPS source URLs (recorded, not fetched or independently verified)');
    const leaders = ['dem', 'rep', 'other'].filter((_, i) => counts[i] === Math.max(...counts));
    let rating;
    if (leaders.length > 1) {
      requireValue(params.tie_policy !== 'error', `Tied counts for ${row.state}; choose keep or toss_up to resolve`);
      if (params.tie_policy === 'keep') continue;
      rating = 'toss_up';
    } else rating = `safe_${leaders[0]}`;
    ratings[row.state] = rating;
    if (params.district_policy === 'state_sweep') {
      for (const unit of data.order.filter(u => u.startsWith(`${row.state}-`))) ratings[unit] = rating;
    }
  }
  return {
    map: { ...base, ratings },
    research: {
      metric: params.metric, election_year: params.election_year, as_of: params.as_of,
      mapping_rule: params.mapping_rule, tie_policy: params.tie_policy, district_policy: params.district_policy,
      rows: params.rows, verification: 'client_supplied_not_independently_verified',
      interpretation: 'Hypothetical map: the party with the most supplied seats/races receives the state electoral units under the selected district policy. Ratings encode assignments, not presidential predictions or confidence.',
      unchanged_scope: 'States absent from rows and DC retain the base map.',
      sharing_note: 'The clickable map URL carries ratings and allocation only. Keep this response with it to retain research sources and assumptions.',
    },
  };
}
