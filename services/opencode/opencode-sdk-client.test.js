import test from 'node:test';
import assert from 'node:assert/strict';
import * as registry from './engine-registry.js';
import {
  createSession,
  listMessages,
  listSessions,
  normalizeDirForMatch,
  promptAsync,
  resetClient,
  setBaseUrl,
  setSessionAgent,
  setSessionModel,
  summarizeSession,
  toV2ModelRef,
} from './opencode-sdk-client.js';
import { resolvePendingCompaction, clearPendingCompactions } from './compaction-tracker.js';

/**
 * Route-contract tests for the v2 message endpoint.
 *
 * Background: `listMessages` used to request `/session/{id}/message` — no `/api`
 * prefix — on the belief that v2 dropped the prefix. That path is not a server
 * route, so the web UI's SPA handler answered `200 text/html` and the client
 * died in `res.json()` with `Unexpected token '<'`, which is what surfaced to the
 * user as "loading a history session fails". The authoritative route table is the
 * server's own `/openapi.json`; the prefix is required.
 *
 * These tests pin the URL, so the same mistake cannot come back silently.
 */

const SESSION_ID = 'ses_route_contract';

/** Install a fetch stub and hand back the recorded requests. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url?.url ?? String(url);
    calls.push({ href, path: new URL(href).pathname, init });
    return handler(href, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key) => (String(key).toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function htmlResponse() {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (key) => (String(key).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
    },
    json: async () => {
      throw new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON');
    },
    text: async () => '<!doctype html><html></html>',
  };
}

/** Force the registry into a locked v2 state without any probing or spawning. */
function lockV2() {
  registry.reset();
  registry.lock('v2', { probePath: '/api/info', status: 200, apiVersion: 2 });
  setBaseUrl('http://localhost:4096');
  resetClient();
}

test('v2 listMessages requests /api/session/{id}/message (with the /api prefix)', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({ data: [] }));
  try {
    await listMessages(SESSION_ID);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].path, `/api/session/${SESSION_ID}/message`);
    // The prefix-less form is the SPA route; it must never be the primary request.
    assert.notEqual(stub.calls[0].path, `/session/${SESSION_ID}/message`);
  } finally {
    stub.restore();
  }
});

test('v2 listMessages parses the data array returned by the real route', async () => {
  lockV2();
  const stub = stubFetch(() =>
    jsonResponse({
      data: [
        { id: 'msg_b', time: { created: 200 }, info: { id: 'msg_b' }, parts: [] },
        { id: 'msg_a', time: { created: 100 }, info: { id: 'msg_a' }, parts: [] },
      ],
    }),
  );
  try {
    const entries = await listMessages(SESSION_ID);
    assert.equal(entries.length, 2);
    // Chronological order is part of the contract: newest-first from the server.
    assert.equal(entries[0].info.id, 'msg_a');
    assert.equal(entries[1].info.id, 'msg_b');
  } finally {
    stub.restore();
  }
});

