// SPDX-License-Identifier: AGPL-3.0-only
import { AdapterError, RATINGS, object, requireValue, baseMap, describeMap, modifyMap, changesBetween } from './map.js';
import { createSiteClient } from './site.js';
import { researchBrief, applyResults, METRICS } from './research.js';
import { DATASETS, RECORD_KINDS, createPollingClient, pollRecords, pollAverage, pollingScenario } from './polling.js';

const p = (type, description, required = false, extra = {}) => ({ type, description, required, ...extra });
const baseParams = {
  scenario_id: p('string', 'A live site scenario ID from list_scenarios; defaults to current. Mutually exclusive with map_url.'),
  map_url: p('string', 'Full https://electoralvotemap.com/?map=YEAR:CODE share URL. Parsed locally, never fetched.'),
  electoral_allocation: p('string', 'Override current or projected 2032 allocation independently of the map election year.', false, { enum: ['current', 'projected_2032'] }),
};
const metricParams = {
  metric: p('string', 'Congressional measure; races won and sitting delegations have distinct meanings.', true, { enum: METRICS }),
  election_year: p('integer', 'Year of researched election or delegation snapshot; does not change presidential map year.', true, { minimum: 1789, maximum: 2100 }),
};
const rowPolicy = p('string', 'strict (default) fails on any invalid row; quarantine returns accepted rows with explicit partial coverage and rejected-row reasons. Structural file errors always fail.', false, { enum: ['strict', 'quarantine'] });
const incompletePolicy = p('string', 'error (default) rejects partial datasets; use_accepted explicitly permits incomplete evidence.', false, { enum: ['error', 'use_accepted'] });
const pollingParams = {
  row_policy: rowPolicy,
  duplicate_policy: p('string', 'collapse_indistinguishable (default) gives each published-field group one vote; keep_all gives each source row equal weight. Neither proves survey identity.', false, { enum: ['collapse_indistinguishable', 'keep_all'] }),
  dataset_id: p('string', 'Verified source dataset ID from list_poll_datasets. Race and election year remain distinct from the map.', true),
  as_of: p('string', 'Required YYYY-MM-DD UTC cutoff on source/fieldwork dates. Publication timestamps are unavailable; this is not a point-in-time archive.', true),
};
const averageParams = {
  ...pollingParams, incomplete_policy: incompletePolicy,
  race_id: p('string', 'Two-letter state ID; -special identifies a separate Senate race. Discover race_ids with list_poll_datasets.', true),
  max_age_days: p('integer', 'Maximum age since the latest included poll ended. Default 30; freshness is independent of the seven-day averaging window.', false, { minimum: 0, maximum: 3650 }),
};
const definitions = [
  ['introspect', 'Discover operations, parameters, examples and domain types without contacting the website.', {
    query: p('string', 'Discovery query; defaults to operations.', false, { enum: ['operations', 'types'] }),
    name: p('string', 'Optional operation/type name for complete details.'),
  }, 'Discovery', { query: 'operations' }],
  ['list_scenarios', 'Connect to Electoral Vote Map and discover its current forecast and named What If scenarios, each with totals and a clickable URL.', {}, 'ScenarioCatalog', {}],
  ['get_map', 'Inspect a site scenario or supplied map URL: ratings, totals, electoral allocation and clickable map.', baseParams, 'Map', { scenario_id: 'blue-wall' }],
  ['list_units', 'Discover electoral unit IDs, names and current/projected votes; ME and NE statewide units have two votes and districts are separate.', {}, 'UnitCatalog', {}],
  ['modify_map', 'Evaluate explicit unit edits or D/R flips and return a new clickable map. No saved map, browser or site state is modified. Choose unexpected states in the AI, then supply edits.', {
    ...baseParams, edits: p('array', '1–56 unique {unit, rating} or {unit, flip:true} edits. ME/NE affect statewide votes only; edit their districts explicitly for a sweep.', true, { items: { type: 'object' } }),
  }, 'ScenarioChange', { scenario_id: 'blue-wall', edits: [{ unit: 'MA', flip: true }, { unit: 'SC', flip: true }] }],
  ['compare_maps', 'Compare two share URLs, separating rating changes from electoral allocation changes.', {
    left_url: p('string', 'First full map URL.', true), right_url: p('string', 'Second full map URL.', true),
  }, 'MapComparison', { left_url: 'https://electoralvotemap.com/?map=2028:RRRRDDDDDRRDRRDRRRRDDDDRDDRRRRRRRDRDDDRDRRDDDRRRRRDDDDRR', right_url: 'https://electoralvotemap.com/?map=2028:RRRRDDDDDRRDRRDRRRRDDDDRDDRRRRRRRDRDDDRDRRDDDRRRRRDDDDRR&ev=2032' }],
  ['get_research_brief', 'Prepare a research handoff for the connected AI to find congressional results with its own search tools, then apply them to a map.', {
    ...metricParams, states: p('array', 'Optional unique two-letter states to research; excludes DC and district IDs.', false, { items: { type: 'string' } }),
  }, 'ResearchBrief', { metric: 'house_seats_won', election_year: 2026, states: ['MA', 'GA'] }],
  ['apply_election_results', 'Convert AI-researched congressional counts into a hypothetical electoral map under explicit tie and district rules. Sources are carried through but not independently verified.', {
    ...baseParams, ...metricParams,
    rows: p('array', '1–50 {state, dem, rep, other, status, source_urls} rows. Missing states remain unchanged.', true, { items: { type: 'object' } }),
    as_of: p('string', 'UTC ISO 8601 timestamp for researched facts.', true),
    mapping_rule: p('string', 'Explicit hypothetical conversion rule.', true, { enum: ['state_plurality'] }),
    tie_policy: p('string', 'How to treat tied supplied counts.', true, { enum: ['error', 'keep', 'toss_up'] }),
    district_policy: p('string', 'state_sweep assigns all ME/NE units; preserve_districts changes only statewide units.', true, { enum: ['state_sweep', 'preserve_districts'] }),
  }, 'ResearchScenario', { scenario_id: 'current', metric: 'senate_delegation', election_year: 2026, rows: [{ state: 'MA', dem: 2, rep: 0, other: 0, status: 'certified', source_urls: ['https://www.senate.gov/'] }], as_of: '2026-11-14T00:00:00Z', mapping_rule: 'state_plurality', tie_policy: 'error', district_policy: 'preserve_districts' }],
  ['list_poll_datasets', 'Probe the three configured electoral-vote.com CSV datasets independently; discover race IDs, record kinds and availability. Unavailable sources return explicit errors, never empty polling data.', { row_policy: rowPolicy }, 'PollDatasetCatalog', {}],
  ['get_state_polls', 'Retrieve dated source records for one state/race, preserving polls, historical results, calls, uncalled and unknown records separately. Missing records do not prove no race occurred.', {
    ...pollingParams, race_id: averageParams.race_id,
  }, 'PollRecords', { dataset_id: 'president_2024', race_id: 'PA', as_of: '2024-11-04' }],
  ['get_poll_average', 'Average actual D/R poll rows only using the site midpoint-based seven-day window. Report freshness and other evidence separately. Results/calls never enter the average.', averageParams, 'PollAverage', { dataset_id: 'president_2024', race_id: 'PA', as_of: '2024-11-04', max_age_days: 30 }],
  ['build_polling_scenario', 'Generate a clickable hypothetical map from polling averages with explicit thresholds and policies for stale/missing data, districts and cross-election comparisons. Call/result records are inspected separately, never substituted for polls.', {
    ...baseParams, ...pollingParams, max_age_days: averageParams.max_age_days,
    incomplete_policy: p('string', 'error (default) rejects partial datasets; use_accepted explicitly uses incomplete evidence; keep or toss_up withholds the average and controls each selected state.', false, { enum: ['error', 'use_accepted', 'keep', 'toss_up'] }),
    race_ids: p('array', '1–51 unique race IDs. Choose only one regular/special race per state.', true, { items: { type: 'string' } }),
    comparison_mode: p('string', 'same_race_year requires presidential polls from the map year; otherwise explicitly select hypothetical_cross_election.', true, { enum: ['same_race_year', 'hypothetical_cross_election'] }),
    rating_thresholds: p('object', 'Required {toss_up_below, likely_from, safe_from} margin-point thresholds, ascending from 0 to 100. Between toss and likely is Lean.', true),
    swing_points: p('number', 'Add to the D-minus-R margin: positive favors Democrats, negative Republicans. Default zero.', false, { minimum: -100, maximum: 100 }),
    stale_policy: p('string', 'Explicit handling of old polls.', true, { enum: ['error', 'keep', 'toss_up', 'use'] }),
    unavailable_policy: p('string', 'Explicit handling of missing actual polls, including result-only files.', true, { enum: ['error', 'keep', 'toss_up'] }),
    district_policy: p('string', 'state_sweep assigns ME/NE districts too; preserve_districts changes statewide units only.', true, { enum: ['state_sweep', 'preserve_districts'] }),
  }, 'PollingScenario', { dataset_id: 'president_2024', as_of: '2024-11-04', scenario_id: 'current', race_ids: ['PA', 'MI', 'WI'], comparison_mode: 'hypothetical_cross_election', rating_thresholds: { toss_up_below: 2, likely_from: 5, safe_from: 10 }, swing_points: -2, stale_policy: 'error', unavailable_policy: 'keep', district_policy: 'preserve_districts' }],
];
export const OPERATIONS = definitions.map(([name, description, parameters, returns, example]) => ({
  name, endpoint: 'READ', mcpTool: 'mcp_aql_read', description,
  permissions: { readOnly: true, destructive: false },
  parameters: Object.entries(parameters).map(([name, spec]) => ({ name, ...spec })),
  returns: { name: returns, kind: 'object' }, examples: [{ request: { operation: name, params: example } }],
}));
const field = (name, type, description, required = true) => ({ name, type, description, required });
export const TYPES = [
  { name: 'Rating', kind: 'enum', values: Object.keys(RATINGS), description: 'Categorical assignment; ratings are not numeric probabilities.' },
  { name: 'PollRecordKind', kind: 'enum', values: RECORD_KINDS, description: 'Only poll records enter polling averages; no other kind is a fresh poll.' },
  { name: 'PollRecord', kind: 'object', fields: [field('state', 'string', 'Two-letter state ID.'), field('race_id', 'string', 'State plus optional -special suffix.'), field('race_type', 'string', 'regular or special.'), field('office', 'string', 'president or senate.'), field('election_year', 'integer', 'Source dataset cycle.'), field('kind', 'PollRecordKind', 'Poll, historical result, call, uncalled or unknown.'), field('source_date', 'string', 'YYYY-MM-DD source marker, not a publication timestamp.'), field('fieldwork_start', 'string|null', 'Poll start date; null for non-polls.'), field('fieldwork_end', 'string|null', 'Poll end date; null for non-polls.'), field('midpoint_day', 'number', 'Midpoint relative to Jan 1 = 1; may be zero or negative for year-crossing fieldwork.'), field('poll_length_days', 'integer|null', 'Poll duration; null for non-polls.'), field('shares', 'object', 'dem/rep/ind percentages; missing shares stay null.'), field('margin_dem_minus_rep', 'number|null', 'D minus R; null if either is missing.'), field('label', 'string', 'Original source label without repeated duration suffix.'), field('raw_label', 'string', 'Original CSV label, including the duration suffix; untrusted source text.'), field('classification_reason', 'string', 'explicit_historical_result, explicit_call, explicit_uncalled, reviewed_pollster_label, ambiguous_non_poll_keyword or pollster_label_convention.'), field('classification_confidence', 'string', 'source_label, label_only or unresolved; no independent survey verification.'), field('source_rows', 'array', 'All contributing CSV record positions for a collapsed group, or this row alone under keep_all.'), field('source_labels', 'array', 'Per-row {source_row,raw_label} provenance; full group when collapsed, this row only under keep_all.'), field('source_group_id', 'string', 'Download-local group reference; not an upstream survey ID.'), field('pollster', 'string|null', 'Pollster only for poll rows.'), field('result_year', 'integer|null', 'Referenced historical result year, which can differ from dataset year.'), field('candidate_matchup', 'null', 'Not provided by CSV; not inferred.'), field('sample_size', 'null', 'Not provided by CSV; not inferred.'), field('margin_of_error', 'null', 'Not provided by CSV; not inferred.'), field('source_row', 'integer', 'Original CSV line/record position including header.')] },
  { name: 'PollDataQuality', kind: 'object', fields: [field('row_policy', 'string', 'strict or quarantine.'), field('coverage', 'string', 'complete or partial.'), field('total_row_count', 'integer', 'Data records before validation and grouping.'), field('accepted_row_count', 'integer', 'Accepted rows before grouping.'), field('rejected_row_count', 'integer', 'Rows rejected by validation.'), field('rejected_rows', 'array', 'First 100 rejected {source_row,race_id,reason} references; no raw values.'), field('rejections_truncated', 'boolean', 'More rejections exist than are listed.'), field('affected_race_ids', 'array', 'Known race IDs with rejected rows.'), field('unknown_race_rejections', 'integer', 'Rejected rows whose race cannot be resolved; selected-race coverage stays uncertain.'), field('selected_race_coverage', 'string', 'uncertain, partial or no_known_rejections; only on selected-race summaries.', false)] },
  { name: 'PollDuplicateGroup', kind: 'object', fields: [field('source_group_id', 'string', 'Download-local published-field group reference.'), field('source_rows', 'array', 'Every accepted row position in this group.'), field('source_labels', 'array', 'Every original {source_row,raw_label}, including labels that normalize alike.'), field('race_id', 'string', 'State/regular-special identity.'), field('source_date', 'string', 'Source marker date.')] },
  { name: 'PollDatasetCatalog', kind: 'object', fields: [field('datasets', 'array', 'Each entry includes dataset identity, status, source metadata, race_ids and kind counts; failed probes include an explicit error.') ] },
  { name: 'PollRecords', kind: 'object', fields: [field('dataset', 'object', 'Dataset ID, office, year and URL.'), field('race_id', 'string', 'Selected state/race.'), field('as_of', 'string', 'UTC date cutoff.'), field('election_day', 'string', 'Federal general-election calendar date.'), field('phase', 'string', 'pre_election, election_day or post_election relative to as_of.'), field('counts', 'object', 'Record counts by kind.'), field('coverage', 'string', 'records_available, no_records_as_of or partial_dataset; partial data never proves absence of a race.'), field('records', 'array', 'PollRecord observations at or before cutoff.'), field('source', 'object', 'Dataset URL, retrieved_at and live/test_fixture mode.'), field('dataset_duplicate_rows_removed', 'integer', 'Dataset-wide count of collapsed indistinguishable rows.'), field('quality', 'PollDataQuality', 'Validation coverage and bounded rejected-row references.'), field('duplicate_policy', 'string', 'collapse_indistinguishable or keep_all.'), field('dataset_indistinguishable_rows', 'integer', 'Dataset-wide extra published-field repetitions before selected policy.'), field('race_duplicate_rows', 'integer', 'Extra repeated rows for this race and date cutoff.'), field('duplicate_groups', 'array', 'PollDuplicateGroup provenance for repeated groups in the race/cutoff.'), field('notes', 'array', 'Data interpretation and missing metadata.')] },
  { name: 'PollAverage', kind: 'object', fields: [field('dataset', 'object', 'Dataset identity.'), field('race_id', 'string', 'Selected race.'), field('as_of', 'string', 'UTC date cutoff.'), field('phase', 'string', 'Calendar phase.'), field('election_day', 'string', 'Election calendar date.'), field('counts', 'object', 'Available records by kind.'), field('coverage', 'string', 'records_available, no_records_as_of or partial_dataset.'), field('polling_status', 'string', 'fresh, stale, no_usable_polls or incomplete_data when a map policy withholds the average.'), field('latest_record_kinds', 'array', 'Kinds on the latest visible source marker date, independently of polling status.'), field('latest_poll_end', 'string|null', 'End date of latest included fieldwork.'), field('age_days', 'number|null', 'Days from latest included fieldwork end to as_of.'), field('max_age_days', 'integer', 'Freshness cutoff.'), field('poll_count', 'integer', 'Actual polls used.'), field('average', 'object|null', 'Average D/R shares and D-minus-R margin, or null.'), field('method', 'string', 'Averaging rule.'), field('context_note', 'string', 'Distinguishes a polls-only summary from later outcome evidence.'), field('incomplete_policy', 'string', 'Explicit incomplete-data handling, default error.'), field('included_duplicate_rows', 'integer', 'Extra repeated rows in the contributing averaging window; distinguish from dataset/race counts.'), field('excluded_unknown_records', 'array', 'First 100 excluded unknown labels with raw labels, classification reasons and row/group references.'), field('unknown_exclusions_truncated', 'boolean', 'Unknown-record diagnostics exceeded 100 entries.'), field('included_polls', 'array', 'Exact contributing PollRecord observations.'), field('excluded_record_count', 'integer', 'Available rows outside averaging window or not usable polls.'), field('excluded_unknown_labels', 'array', 'Unknown source labels excluded for this race/cutoff; inspect for false-positive keyword matches.'), field('dataset_duplicate_rows_removed', 'integer', 'Dataset-wide count of collapsed indistinguishable rows.'), field('quality', 'PollDataQuality', 'Validation coverage and bounded rejected-row references.'), field('duplicate_policy', 'string', 'collapse_indistinguishable or keep_all.'), field('dataset_indistinguishable_rows', 'integer', 'Dataset-wide extra published-field repetitions before selected policy.'), field('race_duplicate_rows', 'integer', 'Extra repeated rows for this race and date cutoff.'), field('duplicate_groups', 'array', 'PollDuplicateGroup provenance for repeated groups in the race/cutoff.'), field('source', 'object', 'Download metadata.'), field('notes', 'array', 'Source limitations.')] },
  { name: 'PollingScenario', kind: 'object', fields: [field('map', 'Map', 'Generated map.'), field('base_url', 'string', 'Starting map.'), field('changes', 'array', 'Rating changes.'), field('polling', 'object', 'Per-race PollAverage evidence, applied decisions, dataset, assumptions, thresholds and policies.')] },
  { name: 'MapEdit', kind: 'object', description: 'Exactly one of rating or flip must be supplied. Unit IDs come from list_units.', fields: [field('unit', 'string', 'Electoral unit ID.'), field('rating', 'Rating', 'Explicit target rating.', false), field('flip', 'boolean', 'Must be true; swaps Democratic/Republican while preserving strength.', false)] },
  { name: 'ElectionResult', kind: 'object', description: 'Client-researched state counts, with sources. State IDs exclude DC and congressional district IDs.', fields: [field('state', 'string', 'Two-letter state ID.'), field('dem', 'integer', 'Democratic seat/race count.'), field('rep', 'integer', 'Republican seat/race count.'), field('other', 'integer', 'Other party seat/race count; resolve independents explicitly.'), field('status', 'string', 'certified, projected or partial.'), field('source_urls', 'array', 'One to ten HTTPS source URLs, recorded but not fetched.')] },
  { name: 'Map', kind: 'object', fields: [field('map_url', 'string', 'Clickable site map.'), field('election_year', 'integer', 'Presidential map year.'), field('electoral_allocation', 'string', 'current or projected_2032.'), field('totals', 'object', 'Electoral votes by dem, rep, other, alt, alt2, toss_up.'), field('to_win', 'integer', 'Winning threshold.'), field('winner', 'string|null', 'Party at threshold or null.'), field('ratings', 'object', 'Electoral unit ID to Rating.'), field('source', 'object', 'Site URL, UTC retrieved_at, live/test_fixture mode and source contract.'), field('allocation_note', 'string', 'Allocation interpretation.')] },
  { name: 'ScenarioCatalog', kind: 'object', fields: [field('scenarios', 'array', 'Site scenarios, including id/name/description and complete Map fields.'), field('source', 'object', 'Site retrieval metadata.')] },
  { name: 'UnitCatalog', kind: 'object', fields: [field('units', 'array', 'Ordered {unit,name,current_ev,projected_2032_ev} records.'), field('source', 'object', 'Site retrieval metadata.')] },
  { name: 'ScenarioChange', kind: 'object', fields: [field('map', 'Map', 'Result map.'), field('changes', 'array', 'Changed {unit,from,to} ratings.'), field('base_url', 'string', 'Original map URL.')] },
  { name: 'MapComparison', kind: 'object', fields: [field('left', 'Map', 'First map.'), field('right', 'Map', 'Second map.'), field('changes', 'array', 'Rating changes.'), field('allocation_changed', 'boolean', 'Allocation differs.'), field('electoral_vote_delta', 'object', 'Right minus left votes by side.')] },
  { name: 'ResearchBrief', kind: 'object', fields: [field('metric', 'string', 'Congressional metric.'), field('election_year', 'integer', 'Research year.'), field('states', 'array', 'Research scope.'), field('research_owner', 'string', 'Client owns web research.'), field('queries', 'array', 'Suggested state search queries.'), field('source_guidance', 'array', 'Research and interpretation instructions.'), field('next_operation', 'string', 'apply_election_results.'), field('required_decisions', 'object', 'Mapping, tie and district policies.'), field('row_example', 'object', 'Illustrative row only.'), field('row_note', 'string', 'Example is not research evidence.')] },
  { name: 'ResearchScenario', kind: 'object', fields: [field('map', 'Map', 'Result map.'), field('changes', 'array', 'Rating changes.'), field('base_url', 'string', 'Original map.'), field('research', 'object', 'Rows, source URLs, timestamp, verification status and explicit mapping assumptions.')] },
  { name: 'Discovery', kind: 'object', fields: [field('operations', 'array', 'Operation summaries for an operations list query.', false), field('_protocol', 'object', 'Protocol metadata accompanying an operations list.', false), field('operation', 'object', 'Operation detail for a named query.', false), field('types', 'array', 'Type summaries for a types list query.', false), field('type', 'object', 'Type detail for a named query.', false)], description: 'One of the protocol introspection shapes, selected by query and name.' },
];
export const LIMITS = { max_request_size: 1048576, max_response_size: 10485760, max_string_length: 1048576, max_array_elements: 10000, max_nesting_depth: 32 };
function validateTree(value, depth = 1) {
  requireValue(depth <= LIMITS.max_nesting_depth, 'Request nesting exceeds limit', 'VALIDATION_PAYLOAD_TOO_LARGE');
  if (typeof value === 'string') {
    requireValue(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 'Unpaired Unicode surrogate', 'VALIDATION_INVALID_ENCODING');
    requireValue(!value.includes('\0'), 'Null bytes are unsupported', 'VALIDATION_INVALID_ENCODING');
    requireValue(Buffer.byteLength(value) <= LIMITS.max_string_length, 'String exceeds limit', 'VALIDATION_PAYLOAD_TOO_LARGE');
  }
  if (Array.isArray(value)) requireValue(value.length <= LIMITS.max_array_elements, 'Array exceeds limit', 'VALIDATION_PAYLOAD_TOO_LARGE');
  if (object(value) || Array.isArray(value)) for (const [key, item] of Object.entries(value)) { validateTree(key, depth); validateTree(item, depth + 1); }
}
function validateParams(params, definition) {
  const allowed = new Set(definition.parameters.map(p => p.name));
  for (const key of Object.keys(params)) requireValue(allowed.has(key), `Unknown parameter: ${key}`, 'VALIDATION_UNKNOWN_PARAM');
  for (const spec of definition.parameters) {
    const value = params[spec.name];
    requireValue(!spec.required || value !== undefined, `Missing required parameter: ${spec.name}`, 'VALIDATION_MISSING_PARAM');
    if (value === undefined) continue;
    const valid = spec.type === 'array' ? Array.isArray(value) : spec.type === 'integer' ? Number.isSafeInteger(value) : typeof value === spec.type;
    requireValue(valid && value !== null, `Invalid type for ${spec.name}: expected ${spec.type}`);
    if (spec.type === 'string') requireValue(value.trim().length > 0, `${spec.name} cannot be empty`);
    if (spec.enum) requireValue(spec.enum.includes(value), `Invalid value for ${spec.name}`);
    if (spec.minimum !== undefined) requireValue(value >= spec.minimum && value <= spec.maximum, `${spec.name} outside permitted range`);
    if (spec.items?.type === 'string') requireValue(value.every(v => typeof v === 'string'), `${spec.name} must contain strings`);
  }
}
export function createAdapter({ loadSite = createSiteClient(), loadPolling = createPollingClient() } = {}) {
  return async function dispatch(tool, request) {
    try {
      requireValue(tool === 'mcp_aql_read', 'All demo operations are READ; use mcp_aql_read', 'VALIDATION_WRONG_ENDPOINT');
      validateTree(request);
      requireValue(Buffer.byteLength(JSON.stringify(request)) <= LIMITS.max_request_size, 'Request exceeds 1 MiB', 'VALIDATION_PAYLOAD_TOO_LARGE');
      requireValue(object(request) && typeof request.operation === 'string', 'operation is required', 'VALIDATION_MISSING_PARAM');
      for (const key of Object.keys(request)) requireValue(['operation', 'params', 'parameters'].includes(key), `Unknown request parameter: ${key}`, 'VALIDATION_UNKNOWN_PARAM');
      const definition = OPERATIONS.find(op => op.name === request.operation);
      if (!definition) throw new AdapterError('NOT_FOUND_OPERATION', `Unknown operation: ${request.operation}`);
      for (const key of ['params', 'parameters']) if (Object.hasOwn(request, key)) requireValue(object(request[key]), `${key} must be an object; null is not supported`);
      const params = { ...request.parameters, ...request.params };
      validateParams(params, definition);
      let result;
      if (request.operation === 'introspect') {
        const list = (params.query || 'operations') === 'operations' ? OPERATIONS : TYPES;
        if (params.name) {
          const item = list.find(item => item.name === params.name);
          if (!item) throw new AdapterError('NOT_FOUND_RESOURCE', `Unknown discovery name: ${params.name}`);
          result = { [list === OPERATIONS ? 'operation' : 'type']: item };
        } else if (list === TYPES) result = { types: TYPES.map(({ name, kind, description }) => ({ name, kind, ...(description ? { description } : {}) })) };
        else result = {
          _protocol: { version: '1.0.0-draft', mode: 'crude', conformance: 'level-1', concurrency: 'fully-concurrent', limits: LIMITS,
            capabilities: { batch: false, field_selection: false, pagination: false, execution_safety_loop: false, confirmation: false },
            null_semantics: 'Optional fields must be omitted; explicit null is rejected. No mutable resources.',
          },
          operations: OPERATIONS.map(({ name, endpoint, description }) => ({ name, endpoint, description })),
        };
      } else if (request.operation === 'list_poll_datasets') {
        // Each source failure becomes a dataset result, preserving partial availability.
        result = { datasets: await Promise.all(DATASETS.map(async dataset => {
          try {
            const data = await loadPolling(dataset.id, { row_policy: params.row_policy });
            return { ...data.dataset, status: data.quality?.coverage === 'partial' ? 'partial' : 'available', quality: data.quality, source: data.source, race_ids: [...new Set(data.records.map(r => r.race_id))], counts: Object.fromEntries(RECORD_KINDS.map(kind => [kind, data.records.filter(r => r.kind === kind).length])), duplicate_rows_removed: data.duplicate_rows_removed, notes: data.notes };
          } catch (error) { return { id: dataset.id, office: dataset.office, election_year: dataset.election_year, url: dataset.url, status: 'unavailable', error: { code: error?.code || 'UPSTREAM_UNAVAILABLE', message: error?.message || 'Polling source unavailable' } }; }
        })) };
      } else if (['get_state_polls', 'get_poll_average', 'build_polling_scenario'].includes(request.operation)) {
        const data = await loadPolling(params.dataset_id, { row_policy: params.row_policy });
        if (request.operation === 'get_state_polls') result = pollRecords(data, params);
        if (request.operation === 'get_poll_average') result = pollAverage(data, params);
        if (request.operation === 'build_polling_scenario') result = pollingScenario(data, params, await loadSite());
      } else {
        const data = await loadSite();
        if (request.operation === 'list_scenarios') result = { scenarios: data.scenarios.map(s => ({ id: s.id, name: s.name, description: s.description, ...describeMap(baseMap({ scenario_id: s.id }, data), data) })), source: data.source };
        if (request.operation === 'list_units') result = { units: data.order.map(unit => ({ unit, name: data.units[unit].name, current_ev: data.units[unit].ev, projected_2032_ev: data.projected_ev[unit] })), source: data.source };
        if (request.operation === 'get_map') result = describeMap(baseMap(params, data), data);
        if (request.operation === 'modify_map') {
          const base = baseMap(params, data), next = modifyMap(base, params.edits, data);
          result = { map: describeMap(next, data), changes: changesBetween(base, next, data), base_url: describeMap(base, data).map_url };
        }
        if (request.operation === 'compare_maps') {
          const a = baseMap({ map_url: params.left_url }, data), b = baseMap({ map_url: params.right_url }, data);
          const left = describeMap(a, data), right = describeMap(b, data);
          result = { left, right, changes: changesBetween(a, b, data), allocation_changed: a.electoral_allocation !== b.electoral_allocation, electoral_vote_delta: Object.fromEntries(Object.keys(left.totals).map(k => [k, right.totals[k] - left.totals[k]])) };
        }
        if (request.operation === 'get_research_brief') result = researchBrief(params, data);
        if (request.operation === 'apply_election_results') {
          const base = baseMap(params, data), { map, research } = applyResults(base, params, data);
          result = { map: describeMap(map, data), changes: changesBetween(base, map, data), base_url: describeMap(base, data).map_url, research };
        }
      }
      const response = { success: true, data: result };
      requireValue(Buffer.byteLength(JSON.stringify(response)) <= LIMITS.max_response_size, 'Response exceeds 10 MiB', 'VALIDATION_PAYLOAD_TOO_LARGE');
      return response;
    } catch (error) {
      return { success: false, error: { code: error instanceof AdapterError ? error.code : 'INTERNAL_ERROR', message: error instanceof AdapterError ? error.message : 'Unexpected adapter error', ...(error?.details ? { details: error.details } : {}) } };
    }
  };
}
