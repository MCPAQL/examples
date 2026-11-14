// SPDX-License-Identifier: AGPL-3.0-only
import { AdapterError, requireValue, knownFields, baseMap, describeMap, changesBetween } from './map.js';
import { createSourceCache } from './source-cache.js';
import { sourceTime } from './source-timing.js';

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
  const rows = []; let sourceRow = 1; let row = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; };
  const finishRow = () => { finishCell(); row.source_row = sourceRow++; if (row.some(c => c.trim())) rows.push(row); row = []; contract(rows.length <= 10001, 'Too many polling records'); };
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
// These exact label interpretations only resolve keyword collisions. They are not
// certification of the organization, survey methods, or candidate identities.
const REVIEWED_LABELS = new Set(['election data services', 'primary source research']);
export function classifyLabel(label) {
  const result = (kind, classification_reason, classification_confidence = 'source_label') => ({ kind, classification_reason, classification_confidence });
  if (/^Election\s+\d{4}$/i.test(label)) return result('historical_result', 'explicit_historical_result');
  if (/^called for\s+\S/i.test(label)) return result('election_call', 'explicit_call');
  if (/^(?:not called|uncalled|too close to call)$/i.test(label)) return result('uncalled', 'explicit_uncalled');
  if (REVIEWED_LABELS.has(label.toLowerCase())) return result('poll', 'reviewed_pollster_label', 'label_only');
  if (!label || /\b(?:election|result|called|estimate|baseline|projection|forecast|average|model|certified|unofficial|exit poll|no poll|unopposed|primary|runoff)\b/i.test(label)) return result('unknown', 'ambiguous_non_poll_keyword', 'unresolved');
  return result('poll', 'pollster_label_convention', 'label_only');
}
export function parsePollingCsv(text, dataset, source, { row_policy = 'strict' } = {}) {
  requireValue(['strict', 'quarantine'].includes(row_policy), 'Invalid row_policy');
  const rows = csvRows(text), header = rows.shift();
  contract(header?.length === 16 && header.slice(0, 8).join(',') === 'Day,Len,State,EV,Dem,GOP,Ind,Date' && header[15] === 'Pollster' && header.slice(8, 15).every(c => c === ''), 'Unexpected polling CSV header');
  contract(rows.length > 0, 'Empty polling dataset');
  const records = [], seen = new Map(), rejected = [], affected = new Set();
  let duplicateRows = 0, rejectedCount = 0, unknownRaceRejections = 0;
  for (const [index, fields] of rows.entries()) {
    contract(fields.length === 16, `Unexpected CSV width on data row ${index + 1}`);
    const values = fields.map(s => s.trim());
    const special = /-special$/i.test(values[2]), rawState = values[2].replace(/-special$/i, '');
    const state = STATE_IDS.get(rawState.toLowerCase());
    let reason = 'invalid_fieldwork';
    const reject = (condition, code, message) => { reason = code; contract(condition, message); };
    try {
      reject(state && !(dataset.office === 'president' && special), 'unknown_state_or_race', 'Unknown state/race identity');
      const length = Number(values[1]), middle = Number(values[0]);
      // An early-January poll can have a zero/negative midpoint relative to Jan 1.
      // The Len/Date cross-check below still rejects inconsistent negative values.
      reject(values[0] !== '' && values[1] !== '' && Number.isInteger(length) && length >= 1 && length <= 366 && Number.isFinite(middle) && middle >= 1 - (length - 1) / 2 && middle <= 366, 'invalid_fieldwork', 'Invalid polling date/length');
      const dateMatch = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/.exec(values[7]);
      reject(dateMatch, 'invalid_source_date', 'Unknown source date');
      const month = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').indexOf(dateMatch[1]);
      const end = Date.UTC(dataset.election_year, month, Number(dateMatch[2]));
      reject(new Date(end).getUTCMonth() === month && new Date(end).getUTCDate() === Number(dateMatch[2]), 'invalid_source_date', 'Invalid calendar date in polling source');
      const label = values[15].replace(new RegExp(`-${length}$`), '');
      reject(label.length > 0 && label.length <= 500 && fields[15].length <= 510, 'invalid_label', 'Invalid source label');
      const classification = classifyLabel(label), { kind } = classification;
      const shares = Object.fromEntries(['dem', 'rep', 'ind'].map((side, i) => {
        const value = values[i + 4] === '' ? null : Number(values[i + 4]);
        reject(value === null || (Number.isFinite(value) && value >= 0 && value <= 100), 'invalid_percentage', 'Invalid candidate percentage');
        return [side, value];
      }));
      const start = end - (length - 1) * DAY;
      // Day is authoritative for the site's averaging window; it must agree with Len/Date.
      reject(Math.abs((start + end) / (2 * DAY) - Date.UTC(dataset.election_year, 0, 1) / DAY + 1 - middle) <= 0.01, 'inconsistent_midpoint', 'Midpoint disagrees with source dates');
      const record = {
        state, race_id: state + (special ? '-special' : ''), race_type: special ? 'special' : 'regular',
        office: dataset.office, election_year: dataset.election_year, kind,
        source_date: dateString(end), fieldwork_start: kind === 'poll' ? dateString(start) : null,
        fieldwork_end: kind === 'poll' ? dateString(end) : null,
        midpoint_day: middle, poll_length_days: kind === 'poll' ? length : null,
        shares, margin_dem_minus_rep: shares.dem === null || shares.rep === null ? null : shares.dem - shares.rep,
        ...classification, raw_label: fields[15], label, pollster: kind === 'poll' ? label : null,
        result_year: kind === 'historical_result' ? Number(label.match(/\d{4}/)[0]) : null,
        candidate_matchup: null, sample_size: null, margin_of_error: null,
        source_row: fields.source_row,
      };
      const identity = JSON.stringify({ ...record, source_row: undefined, raw_label: undefined });
      const sourceLabel = { source_row: record.source_row, raw_label: record.raw_label };
      if (seen.has(identity)) {
        const group = seen.get(identity);
        group.source_rows.push(record.source_row);
        group.source_labels.push(sourceLabel);
        duplicateRows++;
        continue;
      }
      record.source_rows = [record.source_row];
      record.source_labels = [sourceLabel];
      record.source_group_id = `${dataset.id}:row:${record.source_row}`;
      seen.set(identity, record); records.push(record);
    } catch (error) {
      if (row_policy === 'strict') throw error;
      if (!(error instanceof AdapterError) || error.code !== 'UPSTREAM_CONTRACT_CHANGED') throw error;
      rejectedCount++;
      const race_id = state && !(dataset.office === 'president' && special) ? state + (special ? '-special' : '') : null;
      if (race_id) affected.add(race_id); else unknownRaceRejections++;
      if (rejected.length < 100) rejected.push({ source_row: fields.source_row, race_id, reason });
    }
  }
  return {
    dataset: { id: dataset.id, office: dataset.office, election_year: dataset.election_year, url: dataset.url },
    records, duplicate_rows_removed: duplicateRows, source,
    quality: { row_policy, coverage: rejectedCount ? 'partial' : 'complete', total_row_count: rows.length, accepted_row_count: rows.length - rejectedCount, rejected_row_count: rejectedCount, rejected_rows: rejected, rejections_truncated: rejectedCount > rejected.length, affected_race_ids: [...affected], unknown_race_rejections: unknownRaceRejections },
    notes: [
      'Dataset paths describe an election cycle, not freshness. A live file can contain election calls or historical fallback rows.',
      'Blank shares remain null. The archive does not supply candidate matchup, sample size or margin of error; these are not inferred.',
      'D/R are source column labels, not verified candidate party or caucus identities. Independents and candidate changes require external verification before substantive party predictions.',
      'Source dates for result/call rows are source markers, not certified election dates or publication timestamps.',
      'As-of queries filter source/fieldwork dates in the currently downloaded file; publication times and past file revisions are unavailable. This is not a point-in-time archive.',
      'No survey IDs are supplied. Identical published fields do not prove survey identity. source_group_id identifies a group in this download, not a stable upstream survey. source_rows preserves every accepted source reference.',
    ],
  };
}
export function createPollingClient({ fetchImpl = fetch, fixtureCsv, now = () => new Date(), ttlMs = 300000, failureTtlMs = 30000 } = {}) {
  const load = createSourceCache(async id => {
    const dataset = DATASETS.find(d => d.id === id);
    let text = fixtureCsv, retrievedAt;
    if (text === undefined) {
      try {
        const response = await fetchImpl(dataset.url, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { accept: 'text/csv,text/plain,application/octet-stream', 'user-agent': 'MCPAQL-ElectoralVoteMap-Demo/0.2' } });
        retrievedAt = sourceTime(response);
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
    // Parse once per download. Policy changes reuse the same data and never
    // multiply upstream reads. Strict callers still fail on any rejected row.
    return parsePollingCsv(text, dataset, { url: dataset.url, retrieved_at: retrievedAt ?? now().toISOString(), mode: fixtureCsv === undefined ? 'live' : 'test_fixture' }, { row_policy: 'quarantine' });
  }, { now, ttlMs, failureTtlMs, expiresAt: data => Date.parse(data.source.retrieved_at) + ttlMs });
  return async (id, { row_policy = 'strict' } = {}) => {
    if (!DATASETS.some(d => d.id === id)) throw new AdapterError('NOT_FOUND_RESOURCE', `Unknown polling dataset: ${id}; use list_poll_datasets`);
    requireValue(['strict', 'quarantine'].includes(row_policy), 'Invalid row_policy');
    const data = await load(id);
    if (row_policy === 'strict' && data.quality.rejected_row_count) throw new AdapterError('UPSTREAM_CONTRACT_CHANGED', 'Polling dataset contains invalid rows; strict policy rejects the dataset');
    return { ...data, quality: { ...data.quality, row_policy } };
  };
}
export function pollRecords(data, params) {
  const cutoff = isoDate(params.as_of);
  requireValue(/^[A-Z]{2}(?:-special)?$/.test(params.race_id) && STATES.includes(params.race_id.split('-')[0]), 'race_id must be a state ID with optional -special suffix; use dataset race_ids');
  const duplicate_policy = params.duplicate_policy ?? 'collapse_indistinguishable';
  requireValue(['collapse_indistinguishable', 'keep_all'].includes(duplicate_policy), 'Invalid duplicate_policy');
  const groups = data.records.filter(r => r.race_id === params.race_id && isoDate(r.source_date) <= cutoff);
  const records = duplicate_policy === 'keep_all' ? groups.flatMap(r => r.source_labels.map(label => ({ ...r, source_row: label.source_row, raw_label: label.raw_label, source_rows: [label.source_row], source_labels: [label] }))) : groups;
  const counts = Object.fromEntries(RECORD_KINDS.map(kind => [kind, records.filter(r => r.kind === kind).length]));
  const partial = data.quality?.coverage === 'partial';
  return {
    dataset: data.dataset, race_id: params.race_id, as_of: params.as_of,
    ...electionPhase(data.dataset.election_year, cutoff), counts,
    coverage: partial ? 'partial_dataset' : records.length ? 'records_available' : 'no_records_as_of',
    quality: { ...data.quality, selected_race_coverage: data.quality?.unknown_race_rejections ? 'uncertain' : data.quality?.affected_race_ids.includes(params.race_id) ? 'partial' : 'no_known_rejections' },
    duplicate_policy, dataset_indistinguishable_rows: data.duplicate_rows_removed,
    dataset_duplicate_rows_removed: duplicate_policy === 'keep_all' ? 0 : data.duplicate_rows_removed,
    race_duplicate_rows: groups.reduce((n, r) => n + (r.source_rows?.length ?? 1) - 1, 0),
    duplicate_groups: groups.filter(r => r.source_rows?.length > 1).map(r => ({ source_group_id: r.source_group_id, source_rows: r.source_rows, source_labels: r.source_labels, race_id: r.race_id, source_date: r.source_date })),
    records, source: data.source, notes: data.notes,
  };
}
export function pollAverage(data, params) {
  const view = pollRecords(data, params), cutoff = isoDate(params.as_of);
  const partial = view.quality.coverage === 'partial', incomplete_policy = params.incomplete_policy ?? 'error';
  requireValue(!partial || ['use_accepted', 'keep', 'toss_up'].includes(incomplete_policy), 'Partial dataset: choose an explicit incomplete_policy before calculating an average');
  const withheld = partial && incomplete_policy !== 'use_accepted';
  const polls = (withheld ? [] : view.records).filter(r => r.kind === 'poll' && r.margin_dem_minus_rep !== null);
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
    incomplete_policy,
    polling_status: withheld ? 'incomplete_data' : windowPolls.length ? age > maxAge ? 'stale' : 'fresh' : 'no_usable_polls',
    latest_record_kinds: recentKinds, latest_poll_end: latestEnd === null ? null : dateString(latestEnd),
    age_days: age, max_age_days: maxAge, poll_count: windowPolls.length,
    average: windowPolls.length ? { dem: average('dem'), rep: average('rep'), margin_dem_minus_rep: average('dem') - average('rep') } : null,
    excluded_unknown_labels: [...new Set(view.records.filter(r => r.kind === 'unknown').map(r => r.label))].slice(0, 100),
    excluded_unknown_records: view.records.filter(r => r.kind === 'unknown').slice(0, 100).map(r => ({ label: r.label, raw_label: r.raw_label, classification_reason: r.classification_reason, classification_confidence: r.classification_confidence, source_row: r.source_row, source_group_id: r.source_group_id })),
    unknown_exclusions_truncated: view.records.filter(r => r.kind === 'unknown').length > 100,
    included_duplicate_rows: view.duplicate_policy === 'keep_all' ? windowPolls.length - new Set(windowPolls.map(r => r.source_group_id)).size : windowPolls.reduce((n, r) => n + (r.source_rows?.length ?? 1) - 1, 0),
    method: withheld ? 'Average withheld because the dataset is incomplete.' : `Equal weight per ${view.duplicate_policy === 'keep_all' ? 'source row' : 'indistinguishable published-field group'} within seven midpoint days of the latest eligible poll; non-polls and missing D/R shares excluded.`,
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
    if (summary.polling_status === 'incomplete_data') {
      decision = params.incomplete_policy === 'keep' ? 'kept_base_incomplete' : 'toss_up_incomplete';
      if (params.incomplete_policy === 'toss_up') rating = 'toss_up';
    } else if (summary.polling_status === 'no_usable_polls' || (summary.polling_status === 'stale' && params.stale_policy !== 'use')) {
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
      row_policy: data.quality?.row_policy ?? 'strict', incomplete_policy: params.incomplete_policy ?? 'error', duplicate_policy: params.duplicate_policy ?? 'collapse_indistinguishable',
      quality: data.quality, evidence,
      interpretation: 'Polling margins mapped to explicit display thresholds, not calibrated win probabilities. Missing races keep/toss/error per policy; calls and historical results never substitute for polls. Source-era electoral votes are never reused.',
      sharing_note: 'The URL contains ratings and electoral allocation only; preserve this response for source evidence and assumptions.',
    },
  };
}
