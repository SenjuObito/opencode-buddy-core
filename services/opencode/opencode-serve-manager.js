/**
 * opencode-serve-manager.js
 *
 * Manages the *process* lifecycle of `opencode serve` for the bridge: find a
 * binary, spawn it, wait until it is listening, reuse an already-listening
 * instance, stop it, and self-heal after a steady-state crash.
 *
 * This module deliberately knows nothing about engine modes (v1 vs v2):
 * readiness is liveness only, and the engine is whatever
 * `services/opencode/engine-registry.js` probes it to be. Keeping the mode out
 * of here removes the "locked at boot, never rechecked" failure mode
 * (docs/engine-resolution-architecture.md R3).
 *
 * Cross-platform: Windows (.cmd shims via shell), macOS, and Linux.
 * Binary resolution is delegated to cli-path.js (resolveCli).
 */

import * as cp from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { homedir } from 'node:os';
import {
  resolveCli,
  needsShellOnWindows,
  commonCliBinDirs,
  enrichPathWithBinDirs,
  probeSystemNode,
  probeCliVersion,
  buildWindowsShellCommandLine,
} from '../../utils/cli-path.js';
import { probeEngine } from '../../utils/engine-probe.js';
import { logInfo, logWarn, logError, logDebug } from '../../utils/logger.js';

/** @type {cp.ChildProcess | null} */
let _process = null;
let _serverUrl = null;
/** Password this process learned (own spawn env or a file) — see resolveServerPassword(). */
let _knownPassword = null;
/** Options from the last start() call (set by engine-registry). */
let _startOptions = { binary: null, cliSource: null, cliVersion: null };
/** @type {Promise<string> | null} */
let _startPromise = null;
/** Last port passed to start(), so an auto-restart rebinds the same port the
 *  daemon originally requested (the daemon may override via OPENCODE_PORT env). */
let _lastPort = 4096;
/** True once serve has been started or reused successfully. Distinguishes a
 *  steady-state crash (auto-restart) from a failure during initial boot
 *  (which must surface to the caller instead of retrying forever). */
let _started = false;
/** Set while stop() is in progress so an exit event is treated as an expected
 *  shutdown rather than a crash to recover from. */
let _stopRequested = false;
/** Auto-restart backoff bookkeeping. */
let _restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 10000;

const STDERR_RING_CAPACITY = 20;
/** @type {string[]} */
const _stderrRing = [];

function appendStderr(line) {
  if (!line) return;
  _stderrRing.push(line);
  while (_stderrRing.length > STDERR_RING_CAPACITY) {
    _stderrRing.shift();
  }
}

/**
 * @returns {string[]} Snapshot of the last stderr lines from the serve process.
 */
export function getStderrTail() {
  return _stderrRing.slice();
}

/** @type {Set<(info: { code: number | null, signal: NodeJS.Signals | null, uptime: number, stderrTail: string[] }) => void>} */
const _exitListeners = new Set();

/**
 * Register a listener for serve process exit events (steady-state crashes or unexpected exits).
 * @param {(info: { code: number | null, signal: NodeJS.Signals | null, uptime: number, stderrTail: string[] }) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onServeExit(callback) {
  _exitListeners.add(callback);
  return () => _exitListeners.delete(callback);
}

export function offServeExit(callback) {
  _exitListeners.delete(callback);
}

function notifyExitListeners(info) {
  for (const cb of _exitListeners) {
    try {
      cb(info);
    } catch (err) {
      logError('opencode-serve-manager', `exit listener threw: ${err?.message || err}`);
    }
  }
}

/**
 * Reset auto-restart attempts budget (e.g. when a user actively initiates a new turn).
 */
export function resetRestartAttempts() {
  _restartAttempts = 0;
}

/**
 * @returns {string | null} The URL the server was started on, if any.
 */
export function getServerUrl() {
  return _serverUrl;
}

/**
 * Resolve the Basic Auth password for the running server.
 *
 * Deliberately resolved *per call* rather than cached at module load (defect
 * D9): the host may inject it, opencode may have written it to its own
 * `service.json`, or this process may have generated one when spawning.
 *
 * @returns {string | null}
 */
export function resolveServerPassword() {
  const fromEnv = firstNonEmpty(process.env.OPENCODE_SERVER_PASSWORD, process.env.OPENCODE_PASSWORD);
  if (fromEnv) return fromEnv;
  const fromService = tryReadServicePassword();
  if (fromService) return fromService;
  if (_knownPassword) return _knownPassword;
  return readGeneratedPassword();
}

