/**
 * engine-registry.js
 *
 * The single host of the "which opencode engine is running" state.
 *
 * This module exists because the state used to live inside
 * `opencode-serve-manager.js` as module-level flags (`_isV2`,
 * `_engineInitialized`) computed once at process boot and then frozen. That
 * design made "deterministic" mean "decided early and never rechecked", so a
 * failed boot-time probe locked the process into v1 forever — even after a v2
 * server was successfully spawned (see docs/cli-path-and-engine-mode-architecture.md,
 * defects D1/D4/D6/D8).
 *
 * Contract (see docs/engine-resolution-architecture.md §3):
 *   states   pending | v1 | v2 | unknown      (`unknown` is a first-class state)
 *   INV-1    v1/v2 require evidence from a capability probe — never a version string
 *   INV-2    no direct v1 ↔ v2 transition; always through `pending`
 *   INV-3    `unknown` + blocking ⇒ callers must fail loudly, never pick a route
 *   INV-5    every state change emits exactly one `engine_status` (fingerprint-deduped)
 *   INV-6    `ensure()` is O(1) once locked and never re-probes
 *
 * Both entry points use this registry:
 *   - daemon.js          (long-lived; reports `engine_status` to the host)
 *   - channel-manager.js (one-shot; the probe-first path makes re-verification cheap)
 *
 * v1/v2 routing differences themselves stay in opencode-sdk-client.js — this
 * module only answers "which one am I talking to".
 */

import { resolveCli, describeResolveFailure } from '../../utils/cli-path.js';
import { probeEngine, describeProbeFailure } from '../../utils/engine-probe.js';
import { logInfo, logWarn } from '../../utils/logger.js';

export const ENGINE_STATES = Object.freeze({
  PENDING: 'pending',
  V1: 'v1',
  V2: 'v2',
  UNKNOWN: 'unknown',
});

/** Cooldown after a blocking failure, so a request storm cannot become a probe storm. */
const FAILURE_COOLDOWN_MS = 1500;

/**
 * Thrown when a request needs the engine mode but it could not be determined.
 * Carries the full status so callers/UI can show the actionable reason.
 */
export class EngineUnresolvedError extends Error {
  constructor(status) {
    const reason = (status && status.reason) || {};
    super(
      `无法确定 opencode 引擎模式（v1/v2）：${reason.message || '未知原因'}`
      + `｜state=${status?.state || 'unknown'}｜reason=${reason.kind || 'unknown'}`
      + '。请在设置中检查 opencode 路径，或确认端口未被其它程序占用。',
    );
    this.name = 'EngineUnresolvedError';
    this.code = 'ENGINE_UNRESOLVED';
    this.engineStatus = status;
  }
}

/** @returns {object} Fresh default dependency set (all overridable for tests). */
function defaultDeps() {
  return {
    port: Number(process.env.OPENCODE_PORT) || 4096,
    env: () => process.env,
    /**
     * CLI resolution seam. Defaults to the real resolver; tests inject a fake so
     * the state machine can be exercised with no filesystem or child processes.
     */
    resolve: (spec) => resolveCli(spec),
    /**
     * Make sure a server is reachable, spawning one if needed.
     * Dynamic import keeps serve-manager (a process-lifecycle module, with
     * spawn/kill side effects) out of this module's own import graph so the
     * registry can be unit-tested without any of it.
     */
    ensureServer: async ({ resolution, port }) => {
      const serve = await import('./opencode-serve-manager.js');
      return serve.start(port, {
        binary: resolution?.path || null,
        cliSource: resolution?.source || null,
        cliVersion: resolution?.version || null,
      });
    },
    getServerUrl: async () => {
      const serve = await import('./opencode-serve-manager.js');
      return serve.getServerUrl();
    },
    getPassword: async () => {
      const serve = await import('./opencode-serve-manager.js');
      return serve.resolveServerPassword();
    },
    probeTimeoutMs: 3000,
    probeRetries: 1,
    /** @type {typeof fetch | null} */
    fetchImpl: null,
  };
}

