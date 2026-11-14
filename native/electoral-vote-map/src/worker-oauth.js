// SPDX-License-Identifier: AGPL-3.0-only
import { OAuthAuthorizationServer, OAuthResourceServer, OAuthError, AuthorizationError, CimdFetchError, insufficientScope, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import * as oidc from 'openid-client';
import { HttpFailure, failureReply, networkIdentity, readWorkerConfig } from './worker-policy.js';
import { OAUTH_SCOPE, AUTH_PATHS, RESOURCE_PATHS, oauthConfig, isOAuthIdentity, quotaIdentity, escapeHtml, sessionValid, meteredKV, authBudget, authBody, usedTransaction, digest, oauthFailureReply } from './worker-oauth-policy.js';

// No redirects, unbounded provider responses, or non-HTTPS endpoints. The Worker
// also uses global_fetch_strictly_public for outbound network address checks.
export async function identityFetch(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe identity endpoint');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader;
  try {
    const response = await fetch(input, { ...init, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
    if (response.status >= 300 && response.status < 400) throw new Error('Identity redirect refused');
    const chunks = []; let size = 0;
    reader = response.body?.getReader();
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 262_144) throw new Error('Identity response too large');
      chunks.push(value);
    }
    const body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(response.body ? body : null, { status: response.status, headers: response.headers });
  } finally { clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); }
}

function authorizationServer(origin, dcr) {
  return new OAuthAuthorizationServer({
    issuer: origin, resources: [origin + '/mcp'], defaultResource: origin + '/mcp',
    scopesSupported: [OAUTH_SCOPE, 'offline_access'], clientIdMetadataDocumentEnabled: true,
    ...(dcr ? { clientRegistrationEndpoint: origin + '/oauth/register', clientRegistrationTTL: 86_400 } : {}),
    accessTokenTTL: 3600, refreshTokenTTL: 7 * 86_400,
    cookiePrefix: '__Host-electoral-oauth-',
    tokenExchangeCallback({ props, requestedScope }) {
      if (!sessionValid(props) || !requestedScope.includes(OAUTH_SCOPE)) throw new OAuthError('invalid_grant', { description: 'Please sign in again' });
      // A refresh cannot extend the seven-day sign-in window. No upstream
      // provider token is stored in props or used to access provider APIs.
      return { accessTokenTTL: Math.max(1, Math.min(3600, Math.floor((props.loginAt + 7 * 86_400_000 - Date.now()) / 1000))) };
    },
    onError: () => {}, // Deliberately avoid request/internal-detail console logs.
  });
}

function stubFor(env) {
  return env.ELECTORAL_OAUTH_COORDINATOR.get(env.ELECTORAL_OAUTH_COORDINATOR.idFromName('oauth-global-v1'));
}

