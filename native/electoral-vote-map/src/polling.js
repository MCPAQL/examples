// SPDX-License-Identifier: AGPL-3.0-only
import { AdapterError, requireValue, knownFields, baseMap, describeMap, changesBetween } from './map.js';

const ORIGIN = 'https://www.electoral-vote.com';
export const DATASETS = [
  { id: 'president_2024', office: 'president', election_year: 2024, path: '/evp2024/Pres/pres_polls.csv' },
  { id: 'senate_2024', office: 'senate', election_year: 2024, path: '/evp2024/Senate/senate_polls.csv' },
  { id: 'senate_2026', office: 'senate', election_year: 2026, path: '/evp2026/Senate/senate_polls.csv' },
].map(d => ({ ...d, url: ORIGIN + d.path }));
export const RECORD_KINDS = ['poll', 'historical_result', 'election_call', 'uncalled', 'unknown'];
// Source names have explicit identities, independent of the map codec's ordering.
const STATE_CODES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};
const STATES = Object.values(STATE_CODES);
const STATE_IDS = new Map(Object.entries(STATE_CODES).map(([name, code]) => [name.toLowerCase(), code]));
STATE_IDS.set('d.c.', 'DC');
const DAY = 86400000;
export function isoDate(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'as_of must be a valid YYYY-MM-DD date in UTC');
  const ms = Date.parse(value + 'T00:00:00Z');
  requireValue(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value, 'as_of must be a valid YYYY-MM-DD date in UTC');
  return ms;
}
const dateString = ms => new Date(ms).toISOString().slice(0, 10);
export function electionPhase(year, asOf) {
  const first = new Date(Date.UTC(year, 10, 1));
  const electionDay = Date.UTC(year, 10, 1 + ((8 - first.getUTCDay()) % 7) + 1);
  return { election_day: dateString(electionDay), phase: asOf < electionDay ? 'pre_election' : asOf === electionDay ? 'election_day' : 'post_election' };
}
function contract(condition, message) { requireValue(condition, message, 'UPSTREAM_CONTRACT_CHANGED'); }

