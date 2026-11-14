// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';

// These keys/tokens exist only inside the fixture identity provider. Tests do
// not contact Google, solve Turnstile, or use production credentials.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' };
const origin = 'https://electoral.example', issuer = 'https://accounts.google.com';
const operator = 'fixture-operator-'.padEnd(48, 'x');
const challenge = text => createHash('sha256').update(text).digest('base64url');
function jwt(claims, badSignature = false) {
  const input = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(input), privateKey);
  if (badSignature) signature[0] ^= 255;
  return input + '.' + signature.toString('base64url');
}
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

async function runtime(t, vars = {}) {
  const codes = new Map(), requests = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'electoral-oauth-test', modules: true, scriptPath: fileURLToPath(new URL('../../.worker-build/worker.js', import.meta.url)),
    compatibilityDate: '2026-11-13', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], cf: false, port: 0,
    bindings: { EVM_ENABLED: 'true', EVM_PUBLIC_ORIGIN: origin, EVM_OAUTH_ENABLED: 'true', EVM_OAUTH_PUBLIC_SIGNUP: 'false',
      EVM_CLIENT_TOKENS: JSON.stringify({ operator }), EVM_OPERATOR_CLIENT_IDS: '["operator"]',
      EVM_OIDC_CLIENT_ID: 'fixture-google-client', EVM_OIDC_CLIENT_SECRET: 'fixture-client-secret', EVM_TURNSTILE_SITE_KEY: 'fixture-site-key', EVM_TURNSTILE_SECRET: 'fixture-site-secret',
      EVM_OAUTH_ALLOWED_EMAILS: '["allowed@example.com"]', ...vars },
    kvNamespaces: ['OAUTH_KV'],
    durableObjects: { ELECTORAL_COORDINATOR: { className: 'ElectoralCoordinator', useSQLite: true }, ELECTORAL_OAUTH_COORDINATOR: { className: 'OAuthCoordinator', useSQLite: true } },
    ratelimits: Object.fromEntries(['MCP_RATE_LIMITER', 'OAUTH_NETWORK_LIMITER', 'OAUTH_FLOW_LIMITER'].map((name, i) => [name, { namespace_id: String(7201 + i), simple: { limit: 10000, period: 60 } }])),
    outboundService: async request => {
      requests.push({ url: request.url, auth: request.headers.get('authorization'), cookie: request.headers.get('cookie') });
      const json = data => new RuntimeResponse(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      if (request.url === issuer + '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: issuer + '/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
      if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') return json({ keys: [jwk] });
      if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
        const form = new URLSearchParams(await request.text());
        return json({ success: form.get('response') === 'fixture-pass', hostname: new URL(origin).hostname, action: 'electoral-oauth' });
      }
      if (request.url === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(await request.text()), details = codes.get(form.get('code'));
        if (!details || challenge(form.get('code_verifier')) !== details.challenge || form.get('client_secret') !== 'fixture-client-secret') return new RuntimeResponse('{"error":"invalid_grant"}', { status: 400, headers: { 'content-type': 'application/json' } });
        codes.delete(form.get('code'));
        const now = Math.floor(Date.now() / 1000);
        return json({ access_token: 'fixture-upstream-token-do-not-persist', token_type: 'Bearer', expires_in: 300,
          id_token: jwt({ iss: issuer, aud: 'fixture-google-client', sub: 'fixture-user-one', iat: now, exp: now + 300, nonce: details.nonce, email: 'allowed@example.com', email_verified: true, ...details.claims }, details.badSignature) });
      }
      if (/^https:\/\/client[12]\.example\/oauth\.json$/.test(request.url)) {
        const host = new URL(request.url).hostname;
        return json({ client_id: request.url, client_name: '<script>client</script>', redirect_uris: [`https://${host}/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
      }
      throw new Error('Unexpected fixture outbound request');
    },
  }));
  t.after(() => mf.dispose()); await mf.ready;
  const fetch = (path, init = {}) => mf.dispatchFetch(new URL(path, origin).href, { redirect: 'manual', ...init, headers: { 'cf-connecting-ip': '192.0.2.1', ...init.headers } });
  const form = (path, data, headers = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data).toString() });
  async function consent(client = 1, scope = 'electoral:read offline_access') {
    const verifier = 'fixture-verifier-'.padEnd(48, 'v');
    const clientId = `https://client${client}.example/oauth.json`, redirect = `https://client${client}.example/callback`;
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope, state: 'fixture-client-state', resource: origin + '/mcp', code_challenge: challenge(verifier), code_challenge_method: 'S256' });
    const gate = await fetch('/authorize?' + query);
    assert.equal(gate.status, 200);
    const page = await form('/authorize', { stage: 'verify', query: '?' + query, 'cf-turnstile-response': 'fixture-pass' }, { origin });
    assert.equal(page.status, 200);
    const text = await page.text(), handle = text.match(/name="handle" value="([^"]+)"/)?.[1];
    assert.ok(handle);
    return { verifier, clientId, redirect, page, text, handle, cookie: cookie(page) };
  }
  async function approve(initial, offline = true) {
    return form('/authorize', { handle: initial.handle, decision: 'approve', ...(offline ? { offline: 'yes' } : {}) }, { cookie: initial.cookie, origin });
  }
  async function signIn({ client = 1, claims = {}, badSignature = false, scope = 'electoral:read offline_access', offline = true } = {}) {
    const initial = await consent(client, scope), approved = await approve(initial, offline);
    assert.equal(approved.status, 302);
    const google = new URL(approved.headers.get('location'));
    assert.equal(google.origin, issuer);
    assert.equal(google.searchParams.get('scope'), 'openid email');
    const upstreamCode = randomUUID();
    codes.set(upstreamCode, { nonce: google.searchParams.get('nonce'), challenge: google.searchParams.get('code_challenge'), claims, badSignature });
    const callbackPath = '/callback?' + new URLSearchParams({ code: upstreamCode, state: google.searchParams.get('state') });
    const callback = await fetch(callbackPath, { headers: { cookie: cookie(approved) } });
    assert.equal(callback.status, 302);
    const returned = new URL(callback.headers.get('location'));
    assert.equal(returned.origin, new URL(initial.redirect).origin);
    assert.equal(returned.searchParams.get('state'), 'fixture-client-state');
    assert.equal(returned.searchParams.get('iss'), origin);
    return { ...initial, callbackPath, upstreamCookie: cookie(approved), returned, code: returned.searchParams.get('code') };
  }
  async function exchange(signed, extra = {}) {
    return form('/oauth/token', { grant_type: 'authorization_code', client_id: signed.clientId, redirect_uri: signed.redirect, code: signed.code, code_verifier: signed.verifier, resource: origin + '/mcp', ...extra });
  }
  const mcp = token => fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  return { mf, fetch, form, consent, approve, signIn, exchange, mcp, requests };
}

test('declined or unrequested offline access never issues refresh tokens', { timeout: 60_000 }, async t => {
  const app = await runtime(t);
  for (const choice of [{ offline: false }, { scope: 'electoral:read', offline: false }, { scope: 'electoral:read', offline: true }]) {
    const signed = await app.signIn(choice);
    if (choice.scope === 'electoral:read') assert.doesNotMatch(signed.text, /name="offline"/);
    const response = await app.exchange(signed); assert.equal(response.status, 200);
    const token = await response.json();
    assert.ok(token.access_token);
    assert.equal(token.refresh_token, undefined);
    assert.equal(token.scope, 'electoral:read');
    assert.ok(token.expires_in <= 3600);
    assert.equal((await app.mcp(token.access_token)).status, 200);
  }
});

test('pinned token validation costs one KV read and invalid traffic cannot allocate replay fences', { timeout: 60_000 }, async t => {
  const app = await runtime(t), signed = await app.signIn();
  const response = await app.exchange(signed); assert.equal(response.status, 200);
  const token = await response.json();
  const usage = async () => (await app.fetch('/admin/oauth-usage', { headers: { authorization: 'Bearer ' + operator } })).json();
  const before = await usage();
  for (let i = 0; i < 3; i++) assert.equal((await app.mcp(token.access_token)).status, 200);
  const afterValid = await usage();
  assert.equal(afterValid.counts.read - before.counts.read, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.mcp('unknown:grant:' + randomUUID())).status, 401);
    assert.equal((await app.form('/authorize', { handle: randomUUID(), decision: 'approve' }, { origin })).status, 400);
    assert.equal((await app.fetch('/callback?state=' + randomUUID())).status, 400);
  }
  const afterInvalid = await usage();
  assert.equal(afterInvalid.counts.read - afterValid.counts.read, 3);
  assert.equal(afterInvalid.active_replay_fences, before.active_replay_fences);
});

