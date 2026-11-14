// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAdapter } from '../src/adapter.js';
import { createSiteClient } from '../src/site.js';
import { createPollingClient } from '../src/polling.js';
import { MAX_HTTP_BODY_BYTES, readTransportConfig, startHttpServer } from '../src/http.js';

const fixtureHtml = await readFile(new URL('./fixtures/site.html', import.meta.url), 'utf8');
const fixtureCsv = await readFile(new URL('./fixtures/polling.csv', import.meta.url), 'utf8');
const dispatch = createAdapter({ loadSite: createSiteClient({ fixtureHtml }), loadPolling: createPollingClient({ fixtureCsv }) });
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'https-test', version: '1.0.0' } } };

async function start(t, options = {}) {
  const server = await startHttpServer({ dispatch, port: 0, ...options });
  t.after(() => server.close());
  return server;
}
async function connect(t, url, options = {}) {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), options));
  return client;
}
// fetch controls Host itself on some supported Node versions. Use a raw request
// so the DNS-rebinding tests send the exact attacker/proxy authority on the wire.
function rawHttp(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('transport configuration keeps stdio default and requires explicit, complete HTTPS settings', () => {
  assert.deepEqual(readTransportConfig(), { transport: 'stdio' });
  assert.equal(readTransportConfig({ EVM_TRANSPORT: 'http' }).host, '127.0.0.1');
  const config = readTransportConfig({ EVM_TRANSPORT: 'http', EVM_PORT: '0', EVM_TLS_CERT: 'cert.pem', EVM_TLS_KEY: 'key.pem', EVM_ALLOWED_HOSTS: 'maps.example.com', EVM_ALLOWED_ORIGINS: 'https://maps.example.com' }, ['--transport=https']);
  assert.equal(config.transport, 'https');
  assert.equal(config.port, 0);
  for (const env of [
    { EVM_TRANSPORT: 'bad' }, { EVM_TRANSPORT: 'https' },
    { EVM_TRANSPORT: 'http', EVM_TLS_KEY: 'key.pem' },
    { EVM_TRANSPORT: 'http', EVM_PORT: '3000junk' },
    { EVM_TRANSPORT: 'http', EVM_PORT: '65536' },
    { EVM_TRANSPORT: 'http', EVM_ALLOWED_HOSTS: 'https://evil.example/' },
    { EVM_TRANSPORT: 'http', EVM_ALLOWED_ORIGINS: '*' },
    { EVM_TRANSPORT: 'http', EVM_HTTP_BEARER_TOKEN: '' },
    { EVM_TRANSPORT: 'http', EVM_HTTP_REQUESTS_PER_MINUTE: '0' },
    { EVM_TRANSPORT: 'http', EVM_HTTP_MAX_CONCURRENT: 'unlimited' },
  ]) assert.throws(() => readTransportConfig(env));
  assert.throws(() => readTransportConfig({}, ['--unknown']));
});

test('real Streamable HTTP clients have independent lifecycles and the same MCP-AQL operations', { timeout: 30_000 }, async t => {
  const { url } = await start(t);
  const clients = await Promise.all([connect(t, url), connect(t, url)]);
  await Promise.all(clients.map(async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['mcp_aql_read']);
    assert.equal(tools[0].annotations.readOnlyHint, true);
    const invoke = async (operation, params = {}) => client.callTool({ name: 'mcp_aql_read', arguments: { operation, params } });
    assert.equal((await invoke('introspect')).structuredContent.success, true);
    assert.equal((await invoke('list_scenarios')).structuredContent.data.scenarios.length, 7);
    const changed = await invoke('modify_map', { scenario_id: 'blue-wall', edits: [{ unit: 'MA', flip: true }] });
    assert.equal(changed.structuredContent.data.map.totals.rep, 279);
    assert.match(changed.structuredContent.data.map.map_url, /^https:\/\/electoralvotemap.com\/\?map=2028:/);
    const invalid = await invoke('get_map', { arbitrary: 'not allowed' });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, 'VALIDATION_UNKNOWN_PARAM');
    const polling = await invoke('get_poll_average', { dataset_id: 'senate_2024', race_id: 'PA', as_of: '2024-11-02' });
    assert.equal(polling.structuredContent.data.poll_count, 2);
  }));
  await clients[0].close();
  assert.equal((await clients[1].listTools()).tools.length, 1);
});

