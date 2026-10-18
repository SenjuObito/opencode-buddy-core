import test from 'node:test';
import assert from 'node:assert/strict';
import { probeEngine, describeProbeFailure, ENGINE_BY_API_VERSION } from './engine-probe.js';

/** Minimal Response stand-in for the injected fetch. */
function response(status, body, contentType = 'application/json') {
  return {
    status,
    headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Build a fetchImpl from a route table; unmatched routes 404 with HTML. */
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, authorized: Boolean(init?.headers?.Authorization) });
    const handler = routes[path];
    if (!handler) return response(404, '<!doctype html><html></html>', 'text/html');
    return typeof handler === 'function' ? handler(init) : handler;
  };
}

test('probeEngine: /api/info with apiVersion 2 ⇒ v2', async () => {
  const res = await probeEngine({
    baseUrl: 'http://localhost:4096',
    fetchImpl: fakeFetch({ '/api/info': response(200, { apiVersion: 2, version: '2.0.27' }) }),
  });
  assert.equal(res.engine, 'v2');
  assert.equal(res.apiVersion, 2);
  assert.equal(res.evidence.probePath, '/api/info');
  assert.equal(res.evidence.status, 200);
});

test('probeEngine: /api/info 200 JSON without apiVersion still means v2 (path capability)', async () => {
  const res = await probeEngine({
    baseUrl: 'http://localhost:4096',
    fetchImpl: fakeFetch({ '/api/info': response(200, { ok: true }) }),
  });
  assert.equal(res.engine, 'v2');
  assert.equal(res.apiVersion, 2);
});

test('probeEngine: the HTML SPA fallback must NOT be mistaken for v2', async () => {
  const calls = [];
  const res = await probeEngine({
    baseUrl: 'http://localhost:4096',
    fetchImpl: fakeFetch({
      '/api/info': response(200, '<!doctype html><html>web ui</html>', 'text/html'),
      '/config': response(200, '<!doctype html><html>web ui</html>', 'text/html'),
    }, calls),
    retries: 0,
  });
  assert.equal(res.engine, 'unknown');
  assert.equal(res.evidence.error, 'no-capability-match');
  assert.ok(calls.some((c) => c.path === '/config'), 'v1 capability must be checked too');
});

test('probeEngine: /config returning JSON ⇒ v1', async () => {
  const res = await probeEngine({
    baseUrl: 'http://localhost:4096',
    fetchImpl: fakeFetch({
      '/api/info': response(404, 'not found', 'text/plain'),
      '/config': response(200, { provider: {} }),
    }),
    retries: 0,
  });
  assert.equal(res.engine, 'v1');
  assert.equal(res.evidence.probePath, '/config');
});

test('probeEngine: 401 with a password retries anonymously (password mismatch ≠ unknown engine)', async () => {
  const calls = [];
  const res = await probeEngine({
    baseUrl: 'http://localhost:4096',
    password: 'stale-password',
    fetchImpl: fakeFetch({
      '/api/info': (init) => (
        init?.headers?.Authorization
          ? response(401, { error: 'unauthorized' })
          : response(200, { apiVersion: 2 })
      ),
    }, calls),
    retries: 0,
  });
  assert.equal(res.engine, 'v2');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorized, true);
  assert.equal(calls[1].authorized, false);
});

test('probeEngine: an unknown apiVersion is reported as unknown, never guessed', async () => {
  const res = await probeEngine({
    baseUrl: 'http://localhost:4096',
    fetchImpl: fakeFetch({ '/api/info': response(200, { apiVersion: 99 }) }),
    retries: 0,
  });
  assert.equal(res.engine, 'unknown');
  assert.equal(res.evidence.error, 'unsupported-api-version');
  assert.match(describeProbeFailure(res), /unknown API version 99/);
});

test('probeEngine: connection failures retry then report unknown with no HTTP status', async () => {
  let attempts = 0;
  const res = await probeEngine({
    baseUrl: 'http://localhost:4096',
    fetchImpl: async () => {
      attempts += 1;
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    },
    retries: 1,
  });
  assert.equal(res.engine, 'unknown');
  assert.equal(res.evidence.status, null);
  assert.ok(attempts >= 2, `expected a retry, got ${attempts} attempt(s)`);
  assert.match(describeProbeFailure(res), /No HTTP response/);
});

test('probeEngine: a hung request is aborted by the timeout', async () => {
  const res = await probeEngine({
    baseUrl: 'http://localhost:4096',
    timeoutMs: 60,
    retries: 0,
    fetchImpl: (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  assert.equal(res.engine, 'unknown');
  assert.equal(res.evidence.error, 'timeout');
});

test('probeEngine: missing baseUrl short-circuits without fetching', async () => {
  let called = false;
  const res = await probeEngine({
    baseUrl: '',
    fetchImpl: async () => { called = true; return response(200, {}); },
  });
  assert.equal(called, false);
  assert.equal(res.engine, 'unknown');
  assert.equal(res.evidence.error, 'no-base-url');
});

test('ENGINE_BY_API_VERSION is the single extension point for a future v3', () => {
  assert.deepEqual(ENGINE_BY_API_VERSION, { 1: 'v1', 2: 'v2' });
});