// Called only after the edge's origin/header checks. The verified identity is a
// JavaScript argument to the application; caller-supplied identity headers have
// no authority at this boundary.
export async function routeOAuth(request, env, ctx, application) {
  oauthConfig(env);
  const origin = env.EVM_PUBLIC_ORIGIN, url = new URL(request.url);
  if (!env.OAUTH_NETWORK_LIMITER?.limit || !env.OAUTH_FLOW_LIMITER?.limit) throw new HttpFailure(503, 'Authentication unavailable', 60);
  const network = networkIdentity(request.headers.get('cf-connecting-ip'));
  if (!(await env.OAUTH_NETWORK_LIMITER.limit({ key: network })).success) throw new HttpFailure(429, 'Too many authentication requests', 60);
  const resource = new OAuthResourceServer({
    resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin], resource_name: 'Electoral Vote Map' },
    requiredScopes: [OAUTH_SCOPE],
    validateToken: () => async (audience, token) => {
      if (token.length > 2048) return null;
      const response = await stubFor(env).fetch(new Request('https://oauth-coordinator/validate', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-evm-oauth-action': 'validate' }, body: JSON.stringify({ audience, token }),
      }));
      if (!response.ok) throw new OAuthError('temporarily_unavailable', { description: 'Authentication unavailable', statusCode: response.status === 429 ? 429 : 503, headers: { 'Retry-After': response.headers.get('retry-after') ?? '60' } });
      return response.json();
    },
    handler: { fetch(req, bindings, authContext) {
      if (!authContext.auth.scope.includes(OAUTH_SCOPE)) return insufficientScope(authContext.auth, [OAUTH_SCOPE]);
      if (!sessionValid(authContext.props)) throw new HttpFailure(401, 'Please sign in again');
      return application(req, bindings, { id: authContext.props.quotaId, kind: 'oauth' });
    } },
  });
  if (RESOURCE_PATHS.has(url.pathname)) {
    if (request.method !== 'GET' || url.search) throw new HttpFailure(404, 'Not found');
    // Publish the root discovery alias as well as RFC 9728's path-specific URL.
    const canonical = new URL(origin + '/.well-known/oauth-protected-resource/mcp');
    return resource.fetch(new Request(canonical, request), env, ctx);
  }
  if (url.pathname === '/mcp' && !url.search) {
    const bearer = request.headers.get('authorization');
    // Repeated use of one token is bounded before any KV validation. The
    // separate stable-account limiter still applies after verification.
    if (bearer && !(await env.MCP_RATE_LIMITER.limit({ key: 'oauth-token:' + digest(bearer) })).success) throw new HttpFailure(429, 'Too many requests', 60);
    return resource.fetch(request, env, ctx);
  }
  const paths = new Set([...AUTH_PATHS, ...(env.EVM_OAUTH_DCR_ENABLED === 'true' ? ['/oauth/register'] : [])]);
  if (!paths.has(url.pathname)) throw new HttpFailure(404, 'Not found');
  const get = request.method === 'GET';
  if ((url.pathname === '/callback' || url.pathname.startsWith('/.well-known/')) ? !get : !['GET', 'POST', 'OPTIONS'].includes(request.method)) throw new HttpFailure(405, 'Method not allowed');
  if (!(await env.OAUTH_FLOW_LIMITER.limit({ key: network })).success) throw new HttpFailure(429, 'Too many sign-in attempts', 60);
  if (url.pathname === '/authorize' && get) {
    const query = url.search;
    if (query.length > 8192) throw new HttpFailure(414, 'Authorization URL too long');
    return new Response(verificationPage(query, env.EVM_TURNSTILE_SITE_KEY), { headers: pageHeaders() });
  }
  if (url.pathname === '/authorize' && request.method === 'POST' && request.headers.get('origin') !== origin) throw new HttpFailure(403, 'Origin not allowed');
  const headers = new Headers();
  for (const name of ['content-type', 'accept', 'cookie', 'authorization', 'origin']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  headers.set('x-evm-oauth-action', 'protocol');
  let body;
  if (request.method === 'POST') body = await authBody(request);
  // Service-binding fetch follows redirects unless told otherwise. OAuth
  // redirects must return to the browser, never be followed with its cookies
  // inside the coordinator boundary.
  return stubFor(env).fetch(new Request(request.url, { method: request.method, headers, redirect: 'manual', ...(body !== undefined ? { body } : {}) }));
}

function consentPage(details, handle) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Electoral Vote Map</title>
<h1>Connect Electoral Vote Map</h1><p>Allow <strong>${escapeHtml(details.clientName)}</strong> to use the free electoral map tools?</p>
<p>${details.clientDomain ? `Client domain: <strong>${escapeHtml(details.clientDomain)}</strong>.` : 'This client registered its own name; the name is not verified.'}
Access returns to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p><strong>This sends access to an app on your computer. Continue only if you started this connection.</strong></p>' : ''}
<p>Read public scenarios and polling data, calculate hypothetical maps, and generate map links. No ability to change the source websites. Free usage limits apply.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<p>Permission: electoral:read</p>${details.scope.includes('offline_access') ? '<label><input type="checkbox" name="offline" value="yes" checked> Keep this connection for up to seven days</label>' : ''}
<p><button name="decision" value="approve">Continue with Google</button> <button name="decision" value="deny">Deny</button></p></form>
<p>Google verifies your identity. We do not request access to your Google files or other Google services. A pseudonymous account identifier is used for quotas. Enrollment is controlled during the pilot.</p>
</html>`;
}

function verificationPage(query, siteKey) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Electoral Vote Map</title>
<h1>Connect Electoral Vote Map</h1><p>Verify to review the app requesting access to the free electoral map tools.</p>
<form method="post" action="/authorize"><input type="hidden" name="stage" value="verify"><input type="hidden" name="query" value="${escapeHtml(query)}">
<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="electoral-oauth"></div><p><button>Review connection</button></p></form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></html>`;
}

function pageHeaders(headers = new Headers()) {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('content-security-policy', "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return headers;
}

async function turnstile(env, token) {
  if (typeof token !== 'string' || !token.length || token.length > 2048) throw new HttpFailure(403, 'Verification required');
  const response = await identityFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: env.EVM_TURNSTILE_SECRET, response: token }),
  });
  if (!response.ok) throw new HttpFailure(503, 'Verification unavailable', 60);
  const result = await response.json();
  if (result.success !== true || result.hostname !== new URL(env.EVM_PUBLIC_ORIGIN).hostname || result.action !== 'electoral-oauth') throw new HttpFailure(403, 'Verification failed');
}

