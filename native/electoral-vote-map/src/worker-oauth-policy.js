// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { HttpFailure, failureReply } from './worker-policy.js';

export const OAUTH_SCOPE = 'electoral:read';
export const AUTH_BODY_LIMIT = 16_384;
export const AUTH_PATHS = new Set(['/authorize', '/callback', '/oauth/token', '/.well-known/oauth-authorization-server']);
export const RESOURCE_PATHS = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
export const isOAuthIdentity = id => typeof id === 'string' && /^oauth:[a-f0-9]{64}$/.test(id);
export const digest = text => createHash('sha256').update(text).digest('hex');
export const quotaIdentity = (issuer, subject) => `oauth:${digest(`${issuer}\0${subject}`)}`;
export const escapeHtml = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function oauthFailureReply(request, error) {
  if (!['/oauth/token', '/oauth/register'].includes(new URL(request.url).pathname)) return failureReply(error);
  const status = error instanceof HttpFailure ? error.status : 503;
  return Response.json({ error: status === 429 || status >= 500 ? 'temporarily_unavailable' : 'invalid_request',
    error_description: error instanceof HttpFailure ? error.message : 'Authentication unavailable' }, {
    status, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...(error instanceof HttpFailure && error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}) },
  });
}

export function oauthConfig(env) {
  if (env.EVM_OAUTH_ENABLED !== 'true' || !env.OAUTH_KV || !env.ELECTORAL_OAUTH_COORDINATOR) throw new HttpFailure(503, 'Authentication unavailable', 60);
  const issuer = new URL(env.EVM_OIDC_ISSUER ?? 'https://accounts.google.com');
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash || issuer.search) throw new Error('Invalid identity issuer');
  for (const key of ['EVM_OIDC_CLIENT_ID', 'EVM_OIDC_CLIENT_SECRET', 'EVM_TURNSTILE_SITE_KEY', 'EVM_TURNSTILE_SECRET']) {
    if (typeof env[key] !== 'string' || !env[key].length || env[key].length > 4096) throw new HttpFailure(503, 'Authentication unavailable', 60);
  }
  if (!['true', 'false', undefined].includes(env.EVM_OAUTH_PUBLIC_SIGNUP)) throw new Error('Invalid enrollment policy');
  const emails = JSON.parse(env.EVM_OAUTH_ALLOWED_EMAILS ?? '[]');
  if (!Array.isArray(emails) || emails.length > 100 || emails.some(email => typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))) throw new Error('Invalid enrollment policy');
  return { issuer: issuer.href.replace(/\/$/, ''), publicSignup: env.EVM_OAUTH_PUBLIC_SIGNUP === 'true', emails: emails.map(email => email.toLowerCase()) };
}

export function sessionValid(props, now = Date.now()) {
  return isOAuthIdentity(props?.quotaId) && Number.isSafeInteger(props.loginAt) && props.loginAt <= now && now - props.loginAt < 7 * 86_400_000;
}

// Reserve before touching KV, including failed operations. These are this
// adapter's ceilings, not reservations of the account's shared free allowance.
export async function authBudget(storage, kind, now = Date.now()) {
  const limits = { read: 25_000, write: 500, delete: 500, list: 500, flow: 1000, registration: 25 };
  if (!(kind in limits)) throw new Error('Invalid authentication budget');
  await storage.transaction(async tx => {
    const day = new Date(now).toISOString().slice(0, 10);
    let budget = await tx.get('oauth-budget');
    if (budget?.day !== day) budget = { day, counts: {}, tokens: 60, updated: now };
    const retry = Math.max(1, Math.ceil((Date.parse(day + 'T00:00:00Z') + 86_400_000 - now) / 1000));
    if ((budget.counts[kind] ?? 0) >= limits[kind]) throw new HttpFailure(503, 'Authentication budget exhausted', retry);
    if (kind === 'flow') {
      budget.tokens = Math.min(60, budget.tokens + Math.max(0, now - budget.updated) / 1000);
      budget.updated = now;
      if (budget.tokens < 1) throw new HttpFailure(429, 'Authentication rate exhausted', 1);
      budget.tokens--;
    }
    budget.counts[kind] = (budget.counts[kind] ?? 0) + 1;
    await tx.put('oauth-budget', budget);
  });
}

export function meteredKV(kv, storage) {
  const result = {};
  for (const [method, kind] of Object.entries({ get: 'read', getWithMetadata: 'read', put: 'write', delete: 'delete', list: 'list' })) {
    result[method] = async (...args) => { await authBudget(storage, kind); return kv[method](...args); };
  }
  return result;
}

// A small request reader for form/protocol endpoints. Read and time limits apply
// before handing untrusted input to either established authentication library.
export async function authBody(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > AUTH_BODY_LIMIT)) throw new HttpFailure(413, 'Authentication request too large');
  if (!request.body) throw new HttpFailure(400, 'Missing authentication request');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let timer, size = 0, result = '';
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new HttpFailure(408, 'Authentication request timeout')); }, 5000); });
  try {
    await Promise.race([(async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > AUTH_BODY_LIMIT) throw new HttpFailure(413, 'Authentication request too large');
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode();
    })(), timeout]);
    return result;
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure(400, 'Invalid authentication request');
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

// DO fencing supplements KV's non-atomic get/delete helpers. Keep only hashes of
// successful transactions for their ten-minute lifetime, with a hard size bound.
export async function usedTransaction(storage, value, consume = false, now = Date.now()) {
  return storage.transaction(async tx => {
    const records = Object.fromEntries(Object.entries(await tx.get('oauth-used') ?? {}).filter(([, until]) => until > now));
    const key = digest(value);
    if (records[key]) throw new HttpFailure(400, 'Authorization already used');
    if (consume) {
      if (Object.keys(records).length >= 1000) throw new HttpFailure(503, 'Authentication busy', 60);
      records[key] = now + 600_000;
      await tx.put('oauth-used', records);
    }
  });
}