let _deps = defaultDeps();

let _state = ENGINE_STATES.PENDING;
/** @type {{ path: string|null, version: string|null, source: string|null, verified: boolean }} */
let _cli = { path: null, version: null, source: null, verified: false };
/** @type {import('../../utils/engine-probe.js').Evidence | null} */
let _evidence = null;
/** @type {{ kind: string, message: string, blocking: boolean }} */
let _reason = { kind: 'none', message: '', blocking: false };
let _lastInvalidation = null;
let _updatedAt = Date.now();

/** @type {Promise<string> | null} */
let _ensurePromise = null;
let _lastFailureAt = 0;
let _lastFingerprint = '';

/** @type {Set<(status: object) => void>} */
const _listeners = new Set();

/**
 * Inject dependencies (daemon-service / channel entry / tests).
 * @param {Partial<ReturnType<typeof defaultDeps>>} deps
 */
export function configure(deps = {}) {
  _deps = { ..._deps, ...deps };
}

/** Test seam: return to the initial (unresolved) state. */
export function reset() {
  _state = ENGINE_STATES.PENDING;
  _cli = { path: null, version: null, source: null, verified: false };
  _evidence = null;
  _reason = { kind: 'none', message: '', blocking: false };
  _lastInvalidation = null;
  _updatedAt = Date.now();
  _ensurePromise = null;
  _lastFailureAt = 0;
  _lastFingerprint = '';
}

/**
 * @returns {'pending'|'v1'|'v2'|'unknown'}
 */
export function getState() {
  return _state;
}

/**
 * Synchronous, side-effect-free read used by the routing layer.
 * Safe to call now because every request path goes through `ensure()` first
 * (ADR-3: keep the sync accessor, gate at the request boundary).
 *
 * @returns {boolean}
 */
export function isV2() {
  return _state === ENGINE_STATES.V2;
}

/** @returns {{ path: string|null, version: string|null, source: string|null, verified: boolean }} */
export function getCliInfo() {
  return { ..._cli };
}

/**
 * Full status snapshot: the single assertion/inspection entry point
 * (daemon `status` command, `engine_status` event, host UI, tests).
 *
 * @returns {{
 *   state: 'pending'|'v1'|'v2'|'unknown',
 *   locked: boolean,
 *   cli: { path: string|null, version: string|null, source: string|null, verified: boolean },
 *   evidence: object|null,
 *   reason: { kind: string, message: string, blocking: boolean },
 *   lastInvalidation: string|null,
 *   updatedAt: number,
 * }}
 */
export function getStatus() {
  return {
    state: _state,
    locked: _state === ENGINE_STATES.V1 || _state === ENGINE_STATES.V2,
    cli: { ..._cli },
    evidence: _evidence ? { ..._evidence } : null,
    reason: { ..._reason },
    lastInvalidation: _lastInvalidation,
    updatedAt: _updatedAt,
  };
}

/**
 * Subscribe to state changes (daemon forwards these as `engine_status`).
 * @param {(status: object) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribe(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function fingerprint() {
  const ev = _evidence || {};
  return [
    _state,
    _cli.path || '',
    _cli.version || '',
    _cli.source || '',
    _reason.kind,
    _reason.blocking ? '1' : '0',
    ev.probePath || '',
    ev.status === null || ev.status === undefined ? '' : String(ev.status),
  ].join('|');
}

/** Emit exactly one status event per observable change (INV-5). */
function emit(force = false) {
  const fp = fingerprint();
  if (!force && fp === _lastFingerprint) return;
  _lastFingerprint = fp;
  const status = getStatus();
  for (const listener of _listeners) {
    try {
      listener(status);
    } catch (err) {
      logWarn('engine-registry', `status listener threw: ${err?.message || err}`);
    }
  }
}

function setState(state, reason = null) {
  _state = state;
  if (reason) _reason = reason;
  _updatedAt = Date.now();
  emit();
}

