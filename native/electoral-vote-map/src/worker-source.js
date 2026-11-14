// SPDX-License-Identifier: AGPL-3.0-only
import { HOME, AdapterError } from './map.js';
import { DATASETS, parsePollingCsv } from './polling.js';
import { parseSite } from './site.js';
import { markSourceTime } from './source-timing.js';

const SOURCES = [HOME, ...DATASETS.map(d => d.url)];
const MAX_BYTES = 2 * 1024 * 1024, CHUNK_CHARS = 8192;
// Chunk values stay below Durable Object KV's 128 KiB value limit, including
// Unicode/serialization overhead. One logical source has at most 256 chunks.
export function durableSourceFetch(storage, { fetchImpl = (url, init) => fetch(url, init), now = Date.now } = {}) {
  const pending = new Map();
  async function read(key) {
    return storage.transaction(async tx => {
      const entry = await tx.get(key);
      if (!entry || entry.expires <= now()) return null;
      if (entry.error) return entry;
      let body = '';
      for (let start = 0; start < entry.chunks; start += 64) {
        const keys = Array.from({ length: Math.min(64, entry.chunks - start) }, (_, i) => `${key}:${start + i}`);
        const values = await tx.get(keys);
        for (const chunk of keys) {
          if (typeof values.get(chunk) !== 'string') throw new Error('Incomplete source cache');
          body += values.get(chunk);
        }
      }
      return { ...entry, body };
    });
  }
  async function write(key, entry) {
    const chunks = [];
    for (let i = 0; i < (entry.body?.length ?? 0); i += CHUNK_CHARS) chunks.push(entry.body.slice(i, i + CHUNK_CHARS));
    await storage.transaction(async tx => {
      const previous = await tx.get(key);
      for (let start = 0; start < chunks.length; start += 64) await tx.put(Object.fromEntries(chunks.slice(start, start + 64).map((chunk, i) => [`${key}:${start + i}`, chunk])));
      for (let start = chunks.length; start < (previous?.chunks ?? 0); start += 64) await tx.delete(Array.from({ length: Math.min(64, previous.chunks - start) }, (_, i) => `${key}:${start + i}`));
      const { body: _body, ...metadata } = entry;
      await tx.put(key, { ...metadata, chunks: chunks.length });
    });
  }
  return async url => {
    const index = SOURCES.indexOf(String(url));
    if (index < 0) throw new Error('Source URL not allowed');
    const key = `source:${index}`;
    const materialize = entry => {
      if (entry.code === 'UPSTREAM_CONTRACT_CHANGED') throw new AdapterError(entry.code, 'Source contract is temporarily unavailable');
      return entry.error ? new Response('Source temporarily unavailable', { status: 503 })
        : markSourceTime(new Response(entry.body), new Date(entry.retrievedAt).toISOString());
    };
    if (!pending.has(key)) {
      const request = (async () => {
        const cached = await read(key);
        if (cached) return cached;
        let entry;
        try {
          // Workers supports manual/follow only; reject every non-2xx response
          // explicitly so a redirect never leaves the four fixed source URLs.
          const response = await fetchImpl(SOURCES[index], { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: index === 0 ? 'text/html' : 'text/csv,text/plain,application/octet-stream', 'user-agent': 'MCPAQL-ElectoralVoteMap-Demo/0.2' } });
          if (!response.ok) { await response.body?.cancel(); throw new Error('Source unavailable'); }
          const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
          let size = 0, body = '';
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              size += value.byteLength;
              if (size > MAX_BYTES) throw new Error('Source too large');
              body += decoder.decode(value, { stream: true });
            }
            body += decoder.decode();
          } finally { await reader.cancel(); }
          const retrievedAt = now();
          // An HTTP 200 maintenance page is not a successful source contract.
          // Quarantine validates CSV structure without hiding rejected row evidence.
          const source = { url: SOURCES[index], retrieved_at: new Date(retrievedAt).toISOString(), mode: 'live' };
          if (index === 0) parseSite(body, source);
          else parsePollingCsv(body, DATASETS[index - 1], source, { row_policy: 'quarantine' });
          entry = { body, retrievedAt, expires: retrievedAt + 300_000 };
        } catch (error) { entry = { error: true, ...(error?.code === 'UPSTREAM_CONTRACT_CHANGED' ? { code: error.code } : {}), expires: now() + 30_000 }; }
        await write(key, entry);
        return entry;
      })();
      pending.set(key, request);
      void request.finally(() => pending.delete(key)).catch(() => {});
    }
    return materialize(await pending.get(key));
  };
}
