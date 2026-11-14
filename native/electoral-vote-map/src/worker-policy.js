// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, timingSafeEqual } from 'node:crypto';

export class HttpFailure extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export const MAX_WORKER_BODY = 1024 * 1024;
export function jsonReply(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
}
export function failureReply(error) {
  return error instanceof HttpFailure
    ? jsonReply(error.status, error.message, { ...(error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}), ...(error.status === 401 ? { 'www-authenticate': 'Bearer realm="electoral-vote-map"' } : {}) })
    : jsonReply(503, 'Service unavailable');
}
export function readWorkerConfig(env) {
  const origin = new URL(env.EVM_PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.EVM_PUBLIC_ORIGIN) throw new Error('Invalid public origin');
  const integer = (name, fallback, max) => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error('Invalid limit');
    return Number(value);
  };
  if (env.EVM_ALLOW_ANONYMOUS !== undefined && !['true', 'false'].includes(env.EVM_ALLOW_ANONYMOUS)) throw new Error('Invalid anonymous policy');
  if (env.EVM_OAUTH_ENABLED !== undefined && !['true', 'false'].includes(env.EVM_OAUTH_ENABLED)) throw new Error('Invalid OAuth policy');
  const tokens = [];
  if (env.EVM_CLIENT_TOKENS !== undefined) {
    if (env.EVM_CLIENT_TOKENS.length > 16_384) throw new Error('Invalid client configuration');
    const entries = JSON.parse(env.EVM_CLIENT_TOKENS);
    if (!entries || Array.isArray(entries) || typeof entries !== 'object') throw new Error('Invalid client configuration');
    const seen = new Set();
    for (const [id, token] of Object.entries(entries)) {
      if (!/^[a-z0-9_-]{1,64}$/.test(id) || typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{32,256}$/.test(token) || seen.has(token)) throw new Error('Invalid client configuration');
      seen.add(token);
      tokens.push({ id, hash: createHash('sha256').update(`Bearer ${token}`).digest() });
    }
    if (!tokens.length || tokens.length > 32) throw new Error('Invalid client configuration');
  }
  const anonymous = env.EVM_ALLOW_ANONYMOUS === 'true';
  const oauth = env.EVM_OAUTH_ENABLED === 'true';
  if (oauth && anonymous) throw new Error('OAuth requires authenticated access');
  if (!anonymous && !tokens.length && !oauth) throw new Error('Client authentication required');
  const operatorIds = JSON.parse(env.EVM_OPERATOR_CLIENT_IDS ?? '[]');
  if (!Array.isArray(operatorIds) || operatorIds.length > 32 || new Set(operatorIds).size !== operatorIds.length || operatorIds.some(id => !tokens.some(token => token.id === id))) throw new Error('Invalid operator configuration');
  return {
    origin: origin.origin, anonymous, oauth, tokens, operatorIds,
    maxDailyClients: integer('EVM_MAX_DAILY_CLIENTS', oauth ? 256 : 32, 512),
    dailyLimit: integer('EVM_DAILY_REQUEST_LIMIT', 10_000, 100_000),
    clientDailyLimit: integer('EVM_CLIENT_DAILY_REQUEST_LIMIT', 1000, 100_000),
    perMinute: integer('EVM_REQUESTS_PER_MINUTE', 120, 1000),
    perClientPerMinute: integer('EVM_CLIENT_REQUESTS_PER_MINUTE', 60, 1000),
    maxConcurrent: integer('EVM_MAX_CONCURRENT', 16, 64),
    clientMaxConcurrent: integer('EVM_CLIENT_MAX_CONCURRENT', 4, 64),
  };
}
export function authenticatedClient(request, config) {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const hash = createHash('sha256').update(header).digest();
  let id = null;
  for (const token of config.tokens) if (timingSafeEqual(hash, token.hash)) id = token.id;
  if (!id) throw new HttpFailure(401, 'Unauthorized');
  return id;
}

export function checkBodyLength(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_WORKER_BODY)) throw new HttpFailure(413, 'Request body too large');
}