test('an HTML SPA response is reported as a route problem, not a JSON syntax error', async () => {
  lockV2();
  const stub = stubFetch(() => htmlResponse());
  try {
    await assert.rejects(
      () => listMessages(SESSION_ID),
      (err) => {
        // The confusing `Unexpected token '<'` must not be what the caller sees:
        // it names the payload instead of the actual cause (a wrong route).
        assert.match(err.message, /does not exist on this engine build/);
        assert.doesNotMatch(err.message, /Unexpected token/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('tolerateError turns both a bad route and a bad status into an empty list', async () => {
  lockV2();
  const stub = stubFetch(() => htmlResponse());
  try {
    assert.deepEqual(await listMessages(SESSION_ID, undefined, { tolerateError: true }), []);
  } finally {
    stub.restore();
  }

  const stub404 = stubFetch(() => jsonResponse({}, 404));
  try {
    assert.deepEqual(await listMessages(SESSION_ID, undefined, { tolerateError: true }), []);
  } finally {
    stub404.restore();
  }
});

// =============================================================================
// v2 session-scoped agent / model
//
// v2 moved agent/model from message scope to session scope: `POST /prompt` has
// no such fields, and the session keeps whatever it was created with until
// `/agent` or `/model` changes it. These tests pin both halves — creation seeds
// the selection, and the prompt body must never carry it again.
// =============================================================================

const V2_MODEL = { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' };

function lockV1() {
  registry.reset();
  registry.lock('v1', { probePath: '/config', status: 200 });
  setBaseUrl('http://localhost:4096');
  resetClient();
}

test('toV2ModelRef renames modelID to id and folds in the variant', () => {
  assert.deepEqual(toV2ModelRef(V2_MODEL, 'high'), {
    id: 'deepseek-v4.1-flash-free',
    providerID: 'opencode',
    variant: 'high',
  });

  // No variant: the field is omitted rather than sent empty.
  assert.deepEqual(toV2ModelRef(V2_MODEL), {
    id: 'deepseek-v4.1-flash-free',
    providerID: 'opencode',
  });
});

test('toV2ModelRef refuses a bare model id (Model.Ref requires a provider)', () => {
  assert.equal(toV2ModelRef({ providerID: '', modelID: 'gpt-5' }), null);
  assert.equal(toV2ModelRef(null), null);
  assert.equal(toV2ModelRef({ providerID: 'opencode' }), null);
});

test('v2 createSession seeds agent and model on the new session', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({ data: { id: SESSION_ID } }));
  try {
    await createSession('', '/repo', { agent: 'plan', model: V2_MODEL, variant: 'high' });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].path, '/api/session');
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.agent, 'plan');
    assert.deepEqual(body.model, {
      id: 'deepseek-v4.1-flash-free',
      providerID: 'opencode',
      variant: 'high',
    });
    assert.equal(body.location.directory, '/repo');
  } finally {
    stub.restore();
  }
});

test('v2 setSessionAgent posts to /agent', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({}));
  try {
    const applied = await setSessionAgent(SESSION_ID, 'plan');
    assert.equal(applied, true);
    assert.equal(stub.calls[0].path, `/api/session/${SESSION_ID}/agent`);
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), { agent: 'plan' });
  } finally {
    stub.restore();
  }
});

test('v2 setSessionModel posts /model with Model.Ref shape', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({}));
  try {
    const ref = toV2ModelRef(V2_MODEL, 'high');
    const applied = await setSessionModel(SESSION_ID, ref);
    assert.equal(applied, true);
    assert.equal(stub.calls[0].path, `/api/session/${SESSION_ID}/model`);
    const body = JSON.parse(stub.calls[0].init.body);
    assert.deepEqual(body, {
      model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', variant: 'high' },
    });
    // The v1 field name must never leak into the v2 payload.
    assert.equal(body.model.modelID, undefined);
  } finally {
    stub.restore();
  }
});

test('v1 never calls the v2 selection endpoints', async () => {
  lockV1();
  const stub = stubFetch(() => jsonResponse({}));
  try {
    assert.equal(await setSessionAgent(SESSION_ID, 'plan'), false);
    assert.equal(await setSessionModel(SESSION_ID, toV2ModelRef(V2_MODEL)), false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('v2 prompt body carries no agent/model (they live on the session)', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({}));
  try {
    await promptAsync(SESSION_ID, 'hello', {
      agent: 'plan',
      model: V2_MODEL,
      variant: 'high',
    });
    assert.equal(stub.calls[0].path, `/api/session/${SESSION_ID}/prompt`);
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.text, 'hello');
    assert.equal(body.agent, undefined);
    assert.equal(body.model, undefined);
  } finally {
    stub.restore();
  }
});

test('v2 setSessionModel retries without the variant when the model rejects it', async () => {
  lockV2();
  let attempts = 0;
  const stub = stubFetch(() => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => 'Variant unavailable for opencode/mimo-v2.6-flash-free: high',
      };
    }
    return jsonResponse({});
  });
  try {
    const applied = await setSessionModel(SESSION_ID, {
      id: 'mimo-v2.6-flash-free',
      providerID: 'opencode',
      variant: 'high',
    });
    // The model switch still lands; only the unsupported variant is dropped.
    assert.equal(applied, true);
    assert.equal(stub.calls.length, 2);
    const retry = JSON.parse(stub.calls[1].init.body);
    assert.deepEqual(retry.model, { id: 'mimo-v2.6-flash-free', providerID: 'opencode' });
    assert.equal(retry.model.variant, undefined);
  } finally {
    stub.restore();
  }
});