export class OAuthCoordinatorImpl {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); this.pending = 0; this.validations = 0;
    this.boundEnv = { ...env, OAUTH_KV: meteredKV(env.OAUTH_KV, ctx.storage) };
    this.server = authorizationServer(env.EVM_PUBLIC_ORIGIN, env.EVM_OAUTH_DCR_ENABLED === 'true');
    this.identity = null;
  }
  async oidcConfiguration() {
    if (!this.identity) {
      const config = oauthConfig(this.env);
      this.identity = oidc.discovery(new URL(config.issuer), this.env.EVM_OIDC_CLIENT_ID,
        { token_endpoint_auth_method: 'client_secret_post' }, oidc.ClientSecretPost(this.env.EVM_OIDC_CLIENT_SECRET),
        { [oidc.customFetch]: identityFetch, execute: [oidc.enableNonRepudiationChecks] }).catch(error => { this.identity = null; throw error; });
    }
    return this.identity;
  }
  async fetch(request) {
    try {
      if (this.env.EVM_ENABLED !== 'true') throw new HttpFailure(503, 'Service disabled', 60);
      oauthConfig(this.env);
      if (request.headers.get('x-evm-oauth-action') === 'usage') {
        if (request.url !== 'https://oauth-coordinator/usage' || request.method !== 'GET' || !readWorkerConfig(this.env).operatorIds.includes(request.headers.get('x-evm-client-id'))) throw new HttpFailure(403, 'Operator required');
        const day = new Date().toISOString().slice(0, 10), stored = await this.ctx.storage.get('oauth-budget');
        return Response.json({ day, counts: stored?.day === day ? stored.counts : {}, pending_flows: this.pending, active_validations: this.validations }, { headers: { 'cache-control': 'no-store' } });
      }
      if (request.headers.get('x-evm-oauth-action') === 'validate') {
        if (request.url !== 'https://oauth-coordinator/validate' || request.method !== 'POST') throw new HttpFailure(404, 'Not found');
        if (this.validations >= 16) throw new HttpFailure(503, 'Authentication busy', 1);
        this.validations++;
        try {
          const { audience, token } = JSON.parse(await authBody(request));
          if (audience !== this.env.EVM_PUBLIC_ORIGIN + '/mcp' || typeof token !== 'string' || token.length > 2048) throw new HttpFailure(400, 'Invalid validation request');
          const result = await this.server.validateToken(audience, token, this.boundEnv);
          if (result && (!sessionValid(result.props) || !isOAuthIdentity(result.props.quotaId))) return Response.json(null);
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        } finally { this.validations--; }
      }
      if (request.headers.get('x-evm-oauth-action') !== 'protocol' || new URL(request.url).origin !== this.env.EVM_PUBLIC_ORIGIN) throw new HttpFailure(404, 'Not found');
      if (this.pending >= 8) throw new HttpFailure(503, 'Authentication busy', 1);
      this.pending++;
      // KV get/delete is not atomic. One named DO serializes protocol mutations;
      // successful one-time transactions additionally receive durable fences.
      const work = this.queue.then(async () => {
        if (request.method === 'POST' || new URL(request.url).pathname === '/callback') await authBudget(this.ctx.storage, 'flow');
        return this.protocol(request);
      });
      this.queue = work.catch(() => {});
      try { return await work; } finally { this.pending--; }
    } catch (error) { return oauthFailureReply(request, error); }
  }
  async protocol(request) {
    const path = new URL(request.url).pathname;
    const api = this.server.getOAuthApi(this.boundEnv);
    try {
      if (path === '/authorize' && request.method === 'GET') {
        const query = new URL(request.url).search;
        if (query.length > 8192) throw new HttpFailure(414, 'Authorization URL too long');
        // No client metadata fetch or consent KV write before a human verifies.
        return new Response(verificationPage(query, this.env.EVM_TURNSTILE_SITE_KEY), { headers: pageHeaders() });
      }
      if (path === '/authorize' && request.method === 'POST') {
        if (request.headers.get('origin') !== this.env.EVM_PUBLIC_ORIGIN || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new HttpFailure(403, 'Invalid consent form');
        const form = new URLSearchParams(await authBody(request));
        if (form.get('stage') === 'verify') {
          await turnstile(this.env, form.get('cf-turnstile-response'));
          const query = form.get('query');
          if (!query || !query.startsWith('?') || query.includes('#') || query.length > 8192) throw new HttpFailure(400, 'Invalid authorization request');
          // The query is untrusted; the Cloudflare library revalidates every
          // client/redirect/resource/scope field after verification.
          const original = await api.parseAuthRequest(new Request(this.env.EVM_PUBLIC_ORIGIN + '/authorize' + query));
          if (!original.codeChallenge || original.codeChallengeMethod !== 'S256' || !original.scope.includes(OAUTH_SCOPE)) throw new HttpFailure(400, 'Use electoral:read and S256 PKCE');
          const details = await api.describeConsent(original), consent = await api.beginConsent(original);
          return new Response(consentPage(details, consent.handle), { headers: pageHeaders(consent.headers) });
        }
        const handle = form.get('handle');
        if (!handle || handle.length > 256) throw new HttpFailure(400, 'Invalid consent form');
        await usedTransaction(this.ctx.storage, 'consent:' + handle);
        if (form.get('decision') === 'deny') {
          const denied = await api.denyConsent(request, handle);
          await usedTransaction(this.ctx.storage, 'consent:' + handle, true);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        if (form.get('decision') !== 'approve') throw new HttpFailure(400, 'Invalid consent decision');
        const approved = await api.approveConsent(request, handle, { scope: [OAUTH_SCOPE, ...(form.get('offline') === 'yes' ? ['offline_access'] : [])] });
        await usedTransaction(this.ctx.storage, 'consent:' + handle, true);
        const verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
        const config = await this.oidcConfiguration();
        const upstream = await api.beginUpstream(approved.request, { data: { verifier, nonce }, headers: approved.headers });
        const location = oidc.buildAuthorizationUrl(config, { redirect_uri: this.env.EVM_PUBLIC_ORIGIN + '/callback', scope: 'openid email',
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state: upstream.state, nonce });
        upstream.headers.set('location', location.href);
        upstream.headers.set('referrer-policy', 'no-referrer');
        return new Response(null, { status: 302, headers: upstream.headers });
      }
      if (path === '/callback' && request.method === 'GET') {
        const state = new URL(request.url).searchParams.get('state');
        if (!state || state.length > 256) throw new HttpFailure(400, 'Invalid sign-in response');
        await usedTransaction(this.ctx.storage, 'upstream:' + state);
        const upstream = await api.finishUpstream(request);
        await usedTransaction(this.ctx.storage, 'upstream:' + state, true);
        let location;
        try {
          if (new URL(request.url).searchParams.has('error')) throw new Error('Sign-in declined');
          const config = await this.oidcConfiguration();
          // Cloudflare has verified the state and browser binding above. The
          // OIDC library independently validates nonce, PKCE, issuer and claims.
          const tokens = await oidc.authorizationCodeGrant(config, new URL(request.url), {
            pkceCodeVerifier: upstream.data.verifier, expectedNonce: upstream.data.nonce, expectedState: state, idTokenExpected: true,
          });
          const claims = tokens.claims(), enrollment = oauthConfig(this.env);
          if (!claims?.sub || typeof claims.sub !== 'string' || claims.sub.length > 1024 || claims.email_verified !== true || typeof claims.email !== 'string' ||
            (!enrollment.publicSignup && !enrollment.emails.includes(claims.email.toLowerCase()))) throw new Error('Enrollment denied');
          const quotaId = quotaIdentity(claims.iss, claims.sub);
          ({ redirectTo: location } = await api.completeAuthorization({ request: upstream.request, userId: quotaId.slice(6), metadata: {},
            scope: upstream.request.scope, props: { quotaId, loginAt: Date.now() } }));
        } catch (error) {
          if (error instanceof HttpFailure) throw error;
          location = authorizationErrorRedirect(upstream.request, 'access_denied', 'Sign-in or enrollment could not be verified');
        }
        upstream.headers.set('location', location);
        upstream.headers.set('referrer-policy', 'no-referrer');
        return new Response(null, { status: 302, headers: upstream.headers });
      }
      // Prevent a successful code exchange from being repeated even if a later
      // KV read observes the earlier grant. Never fence a failed PKCE exchange.
      let code;
      if (path === '/oauth/token' && request.method === 'POST') {
        const text = await authBody(request);
        const form = new URLSearchParams(text);
        if (form.get('grant_type') === 'authorization_code') {
          code = form.get('code');
          if (code) {
            try { await usedTransaction(this.ctx.storage, 'code:' + code); }
            catch (error) {
              if (!(error instanceof HttpFailure) || error.status !== 400) throw error;
              return Response.json({ error: 'invalid_grant', error_description: 'Authorization code already used' }, { status: 400, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
            }
          }
        }
        const headers = new Headers(request.headers); headers.delete('content-length');
        request = new Request(request.url, { method: 'POST', headers, body: text });
      }
      if (path === '/oauth/register' && request.method === 'POST') await authBudget(this.ctx.storage, 'registration');
      const response = await this.server.fetch(request, this.boundEnv, this.ctx);
      if (response.ok && code) await usedTransaction(this.ctx.storage, 'code:' + code, true);
      return response;
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return new Response(null, { status: 302, headers: { location: error.redirectTo, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) return new Response('Authorization could not be verified. Start again from your client.', { status: 400, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
      throw error;
    }
  }
}