function updateCli(resolution) {
  _cli = {
    path: resolution.path || null,
    version: resolution.version || null,
    source: resolution.source || null,
    verified: Boolean(resolution.verified),
  };
}

/**
 * Lock the engine mode. Preconditions are enforced here (INV-1/INV-4):
 * only a successful capability probe may produce a lock.
 *
 * @param {'v1'|'v2'} state
 * @param {object} evidence - from probeEngine()
 */
export function lock(state, evidence = null) {
  if (state !== ENGINE_STATES.V1 && state !== ENGINE_STATES.V2) {
    throw new Error(`engine-registry: lock() requires 'v1' or 'v2', got '${state}'`);
  }
  if (!evidence || evidence.probePath === null || evidence.probePath === undefined) {
    // Production degrades to a warning rather than crashing the daemon; the
    // invariant violation is loud in the log.
    logWarn('engine-registry', `lock(${state}) without probe evidence — invariant INV-1 violated`);
  }
  _evidence = evidence ? { ...evidence } : null;
  _lastInvalidation = null;
  setState(state, { kind: 'none', message: '', blocking: false });
  logInfo(
    'engine-registry',
    `Engine mode locked: ${state} (evidence=${_evidence?.probePath || 'none'}`
    + ` HTTP=${_evidence?.status ?? 'n/a'}, cli=${_cli.path || 'unknown'}`
    + ` source=${_cli.source || 'unknown'}, version=${_cli.version || 'n/a'})`,
  );
  return _state;
}

/**
 * Drop a lock and go back to `pending` (serve crash, stale URL, settings change).
 * Keeps the resolved CLI info so the next attempt does not re-scan.
 *
 * @param {string} reason
 */
export function invalidate(reason = 'unspecified') {
  if (_state !== ENGINE_STATES.PENDING) {
    logInfo('engine-registry', `Engine mode invalidated (${reason}); will re-resolve on next request`);
  }
  _evidence = null;
  _lastInvalidation = reason;
  setState(ENGINE_STATES.PENDING, { kind: 'none', message: '', blocking: false });
}

function fail(kind, message, blocking) {
  _lastFailureAt = Date.now();
  logWarn('engine-registry', `Engine mode undetermined (${kind}): ${message}`);
  setState(ENGINE_STATES.UNKNOWN, { kind, message, blocking });
  throw new EngineUnresolvedError(getStatus());
}

/** Map a probe result onto the failure taxonomy (see architecture doc §7). */
function reasonKindForProbe(result) {
  const ev = result.evidence || {};
  if (ev.error === 'unsupported-api-version') return 'unsupported-api-version';
  if (ev.status === 401 || ev.status === 403) return 'auth-failed';
  if (ev.error === 'timeout') return 'probe-timeout';
  if (ev.status === null) return 'serve-unreachable';
  return 'probe-mismatch';
}

async function safeGet(fn) {
  try {
    return fn ? await fn() : null;
  } catch {
    return null;
  }
}

async function probeAt(baseUrl, { timeoutMs, retries }) {
  return probeEngine({
    baseUrl,
    password: await safeGet(_deps.getPassword),
    timeoutMs,
    retries,
    fetchImpl: _deps.fetchImpl || undefined,
  });
}

/**
 * Resolve the CLI only (no spawn, no probe). Runs at daemon boot so the host
 * can surface "CLI not found" / "configured path invalid" immediately instead
 * of only after the first user message.
 *
 * @returns {object} status snapshot
 */
export function resolveOnly() {
  if (_cli.path) return getStatus();

  const env = _deps.env ? _deps.env() : process.env;
  const resolution = _deps.resolve({ kind: 'opencode', env });

  if (!resolution.ok) {
    const kind = resolution.reason?.kind === 'settings-invalid' ? 'settings-invalid' : 'cli-not-found';
    const message = describeResolveFailure(resolution);
    _lastFailureAt = Date.now();
    logWarn('engine-registry', `CLI resolution failed (${kind}): ${message}`);
    setState(ENGINE_STATES.UNKNOWN, { kind, message, blocking: true });
    return getStatus();
  }

  updateCli(resolution);
  logInfo(
    'engine-registry',
    `CLI resolved: ${resolution.path} (version=${resolution.version || 'unprobeable'},`
    + ` source=${resolution.source}, verified=${resolution.verified})`,
  );
  setState(ENGINE_STATES.PENDING, { kind: 'none', message: '', blocking: false });
  return getStatus();
}