test('v2 setSessionModel surfaces unrelated failures without retrying', async () => {
  lockV2();
  const stub = stubFetch(() => ({
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => 'internal boom',
  }));
  try {
    await assert.rejects(
      () => setSessionModel(SESSION_ID, { id: 'x', providerID: 'opencode', variant: 'high' }),
      /HTTP 500/,
    );
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('toV2ModelRef drops the pseudo-variant "default"', () => {
  // "default" is the UI's way of saying "send no variant". No opencode model
  // declares it, so forwarding it would ask for a level that does not exist.
  // Omitting the field is what makes the server report `variant: "default"`.
  assert.deepEqual(toV2ModelRef(V2_MODEL, 'default'), {
    id: 'deepseek-v4.1-flash-free',
    providerID: 'opencode',
  });
  // Blank / whitespace-only input behaves the same.
  assert.deepEqual(toV2ModelRef(V2_MODEL, '   '), {
    id: 'deepseek-v4.1-flash-free',
    providerID: 'opencode',
  });
  // A real variant is still forwarded.
  assert.equal(toV2ModelRef(V2_MODEL, 'high').variant, 'high');
});

test('v2 createSession omits the variant when the effort is default', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({ data: { id: SESSION_ID } }));
  try {
    await createSession('', '/repo', { agent: 'plan', model: V2_MODEL, variant: 'default' });
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.agent, 'plan');
    assert.deepEqual(body.model, { id: 'deepseek-v4.1-flash-free', providerID: 'opencode' });
    assert.equal(body.model.variant, undefined);
  } finally {
    stub.restore();
  }
});

test('v2 listSessions strictly filters sessions by directory and does not leak other projects', async () => {
  lockV2();
  const stub = stubFetch(() =>
    jsonResponse({
      data: [
        { id: 'ses_1', location: { directory: 'd:/source/repos/project-a' }, title: 'Project A session' },
        { id: 'ses_2', location: { directory: 'd:/source/repos/project-b' }, title: 'Project B session' },
      ],
    }),
  );
  try {
    // When requesting project-a, only project-a sessions are returned
    const projASessions = await listSessions('D:\\source\\repos\\project-a');
    assert.equal(projASessions.length, 1);
    assert.equal(projASessions[0].id, 'ses_1');

    // When requesting a brand new project-c (0 matching sessions), it returns [] instead of leaking project A or B
    const projCSessions = await listSessions('D:\\source\\repos\\project-c');
    assert.equal(projCSessions.length, 0);
  } finally {
    stub.restore();
  }
});

test('v2 listSessions forwards parentID so child sessions are discovered server-side', async () => {
  lockV2();
  const stub = stubFetch(() =>
    jsonResponse({
      data: [
        { id: 'ses_child', parentID: 'ses_parent', location: { directory: '/repo' }, title: 'Explore repo' },
      ],
    }),
  );
  try {
    const children = await listSessions('/repo', 200, 'ses_parent');
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].href, /[?&]parentID=ses_parent(?:&|$)/);
    assert.equal(children.length, 1);
    assert.equal(children[0].id, 'ses_child');
  } finally {
    stub.restore();
  }
});

test('v2 listSessions unifies location.directory and the model object for the host', async () => {
  lockV2();
  const stub = stubFetch(() =>
    jsonResponse({
      data: [
        {
          id: 'ses_1',
          location: { directory: 'd:/source/repos/project-a' },
          model: { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'low' },
          agent: 'build',
          title: 'Project A session',
        },
      ],
    }),
  );
  try {
    const sessions = await listSessions('D:\\source\\repos\\project-a');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].directory, 'd:/source/repos/project-a');
    assert.equal(sessions[0].model, 'opencode/deepseek-v4.1-flash-free');
    assert.equal(sessions[0].agent, 'build');
  } finally {
    stub.restore();
  }
});

