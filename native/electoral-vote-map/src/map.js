// SPDX-License-Identifier: AGPL-3.0-only
export const HOME = 'https://electoralvotemap.com/';
export const RATINGS = {
  safe_dem: 'D', likely_dem: 'E', lean_dem: 'F',
  safe_rep: 'R', likely_rep: 'S', lean_rep: 'T',
  safe_other: 'O', likely_other: 'P', lean_other: 'Q',
  safe_alt: 'A', likely_alt: 'B', lean_alt: 'C',
  safe_alt2: 'G', likely_alt2: 'H', lean_alt2: 'I', toss_up: '_',
};
export const UNIT_ORDER = 'AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME ME-1 ME-2 MI MN MO MS MT NC ND NE NE-1 NE-2 NE-3 NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY'.split(' ');
const BY_CODE = Object.fromEntries(Object.entries(RATINGS).map(([rating, code]) => [code, rating]));
export class AdapterError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
export function requireValue(condition, message, code = 'VALIDATION_INVALID_PARAM') {
  if (!condition) throw new AdapterError(code, message);
}
export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function knownFields(value, fields, label) {
  requireValue(object(value), `${label} must be an object`);
  for (const key of Object.keys(value)) requireValue(fields.includes(key), `Unknown ${label} field: ${key}`, 'VALIDATION_UNKNOWN_FIELD');
}
export function decode(code, data) {
  requireValue(typeof code === 'string' && code.length === data.order.length, `Map code must have ${data.order.length} characters`);
  requireValue([...code].every(c => Object.hasOwn(BY_CODE, c)), 'Map code contains an unknown rating');
  return Object.fromEntries(data.order.map((unit, i) => [unit, BY_CODE[code[i]]]));
}
export function parseUrl(raw, data) {
  let url;
  try { url = new URL(raw); } catch { throw new AdapterError('VALIDATION_INVALID_PARAM', 'map_url must be an absolute Electoral Vote Map URL'); }
  requireValue(url.origin === new URL(HOME).origin && url.pathname === '/' && !url.username && !url.password, 'Only the Electoral Vote Map home URL is supported; supplied URLs are never fetched');
  requireValue(!url.hash, 'Hash/embed maps are not supported in this demo; use the full share URL');
  for (const key of url.searchParams.keys()) {
    requireValue(['map', 'ev'].includes(key), `Unsupported map URL parameter: ${key}`);
    requireValue(url.searchParams.getAll(key).length === 1, `Duplicate URL parameter: ${key}`);
  }
  const match = /^(\d{4}):([A-Z_]+)$/.exec(url.searchParams.get('map') || '');
  requireValue(match && Number(match[1]) === data.year, `Expected a ${data.year} map URL without nominee-name suffixes`);
  const allocation = url.searchParams.get('ev');
  requireValue(allocation === null || allocation === '2032', 'Only current or projected 2032 allocations are supported');
  return { ratings: decode(match[2], data), electoral_allocation: allocation === '2032' ? 'projected_2032' : 'current' };
}
export function mapUrl(map, data) {
  const code = data.order.map(unit => {
    requireValue(Object.hasOwn(RATINGS, map.ratings[unit]), `Invalid rating for ${unit}`);
    return RATINGS[map.ratings[unit]];
  }).join('');
  return `${HOME}?map=${data.year}:${code}${map.electoral_allocation === 'projected_2032' ? '&ev=2032' : ''}`;
}
export function describeMap(map, data) {
  const totals = { dem: 0, rep: 0, other: 0, alt: 0, alt2: 0, toss_up: 0 };
  for (const unit of data.order) {
    const rating = map.ratings[unit];
    const side = rating === 'toss_up' ? rating : rating.split('_').slice(1).join('_');
    totals[side] += map.electoral_allocation === 'projected_2032' ? data.projected_ev[unit] : data.units[unit].ev;
  }
  const winner = Object.keys(totals).find(side => side !== 'toss_up' && totals[side] >= data.to_win) || null;
  return {
    map_url: mapUrl(map, data), election_year: data.year,
    electoral_allocation: map.electoral_allocation, totals, to_win: data.to_win, winner,
    ratings: map.ratings, source: data.source,
    allocation_note: map.electoral_allocation === 'projected_2032'
      ? `Population projection, not a finalized apportionment: ${data.projection_as_of}`
      : 'Current electoral allocation from the site; Maine and Nebraska statewide units carry two votes each.',
  };
}
export function baseMap(params, data) {
  requireValue(!(params.map_url && params.scenario_id), 'Supply map_url or scenario_id, not both');
  let map;
  if (params.map_url) map = parseUrl(params.map_url, data);
  else {
    const id = params.scenario_id || 'current';
    const preset = data.scenarios.find(s => s.id === id);
    if (!preset) throw new AdapterError('NOT_FOUND_RESOURCE', `Unknown scenario_id: ${id}`);
    map = { ratings: decode(preset.code, data), electoral_allocation: 'current' };
  }
  if (params.electoral_allocation) map.electoral_allocation = params.electoral_allocation;
  return map;
}
export function modifyMap(map, edits, data) {
  requireValue(Array.isArray(edits) && edits.length > 0 && edits.length <= 56, 'edits must contain 1–56 unit changes');
  const ratings = { ...map.ratings }, seen = new Set();
  for (const edit of edits) {
    knownFields(edit, ['unit', 'rating', 'flip'], 'edit');
    requireValue(typeof edit.unit === 'string' && data.order.includes(edit.unit), `Unknown electoral unit: ${edit.unit}`);
    requireValue(!seen.has(edit.unit), `Duplicate edit: ${edit.unit}`); seen.add(edit.unit);
    requireValue((Object.hasOwn(edit, 'rating') ? 1 : 0) + (Object.hasOwn(edit, 'flip') ? 1 : 0) === 1, 'Each edit requires exactly one of rating or flip');
    if (Object.hasOwn(edit, 'flip')) {
      requireValue(edit.flip === true, 'flip must be true');
      requireValue(/_(dem|rep)$/.test(ratings[edit.unit]), `Cannot flip ${edit.unit}: explicitly rate a toss-up or third-party unit`);
      ratings[edit.unit] = ratings[edit.unit].replace(/_(dem|rep)$/, (_, side) => side === 'dem' ? '_rep' : '_dem');
    } else {
      requireValue(Object.hasOwn(RATINGS, edit.rating), `Unknown rating: ${edit.rating}`);
      ratings[edit.unit] = edit.rating;
    }
  }
  return { ...map, ratings };
}
export function changesBetween(a, b, data) {
  return data.order.filter(unit => a.ratings[unit] !== b.ratings[unit]).map(unit => ({ unit, from: a.ratings[unit], to: b.ratings[unit] }));
}