// Cloudflare supplies CF-Connecting-IP at its public edge. Never read forwarded
// identity headers. Normalize IPv6 to /64 so rotating interface IDs share a key.
export function networkIdentity(ip) {
  if (typeof ip !== 'string') throw new HttpFailure(403, 'Client identity unavailable');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip.split('.').every(n => Number(n) <= 255)) return `ipv4:${ip.split('.').map(Number).join('.')}`;
  let normalized;
  try { normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { throw new HttpFailure(403, 'Client identity unavailable'); }
  const [left, right] = normalized.split('::');
  const first = left ? left.split(':') : [], last = right ? right.split(':') : [];
  const groups = right === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
  if (groups.length !== 8 || groups.some(g => !/^[a-f0-9]{1,4}$/.test(g))) throw new HttpFailure(403, 'Client identity unavailable');
  const words = groups.map(g => parseInt(g, 16));
  if (words.slice(0, 5).every(n => n === 0) && words[5] === 65535) return `ipv4:${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  return `ipv6:${words.slice(0, 4).map(n => n.toString(16)).join(':')}::/64`;
}

export async function boundedBody(request, timeoutMs = 5000) {
  checkBodyLength(request);
  if (!request.body) throw new HttpFailure(400, 'Missing request body');
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let timer, size = 0, text = '';
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new HttpFailure(408, 'Request body timeout')); }, timeoutMs); });
  try {
    await Promise.race([(async () => {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_WORKER_BODY) throw new HttpFailure(413, 'Request body too large');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    })(), timeout]);
    const message = JSON.parse(text);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Not one message');
    return text;
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure(400, 'Invalid UTF-8 JSON message');
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

// Every location routes to one named object. Quota state is durable, and all
// admission checks precede the write so rejected clients cannot spend shared quota.
export async function takeBudget(storage, config, clientId, time = Date.now()) {
  return storage.transaction(async tx => {
    const day = new Date(time).toISOString().slice(0, 10);
    const budget = await tx.get('request-budget') ?? { day, count: 0, tokens: config.perMinute, updated: time, clients: {} };
    if (budget.day !== day) { budget.day = day; budget.count = 0; budget.clients = {}; }
    const dailyRetry = Math.max(1, Math.ceil((Date.parse(day + 'T00:00:00Z') + 86_400_000 - time) / 1000));
    if (budget.count >= config.dailyLimit) throw new HttpFailure(429, 'Daily admission quota exhausted', dailyRetry);
    const refill = (bucket, capacity) => { bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, time - bucket.updated) * capacity / 60_000); bucket.updated = time; };
    refill(budget, config.perMinute);
    let client;
    if (clientId) {
      client = budget.clients[`client:${clientId}`];
      if (!client && Object.keys(budget.clients).length >= config.maxDailyClients) throw new HttpFailure(429, 'Client quota table full', dailyRetry);
      client ??= { tokens: config.perClientPerMinute, updated: time, count: 0 };
      // Legacy records have no per-client count. Conservatively attribute the
      // existing global count rather than granting a new allowance on upgrade.
      client.count ??= budget.count;
      if (client.count >= config.clientDailyLimit) throw new HttpFailure(429, 'Client daily admission quota exhausted', dailyRetry);
      refill(client, config.perClientPerMinute);
      if (client.tokens < 1) throw new HttpFailure(429, 'Client admission quota exhausted', Math.ceil((1 - client.tokens) * 60 / config.perClientPerMinute));
    }
    if (budget.tokens < 1) throw new HttpFailure(429, 'Global admission rate exhausted', Math.ceil((1 - budget.tokens) * 60 / config.perMinute));
    budget.tokens--; budget.count++;
    if (client) { client.tokens--; client.count++; budget.clients[`client:${clientId}`] = client; }
    await tx.put('request-budget', budget);
  });
}

// Operator-visible aggregate accounting, never tokens, request data or client IDs.
export async function readUsage(storage, config, time = Date.now()) {
  const day = new Date(time).toISOString().slice(0, 10);
  const stored = await storage.get('request-budget');
  const budget = stored?.day === day ? stored : { count: 0, clients: {} };
  const clients = Object.values(budget.clients);
  return {
    day, admitted: budget.count, daily_limit: config.dailyLimit,
    daily_remaining: Math.max(0, config.dailyLimit - budget.count),
    client_daily_limit: config.clientDailyLimit, active_clients: clients.length,
    highest_client_admissions: Math.max(0, ...clients.map(client => client.count ?? budget.count)),
  };
}
