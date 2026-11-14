// SPDX-License-Identifier: AGPL-3.0-only
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.js';

export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

const csv = value => value ? value.split(',').map(item => item.trim()) : [];
function authority(value) {
  const url = new URL(`http://${value}`);
  if (url.host !== value.toLowerCase() || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('EVM_ALLOWED_HOSTS must contain exact host[:port] values');
  }
  return url.host;
}
function origin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
    throw new Error('EVM_ALLOWED_ORIGINS must contain exact HTTP(S) origins without trailing slashes');
  }
  return value;
}

export function readTransportConfig(env = {}, args = []) {
  let transport = env.EVM_TRANSPORT || 'stdio';
  if (args.length) {
    if (args.length === 1 && args[0].startsWith('--transport=')) transport = args[0].slice(12);
    else if (args.length === 2 && args[0] === '--transport') transport = args[1];
    else throw new Error('Usage: server.js [--transport=stdio|http|https]');
  }
  if (!['stdio', 'http', 'https'].includes(transport)) throw new Error('EVM_TRANSPORT must be stdio, http or https');
  if (transport === 'stdio') return { transport };
  const portText = env.EVM_PORT ?? '3000';
  if (!/^\d+$/.test(portText) || Number(portText) > 65535) throw new Error('EVM_PORT must be an integer from 0 to 65535');
  if (transport === 'https' && (!env.EVM_TLS_CERT || !env.EVM_TLS_KEY)) throw new Error('HTTPS requires EVM_TLS_CERT and EVM_TLS_KEY file paths');
  if (transport === 'http' && (env.EVM_TLS_CERT || env.EVM_TLS_KEY)) throw new Error('Use --transport=https with TLS certificate/key files');
  const bearerToken = env.EVM_HTTP_BEARER_TOKEN;
  if (bearerToken !== undefined && !/^[A-Za-z0-9\-._~+/]+=*$/.test(bearerToken)) throw new Error('EVM_HTTP_BEARER_TOKEN must be a nonempty bearer token');
  return {
    transport, host: env.EVM_HOST || '127.0.0.1', port: Number(portText),
    allowedHosts: csv(env.EVM_ALLOWED_HOSTS).map(authority),
    allowedOrigins: csv(env.EVM_ALLOWED_ORIGINS).map(origin),
    bearerToken, certPath: env.EVM_TLS_CERT, keyPath: env.EVM_TLS_KEY,
  };
}

function reply(res, status, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify({ error: message }));
}

// Stateless Streamable HTTP: a fresh MCP server/transport for EVERY POST avoids
// collisions when different clients reuse JSON-RPC request IDs. Only caches are shared.
export async function startHttpServer({ dispatch, transport = 'http', host = '127.0.0.1', port = 3000,
  allowedHosts = [], allowedOrigins = [], bearerToken, certPath, keyPath }) {
  const tls = transport === 'https' ? {
    cert: await readFile(certPath), key: await readFile(keyPath), minVersion: 'TLSv1.2',
  } : undefined;
  const tokenHash = bearerToken ? createHash('sha256').update(`Bearer ${bearerToken}`).digest() : undefined;
  const active = new Set();
  const listener = async (req, res) => {
    try {
      const boundPort = webServer.address().port;
      const hosts = allowedHosts.length ? allowedHosts : ['127.0.0.1', 'localhost', '[::1]'].map(name => `${name}:${boundPort}`);
      const requestHost = req.headers.host?.toLowerCase();
      // Never trust X-Forwarded-*; configure the public Host explicitly for a proxy.
      if (!hosts.includes(requestHost)) return reply(res, 403, 'Host not allowed');
      const origins = allowedOrigins.length ? allowedOrigins : hosts.map(name => `${transport}://${name}`);
      if (req.headers.origin !== undefined && !origins.includes(req.headers.origin)) return reply(res, 403, 'Origin not allowed');
      // The liveness endpoint contains no data; all MCP methods require authentication when configured.
      if (req.url === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end('{"status":"ok"}');
      }
      if (req.url !== '/mcp') return reply(res, 404, 'Not found');
      if (tokenHash && !timingSafeEqual(tokenHash, createHash('sha256').update(req.headers.authorization || '').digest())) {
        return reply(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="electoral-vote-map"' });
      }
      if (req.method !== 'POST') return reply(res, 405, 'Only POST is supported; no session or standalone SSE stream', { Allow: 'POST' });
      const server = createMcpServer(dispatch);
      const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_HTTP_BODY_BYTES });
      active.add(server);
      res.once('close', () => {
        active.delete(server);
        void server.close().catch(() => {});
      });
      await server.connect(mcpTransport);
      await mcpTransport.handleRequest(req, res);
    } catch {
      // Do not echo request contents, credentials, or TLS paths into responses/logs.
      if (!res.headersSent) reply(res, 500, 'Internal server error');
      else res.destroy();
    }
  };
  const webServer = tls ? createHttpsServer(tls, listener) : createHttpServer(listener);
  webServer.requestTimeout = 30_000;
  webServer.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    webServer.once('error', reject);
    webServer.listen(port, host, resolve);
  });
  const address = webServer.address();
  const urlHost = address.address.includes(':') ? `[${address.address}]` : address.address;
  return {
    url: `${transport}://${urlHost}:${address.port}/mcp`,
    async close() {
      const closed = new Promise((resolve, reject) => webServer.close(error => error ? reject(error) : resolve()));
      webServer.closeAllConnections();
      await Promise.allSettled([...active].map(server => server.close()));
      await closed;
    },
  };
}
