// SPDX-License-Identifier: AGPL-3.0-only
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAdapter } from './adapter.js';
import { createMcpServer } from './mcp.js';
import { createSiteClient } from './site.js';
import { createPollingClient } from './polling.js';
import { durableSourceFetch } from './worker-source.js';
import { HttpFailure, jsonReply, failureReply, readWorkerConfig, authenticatedClient, networkIdentity, checkBodyLength, boundedBody, takeBudget, readUsage } from './worker-policy.js';

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
      if (url.pathname === '/admin/usage' && !url.search) {
        if (!clientId || !config.operatorIds.includes(clientId)) throw new HttpFailure(403, 'Operator required');
        if (request.method !== 'GET') return jsonReply(405, 'Only GET is supported', { allow: 'GET' });
        const stub = env.ELECTORAL_COORDINATOR.get(env.ELECTORAL_COORDINATOR.idFromName('global-v1'));
        return await stub.fetch(new Request('https://coordinator/admin/usage', { headers: { 'x-evm-client-id': clientId } }));
      }
      if (url.pathname !== '/mcp' || url.search) throw new HttpFailure(404, 'Not found');
      if (!clientId && !config.anonymous) return jsonReply(401, 'Unauthorized', { 'www-authenticate': 'Bearer realm="electoral-vote-map"' });
      if (request.method !== 'POST') return jsonReply(405, 'Only POST is supported', { allow: 'POST' });
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpFailure(415, 'Expected application/json');
      checkBodyLength(request);
      const headers = new Headers();
      for (const name of ['content-type', 'content-length', 'accept', 'mcp-protocol-version']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
      if (clientId) headers.set('x-evm-client-id', clientId);
      // Exactly one namespace-local ID for every deployment/location. Never key
      // this by the request, user, region, or revision: that would reset quotas.
      const stub = env.ELECTORAL_COORDINATOR.get(env.ELECTORAL_COORDINATOR.idFromName('global-v1'));
      // Reserve before reading at the edge: a provider may buffer a streamed
      // service-binding body before the coordinator can inspect it.
      const admissionHeaders = new Headers();
      if (clientId) admissionHeaders.set('x-evm-client-id', clientId);
      const admission = await stub.fetch(new Request('https://coordinator/admit', { method: 'POST', headers: admissionHeaders }));
      if (!admission.ok) return admission;
      const { admission_id: admissionId } = await admission.json();
      if (typeof admissionId !== 'string' || !/^[a-f0-9-]{36}$/.test(admissionId)) throw new HttpFailure(503, 'Admission unavailable');
      let handedOff = false, failureStatus;
      try {
        const text = await boundedBody(request);
        headers.set('x-evm-admission-id', admissionId);
        const response = await stub.fetch(new Request('https://coordinator/mcp', { method: 'POST', headers, body: text }));
        handedOff = true;
        return response;
      } catch (error) {
        failureStatus = error instanceof HttpFailure ? error.status : 503;
        throw error;
      } finally {
        if (!handedOff) {
          const releaseHeaders = new Headers({ 'x-evm-admission-id': admissionId });
          if (clientId) releaseHeaders.set('x-evm-client-id', clientId);
          if (failureStatus) releaseHeaders.set('x-evm-release-status', String(failureStatus));
          await stub.fetch(new Request('https://coordinator/release', { method: 'POST', headers: releaseHeaders })).catch(() => {});
        }
      }
    } catch (error) { return failureReply(error); }
  },
};

export class ElectoralCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.active = 0;
    this.admissions = new Map();
    this.transientStats = { since: new Date().toISOString(), rejections_by_status: {} };
    const fetchImpl = durableSourceFetch(ctx.storage);
    // The durable fetch cache owns failure expiry. A second parser-layer failure
    // cache would restart the 30s timer after eviction and delay source recovery.
    this.dispatch = createAdapter({ loadSite: createSiteClient({ fetchImpl, failureTtlMs: 0 }), loadPolling: createPollingClient({ fetchImpl, failureTtlMs: 0 }) });
  }
  releaseAdmission(id, clientId) {
    const admission = this.admissions.get(id);
    if (!admission || admission.clientId !== clientId) return false;
    clearTimeout(admission.timer);
    this.admissions.delete(id);
    this.active--;
    return true;
  }
  recordRejection(status) {
    this.transientStats.rejections_by_status[status] = (this.transientStats.rejections_by_status[status] ?? 0) + 1;
  }
  async fetch(request) {
    let server;
    let admitted = false;
    try {
      if (this.env.EVM_ENABLED !== 'true') throw new HttpFailure(503, 'Service disabled', 60);
      const config = readWorkerConfig(this.env), url = new URL(request.url);
      if (url.origin !== 'https://coordinator' || url.search) throw new HttpFailure(404, 'Not found');
      const clientId = request.headers.get('x-evm-client-id');
      if (clientId && !config.tokens.some(token => token.id === clientId)) throw new HttpFailure(403, 'Unknown client');
      if (url.pathname === '/admin/usage' && request.method === 'GET') {
        if (!clientId || !config.operatorIds.includes(clientId)) throw new HttpFailure(403, 'Operator required');
        return Response.json({ ...await readUsage(this.ctx.storage, config), active_requests: this.active, transient: this.transientStats }, { headers: { 'cache-control': 'no-store' } });
      }
      if (!clientId && !config.anonymous) throw new HttpFailure(403, 'Client required');
      if (request.method !== 'POST') throw new HttpFailure(404, 'Not found');
      const admissionId = request.headers.get('x-evm-admission-id');
      if (url.pathname === '/release') {
        if (this.releaseAdmission(admissionId, clientId)) {
          const status = Number(request.headers.get('x-evm-release-status'));
          if ([400, 408, 413, 503].includes(status)) this.recordRejection(status);
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/admit') {
        if (this.active >= config.maxConcurrent) throw new HttpFailure(503, 'Server busy', 1);
        this.active++; admitted = true;
        await takeBudget(this.ctx.storage, config, clientId);
        const id = crypto.randomUUID();
        const timer = setTimeout(() => this.releaseAdmission(id, clientId), 10_000);
        this.admissions.set(id, { clientId, timer });
        admitted = false; // The reservation now owns the concurrency slot.
        return Response.json({ admission_id: id }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname !== '/mcp') throw new HttpFailure(404, 'Not found');
      const admission = this.admissions.get(admissionId);
      if (!admission || admission.clientId !== clientId) throw new HttpFailure(503, 'Admission expired', 1);
      clearTimeout(admission.timer);
      this.admissions.delete(admissionId);
      admitted = true; // Consume once; keep its slot until MCP work finishes.
      const text = await boundedBody(request);
      server = createMcpServer(this.dispatch);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 });
      await server.connect(transport);
      const response = await transport.handleRequest(new Request(request.url, { method: 'POST', headers: request.headers, body: text }));
      if (response.status >= 400) this.recordRejection(response.status);
      return response;
    } catch (error) {
      const status = error instanceof HttpFailure ? error.status : 503;
      this.recordRejection(status);
      return failureReply(error);
    }
    finally { if (admitted) this.active--; if (server) await server.close().catch(() => {}); }
  }
}
