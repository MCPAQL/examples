// SPDX-License-Identifier: AGPL-3.0-only
// Callers validate fixed catalog keys before entry. Failures are cached briefly
// too, so an unavailable upstream cannot be hammered by sequential client retries.
export function createSourceCache(load, { now = () => new Date(), ttlMs = 300_000, failureTtlMs = 30_000 } = {}) {
  const cache = new Map(), pending = new Map();
  return async key => {
    const entry = cache.get(key);
    if (entry?.expires > now().getTime()) {
      if (entry.error) throw entry.error;
      return entry.data;
    }
    if (pending.has(key)) return pending.get(key);
    const request = Promise.resolve().then(() => load(key)).then(data => {
      cache.set(key, { data, expires: now().getTime() + ttlMs });
      return data;
    }, error => {
      cache.set(key, { error, expires: now().getTime() + failureTtlMs });
      throw error;
    });
    pending.set(key, request);
    try { return await request; } finally { pending.delete(key); }
  };
}
