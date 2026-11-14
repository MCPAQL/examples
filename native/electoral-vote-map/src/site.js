// SPDX-License-Identifier: AGPL-3.0-only
import { HOME, UNIT_ORDER, AdapterError, requireValue, object, decode } from './map.js';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export function parseSite(html, source) {
  const raw = /<script\b[^>]*class=["']evm-payload["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!raw) throw new AdapterError('UPSTREAM_CONTRACT_CHANGED', 'The site no longer exposes the expected map payload');
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new AdapterError('UPSTREAM_CONTRACT_CHANGED', 'The site map payload is not valid JSON'); }
  const validEv = table => object(table) && UNIT_ORDER.every(u => Number.isInteger(table[u]) && table[u] > 0) && Object.keys(table).length === 56 && Object.values(table).reduce((n, ev) => n + ev, 0) === 538;
  requireValue(object(payload.units) && JSON.stringify(Object.keys(payload.units)) === JSON.stringify(UNIT_ORDER), 'Electoral unit ordering changed; review the URL codec before continuing', 'UPSTREAM_CONTRACT_CHANGED');
  requireValue(Number.isInteger(payload.year) && payload.totalEv === 538 && payload.toWin === 270, 'Unsupported election layout', 'UPSTREAM_CONTRACT_CHANGED');
  requireValue(validEv(Object.fromEntries(UNIT_ORDER.map(u => [u, payload.units[u]?.ev]))) && validEv(payload.ev2032?.ev), 'Invalid or missing electoral allocations', 'UPSTREAM_CONTRACT_CHANGED');
  requireValue(Array.isArray(payload.presets) && payload.presets.length > 0 && payload.presets.length <= 100, 'Missing site scenarios', 'UPSTREAM_CONTRACT_CHANGED');
  const scenarios = [{ id: 'current', name: 'Current site map', description: payload.forecast?.label || 'Current forecast', code: payload.forecast?.code }, ...payload.presets.map(s => ({ id: s.key, name: s.name, description: s.note, code: s.code }))];
  requireValue(new Set(scenarios.map(s => s.id)).size === scenarios.length, 'Duplicate site scenario IDs', 'UPSTREAM_CONTRACT_CHANGED');
  const data = { year: payload.year, order: UNIT_ORDER, units: payload.units, to_win: payload.toWin, scenarios, projected_ev: payload.ev2032.ev, projection_as_of: payload.ev2032.asof, source };
  for (const scenario of scenarios) {
    requireValue(typeof scenario.id === 'string' && /^[a-z0-9-]+$/.test(scenario.id) && typeof scenario.name === 'string' && typeof scenario.description === 'string', 'Invalid site scenario metadata', 'UPSTREAM_CONTRACT_CHANGED');
    try { decode(scenario.code, data); } catch { throw new AdapterError('UPSTREAM_CONTRACT_CHANGED', `Invalid map code in site scenario ${scenario.id}`); }
  }
  return data;
}
// The map source only fetches this fixed URL; polling sources have a separate catalog.
// User-supplied URLs are parsed, never fetched.
// No cookies, account, browser, write API, model provider or arbitrary host is involved.
export function createSiteClient({ fetchImpl = fetch, fixtureHtml, now = () => new Date(), ttlMs = 300_000 } = {}) {
  let cached, pending, expires = 0;
  return async function loadSite() {
    if (cached && now().getTime() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      let html = fixtureHtml;
      if (html === undefined) {
        try {
          const response = await fetchImpl(HOME, { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { accept: 'text/html', 'user-agent': 'MCPAQL-ElectoralVoteMap-Demo/0.1' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
          html = ''; let bytes = 0;
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              bytes += value.byteLength;
              if (bytes > MAX_SOURCE_BYTES) throw new Error('Source exceeds 2 MiB');
              html += decoder.decode(value, { stream: true });
            }
            html += decoder.decode();
          } finally { await reader.cancel(); }
        } catch (error) { throw new AdapterError('UPSTREAM_UNAVAILABLE', `Could not read Electoral Vote Map: ${error.message}`); }
      }
      cached = parseSite(html, { url: HOME, retrieved_at: now().toISOString(), mode: fixtureHtml === undefined ? 'live' : 'test_fixture', contract: 'evm-map-1.29-url-codec', forecast_note: 'Site scenarios and ratings are inputs for exploration, not calibrated win probabilities.' });
      expires = now().getTime() + ttlMs;
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