/**
 * @returns {string | null} The server Basic Auth password, if any.
 */
export function getServerPassword() {
  return resolveServerPassword();
}

/**
 * Persist a generated password so the *other* bridge process (the one-shot
 * channel-manager invocation, which did not spawn serve) can authenticate with
 * the same credentials. Without this, a host with no `service.json` would give
 * each process a different random password and every v2 request would 401.
 *
 * @param {string} password
 */
function persistGeneratedPassword(password) {
  const file = generatedPasswordPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, password, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logDebug('opencode-serve-manager:auth', `Could not persist generated password: ${err?.message || err}`);
  }
}

/**
 * Directory for plugin-owned runtime state (currently only the generated serve
 * password).
 *
 * `OPENCODEBUDDY_CONFIG_DIR` is host-injected from the plugin's own config dir
 * (`~/.opencodebuddy`), so both bridge processes agree on where to look even on
 * hosts where `homedir()` is not what the user actually runs under (containers,
 * portable installs, WSL-side node). The hardcoded default is kept for the
 * status-quo case where the plugin runs standalone.
 *
 * @returns {string | null}
 */
function pluginStateDir() {
  const injected = firstNonEmpty(process.env.OPENCODEBUDDY_CONFIG_DIR);
  if (injected) return injected;
  const home = homedir();
  if (!home) return null;
  return path.join(home, '.opencode-idea-gui');
}

export function generatedPasswordPath() {
  const dir = pluginStateDir();
  if (!dir) return null;
  return path.join(dir, 'serve-password');
}

/**
 * Every location a previously generated password may live, newest first.
 *
 * The legacy `~/.opencode-idea-gui/serve-password` is still read when the host
 * injects a different `OPENCODEBUDDY_CONFIG_DIR`: a server spawned by an older
 * plugin build (still holding the port) must remain authenticatable, otherwise
 * the reuse path would start 401-ing on a machine that was working a minute ago.
 *
 * @returns {string[]}
 */
function generatedPasswordCandidates() {
  const out = [];
  const primary = generatedPasswordPath();
  if (primary) out.push(primary);
  const home = homedir();
  if (home) {
    const legacy = path.join(home, '.opencode-idea-gui', 'serve-password');
    if (!out.includes(legacy)) out.push(legacy);
  }
  return out;
}

