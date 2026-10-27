/**
 * Session-title contract.
 *
 * <p>Engine v2 does not name a session on its own: the client must ask for it,
 * and the engine stores and publishes the result (`session.renamed`). The
 * plugin therefore never invents a title — it asks once, mirrors the answer,
 * and never shows the engine's placeholder (`New session - <ISO>`) as if it
 * were a conversation name.</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as engineRegistry from './engine-registry.js';
import {
  createSession,
  generateSessionTitle,
  generateSessionTitleText,
  isDefaultSessionTitle,
  sanitizeGeneratedTitle,
  setBaseUrl,
} from './opencode-sdk-client.js';

const DEFAULT_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('isDefaultSessionTitle recognises both engine placeholders', () => {
  assert.equal(isDefaultSessionTitle('New session - 2026-10-27T09:20:28.850Z'), true);
  assert.equal(isDefaultSessionTitle('Child session - 2026-10-27T09:20:28.850Z'), true);
});

test('isDefaultSessionTitle rejects real titles and non-strings', () => {
  assert.equal(isDefaultSessionTitle('Greeting'), false);
  assert.equal(isDefaultSessionTitle(''), false);
  assert.equal(isDefaultSessionTitle(null), false);
  assert.equal(isDefaultSessionTitle(undefined), false);
  // A near-miss must not be treated as a placeholder: the engine itself only
  // recognises the exact ISO shape.
  assert.equal(isDefaultSessionTitle('New session - 2026-10-27'), false);
});

/** Runs `fn` with a stubbed v2 engine and a recording `fetch`. */
async function withV2Fetch(t, handler) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    engineRegistry.reset();
  });
  setBaseUrl('http://127.0.0.1:9');
  engineRegistry.lock(engineRegistry.ENGINE_STATES.V2, {
    probePath: '/api/session',
    status: 200,
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    return handler({ url: String(url), method: init.method || 'GET', body: init.body });
  };
  return calls;
}

test('createSession does not invent a title (v2)', async (t) => {
  const calls = await withV2Fetch(t, () => ({
    ok: true,
    json: async () => ({ data: { id: 'ses_test' } }),
  }));

  await createSession('', '/tmp/project', { agent: 'plan' });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body);
  assert.equal('title' in body, false, 'the engine decides the name, not the plugin');
});

test('createSession keeps an explicit title (v2)', async (t) => {
  const calls = await withV2Fetch(t, () => ({
    ok: true,
    json: async () => ({ data: { id: 'ses_test' } }),
  }));

  await createSession('My session', '/tmp/project');

  assert.equal(JSON.parse(calls[0].body).title, 'My session');
});

test('generateSessionTitle asks the engine with an empty title (v2)', async (t) => {
  const calls = await withV2Fetch(t, () => ({ ok: true, text: async () => '' }));

  const asked = await generateSessionTitle('ses_test', '/tmp/project');

  assert.equal(asked, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /\/api\/session\/ses_test$/);
  assert.deepEqual(JSON.parse(calls[0].body), { title: '' });
});

test('generateSessionTitle is a no-op on v1 (engine titles itself)', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    engineRegistry.reset();
  });
  engineRegistry.lock(engineRegistry.ENGINE_STATES.V1, { cliPath: '/bin/opencode' });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };

  const asked = await generateSessionTitle('ses_test', '/tmp/project');

  assert.equal(asked, false);
  assert.equal(called, false);
});

test('sanitizeGeneratedTitle normalises the model answer', () => {
  assert.equal(sanitizeGeneratedTitle('“查询今天天气情况”。'), '查询今天天气情况');
  assert.equal(sanitizeGeneratedTitle('Title: Quick sort example\n\nbody'), 'Quick sort example');
  assert.equal(sanitizeGeneratedTitle('- 修复会话标题\nignored'), '修复会话标题');
  assert.equal(sanitizeGeneratedTitle('   \n  hello world  \n'), 'hello world');
  assert.equal(sanitizeGeneratedTitle(''), null);
  assert.equal(sanitizeGeneratedTitle(null), null);
  // Never turn the answer into something the UI would hide as a placeholder.
  assert.equal(sanitizeGeneratedTitle('New session - 2026-10-27T09:20:28.850Z'), null);
  assert.equal(
    sanitizeGeneratedTitle('x'.repeat(80)),
    `${'x'.repeat(47)}...`,
  );
});

/**
 * Runs `fn` with a stubbed v1 engine, recording each request.
 *
 * <p>The v1 SDK path hands `fetch` a {@link Request} object (not `(url, init)`),
 * so the body has to be read from a clone — reading `init.body` here silently
 * sees nothing and makes a broken assertion look like broken code.</p>
 */
async function withV1Fetch(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    engineRegistry.reset();
  });
  setBaseUrl('http://127.0.0.1:9');
  engineRegistry.lock(engineRegistry.ENGINE_STATES.V1, { cliPath: '/bin/opencode' });
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const text = await request.clone().text();
    calls.push({
      method: request.method,
      url: request.url,
      body: text ? JSON.parse(text) : null,
    });
    return new Response(JSON.stringify({ id: 'ses_v1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

test('createSession leaves the title to the engine on v1', async (t) => {
  const calls = await withV1Fetch(t);

  await createSession('', '/tmp/project').catch(() => {});

  assert.equal(calls.length, 1);
  // v1 seeds its own default title; a plugin-supplied one would make the
  // session look already named and suppress the engine's own naming.
  assert.ok(!calls[0].body || !('title' in calls[0].body));
});

test('createSession forwards an explicit title on v1', async (t) => {
  const calls = await withV1Fetch(t);

  await createSession('My session', '/tmp/project').catch(() => {});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.title, 'My session');
});

test('generateSessionTitleText asks the engine to generate from context (v2)', async (t) => {
  const calls = await withV2Fetch(t, () => ({
    ok: true,
    json: async () => ({ data: { text: '查询今天天气情况' } }),
  }));

  const text = await generateSessionTitleText('ses_test', '/tmp/project');

  assert.equal(text, '查询今天天气情况');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/session\/ses_test\/generate$/);
  assert.match(JSON.parse(calls[0].body).prompt, /Reply with a title/);
});

test('generateSessionTitleText is a no-op on v1', async () => {
  assert.equal(await generateSessionTitleText('ses_test'), null);
});

test('generateSessionTitle surfaces engine failures for a retry', async (t) => {
  await withV2Fetch(t, () => ({ ok: false, status: 500, text: async () => 'boom' }));

  await assert.rejects(() => generateSessionTitle('ses_test'), /HTTP 500 boom/);
});
