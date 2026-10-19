import test from 'node:test';
import assert from 'node:assert/strict';
import * as registry from './engine-registry.js';

/**
 * State-machine tests for the single engine-mode host.
 *
 * Everything is injected (resolver / server / fetch), so these run with no
 * filesystem probing and no child processes.
 *
 * The fake fetch models the real sequence: before `ensureServer()` runs there is
 * no server anywhere (probe-first fails); afterwards a server answers with the
 * configured engine's capability route.
 */

function response(status, body, contentType = 'application/json') {
  return {
    status,
    headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/**
 * @param {{up?: boolean, engine?: 'v2'|'v1'|'none', mode?: 'json'|'html'|'dead'}} opts
 */
function makeFetch({ up = false, engine = 'v2', mode = 'json' } = {}) {
  const state = { up, calls: 0, paths: [] };
  const impl = async (url) => {
    state.calls += 1;
    state.paths.push(new URL(url).pathname);
    if (mode === 'dead' || !state.up) {
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    }
    const path = new URL(url).pathname;
    if (mode === 'html') return response(200, '<html>web ui</html>', 'text/html');
    if (engine === 'v2' && path === '/api/info') return response(200, { apiVersion: 2, version: '2.0.27' });
    if (engine === 'v1' && path === '/config') return response(200, { provider: {} });
    return response(404, '<html></html>', 'text/html');
  };
  return { impl, state };
}

const okResolution = {
  ok: true,
  kind: 'opencode',
  path: '/usr/local/bin/opencode',
  version: 'opencode v2.0.27',
  source: 'known-dir',
  verified: true,
  spawn: { argv0: '/usr/local/bin/opencode', needsShell: false, bare: false },
};

/** Wire the registry with a fetch/server pair whose liveness is controllable. */
function configure({ fetch: fake = makeFetch(), overrides = {} } = {}) {
  registry.reset();
  registry.configure({
    port: 4096,
    env: () => ({}),
    resolve: () => okResolution,
    ensureServer: async () => {
      fake.state.up = true;
      return 'http://localhost:4096';
    },
    getServerUrl: async () => (fake.state.up ? 'http://localhost:4096' : null),
    getPassword: async () => null,
    probeTimeoutMs: 50,
    probeRetries: 0,
    fetchImpl: fake.impl,
    ...overrides,
  });
  return fake;
}

test('starts in `pending` — never in a guessed v1', () => {
  configure();
  assert.equal(registry.getState(), 'pending');
  assert.equal(registry.isV2(), false);
  assert.equal(registry.getStatus().locked, false);
});

test('probe-first: an already-running v2 server locks without resolving or spawning', async () => {
  const fake = makeFetch({ up: true });
  let resolveCalls = 0;
  let ensureServerCalls = 0;
  configure({
    fetch: fake,
    overrides: {
      resolve: () => { resolveCalls += 1; return okResolution; },
      ensureServer: async () => { ensureServerCalls += 1; return 'http://localhost:4096'; },
    },
  });

  const state = await registry.ensure();
  assert.equal(state, 'v2');
  assert.equal(registry.isV2(), true);
  assert.equal(resolveCalls, 0, 'a live server means we never need a binary');
  assert.equal(ensureServerCalls, 0);
  assert.equal(registry.getStatus().evidence.probePath, '/api/info');
});

test('spawn path: resolve → ensureServer(resolution) → probe ⇒ v2', async () => {
  const fake = makeFetch({ up: false });
  const seen = [];
  let resolveCalls = 0;
  configure({
    fetch: fake,
    overrides: {
      resolve: () => { resolveCalls += 1; return okResolution; },
      ensureServer: async (arg) => {
        seen.push(arg);
        fake.state.up = true;
        return 'http://localhost:4096';
      },
    },
  });

  const state = await registry.ensure();
  assert.equal(state, 'v2');
  assert.equal(resolveCalls, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].resolution.path, okResolution.path);
  assert.equal(seen[0].port, 4096);
  assert.equal(registry.getStatus().cli.source, 'known-dir');
});

test('a v1 server is detected and locked as v1 (still supported)', async () => {
  const fake = makeFetch({ up: false, engine: 'v1' });
  configure({ fetch: fake });
  assert.equal(await registry.ensure(), 'v1');
  assert.equal(registry.isV2(), false);
  assert.equal(registry.getStatus().evidence.probePath, '/config');
});

test('INV-6: ensure() is O(1) and never re-probes once locked', async () => {
  const fake = makeFetch({ up: false });
  let ensureServerCalls = 0;
  configure({
    fetch: fake,
    overrides: {
      ensureServer: async () => { ensureServerCalls += 1; fake.state.up = true; return 'http://localhost:4096'; },
    },
  });

  await registry.ensure();
  const probesAfterFirst = fake.state.calls;
  await registry.ensure();
  await registry.ensure();

  assert.equal(fake.state.calls, probesAfterFirst, 'no extra probes after locking');
  assert.equal(ensureServerCalls, 1);
});

test('in-flight merging: concurrent ensure() calls share one resolution pass', async () => {
  let resolveCalls = 0;
  const fake = makeFetch({ up: false });
  configure({
    fetch: fake,
    overrides: {
      resolve: () => { resolveCalls += 1; return okResolution; },
      ensureServer: async () => {
        await new Promise((r) => setTimeout(r, 20));
        fake.state.up = true;
        return 'http://localhost:4096';
      },
    },
  });

  const results = await Promise.all([registry.ensure(), registry.ensure(), registry.ensure()]);
  assert.deepEqual(results, ['v2', 'v2', 'v2']);
  assert.equal(resolveCalls, 1);
});

test('cli-not-found ⇒ throws EngineUnresolvedError, unknown + blocking', async () => {
  configure({
    overrides: {
      resolve: () => ({ ok: false, kind: 'opencode', reason: { kind: 'cli-not-found' }, tried: ['opencode'] }),
    },
  });

  await assert.rejects(
    () => registry.ensure(),
    (err) => {
      assert.equal(err.name, 'EngineUnresolvedError');
      assert.equal(err.code, 'ENGINE_UNRESOLVED');
      return true;
    },
  );
  const status = registry.getStatus();
  assert.equal(status.state, 'unknown');
  assert.equal(status.reason.kind, 'cli-not-found');
  assert.equal(status.reason.blocking, true);
});

test('settings-invalid is blocking and never falls back to scanning', async () => {
  configure({
    overrides: {
      resolve: () => ({
        ok: false,
        kind: 'opencode',
        reason: { kind: 'settings-invalid', path: '/bad/opencode' },
        tried: ['/bad/opencode'],
      }),
    },
  });

  await assert.rejects(() => registry.ensure());
  assert.equal(registry.getStatus().reason.kind, 'settings-invalid');
  assert.equal(registry.getStatus().reason.blocking, true);
});

test('probe mismatch ⇒ unknown, non-blocking, and no route is chosen', async () => {
  configure({ fetch: makeFetch({ up: false, mode: 'html' }) });

  await assert.rejects(() => registry.ensure(), /无法确定 opencode 引擎模式/);
  const status = registry.getStatus();
  assert.equal(status.state, 'unknown');
  assert.equal(status.reason.kind, 'probe-mismatch');
  assert.equal(status.reason.blocking, false);
});

test('a 401 on both api/info attempts is reported as auth-failed', async () => {
  registry.reset();
  registry.configure({
    port: 4096,
    env: () => ({}),
    resolve: () => okResolution,
    ensureServer: async () => 'http://localhost:4096',
    getServerUrl: async () => null,
    getPassword: async () => 'stale',
    probeTimeoutMs: 50,
    probeRetries: 0,
    fetchImpl: async () => response(401, { error: 'unauthorized' }),
  });

  await assert.rejects(() => registry.ensure());
  assert.equal(registry.getStatus().reason.kind, 'auth-failed');
});

test('spawn failure is attributable', async () => {
  configure({
    overrides: {
      ensureServer: async () => { throw new Error('找不到 opencode 二进制文件。'); },
    },
  });

  await assert.rejects(() => registry.ensure(), /找不到 opencode/);
  assert.equal(registry.getStatus().reason.kind, 'spawn-failed');
});

test('blocking failures get a cooldown — a request burst does not re-resolve the whole system', async () => {
  let resolveCalls = 0;
  configure({
    overrides: {
      resolve: () => {
        resolveCalls += 1;
        return { ok: false, kind: 'opencode', reason: { kind: 'cli-not-found' }, tried: [] };
      },
    },
  });

  await assert.rejects(() => registry.ensure());
  await assert.rejects(() => registry.ensure());
  await assert.rejects(() => registry.ensure());

  assert.equal(resolveCalls, 1, 'cooldown should short-circuit the repeats');
});

test('invalidate() returns to pending and the next ensure() re-verifies (INV-2, no v1↔v2 flip)', async () => {
  const fake = makeFetch({ up: true });
  configure({ fetch: fake });

  assert.equal(await registry.ensure(), 'v2');
  registry.invalidate('serve-exit');
  assert.equal(registry.getState(), 'pending');
  assert.equal(registry.isV2(), false, 'a crashed server must not leave a stale v2 lock');
  assert.equal(registry.getStatus().evidence, null);

  assert.equal(await registry.ensure(), 'v2');
  assert.ok(fake.state.calls > 1, 're-locking requires a fresh probe');
});

test('invalidateForSettingsChange() drops the cached CLI so the next ensure() re-resolves', async () => {
  const fake = makeFetch({ up: true });
  let resolveCalls = 0;
  configure({
    fetch: fake,
    overrides: {
      resolve: () => {
        resolveCalls += 1;
        return okResolution;
      },
      ensureServer: async () => {
        fake.state.up = true;
        return 'http://localhost:4096';
      },
    },
  });

  await registry.ensure();
  assert.equal(registry.getState(), 'v2');

  // Host changed the configured path: the old server is gone and the env now
  // carries a different OPENCODEBUDDY_CLI_PATH.
  fake.state.up = false;
  registry.invalidateForSettingsChange('settings-changed');

  assert.equal(registry.getState(), 'pending');
  assert.equal(registry.getStatus().cli.path, null, 'cached CLI must be dropped, unlike invalidate()');
  assert.equal(registry.getStatus().lastInvalidation, 'settings-changed');

  await registry.ensure();
  assert.equal(resolveCalls, 1, 'the CLI must be resolved again from the new environment');
  assert.equal(registry.getStatus().cli.path, okResolution.path);
});

test('resolveOnly(): resolves the CLI at boot without spawning, and blocks loudly when it cannot', () => {
  configure();
  const status = registry.resolveOnly();
  assert.equal(status.state, 'pending');
  assert.equal(status.cli.path, okResolution.path);
  assert.equal(status.reason.kind, 'none');

  configure({
    overrides: {
      resolve: () => ({ ok: false, kind: 'opencode', reason: { kind: 'cli-not-found' }, tried: [] }),
    },
  });
  const failed = registry.resolveOnly();
  assert.equal(failed.state, 'unknown');
  assert.equal(failed.reason.kind, 'cli-not-found');
  assert.equal(failed.reason.blocking, true);
});

test('subscribe(): one event per observable change (fingerprint dedup, INV-5)', async () => {
  const fake = makeFetch({ up: true });
  configure({ fetch: fake });
  const seen = [];
  const unsubscribe = registry.subscribe((s) => seen.push(`${s.state}:${s.reason.kind}`));

  registry.resolveOnly();
  registry.resolveOnly(); // identical → no second event
  await registry.ensure();
  await registry.ensure(); // already locked → no extra event

  unsubscribe();
  registry.invalidate('serve-exit');

  assert.deepEqual(seen, ['pending:none', 'v2:none']);
});

test('lock() enforces its precondition — only v1/v2 from a probe may be locked', () => {
  configure();
  assert.throws(() => registry.lock('unknown', null), /requires 'v1' or 'v2'/);
  assert.throws(() => registry.lock('pending', null), /requires 'v1' or 'v2'/);
  assert.equal(registry.lock('v1', { probePath: '/config', status: 200 }), 'v1');
  assert.equal(registry.getState(), 'v1');
});

test('a dead port never yields a locked state', async () => {
  configure({ fetch: makeFetch({ up: false, mode: 'dead' }) });
  await assert.rejects(() => registry.ensure());
  assert.equal(registry.getState(), 'unknown');
  assert.equal(registry.isV2(), false);
});