test('normalizeDirForMatch folds case for Windows-shaped paths on every host', () => {
  // A drive-letter or UNC path can only come from a Windows filesystem, which is
  // case-insensitive. The result must not depend on which OS the bridge runs on:
  // sessions recorded on Windows otherwise stop matching when this code runs on
  // Linux (CI, containers, WSL-adjacent setups).
  assert.equal(
    normalizeDirForMatch('D:\\Source\\Repos\\Project-A\\'),
    normalizeDirForMatch('d:/source/repos/project-a'),
  );
  assert.equal(
    normalizeDirForMatch('\\\\Server\\Share\\Project'),
    normalizeDirForMatch('//server/share/project'),
  );
});

test('normalizeDirForMatch keeps POSIX paths case-sensitive off Windows', () => {
  // Trailing slashes are always normalised away.
  assert.equal(normalizeDirForMatch('/repo/a/'), normalizeDirForMatch('/repo/a'));

  // Windows paths are case-insensitive by definition, so there is nothing to
  // assert there. Everywhere else `/repo/A` and `/repo/a` are two different
  // directories, and folding them would merge unrelated projects' sessions.
  if (process.platform === 'win32') return;
  assert.notEqual(normalizeDirForMatch('/repo/A'), normalizeDirForMatch('/repo/a'));
});

test('v2 listMessages preserves compaction message as isCompactSummary', async () => {
  lockV2();
  const stub = stubFetch(() =>
    jsonResponse({
      data: [
        {
          type: 'compaction',
          id: 'cmp_123',
          summary: 'The session was compacted.',
          recent: 'Recent context.',
          reason: 'manual',
          time: { created: 1000 },
        },
        {
          type: 'user',
          id: 'usr_1',
          text: 'Hello again',
          time: { created: 2000 },
        },
      ],
    }),
  );
  try {
    const messages = await listMessages(SESSION_ID);
    assert.equal(messages.length, 2);
    const compactEntry = messages[0];
    assert.equal(compactEntry.info.role, 'compaction');
    assert.equal(compactEntry.info.isCompactSummary, true);
    assert.equal(compactEntry.info.compactMetadata?.trigger, 'manual');
    assert.equal(compactEntry.info.compactMetadata?.userContext, 'The session was compacted.');
    assert.equal(compactEntry.parts[0]?.text, 'The session was compacted.');
  } finally {
    stub.restore();
  }
});

test('v2 summarizeSession sends POST to /api/session/{id}/compact and awaits pending compaction', async () => {
  lockV2();
  clearPendingCompactions();
  const stub = stubFetch((url) => {
    if (url.includes('/api/session/ses_comp_test/compact')) {
      // Simulate asynchronous resolution from SSE event 50ms later
      setTimeout(() => {
        resolvePendingCompaction('ses_comp_test', true);
      }, 50);
      return { ok: true, status: 204, text: async () => '' };
    }
    return jsonResponse({});
  });
  try {
    await summarizeSession('ses_comp_test');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].path, '/api/session/ses_comp_test/compact');
  } finally {
    stub.restore();
    clearPendingCompactions();
  }
});

test('v2 summarizeSession rejects when compaction fails in background', async () => {
  lockV2();
  clearPendingCompactions();
  const stub = stubFetch((url) => {
    if (url.includes('/api/session/ses_comp_fail/compact')) {
      setTimeout(() => {
        resolvePendingCompaction('ses_comp_fail', false, 'Compaction quota exceeded');
      }, 50);
      return { ok: true, status: 204, text: async () => '' };
    }
    return jsonResponse({});
  });
  try {
    await assert.rejects(
      async () => {
        await summarizeSession('ses_comp_fail');
      },
      {
        message: 'Compaction quota exceeded',
      },
    );
  } finally {
    stub.restore();
    clearPendingCompactions();
  }
});