test('HTTP enforces Host and Origin before serving MCP or health checks', { timeout: 10_000 }, async t => {
  const { url } = await start(t);
  assert.equal((await fetch(new URL('/healthz', url))).status, 200);
  for (const path of ['/mcp', '/healthz']) {
    assert.equal(await rawHttp(new URL(path, url), { Host: 'attacker.example' }), 403);
    assert.equal((await fetch(new URL(path, url), { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(new URL(path, url), { headers: { Origin: 'null' } })).status, 403);
  }
  assert.equal((await fetch(new URL('/healthz', url), { headers: { Origin: new URL(url).origin } })).status, 200);
  const proxy = await start(t, { allowedHosts: ['maps.example.com'], allowedOrigins: ['https://assistant.example.com'] });
  assert.equal((await fetch(proxy.url)).status, 403);
  assert.equal(await rawHttp(proxy.url, { Host: 'maps.example.com', Origin: 'https://assistant.example.com' }), 405);
});

test('optional bearer authentication protects MCP and supports a real SDK client', { timeout: 10_000 }, async t => {
  const { url } = await start(t, { bearerToken: 'test-only-secret' });
  for (const authorization of [undefined, 'Bearer wrong', 'Basic test-only-secret']) {
    const response = await fetch(url, { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Bearer /);
  }
  const client = await connect(t, url, { requestInit: { headers: { Authorization: 'Bearer test-only-secret' } } });
  assert.equal((await client.listTools()).tools.length, 1);
});

test('HTTP handles unsupported methods, malformed messages, protocol versions and oversized bodies', { timeout: 10_000 }, async t => {
  const { url } = await start(t);
  for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
    const response = await fetch(url, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  assert.equal((await fetch(new URL('/missing', url))).status, 404);
  const post = (body, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), { 'MCP-Protocol-Version': 'invalid' })).status, 400);
  assert.equal((await post(' '.repeat(MAX_HTTP_BODY_BYTES + 1))).status, 413);
  // Exercise the observed-size bound too, without a Content-Length header.
  const streamed = await fetch(url, { method: 'POST', headers, body: (async function* () { yield ' '.repeat(MAX_HTTP_BODY_BYTES); yield 'x'; })(), duplex: 'half' });
  assert.equal(streamed.status, 413);
  // Bad requests do not poison later independent requests.
  const response = await post(JSON.stringify(initialize));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), null);
});

test('direct HTTPS verifies a supplied certificate and serves MCP without disabling TLS validation', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'evm-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 10_000 });
  const { url } = await start(t, { transport: 'https', certPath, keyPath });
  await assert.rejects(new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'POST', headers }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.end(JSON.stringify(initialize));
  }), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  // Trust this ephemeral CA only for this request; hostname verification stays on.
  const ca = await readFile(certPath);
  const trusted = await new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'POST', headers, ca }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(initialize));
  });
  assert.equal(trusted.status, 200);
  assert.equal(trusted.body.result.serverInfo.name, 'mcpaql-electoral-vote-map-demo');
});

test('CLI starts HTTP from environment and closes cleanly on SIGTERM', { timeout: 15_000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
    env: { ...process.env, EVM_TRANSPORT: 'http', EVM_HOST: '127.0.0.1', EVM_PORT: '0', EVM_ALLOWED_HOSTS: '', EVM_ALLOWED_ORIGINS: '', EVM_HTTP_BEARER_TOKEN: undefined, EVM_TLS_CERT: undefined, EVM_TLS_KEY: undefined, EVM_TEST_FIXTURE: fileURLToPath(new URL('./fixtures/site.html', import.meta.url)) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const url = await new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/listening on (http:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once('exit', () => reject(new Error(`HTTP startup exited: ${stderr}`)));
    child.once('error', reject);
  });
  const client = await connect(t, url);
  assert.equal((await client.listTools()).tools.length, 1);
  await client.close();
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  assert.deepEqual(await exit, [0, null]);
  assert.equal(stdout, '', 'HTTP diagnostics never write to stdout');
});

test('HTTP counts failed authentication attempts and ignores spoofed proxy identities', { timeout: 10_000 }, async t => {
  const { url } = await start(t, { bearerToken: 'test-only-secret', perIpPerMinute: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await fetch(url, { headers: { 'X-Forwarded-For': `192.0.2.${i}` } })).status, 401);
  const response = await fetch(url, { headers: { Authorization: 'Bearer test-only-secret', 'X-Forwarded-For': '192.0.2.99' } });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.doesNotMatch(await response.text(), /test-only-secret/);
});

test('HTTP rejects work over the concurrency bound and recovers when the active response finishes', { timeout: 10_000 }, async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const { url } = await start(t, { maxConcurrent: 1, dispatch: async () => { entered(); await blocked; return { success: true, data: {} }; } });
  const request = fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mcp_aql_read', arguments: { operation: 'introspect' } } }) });
  await started;
  const busy = await fetch(new URL('/healthz', url));
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '1');
  release();
  assert.equal((await request).status, 200);
  assert.equal((await fetch(new URL('/healthz', url))).status, 200);
});