function readGeneratedPassword() {
  for (const file of generatedPasswordCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function getServiceFileCandidates() {
  const candidates = [];
  const home = homedir();
  if (home) {
    candidates.push(path.join(home, '.local', 'state', 'opencode', 'service.json'));
    candidates.push(path.join(home, '.config', 'opencode', 'service.json'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'service.json'));
  }
  return candidates;
}

export function tryReadServiceInfo() {
  for (const file of getServiceFileCandidates()) {
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && typeof data === 'object') {
          const password = typeof data.password === 'string' && data.password.trim() ? data.password.trim() : null;
          const url = typeof data.url === 'string' && data.url.trim() ? data.url.trim() : null;
          if (password || url) {
            return {
              url,
              password,
              pid: data.pid || null,
            };
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function tryReadServicePassword() {
  const info = tryReadServiceInfo();
  return info?.password || null;
}

/**
 * @returns {cp.ChildProcess | null} The running serve child process (test/debug hook).
 */
export function getServeProcess() {
  return _process;
}

/**
 * Check if a file exists (cross-platform).
 * On Windows X_OK is unreliable; F_OK is sufficient.
 */
function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Search for the opencode binary using cross-platform resolution.
 *
 * Priority (via cli-path.js resolveCli):
 *   0. OPENCODEBUDDY_CLI_PATH (host-injected user setting)
 *   1. OPENCODE_BIN / OPENCODE_PATH / OPENCODE_CLI_PATH env vars
 *   2. known install dirs (npm global, pnpm, scoop, ~/.opencode/bin, …)
 *   3. PATH lookup (where.exe on Windows, which on Unix)
 *   4. bare command name
 *
 * On Windows, npm global installs create .cmd shims which are
 * automatically resolved by cli-path.js.
 *
 * @param {object} [options]
 * @param {string|null} [options.binary] - already-resolved binary from engine-registry
 * @returns {Promise<string | null>} Absolute path, or null if nothing usable.
 */
export async function findBinary(options = {}) {
  if (options.binary) return options.binary;
  if (_startOptions.binary) return _startOptions.binary;

  const resolution = resolveCli({ kind: 'opencode', env: process.env });
  if (!resolution.ok) return null;
  // Bare command name (no path, no drive): cannot F_OK-check against cwd.
  // Let it through to spawn, where needsShellOnWindows forces a shell on
  // Windows so cmd/PATHEXT resolves the real .exe/.cmd.
  if (!/[\\/]/.test(resolution.path) && !/^[A-Za-z]:/.test(resolution.path)) {
    return resolution.path;
  }
  return isExecutable(resolution.path) ? resolution.path : null;
}

/**
 * Poll the server URL until it answers or the timeout elapses.
 * Checks every 300ms with a 2s per-request connect timeout.
 *
 * Liveness only: **any** HTTP response (including 401/404 from the web UI
 * fallback) proves the listener is up. Whether the process behind it is a v1 or
 * v2 engine is decided by engine-registry's capability probe, never here —
 * the old "v1 branch accepts any response ⇒ always ready" shortcut (defect D7)
 * is what silently hid a v1/v2 mismatch.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForReady(url, timeoutMs) {
  const start = Date.now();

  const poll = () => new Promise((resolve) => {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      resolve(false);
      return;
    }

    const req = http.get(new URL(url), (res) => {
      res.resume(); // consume response body
      resolve(true);
    });

    req.on('error', () => {
      // Connection refused or similar — not ready yet
      setTimeout(() => resolve(poll()), 300);
    });

    req.setTimeout(2000, () => {
      req.destroy();
      setTimeout(() => resolve(poll()), 300);
    });
  });

  return poll();
}

/**
 * Does an opencode server (v1 or v2) already answer on this URL?
 *
 * Uses the same capability probe as engine-registry but discards the verdict —
 * this only answers "is it ours?", which is what the port-reuse decision needs.
 * A squatting non-opencode process returns the SPA fallback (or nothing) and is
 * therefore not adopted.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function isOpenCodeServer(url) {
  try {
    const probe = await probeEngine({
      baseUrl: url,
      password: resolveServerPassword(),
      timeoutMs: 1200,
      retries: 0,
    });
    return probe.engine !== 'unknown';
  } catch {
    return false;
  }
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

/**
 * Spawn `opencode serve --port <port>` and wait until it is listening.
 *
 * Idempotent: if a server is already running on the requested port, the
 * existing URL is returned.
 *
 * @param {number} [port] TCP port to listen on (default 4096)
 * @param {object} [options]
 * @param {string|null} [options.binary] - CLI path resolved by engine-registry
 * @param {string|null} [options.cliSource] - resolution source (for diagnostics)
 * @param {string|null} [options.cliVersion] - display-only version (for diagnostics)
 * @returns {Promise<string>} The server URL (e.g. http://localhost:4096)
 * @throws If the binary cannot be found, the process exits early, or startup times out.
 */
export async function start(port = 4096, options = {}) {
  _lastPort = port;
  // An explicit start re-arms steady-state crash recovery: a previous stop()
  // (e.g. the settings-change invalidate flow) must not permanently disable
  // auto-restart for the new process.
  _stopRequested = false;
  if (options.binary) _startOptions.binary = options.binary;
  if (options.cliSource) _startOptions.cliSource = options.cliSource;
  if (options.cliVersion) _startOptions.cliVersion = options.cliVersion;
  if ((_process && _serverUrl) || (_started && _serverUrl)) {
    return _serverUrl;
  }
  if (_startPromise) {
    return _startPromise;
  }
  _startPromise = doStart(port).finally(() => {
    _startPromise = null;
  });
  return _startPromise;
}

async function doStart(port) {
  let targetPort = port;
  let url = `http://localhost:${targetPort}`;

  // Port selection: reuse an *opencode* server when we can authenticate to it,
  // otherwise take the first free port in a small roll-over window.
  //
  // Both halves must be checked per candidate. Checking reuse only on the
  // initially requested port let each process spawn its own duplicate on the
  // next port whenever the running server's password was not recoverable
  // (4096 occupied → spawn 4097; next process → 4098; …). A squatting
  // non-opencode process is still never adopted: the check is a capability
  // probe, not "any HTTP response".
  const PORT_ROLLOVER_WINDOW = 10;
  let chosenPort = null;
  for (let candidate = targetPort; candidate <= targetPort + PORT_ROLLOVER_WINDOW; candidate++) {
    const candidateUrl = `http://localhost:${candidate}`;
    if (await isOpenCodeServer(candidateUrl)) {
      logInfo('opencode-serve-manager', `Reusing existing opencode server on ${candidateUrl}`);
      _serverUrl = candidateUrl;
      _lastPort = candidate;
      _started = true;
      return candidateUrl;
    }
    if (await isPortAvailable(candidate)) {
      chosenPort = candidate;
      break;
    }
    logInfo('opencode-serve-manager', `Port ${candidate} is occupied by a non-opencode process; trying the next port`);
  }

  if (chosenPort === null) {
    throw new Error(
      `端口 ${targetPort}-${targetPort + PORT_ROLLOVER_WINDOW} 全部被占用，无法启动 opencode serve。`
      + '请关闭占用这些端口的程序，或设置 OPENCODE_PORT 指定其它端口。',
    );
  }
  if (chosenPort !== targetPort) {
    logInfo('opencode-serve-manager', `Port ${targetPort} is occupied; rolling over to port ${chosenPort}`);
  }
  targetPort = chosenPort;
  _lastPort = targetPort;
  url = `http://localhost:${targetPort}`;

  // ── Nothing to reuse: we must spawn, so a binary is required from here on ──
  // Resolving the binary only now keeps the reuse path usable even when no
  // local opencode install exists (e.g. a server owned by another process).
  const binary = await findBinary();
  if (!binary) {
    const installHint = process.platform === 'win32'
      ? '安装方法: npm install -g opencode-ai'
      : '安装方法: curl -fsSL https://opencode.ai/install | bash';
    throw new Error(
      `找不到 opencode 二进制文件。请确认 opencode 已安装。\n${installHint}`
    );
  }

  // Windows .cmd/.bat shims (and bare command names) require a shell so
  // PATHEXT can resolve the real executable. Enrich PATH with common user bin
  // dirs (pnpm global, Scoop shims, …) that an IDE-launched process often lacks.
  const spawnEnv = { ...process.env };
  enrichPathWithBinDirs(spawnEnv, commonCliBinDirs(homedir()));

  const systemNode = probeSystemNode(spawnEnv);
  const cliVersion = _startOptions.cliVersion || probeCliVersion(binary, spawnEnv);

  // Auth: the mode is not known at spawn time any more, so always pass a
  // password through. v2 uses it for Basic auth; v1 ignores the variables.
  // A *generated* password is persisted (see persistGeneratedPassword) so the
  // one-shot channel-manager process — which did not spawn this child — can
  // authenticate with the same value instead of 401-ing on every request.
  let password = resolveServerPassword();
  if (!password) {
    password = crypto.randomBytes(16).toString('hex');
    persistGeneratedPassword(password);
    logInfo('opencode-serve-manager:auth', 'Generated a new server password and persisted it');
  }
  _knownPassword = password;
  spawnEnv.OPENCODE_SERVER_PASSWORD = password;
  spawnEnv.OPENCODE_PASSWORD = password;

  const spawnOpts = {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: spawnEnv,
  };
  if (needsShellOnWindows(binary)) {
    spawnOpts.shell = true;
  }

  logInfo('opencode-serve-manager:env', '════════════════════════════════════════════════════');
  logInfo('opencode-serve-manager:env', 'Runtime Environment Diagnostic:');
  logInfo('opencode-serve-manager:env', `  - Daemon Node ExecPath: ${process.execPath} (${process.version})`);
  logInfo('opencode-serve-manager:env', `  - System Node (${systemNode ? systemNode.source : 'n/a'}): ${systemNode ? `${systemNode.path} (${systemNode.version})` : 'none detected'}`);
  logInfo('opencode-serve-manager:env', `  - Platform: ${process.platform} (${process.arch})`);
  logInfo('opencode-serve-manager:env', `  - OpenCode CLI Resolved: ${binary} (source: ${_startOptions.cliSource || 'auto'})`);
  logInfo('opencode-serve-manager:env', `  - OpenCode CLI Version: ${cliVersion || 'unknown'} (display only; engine mode is probed after start)`);
  logInfo('opencode-serve-manager:env', `  - Auth Enabled: ${password ? 'Basic auth configured' : 'none'}`);
  logInfo('opencode-serve-manager:env', `  - Target Port: ${targetPort}`);
  logInfo('opencode-serve-manager:env', '════════════════════════════════════════════════════');
  logInfo('opencode-serve-manager:spawn', `Starting: ${binary} serve --port ${targetPort}`);

  const spawnStartedAt = Date.now();
  const serveArgs = ['serve', '--port', String(targetPort)];

  return new Promise((resolve, reject) => {
    // On Windows the shell path passes ONE pre-quoted command line instead of
    // (file, args, {shell:true}) — the latter makes Node concatenate args
    // unescaped and emit DEP0190, which the host captures into its log as noise.
    const child = spawnOpts.shell
      ? cp.spawn(buildWindowsShellCommandLine(binary, serveArgs), spawnOpts)
      : cp.spawn(binary, serveArgs, spawnOpts);
    _process = child;
    const childPid = child.pid;
    logInfo('opencode-serve-manager:spawn', `Spawned child process PID=${childPid}`);

    let settled = false;

    const settle = (value, isError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (isError) {
        reject(new Error(value));
      } else {
        _serverUrl = value;
        _started = true;
        // A stable run resets the auto-restart backoff so a future crash gets a
        // fresh retry budget instead of inheriting a near-exhausted counter.
        _restartAttempts = 0;
        logInfo('opencode-serve-manager:ready', `Server ready at ${value} in ${Date.now() - spawnStartedAt}ms`);
        resolve(value);
      }
    };

    // Timeout after 15 seconds
    const timeout = setTimeout(() => {
      settle('opencode serve 启动超时（15 秒）', true);
    }, 15_000);

    // Log stderr for debugging and capture into ring buffer
    let stderrBuf = '';
    child.stderr?.on('data', (data) => {
      stderrBuf += data.toString('utf-8');
      const lines = stderrBuf.split('\n').filter((l) => l.trim());
      if (lines.length > 0) {
        const latest = lines.slice(-1)[0];
        appendStderr(latest);
        logDebug('opencode-serve-manager:stderr', latest);
      }
    });

    // Process errors (e.g. spawn ENOENT, permission denied)
    child.on('error', (err) => {
      logError('opencode-serve-manager:error', `Process error (PID=${childPid}): ${err.message}`);
      if (err.code === 'ENOENT') {
        settle(`找不到可执行文件: ${binary}`, true);
      } else {
        settle(`无法启动 opencode: ${err.message}`, true);
      }
    });

    // Unexpected early exit or crash
    child.on('exit', (code, signal) => {
      const uptime = Date.now() - spawnStartedAt;
      const tail = getStderrTail();
      logInfo('opencode-serve-manager:exit', `Process PID=${childPid} exited: code=${code} signal=${signal} uptime=${uptime}ms`);
      if (tail.length > 0) {
        logDebug('opencode-serve-manager:stderr_tail', tail.slice(-5).join(' | '));
      }

      if (!settled) {
        settle(`opencode 意外退出（退出码: ${code ?? signal}）`, true);
      } else {
        // Normal exit after a successful start (e.g. stop()) — clear state.
        if (_process === child) {
          _process = null;
          _serverUrl = null;
        }

        // Notify active turns and subscribers of the exit event
        notifyExitListeners({
          code,
          signal,
          uptime,
          stderrTail: tail,
        });

        // Steady-state crash (started successfully, not an intentional stop):
        // schedule a backoff auto-restart so the bridge self-heals without
        // waiting for the next outgoing request.
        if (_started && !_stopRequested) {
          scheduleAutoRestart();
        } else if (_stopRequested) {
          _started = false;
        }
      }
    });

    // Start polling the health endpoint
    waitForReady(url, 15_000)
      .then((ready) => {
        if (ready) {
          _serverUrl = url;
          settle(url, false);
        } else {
          settle('opencode serve 未能就绪（超时）', true);
        }
      })
      .catch((err) => {
        settle(`健康检查失败: ${err.message}`, true);
      });
  });
}

/**
 * @returns {boolean} Whether a serve process is currently alive or reused.
 */
export function isRunning() {
  if (_process !== null && !_process.killed) {
    return true;
  }
  return _started && _serverUrl !== null;
}

/**
 * Backoff-restricted auto-restart after a steady-state crash.
 *
 * Guarded by `_stopRequested` (never fight an intentional stop()) and
 * `MAX_RESTART_ATTEMPTS` (avoid a restart storm when the binary is missing or
 * the port is permanently occupied). Rebinds `_lastPort` so the restart uses
 * the same port the daemon originally requested. Re-entrancy is handled by
 * `_startPromise` inside start() and the `_process` guard below.
 */
function scheduleAutoRestart() {
  if (_stopRequested || _process) return;
  if (_restartAttempts >= MAX_RESTART_ATTEMPTS) {
    logWarn('opencode-serve-manager', 'Auto-restart limit reached; giving up on opencode serve');
    return;
  }
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** _restartAttempts, BACKOFF_MAX_MS);
  _restartAttempts += 1;
  logInfo(
    'opencode-serve-manager',
    `Scheduling auto-restart in ${delay}ms (attempt ${_restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
  );
  setTimeout(() => {
    if (_stopRequested || _process) return; // a newer process owns the slot now
    start(_lastPort).catch((err) => {
      logError('opencode-serve-manager', `auto-restart failed: ${err?.message || err}`);
    });
  }, delay);
}

/**
 * Stop the opencode serve process.
 *
 * On Unix: sends SIGTERM first; if the process hasn't exited within 5 seconds,
 * escalates to SIGKILL.
 * On Windows: SIGTERM is not supported; uses proc.kill() which calls
 * TerminateProcess. If the process hasn't exited within 5 seconds, uses
 * taskkill /F /T to force-kill the process tree.
 *
 * No-op when nothing is running.
 *
 * @returns {Promise<void>}
 */
/**
 * Release every handle tied to a dead child.
 *
 * `'exit'` fires as soon as the *direct* child (cmd.exe, when the serve call
 * went through a Windows shell) terminates — but the grandchild opencode.exe can
 * still hold the inherited stdio pipes open, so Node's ChildProcess handle keeps
 * the event loop alive and a one-shot CLI process never exits. The same applies
 * to the stdout/stderr streams themselves.
 *
 * This went unnoticed until now because one-shot commands used to fail and exit
 * through `process.exit()` on the error path; the success path relies on a
 * natural exit (to flush stdout) and was therefore the one that hung.
 *
 * `unref()` only removes the loop-liveness guarantee — nothing else changes.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 */
function detachChildHandles(child) {
  if (!child) return;
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try {
      stream?.destroy();
    } catch {
      // already gone
    }
  }
  try {
    child.unref();
  } catch {
    // not supported on some platforms / already unref'd
  }
}

export async function stop() {
  _stopRequested = true;
  // Drop the resolved binary too: after a settings-change stop the next start
  // must re-resolve (env has been updated) rather than reuse the old path.
  _startOptions = { binary: null, cliSource: null, cliVersion: null };
  _restartAttempts = 0;
  const proc = _process;
  if (!proc) {
    _serverUrl = null;
    _started = false;
    return;
  }

  logInfo('opencode-serve-manager', 'Stopping opencode serve...');

  const isWin = process.platform === 'win32';

  return new Promise((resolve) => {
    // Ensure the promise always settles even if 'exit' never fires because the
    // grandchild (or a broken pipe) swallowed it.
    const settle = () => {
      detachChildHandles(proc);
      if (_process === proc) {
        _process = null;
        _serverUrl = null;
      }
      _started = false;
      resolve();
    };

    const forceKill = setTimeout(() => {
      logWarn('opencode-serve-manager', `Timeout — force killing${isWin ? ' (taskkill)' : ' (SIGKILL)'}`);
      if (proc && proc.exitCode === null) {
        if (isWin) {
          // Windows: use taskkill to kill the process tree (spawned with shell: true
          // for .cmd shims, so the actual node process is a child of cmd.exe).
          try {
            cp.execSync(`taskkill /F /T /PID ${proc.pid}`, {
              stdio: 'ignore',
              windowsHide: true,
            });
          } catch {
            // Process may have already exited
          }
        } else {
          proc.kill('SIGKILL');
        }
      }
      settle();
    }, 5_000);

    proc.on('exit', () => {
      clearTimeout(forceKill);
      logInfo('opencode-serve-manager', 'opencode serve stopped');
      settle();
    });

    // On Windows, SIGTERM is not a valid signal — proc.kill() without a signal
    // uses TerminateProcess which is the closest equivalent.
    if (isWin) {
      proc.kill();
    } else {
      proc.kill('SIGTERM');
    }
  });
}