// Bounded RFC 4180 reader: quoted commas/newlines and doubled quotes are preserved.
function csvRows(text) {
  contract(Buffer.byteLength(text) <= 2097152, 'Polling download exceeds 2 MiB');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; };
  const finishRow = () => { finishCell(); if (row.some(c => c.trim())) rows.push(row); row = []; contract(rows.length <= 10001, 'Too many polling records'); };
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',') finishCell();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; finishRow(); }
    else if (c === '"' && cell === '' && !closed) quoted = true;
    else { contract(!closed && c !== '"', 'Malformed quoted CSV field'); cell += c; }
  }
  contract(!quoted, 'Unterminated CSV quote');
  if (cell || row.length || closed) finishRow();
  return rows;
}
function recordKind(label) {
  if (/^Election\s+\d{4}$/i.test(label)) return 'historical_result';
  if (/^called for\s+\S/i.test(label)) return 'election_call';
  if (/^(?:not called|uncalled|too close to call)$/i.test(label)) return 'uncalled';
  if (!label || /\b(?:election|result|called|estimate|baseline|projection|forecast|average|model|certified|unofficial|exit poll|no poll|unopposed|primary|runoff)\b/i.test(label)) return 'unknown';
  return 'poll';
}
export function parsePollingCsv(text, dataset, source) {
  const rows = csvRows(text), header = rows.shift();
  contract(header?.length === 16 && header.slice(0, 8).join(',') === 'Day,Len,State,EV,Dem,GOP,Ind,Date' && header[15] === 'Pollster' && header.slice(8, 15).every(c => c === ''), 'Unexpected polling CSV header');
  const records = [], seen = new Set(); let duplicateRows = 0;
  for (const [index, fields] of rows.entries()) {
    contract(fields.length === 16, `Unexpected CSV width on data row ${index + 1}`);
    const values = fields.map(s => s.trim());
    const special = /-special$/i.test(values[2]), rawState = values[2].replace(/-special$/i, '');
    const state = STATE_IDS.get(rawState.toLowerCase());
    contract(state && !(dataset.office === 'president' && special), `Unknown state/race: ${values[2]}`);
    const length = Number(values[1]), middle = Number(values[0]);
    // An early-January poll can have a zero/negative midpoint relative to Jan 1.
    // The Len/Date cross-check below still rejects inconsistent negative values.
    contract(values[0] !== '' && values[1] !== '' && Number.isInteger(length) && length >= 1 && length <= 366 && Number.isFinite(middle) && middle >= 1 - (length - 1) / 2 && middle <= 366, 'Invalid polling date/length');
    const dateMatch = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/.exec(values[7]);
    contract(dateMatch, `Unknown source date: ${values[7]}`);
    const month = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').indexOf(dateMatch[1]);
    const end = Date.UTC(dataset.election_year, month, Number(dateMatch[2]));
    contract(new Date(end).getUTCMonth() === month && new Date(end).getUTCDate() === Number(dateMatch[2]), 'Invalid calendar date in polling source');
    const label = values[15].replace(new RegExp(`-${length}$`), '');
    contract(label.length > 0 && label.length <= 500, 'Invalid source label');
    const kind = recordKind(label);
    const shares = Object.fromEntries(['dem', 'rep', 'ind'].map((side, i) => {
      const value = values[i + 4] === '' ? null : Number(values[i + 4]);
      contract(value === null || (Number.isFinite(value) && value >= 0 && value <= 100), 'Invalid candidate percentage');
      return [side, value];
    }));
    const start = end - (length - 1) * DAY;
    // Day is authoritative for the site's averaging window; it must agree with Len/Date.
    contract(Math.abs((start + end) / (2 * DAY) - Date.UTC(dataset.election_year, 0, 1) / DAY + 1 - middle) <= 0.01, 'Midpoint disagrees with source dates');
    const record = {
      state, race_id: state + (special ? '-special' : ''), race_type: special ? 'special' : 'regular',
      office: dataset.office, election_year: dataset.election_year, kind,
      source_date: dateString(end), fieldwork_start: kind === 'poll' ? dateString(start) : null,
      fieldwork_end: kind === 'poll' ? dateString(end) : null,
      midpoint_day: middle, poll_length_days: kind === 'poll' ? length : null,
      shares, margin_dem_minus_rep: shares.dem === null || shares.rep === null ? null : shares.dem - shares.rep,
      label, pollster: kind === 'poll' ? label : null,
      result_year: kind === 'historical_result' ? Number(label.match(/\d{4}/)[0]) : null,
      candidate_matchup: null, sample_size: null, margin_of_error: null,
      source_row: index + 2,
    };
    const identity = JSON.stringify({ ...record, source_row: undefined });
    if (seen.has(identity)) { duplicateRows++; continue; } seen.add(identity); records.push(record);
  }
  contract(records.length > 0, 'Empty polling dataset');
  return {
    dataset: { id: dataset.id, office: dataset.office, election_year: dataset.election_year, url: dataset.url },
    records, duplicate_rows_removed: duplicateRows, source,
    notes: [
      'Dataset paths describe an election cycle, not freshness. A live file can contain election calls or historical fallback rows.',
      'Blank shares remain null. The archive does not supply candidate matchup, sample size or margin of error; these are not inferred.',
      'D/R are source column labels, not verified candidate party or caucus identities. Independents and candidate changes require external verification before substantive party predictions.',
      'Source dates for result/call rows are source markers, not certified election dates or publication timestamps.',
      'As-of queries filter source/fieldwork dates in the currently downloaded file; publication times and past file revisions are unavailable. This is not a point-in-time archive.',
      'Identical normalized rows are collapsed without source poll IDs. Distinct surveys with indistinguishable published fields cannot be distinguished; dataset_duplicate_rows_removed reports this dataset-wide ambiguity.',
    ],
  };
}
export function createPollingClient({ fetchImpl = fetch, fixtureCsv, now = () => new Date(), ttlMs = 300000 } = {}) {
  const cache = new Map(), pending = new Map();
  return async id => {
    const dataset = DATASETS.find(d => d.id === id);
    if (!dataset) throw new AdapterError('NOT_FOUND_RESOURCE', `Unknown polling dataset: ${id}; use list_poll_datasets`);
    if (cache.get(id)?.expires > now().getTime()) return cache.get(id).data;
    if (pending.has(id)) return pending.get(id);
    const request = (async () => {
      let text = fixtureCsv;
      if (text === undefined) {
        try {
          const response = await fetchImpl(dataset.url, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { accept: 'text/csv,text/plain,application/octet-stream', 'user-agent': 'MCPAQL-ElectoralVoteMap-Demo/0.2' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; text = '';
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              bytes += value.byteLength; if (bytes > 2097152) throw new Error('Polling download exceeds 2 MiB');
              text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
          } finally { await reader.cancel(); }
        } catch (error) { throw new AdapterError('UPSTREAM_UNAVAILABLE', `Could not read polling dataset: ${error.message}`); }
      }
      const data = parsePollingCsv(text, dataset, { url: dataset.url, retrieved_at: now().toISOString(), mode: fixtureCsv === undefined ? 'live' : 'test_fixture' });
      cache.set(id, { data, expires: now().getTime() + ttlMs }); return data;
    })();
    pending.set(id, request);
    try { return await request; } finally { pending.delete(id); }
  };
}
export function pollRecords(data, params) {
  const cutoff = isoDate(params.as_of);
  requireValue(/^[A-Z]{2}(?:-special)?$/.test(params.race_id) && STATES.includes(params.race_id.split('-')[0]), 'race_id must be a state ID with optional -special suffix; use dataset race_ids');
  const records = data.records.filter(r => r.race_id === params.race_id && isoDate(r.source_date) <= cutoff);
  const counts = Object.fromEntries(RECORD_KINDS.map(kind => [kind, records.filter(r => r.kind === kind).length]));
  return {
    dataset: data.dataset, race_id: params.race_id, as_of: params.as_of,
    ...electionPhase(data.dataset.election_year, cutoff), counts,
    coverage: records.length ? 'records_available' : 'no_records_as_of',
    records, dataset_duplicate_rows_removed: data.duplicate_rows_removed, source: data.source, notes: data.notes,
  };
}
export function pollAverage(data, params) {
  const view = pollRecords(data, params), cutoff = isoDate(params.as_of);
  const polls = view.records.filter(r => r.kind === 'poll' && r.margin_dem_minus_rep !== null);
  const latest = polls.length ? Math.max(...polls.map(r => r.midpoint_day)) : null;
  const windowPolls = polls.filter(r => r.midpoint_day >= latest - 7);
  const latestEnd = windowPolls.length ? Math.max(...windowPolls.map(r => isoDate(r.fieldwork_end))) : null;
  const age = latestEnd === null ? null : (cutoff - latestEnd) / DAY;
  const maxAge = params.max_age_days ?? 30;
  const average = field => windowPolls.reduce((total, r) => total + r.shares[field], 0) / windowPolls.length;
  const latestMarker = view.records.reduce((latest, r) => r.source_date > latest ? r.source_date : latest, '');
  const recentKinds = [...new Set(view.records.filter(r => r.source_date === latestMarker).map(r => r.kind))];
  const { records: _records, ...metadata } = view;
  return {
    ...metadata,
    polling_status: windowPolls.length ? age > maxAge ? 'stale' : 'fresh' : 'no_usable_polls',
    latest_record_kinds: recentKinds, latest_poll_end: latestEnd === null ? null : dateString(latestEnd),
    age_days: age, max_age_days: maxAge, poll_count: windowPolls.length,
    average: windowPolls.length ? { dem: average('dem'), rep: average('rep'), margin_dem_minus_rep: average('dem') - average('rep') } : null,
    excluded_unknown_labels: [...new Set(view.records.filter(r => r.kind === 'unknown').map(r => r.label))],
    method: 'Equal weight per distinct row within seven midpoint days of the most recent eligible poll. Non-poll records and missing D/R shares are excluded.',
    context_note: recentKinds.some(kind => kind !== 'poll')
      ? 'Other evidence is present on the latest source date. This remains a polls-only summary, not a claim about the current election outcome.'
      : 'A polling summary describes the selected source and cutoff, not a calibrated prediction.',
    included_polls: windowPolls, excluded_record_count: view.records.length - windowPolls.length,
  };
}
export function pollingScenario(data, params, mapData) {
  requireValue(params.race_ids.length > 0 && params.race_ids.length <= 51 && new Set(params.race_ids).size === params.race_ids.length, 'race_ids must contain 1–51 unique IDs');
  const units = params.race_ids.map(id => id.split('-')[0]);
  requireValue(new Set(units).size === units.length, 'Choose only one race per state; regular and special Senate races cannot silently be combined');
  const base = baseMap(params, mapData), ratings = { ...base.ratings };
  const crossElection = data.dataset.office !== 'president' || data.dataset.election_year !== mapData.year;
  requireValue(!crossElection || params.comparison_mode === 'hypothetical_cross_election', 'Source race/year differs from the map: explicitly choose hypothetical_cross_election');
  knownFields(params.rating_thresholds, ['toss_up_below', 'likely_from', 'safe_from'], 'rating_thresholds');
  const { toss_up_below: toss, likely_from: likely, safe_from: safe } = params.rating_thresholds;
  requireValue([toss, likely, safe].every(n => typeof n === 'number' && Number.isFinite(n)) && toss >= 0 && toss < likely && likely < safe && safe <= 100, 'Thresholds require 0 <= toss_up_below < likely_from < safe_from <= 100');
  const evidence = [];
  for (const race_id of params.race_ids) {
    const summary = pollAverage(data, { ...params, race_id }), unit = race_id.split('-')[0];
    let rating, decision = 'poll_average';
    if (summary.polling_status === 'no_usable_polls' || (summary.polling_status === 'stale' && params.stale_policy !== 'use')) {
      const policy = summary.polling_status === 'stale' ? params.stale_policy : params.unavailable_policy;
      requireValue(policy !== 'error', `${race_id}: ${summary.polling_status}`);
      decision = policy === 'keep' ? 'kept_base' : 'toss_up';
      if (policy === 'toss_up') rating = 'toss_up';
    } else {
      const margin = summary.average.margin_dem_minus_rep + (params.swing_points ?? 0);
      requireValue(margin >= -100 && margin <= 100, 'Swing produces a margin outside -100..100');
      const magnitude = Math.abs(margin), side = margin > 0 ? 'dem' : 'rep';
      rating = margin === 0 || magnitude < toss ? 'toss_up' : `${magnitude >= safe ? 'safe' : magnitude >= likely ? 'likely' : 'lean'}_${side}`;
      decision = summary.polling_status === 'stale' ? 'explicitly_used_stale_poll_average' : 'poll_average';
    }
    if (rating) {
      ratings[unit] = rating;
      if (params.district_policy === 'state_sweep') for (const district of mapData.order.filter(u => u.startsWith(`${unit}-`))) ratings[district] = rating;
    }
    evidence.push({ ...summary, decision, applied_rating: rating ?? null, applied_margin: decision.includes('poll_average') ? summary.average.margin_dem_minus_rep + (params.swing_points ?? 0) : null });
  }
  const map = { ...base, ratings };
  return {
    map: describeMap(map, mapData), base_url: describeMap(base, mapData).map_url, changes: changesBetween(base, map, mapData),
    polling: {
      dataset: data.dataset, source: data.source, as_of: params.as_of, comparison_mode: params.comparison_mode,
      hypothetical: crossElection, rating_thresholds: params.rating_thresholds, swing_points: params.swing_points ?? 0,
      district_policy: params.district_policy, stale_policy: params.stale_policy, unavailable_policy: params.unavailable_policy,
      evidence,
      interpretation: 'Polling margins mapped to explicit display thresholds, not calibrated win probabilities. Missing races keep/toss/error per policy; calls and historical results never substitute for polls. Source-era electoral votes are never reused.',
      sharing_note: 'The URL contains ratings and electoral allocation only; preserve this response for source evidence and assumptions.',
    },
  };
}