test('OAuth discovery and consent use the Cloudflare library, safe client rendering and browser-bound state', { timeout: 60_000 }, async t => {
  const app = await runtime(t);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await app.fetch(path); assert.equal(response.status, 200);
    assert.equal((await response.json()).resource, origin + '/mcp');
  }
  const metadata = await (await app.fetch('/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.issuer, origin);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.equal(metadata.registration_endpoint, undefined);
  const unauthenticated = await app.fetch('/mcp');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /resource_metadata=/);
  assert.equal((await app.fetch('/oauth/register', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await app.fetch('/validate', { method: 'POST', headers: { 'x-evm-oauth-action': 'validate' }, body: '{}' })).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await app.fetch('/authorize?client_id=untrusted')).status, 200);
  const beforeHuman = await (await app.fetch('/admin/oauth-usage', { headers: { authorization: 'Bearer ' + operator } })).json();
  assert.deepEqual(beforeHuman.counts, {});
  assert.equal(app.requests.length, 0);
  const initial = await app.consent();
  assert.doesNotMatch(initial.text, /<script>client/);
  assert.match(initial.text, /&#60;script&#62;/);
  assert.match(initial.page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(initial.page.headers.get('set-cookie'), /HttpOnly/i);
  assert.equal((await app.form('/authorize', { handle: initial.handle, decision: 'approve', 'cf-turnstile-response': 'fixture-pass' }, { origin })).status, 400);
  assert.equal((await app.form('/authorize', { handle: initial.handle, decision: 'approve', 'cf-turnstile-response': 'fixture-pass' }, { origin: 'https://attacker.example', cookie: initial.cookie })).status, 403);
  assert.equal((await app.form('/authorize', { stage: 'verify', query: '?client_id=anything', 'cf-turnstile-response': 'fixture-fail' }, { origin })).status, 403);
  const approved = await app.approve(initial); assert.equal(approved.status, 302);
  assert.equal((await app.approve(initial)).status, 400);
  const declined = await app.consent();
  const denied = await app.form('/authorize', { handle: declined.handle, decision: 'deny' }, { origin, cookie: declined.cookie });
  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');
  assert.equal((await app.approve(declined)).status, 400);
});

test('authorization rejects redirect/resource/scope/PKCE manipulation and a wrong token verifier', { timeout: 60_000 }, async t => {
  const app = await runtime(t);
  const base = { response_type: 'code', client_id: 'https://client1.example/oauth.json', redirect_uri: 'https://client1.example/callback', scope: 'electoral:read', state: 'fixture-state', resource: origin + '/mcp', code_challenge: challenge('v'.repeat(48)), code_challenge_method: 'S256' };
  for (const patch of [{ redirect_uri: 'https://attacker.example/callback' }, { resource: 'https://attacker.example/mcp' }, { scope: 'electoral:write' }, { code_challenge_method: 'plain' }, { code_challenge: '' }]) {
    const response = await app.form('/authorize', { stage: 'verify', query: '?' + new URLSearchParams({ ...base, ...patch }), 'cf-turnstile-response': 'fixture-pass' }, { origin });
    assert.ok([400, 302].includes(response.status));
    if (response.status === 302) {
      const location = new URL(response.headers.get('location'));
      assert.equal(location.origin, 'https://client1.example');
      assert.ok(location.searchParams.get('error'));
    }
  }
  const signed = await app.signIn();
  assert.equal((await app.exchange(signed, { code_verifier: 'wrong-verifier'.padEnd(48, 'x') })).status, 400);
});

test('signed OIDC login issues audience-bound MCP tokens with refresh/revocation and account quotas across client apps', { timeout: 60_000 }, async t => {
  const app = await runtime(t, { EVM_CLIENT_DAILY_REQUEST_LIMIT: '1' });
  const signed = await app.signIn(); assert.ok(signed.code);
  assert.equal((await app.fetch(signed.callbackPath, { headers: { cookie: signed.upstreamCookie } })).status, 400);
  const response = await app.exchange(signed); assert.equal(response.status, 200);
  const token = await response.json(); assert.ok(token.access_token); assert.ok(token.refresh_token);
  assert.equal((await app.exchange(signed)).status, 400);
  assert.equal((await app.mcp(token.access_token)).status, 200);
  const other = await app.signIn({ client: 2 }), otherResponse = await app.exchange(other); assert.equal(otherResponse.status, 200);
  const otherToken = await otherResponse.json();
  assert.equal((await app.mcp(otherToken.access_token)).status, 429);
  const refreshedResponse = await app.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: signed.clientId, resource: origin + '/mcp' });
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json();
  assert.equal((await app.mcp(refreshed.access_token)).status, 429);
  const wrongResource = await app.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshed.refresh_token, client_id: signed.clientId, resource: 'https://attacker.example/mcp' });
  assert.equal(wrongResource.status, 400);
  assert.equal((await app.fetch('/admin/usage', { headers: { authorization: 'Bearer ' + refreshed.access_token, 'x-evm-client-id': 'operator', 'x-evm-auth-kind': 'oauth' } })).status, 401);
  assert.equal((await app.fetch('/admin/oauth-usage', { headers: { authorization: 'Bearer ' + refreshed.access_token, 'x-evm-client-id': 'operator' } })).status, 401);
  const usage = await (await app.fetch('/admin/usage', { headers: { authorization: 'Bearer ' + operator } })).json();
  assert.equal(usage.admitted, 1); assert.equal(usage.active_clients, 1);
  const revoked = await app.form('/oauth/token', { token: refreshed.refresh_token, token_type_hint: 'refresh_token', client_id: signed.clientId }); assert.equal(revoked.status, 200);
  assert.equal((await app.mcp(refreshed.access_token)).status, 401);
  const kv = await app.mf.getKVNamespace('OAUTH_KV');
  for (const { name } of (await kv.list()).keys) {
    const value = await kv.get(name);
    assert.doesNotMatch(value ?? '', /fixture-upstream-token-do-not-persist|allowed@example.com|fixture-client-secret|fixture-user-one/);
  }
});

test('OIDC refuses forged signatures, wrong issuer/audience/nonce, expired tokens, unverified email and unenrolled users', { timeout: 60_000 }, async t => {
  const app = await runtime(t);
  for (const options of [{ badSignature: true }, { claims: { iss: 'https://attacker.example' } }, { claims: { aud: 'wrong-client' } }, { claims: { nonce: 'wrong-nonce' } }, { claims: { exp: 1 } }, { claims: { email_verified: false } }, { claims: { email: 'not-enrolled@example.com' } }]) {
    const signed = await app.signIn(options);
    assert.equal(signed.code, null);
    assert.equal(signed.returned.searchParams.get('error'), 'access_denied');
  }
});

test('OAuth stays unavailable without dedicated configuration and global kill switch precedes provider IO', { timeout: 60_000 }, async t => {
  const missing = await runtime(t, { EVM_TURNSTILE_SECRET: '' });
  assert.equal((await missing.fetch('/.well-known/oauth-authorization-server')).status, 503);
  assert.equal(missing.requests.length, 0);
  const disabled = await runtime(t, { EVM_ENABLED: 'false' });
  assert.equal((await disabled.fetch('/authorize')).status, 503);
  assert.equal(disabled.requests.length, 0);
});
