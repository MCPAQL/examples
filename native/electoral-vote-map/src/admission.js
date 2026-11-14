// SPDX-License-Identifier: AGPL-3.0-only
// These are per-process backstops. A public deployment still needs edge controls
// and a provider spending limit; this is not a distributed billing quota.
export function createAdmission({ requestsPerMinute = 120, perIpPerMinute = 60, maxConcurrent = 16,
  maxClients = 1024, now = () => performance.now() } = {}) {
  const clients = new Map();
  const total = { tokens: requestsPerMinute, updated: now() };
  let active = 0, lastSweep = -Infinity;
  function refill(bucket, capacity, time) {
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, time - bucket.updated) * capacity / 60_000);
    bucket.updated = time;
  }
  return {
    enter(ip) {
      const time = now();
      refill(total, requestsPerMinute, time);
      if (total.tokens < 1) return { status: 429, retryAfter: Math.max(1, Math.ceil((1 - total.tokens) * 60 / requestsPerMinute)) };
      // Bounded, request-driven cleanup avoids a timer and a full scan per request.
      // Idle entries expire after 60s, with up to 1s additional sweep delay.
      if (time - lastSweep >= 1000) {
        for (const [key, value] of clients) if (time - value.updated >= 60_000) clients.delete(key);
        lastSweep = time;
      }
      let client = clients.get(ip);
      if (!client) {
        if (clients.size >= maxClients) return { status: 429, retryAfter: 60 };
        client = { tokens: perIpPerMinute, updated: time };
      }
      refill(client, perIpPerMinute, time);
      if (client.tokens < 1) return { status: 429, retryAfter: Math.max(1, Math.ceil((1 - client.tokens) * 60 / perIpPerMinute)) };
      if (active >= maxConcurrent) return { status: 503, retryAfter: 1 };
      // Commit only after every admission check passes. IP/table/concurrency
      // rejections must not spend another client's shared quota or table slot.
      clients.set(ip, client);
      total.tokens--;
      client.tokens--;
      active++;
      let released = false;
      return { release() { if (!released) { released = true; active--; } } };
    },
  };
}
