// SPDX-License-Identifier: AGPL-3.0-only
// These are per-process backstops. A public deployment still needs edge controls
// and a provider spending limit; this is not a distributed billing quota.
export function createAdmission({ requestsPerMinute = 120, perIpPerMinute = 60, maxConcurrent = 16,
  maxClients = 1024, now = () => performance.now() } = {}) {
  const clients = new Map();
  let total = { tokens: requestsPerMinute, updated: now() }, active = 0;
  function refill(bucket, capacity, time) {
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, time - bucket.updated) * capacity / 60_000);
    bucket.updated = time;
  }
  return {
    enter(ip) {
      const time = now();
      refill(total, requestsPerMinute, time);
      if (total.tokens < 1) return { status: 429, retryAfter: Math.max(1, Math.ceil((1 - total.tokens) * 60 / requestsPerMinute)) };
      total.tokens--;
      for (const [key, value] of clients) if (time - value.updated >= 60_000) clients.delete(key);
      let client = clients.get(ip);
      if (!client) {
        if (clients.size >= maxClients) return { status: 429, retryAfter: 60 };
        client = { tokens: perIpPerMinute, updated: time };
        clients.set(ip, client);
      }
      refill(client, perIpPerMinute, time);
      if (client.tokens < 1) return { status: 429, retryAfter: Math.max(1, Math.ceil((1 - client.tokens) * 60 / perIpPerMinute)) };
      client.tokens--;
      if (active >= maxConcurrent) return { status: 503, retryAfter: 1 };
      active++;
      let released = false;
      return { release() { if (!released) { released = true; active--; } } };
    },
  };
}
