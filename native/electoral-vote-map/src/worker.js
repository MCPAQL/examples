// SPDX-License-Identifier: AGPL-3.0-only
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAdapter } from './adapter.js';
import { createMcpServer } from './mcp.js';
import { createSiteClient } from './site.js';
import { createPollingClient } from './polling.js';
import { durableSourceFetch } from './worker-source.js';
import { HttpFailure, jsonReply, failureReply, readWorkerConfig, authenticatedClient, networkIdentity, boundedBody, takeBudget } from './worker-policy.js';

export default {
  async fetch(request, env) {
    try {
      if (env.EVM_ENABLED !== 'true') throw new HttpFailure(503, 'Service disabled', 60);
      const config = readWorkerConfig(env), url = new URL(request.url);
      let headerBytes = 0;
      for (const [name, value] of request.headers) headerBytes += new TextEncoder().encode(name + ': ' + value + '\r\n').byteLength;
      if (headerBytes > 16_384) throw new HttpFailure(431, 'Request headers too large');
      if (url.origin !== config.origin || (request.headers.has('origin') && request.headers.get('origin') !== config.origin)) throw new HttpFailure(403, 'Origin not allowed');
      if (!env.MCP_RATE_LIMITER?.limit || !env.ELECTORAL_COORDINATOR) throw new HttpFailure(503, 'Service unavailable');
      const network = networkIdentity(request.headers.get('cf-connecting-ip'));
      let clientId, authError;
      try { clientId = authenticatedClient(request, config); } catch (error) { authError = error; }
      // Valid, distinct credentials get independent allowances even when their
      // clients share a proxy IP. Invalid/anonymous requests use the network key.
      const identity = clientId ? `client:${clientId}` : network;
      const { success } = await env.MCP_RATE_LIMITER.limit({ key: identity });
      if (!success) throw new HttpFailure(429, 'Too many requests', 60);
      if (authError) throw authError;
      if (url.pathname === '/healthz' && request.method === 'GET' && !url.search) return new Response('{"status":"ok"}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      if (url.pathname !== '/mcp' || url.search) throw new HttpFailure(404, 'Not found');
      if (!clientId && !config.anonymous) return jsonReply(401, 'Unauthorized', { 'www-authenticate': 'Bearer realm="electoral-vote-map"' });
      if (request.method !== 'POST') return jsonReply(405, 'Only POST is supported', { allow: 'POST' });
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpFailure(415, 'Expected application/json');
      const text = await boundedBody(request);
      const headers = new Headers();
      for (const name of ['content-type', 'accept', 'mcp-protocol-version']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
      if (clientId) headers.set('x-evm-client-id', clientId);
      // Exactly one namespace-local ID for every deployment/location. Never key
      // this by the request, user, region, or revision: that would reset quotas.
      const stub = env.ELECTORAL_COORDINATOR.get(env.ELECTORAL_COORDINATOR.idFromName('global-v1'));
      return await stub.fetch(new Request('https://coordinator/mcp', { method: 'POST', headers, body: text }));
    } catch (error) { return failureReply(error); }
  },
};

export class ElectoralCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.active = 0;
    const fetchImpl = durableSourceFetch(ctx.storage);
    // The durable fetch cache owns failure expiry. A second parser-layer failure
    // cache would restart the 30s timer after eviction and delay source recovery.
    this.dispatch = createAdapter({ loadSite: createSiteClient({ fetchImpl, failureTtlMs: 0 }), loadPolling: createPollingClient({ fetchImpl, failureTtlMs: 0 }) });
  }
  async fetch(request) {
    let server;
    let admitted = false;
    try {
      if (this.env.EVM_ENABLED !== 'true') throw new HttpFailure(503, 'Service disabled', 60);
      const config = readWorkerConfig(this.env), url = new URL(request.url);
      if (request.method !== 'POST' || url.origin !== 'https://coordinator' || url.pathname !== '/mcp' || url.search) throw new HttpFailure(404, 'Not found');
      const clientId = request.headers.get('x-evm-client-id');
      if (clientId && !config.tokens.some(token => token.id === clientId)) throw new HttpFailure(403, 'Unknown client');
      if (!clientId && !config.anonymous) throw new HttpFailure(403, 'Client required');
      if (this.active >= config.maxConcurrent) throw new HttpFailure(503, 'Server busy', 1);
      this.active++; admitted = true;
      await takeBudget(this.ctx.storage, config, clientId);
      // Enforce the body bound again for any other code holding the private binding.
      await boundedBody(request.clone());
      server = createMcpServer(this.dispatch);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 });
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) { return failureReply(error); }
    finally { if (admitted) this.active--; if (server) await server.close().catch(() => {}); }
  }
}