/**
 * Gate for every request path: guarantee a verified engine mode, resolving and
 * probing on demand.
 *
 * Order matters (and is deliberate): **probe first, resolve later**.
 *   1. If something already serves our port (the common case for the one-shot
 *      channel-manager process, which does not own the serve child), one HTTP
 *      call is enough — no `--version` spawn, which on Windows costs ~100ms
 *      through cmd.exe.
 *   2. Only when nothing answers do we need a binary to spawn, so only then do
 *      we resolve the CLI.
 *
 * Idempotent and in-flight merged (INV-6).
 *
 * @returns {Promise<'v1'|'v2'>}
 * @throws {EngineUnresolvedError}
 */
export async function ensure() {
  if (_state === ENGINE_STATES.V1 || _state === ENGINE_STATES.V2) return _state;
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = runEnsure().finally(() => {
    _ensurePromise = null;
  });
  return _ensurePromise;
}

async function runEnsure() {
  // Blocking failures get a short cooldown so a burst of requests does not
  // re-probe the whole system for each one.
  if (
    _state === ENGINE_STATES.UNKNOWN
    && _reason.blocking
    && Date.now() - _lastFailureAt < FAILURE_COOLDOWN_MS
  ) {
    throw new EngineUnresolvedError(getStatus());
  }

  // ── 1. Probe-first ───────────────────────────────────────────────────────
  const knownUrl = await safeGet(_deps.getServerUrl);
  const candidateUrls = [];
  if (knownUrl) candidateUrls.push(knownUrl);
  const defaultUrl = `http://localhost:${_deps.port}`;
  if (!knownUrl || knownUrl !== defaultUrl) candidateUrls.push(defaultUrl);

  for (const url of candidateUrls) {
    const pre = await probeAt(url, { timeoutMs: 1500, retries: 0 });
    if (pre.engine !== ENGINE_STATES.UNKNOWN) {
      return lock(pre.engine, pre.evidence);
    }
  }
  if (knownUrl && _state !== ENGINE_STATES.PENDING) {
    // A URL the manager thinks is live no longer answers capabilities.
    invalidate('stale-server-url');
  }

  // ── 2. Resolve the CLI (needed to spawn) ─────────────────────────────────
  let resolution;
  if (_cli.path) {
    resolution = { ok: true, path: _cli.path, version: _cli.version, source: _cli.source, verified: _cli.verified };
  } else {
    const env = _deps.env ? _deps.env() : process.env;
    resolution = _deps.resolve({ kind: 'opencode', env });
    if (!resolution.ok) {
      const kind = resolution.reason?.kind === 'settings-invalid' ? 'settings-invalid' : 'cli-not-found';
      return fail(kind, describeResolveFailure(resolution), true);
    }
    updateCli(resolution);
  }

  // ── 3. Make a server reachable ───────────────────────────────────────────
  let url;
  try {
    url = await _deps.ensureServer({ resolution, port: _deps.port });
  } catch (err) {
    return fail('spawn-failed', err?.message || String(err), true);
  }
  if (!url) {
    return fail('spawn-failed', 'opencode serve did not report a server URL', true);
  }

  // ── 4. Capability probe decides ──────────────────────────────────────────
  const result = await probeAt(url, { timeoutMs: _deps.probeTimeoutMs, retries: _deps.probeRetries });
  if (result.engine === ENGINE_STATES.UNKNOWN) {
    // Not blocking: the serve process may still be warming up, and the
    // auto-restart loop keeps trying. The caller still sees a hard failure.
    return fail(reasonKindForProbe(result), describeProbeFailure(result), false);
  }

  return lock(result.engine, result.evidence);
}
