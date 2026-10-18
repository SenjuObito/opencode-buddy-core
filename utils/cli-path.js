/**
 * Shared CLI binary path resolution (single authoritative resolver).
 *
 * Priority (L0 → L4), first candidate that passes verification wins:
 *   L0  user settings, injected by the host as OPENCODEBUDDY_CLI_PATH /
 *       OPENCODEBUDDY_NODE_BIN. Authoritative: a missing file here is a
 *       *blocking* failure and we do NOT fall back to scanning.
 *   L1  explicit env overrides (OPENCODE_BIN / OPENCODE_PATH / OPENCODE_CLI_PATH)
 *   L2  known install locations (per-platform table)
 *   L3  PATH lookup (`where` / `which`)
 *   L4  bare binary name (resolved by PATHEXT / PATH at spawn time)
 *
 * Engine mode (v1 vs v2) is NOT determined here — see utils/engine-probe.js and
 * services/opencode/engine-registry.js. A version string is display-only.
 *
 * Windows note: npm global installs create three shims (`opencode`, `opencode.cmd`,
 * `opencode.ps1`). Node's `spawn()` cannot CreateProcess the extensionless bash
 * wrapper or a `.cmd` without a shell (`execFileSync` throws EINVAL). Hence:
 * prefer `.exe` > `.cmd` > `.bat` > extensionless, and always run `.cmd`/`.bat`
 * (and bare names) through a shell — both for version probes and for spawn.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, posix as posixPath, win32 as win32Path, isAbsolute } from 'path';
import { execFileSync, execSync } from 'child_process';

/** Extensions Node can CreateProcess on Windows (with shell for .cmd/.bat). */
const WINDOWS_SPAWNABLE_EXT = /\.(cmd|bat|exe)$/i;
/** Prefer real PE binaries, then cmd shims, over extensionless npm wrappers. */
const WINDOWS_SPAWNABLE_PRIORITY = ['.exe', '.cmd', '.bat'];

/** Sentinel for `{env:VAR}` templates whose variable is not set. */
const UNSET = '\u0000UNSET\u0000';

/**
 * Windows npm global installs only ship a `.cmd` / `.bat` shim (no `.exe`),
 * and Node cannot spawn those without `shell: true`.
 * @param {string} bin - resolved binary path or bare name
 * @returns {boolean}
 */
export function isWindowsCmdShim(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(bin || ''));
}

/**
 * Whether the resolved binary must be spawned through a shell on Windows.
 *
 * True for `.cmd`/`.bat` shims AND for bare command names (no path, no
 * extension). Node's `spawn()` without a shell cannot resolve a bare name via
 * PATHEXT, so on Windows we must hand it to `cmd /c` to let PATHEXT pick the
 * real `.exe`/`.cmd`. Absolute/relative paths with an extension (`.exe`, `.com`,
 * …) are left to `CreateProcess` directly.
 *
 * @param {string} bin
 * @param {string} [platform] - test hook; defaults to process.platform
 * @returns {boolean}
 */
export function needsShellOnWindows(bin, platform = process.platform) {
  if (platform !== 'win32') return false;
  const s = String(bin || '');
  if (/\.(cmd|bat)$/i.test(s)) return true;
  const looksLikePath = /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
  const hasExt = /\.[a-z0-9]+$/i.test(s);
  return !looksLikePath && !hasExt;
}

/**
 * Pick the best match from `where` output lines on Windows.
 * Prefer `.exe` / `.cmd` / `.bat` over extensionless npm bash shims.
 *
 * @param {string[]|null|undefined} matches
 * @returns {string|null}
 */
export function selectWindowsWhereMatch(matches) {
  const lines = (Array.isArray(matches) ? matches : [])
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  for (const ext of WINDOWS_SPAWNABLE_PRIORITY) {
    const hit = lines.find((line) => line.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return lines[0];
}

/**
 * If `bin` is an absolute/relative path without a spawnable Windows extension
 * and a sibling `.exe`/`.cmd`/`.bat` exists, return that sibling.
 *
 * Bare names (`opencode`) are left unchanged so PATH+PATHEXT still apply at spawn.
 *
 * @param {string} bin
 * @param {(path: string) => boolean} [existsFn]
 * @param {boolean} [forceWindows] - test hook; defaults to process.platform === 'win32'
 * @returns {string}
 */
export function resolveWindowsSpawnableBin(
  bin,
  existsFn = pathExists,
  forceWindows = process.platform === 'win32',
) {
  if (!forceWindows || typeof bin !== 'string') return bin;
  const trimmed = bin.trim();
  if (!trimmed) return bin;
  if (WINDOWS_SPAWNABLE_EXT.test(trimmed)) return trimmed;

  // Bare command names: let PATHEXT / shell resolve; do not invent a path.
  const looksLikePath = (forceWindows ? win32Path.isAbsolute(trimmed) : isAbsolute(trimmed))
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || /^[A-Za-z]:/.test(trimmed);
  if (!looksLikePath) return trimmed;

  for (const ext of WINDOWS_SPAWNABLE_PRIORITY) {
    const candidate = `${trimmed}${ext}`;
    if (existsFn(candidate)) return candidate;
  }
  return trimmed;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function pathExists(candidate) {
  try {
    return typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate);
  } catch {
    return false;
  }
}

/** Bare command name (no path separator, no drive letter). */
function isBareName(bin) {
  const s = String(bin || '');
  return !/[\\/]/.test(s) && !/^[A-Za-z]:/.test(s);
}

function whichOnPath(binaryName, env = process.env, platform = process.platform) {
  try {
    if (platform === 'win32') {
      // Prefer execFile so the binary name is not re-parsed by a shell.
      // `where` lists every PATHEXT match; the extensionless npm shim is often first
      // and cannot be spawned — selectWindowsWhereMatch prefers .cmd/.exe.
      let output;
      try {
        output = execFileSync('where.exe', [binaryName], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env,
          windowsHide: true,
        });
      } catch {
        // Fallback for systems where where.exe is not on PATH of the IDE process.
        output = execSync(`where ${binaryName}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env,
          windowsHide: true,
        });
      }
      const lines = String(output || '').split(/\r?\n/);
      return selectWindowsWhereMatch(lines);
    }

    const output = execFileSync('which', [binaryName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    const first = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.binaryName - e.g. "opencode" | "node"
 * @param {string[]} [options.envKeys] - env var names for path override
 * @param {string[]} [options.homeCandidates] - absolute-ish candidates under $HOME
 *   (use `{home}` placeholder or pass full relative segments)
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {string}
 */
export function resolveCliPath({ binaryName, envKeys = [], homeCandidates = [], env = process.env }) {
  const win = process.platform === 'win32';
  // npm global installs on Windows ship `.cmd` shims, not `.exe`.
  const exeNames = win
    ? [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`, binaryName]
    : [binaryName];

  const envOverride = firstNonEmpty(...envKeys.map((key) => env[key]));
  if (envOverride) {
    return resolveWindowsSpawnableBin(envOverride);
  }

  // `where <name>` (no extension) honors PATHEXT; we then prefer .cmd/.exe.
  const fromPath = whichOnPath(binaryName, env);
  if (fromPath) return resolveWindowsSpawnableBin(fromPath);

  const home = homedir();
  for (const template of homeCandidates) {
    for (const exeName of exeNames) {
      const resolved = template
        .replace('{home}', home)
        .replace('{bin}', exeName)
        .replace('{name}', binaryName);
      if (pathExists(resolved)) return resolveWindowsSpawnableBin(resolved);
    }
  }

  return binaryName;
}

/**
 * Prepend extra bin dirs to PATH when missing (IDE PATH is often sparse).
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} binDirs
 */
export function enrichPathWithBinDirs(env, binDirs = []) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  let current = env[pathKey] || env.PATH || '';
  const parts = current ? current.split(sep) : [];
  for (const dir of binDirs) {
    if (dir && !parts.includes(dir)) {
      parts.unshift(dir);
    }
  }
  env[pathKey] = parts.join(sep);
  if (pathKey !== 'PATH') {
    env.PATH = env[pathKey];
  }
}

/**
 * Common user-level CLI install dirs (IDE PATH is often sparse / no login shell).
 * Used both for binary resolution and spawn PATH enrichment.
 */
export function commonCliBinDirs(home = homedir(), env = process.env) {
  const dirs = [];
  if (!home) return dirs;
  dirs.push(
    join(home, '.opencode', 'bin'),
    join(home, '.local', 'share', 'opencode', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
  );
  if (process.platform === 'win32') {
    // npm global bin dir on Windows (e.g. C:\Users\<user>\AppData\Roaming\npm).
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    dirs.push(join(appData, 'npm'));
    // pnpm global bin dir on Windows (e.g. C:\Users\<user>\AppData\Local\pnpm).
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(localAppData, 'pnpm'));
    // Scoop shims (e.g. C:\Users\<user>\scoop\shims).
    dirs.push(join(home, 'scoop', 'shims'));
  } else {
    // pnpm global bin dir on macOS/Linux (e.g. ~/.local/share/pnpm).
    dirs.push(join(home, '.local', 'share', 'pnpm'));
  }
  return dirs;
}

export function resolveOpenCodeCliPath(env = process.env) {
  return resolveCliPath({
    binaryName: 'opencode',
    envKeys: ['OPENCODE_BIN', 'OPENCODE_PATH', 'OPENCODE_CLI_PATH'],
    homeCandidates: [
      '{home}/.opencode/bin/{bin}',
      '{home}/.local/bin/{bin}',
      '{home}/.local/share/opencode/bin/{bin}',
    ],
    env,
  });
}

// ── Version probing ─────────────────────────────────────────────────────────

/**
 * Quote a single argument for `cmd.exe`.
 *
 * Windows file paths cannot legally contain a double quote, so wrapping in
 * double quotes is sufficient; cmd also needs the whole thing kept together for
 * paths with spaces (`/s /c` strips the outer quotes).
 *
 * Shared with opencode-serve-manager so both the version probe and the serve
 * spawn build command lines the same way.
 */
export function quoteWindowsShellArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Build a full command line for `cmd.exe` (Windows shell spawns).
 * @param {string} binary
 * @param {string[]} args
 * @returns {string}
 */
export function buildWindowsShellCommandLine(binary, args = []) {
  return [binary, ...args].map(quoteWindowsShellArg).join(' ');
}

/**
 * Run `<bin> <args...>` and capture output, using a shell when Windows requires
 * it (`.cmd`/`.bat` shims and bare command names).
 *
 * Windows shell path: build an explicit command line and hand it to `cmd.exe`.
 * We deliberately avoid `spawn(…, { shell: true })` with an args array — Node
 * emits DEP0190 for that (args are concatenated, not escaped) and the warning
 * would pollute the daemon's stderr, which the host captures into its log ring.
 *
 * @param {string} binaryPath
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number, platform?: string }} [opts]
 * @returns {{ ok: boolean, output: string, status: number|null, error: string|null, usedShell: boolean }}
 */
function runVersionProbe(binaryPath, args, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const timeout = opts.timeout || 4000;
  const usedShell = needsShellOnWindows(binaryPath, platform);

  let stdout = '';
  let stderr = '';
  let status = null;
  let error = null;

  try {
    if (usedShell) {
      const commandLine = buildWindowsShellCommandLine(binaryPath, args);
      const out = execSync(commandLine, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        windowsHide: true,
        env,
      });
      stdout = String(out || '');
      status = 0;
    } else {
      const out = execFileSync(binaryPath, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        windowsHide: true,
        env,
      });
      stdout = String(out || '');
      status = 0;
    }
  } catch (err) {
    // Non-zero exit still carries captured output on the error object.
    status = typeof err?.status === 'number' ? err.status : null;
    stdout = String(err?.stdout || '');
    stderr = String(err?.stderr || '');
    if (!stdout && !stderr) {
      error = err?.code || err?.message || 'probe-failed';
    }
  }

  const trimmedOut = stdout.trim();
  const trimmedErr = stderr.trim();
  const output = trimmedOut || trimmedErr;

  // Accept a non-zero exit when the tool still printed a version (some CLIs
  // exit 1 on `--version` while printing the version to stderr).
  const ok = Boolean(output) && (status === 0 || Boolean(firstVersionToken(output)));
  return { ok, output, status, error, usedShell };
}

/** First `x.y[.z]` token in a string, or null. */
export function firstVersionToken(text) {
  const match = String(text || '').match(/(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)/);
  return match ? match[1] : null;
}

/**
 * Probe the OpenCode CLI version.
 *
 * Windows: `.cmd`/`.bat` shims and bare names run through a shell — a direct
 * `execFileSync` throws EINVAL and used to make the version permanently
 * "unknown" on Windows (the root cause of the 2026-10-16 v1/v2 mix-up).
 *
 * @param {string} binaryPath
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ timeout?: number, platform?: string }} [opts]
 * @returns {string | null} first non-empty output line, or null when unprobeable
 */
export function probeCliVersion(binaryPath, env = process.env, opts = {}) {
  if (!binaryPath) return null;
  const res = runVersionProbe(binaryPath, ['--version'], { ...opts, env });
  if (!res.ok) return null;
  return res.output.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
}

/**
 * Probe the system Node.js path and version from PATH.
 *
 * `OPENCODEBUDDY_NODE_BIN` (host-injected from the user's `nodePath` setting)
 * takes precedence: an IDE-launched daemon inherits a sparse PATH, so "node from
 * PATH" is frequently a *different* runtime than the one the host is configured
 * to use. Reporting the host's choice keeps the runtime diagnostic honest.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ path: string, version: string, source: 'settings'|'path' } | null}
 */
export function probeSystemNode(env = process.env) {
  const injected = firstNonEmpty(env[CLI_DESCRIPTORS.node.settingsKey]);
  if (injected) {
    return { path: injected, version: probeCliVersion(injected, env) || 'unknown', source: 'settings' };
  }
  try {
    const nodeBin = whichOnPath('node', env);
    if (!nodeBin) return null;
    const versionOutput = execFileSync(nodeBin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
      timeout: 3000,
    });
    const version = String(versionOutput || '').trim();
    return { path: nodeBin, version, source: 'path' };
  } catch {
    return null;
  }
}

// ── Unified resolver (L0 → L4) ──────────────────────────────────────────────

/**
 * Table-driven CLI descriptors. Adding a new CLI tool means adding an entry
 * here; the resolution algorithm itself never changes.
 *
 * Candidate templates support `{home}`, `{name}` and `{env:VAR}` placeholders.
 * On Windows, entries without an extension are expanded with
 * `.exe` → `.cmd` → `.bat` → (bare) in that order.
 */
export const CLI_DESCRIPTORS = {
  opencode: {
    kind: 'opencode',
    binaryName: 'opencode',
    /** L0: injected by the host from user settings. Authoritative. */
    settingsKey: 'OPENCODEBUDDY_CLI_PATH',
    /** L1: user shell env overrides. */
    envKeys: ['OPENCODE_BIN', 'OPENCODE_PATH', 'OPENCODE_CLI_PATH'],
    versionArgs: ['--version'],
    knownDirs: {
      win32: [
        '{env:APPDATA}/npm',
        '{env:LOCALAPPDATA}/pnpm',
        '{home}/scoop/shims',
        '{home}/.opencode/bin',
        '{home}/.local/share/opencode/bin',
      ],
      darwin: [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '{home}/.opencode/bin',
        '{home}/.local/bin',
        '{home}/.local/share/opencode/bin',
        '{home}/.bun/bin',
      ],
      linux: [
        '{home}/.opencode/bin',
        '{home}/.local/bin',
        '{home}/.local/share/opencode/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/snap/bin',
      ],
    },
  },
  node: {
    kind: 'node',
    binaryName: 'node',
    settingsKey: 'OPENCODEBUDDY_NODE_BIN',
    envKeys: ['NODE_BIN'],
    versionArgs: ['--version'],
    knownDirs: {
      win32: [
        '{env:ProgramFiles}/nodejs',
        '{env:LOCALAPPDATA}/Programs/nodejs',
        '{env:ProgramData}/chocolatey/bin',
        '{home}/scoop/shims',
        '{env:APPDATA}/nvm/current',
        '{home}/AppData/Roaming/nvm/current',
        '{home}/.volta/bin',
        '{env:LOCALAPPDATA}/fnm_multishells',
      ],
      darwin: [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '{home}/.volta/bin',
        '{home}/.fnm/aliases/default/bin',
        '{home}/.nodenv/shims',
      ],
      linux: [
        '/usr/local/bin',
        '/usr/bin',
        '/snap/bin',
        '{home}/.volta/bin',
        '{home}/.fnm/aliases/default/bin',
      ],
    },
  },
};

function normalisePlatform(platform) {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  return 'linux';
}

/**
 * Path flavour for the *target* platform, not the host one.
 *
 * The resolver is injectable by platform so Windows/macOS/Linux candidate tables
 * can be exercised from any machine (and so WSL/container combinations can be
 * modelled later). Using the host `path.join` here would emit `\home\u\...` for
 * a `linux` target when running on Windows, which silently breaks that seam.
 */
function pathFor(platform) {
  return platform === 'win32' ? win32Path : posixPath;
}

/** Join a path list using the target platform's separator. */
function joinFor(platform, ...parts) {
  return pathFor(platform).join(...parts);
}

function expandTemplate(template, ctx) {
  let missing = false;
  const expanded = String(template)
    .replace(/\{home\}/g, ctx.home || '')
    .replace(/\{name\}/g, ctx.binaryName)
    .replace(/\{env:([A-Za-z0-9_]+)\}/g, (_match, key) => {
      const value = ctx.env[key];
      if (!value) {
        missing = true;
        return UNSET;
      }
      return String(value);
    });
  if (missing || expanded.includes(UNSET)) return null;
  return expanded;
}

/** Expand a known-install-dir entry into concrete file candidates. */
function candidatesFromDir(dir, binaryName, platform) {
  const names = platform === 'win32'
    ? [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`, binaryName]
    : [binaryName];
  return names.map((name) => joinFor(platform, dir, name));
}

/**
 * Build the ordered, de-duplicated candidate list for a descriptor.
 *
 * @returns {{ path: string, source: 'settings'|'env'|'known-dir'|'path'|'bare', bare: boolean }[]}
 */
function buildCandidates(descriptor, ctx) {
  const { env, platform, home } = ctx;
  const seen = new Set();
  const out = [];

  const push = (path, source, bare = false) => {
    if (!path) return;
    const key = platform === 'win32' ? String(path).toLowerCase() : String(path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, source, bare });
  };

  // L0 — user settings (host-injected).
  const fromSettings = firstNonEmpty(env[descriptor.settingsKey]);
  if (fromSettings) {
    push(resolveWindowsSpawnableBin(fromSettings, ctx.exists, platform === 'win32'), 'settings');
  }

  // L1 — explicit env overrides.
  for (const key of descriptor.envKeys) {
    const value = firstNonEmpty(env[key]);
    if (value) push(resolveWindowsSpawnableBin(value, ctx.exists, platform === 'win32'), 'env');
  }

  // L2 — known install locations.
  const dirs = (descriptor.knownDirs[platform] || descriptor.knownDirs.linux || []);
  for (const template of dirs) {
    const dir = expandTemplate(template, ctx);
    if (!dir) continue;
    for (const candidate of candidatesFromDir(dir, descriptor.binaryName, platform)) {
      push(candidate, 'known-dir');
    }
  }

  // L3 — PATH lookup. `ctx.which` is a seam so unit tests never shell out to
  // the host's real `where.exe` / `which` (which would make results depend on
  // whatever happens to be installed on the machine running the tests).
  const fromPath = ctx.which(descriptor.binaryName, env, platform);
  if (fromPath) push(resolveWindowsSpawnableBin(fromPath, ctx.exists, platform === 'win32'), 'path');

  // L4 — bare name.
  push(descriptor.binaryName, 'bare', true);

  return out;
}

/**
 * Resolve a verified CLI executable.
 *
 * Verification: a candidate is *verified* when `<bin> <versionArgs>` produces
 * output. A candidate that exists on disk but cannot be version-probed is kept
 * as an *unverified* fallback (the engine probe — which talks to the server —
 * is the real authority for v1/v2, per ADR-2; the version string is display
 * only). Exceptions: a missing L0 settings path is a **blocking** failure, and
 * a bare-name L4 candidate is accepted without an existence check.
 *
 * @param {{ kind?: 'opencode'|'node', env?: NodeJS.ProcessEnv }} spec
 * @param {{
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   exists?: (p: string) => boolean,
 *   which?: (name: string, env: object, platform: string) => string|null,
 *   execProbe?: (bin: string, args: string[], opts: object) => { ok: boolean, output: string, status: number|null, error: string|null },
 *   timeoutMs?: number,
 * }} [deps] - injection seams; all optional and platform-agnostic for tests
 * @returns {Resolution}
 */
export function resolveCli(spec = {}, deps = {}) {
  const kind = spec.kind === 'node' ? 'node' : 'opencode';
  const descriptor = CLI_DESCRIPTORS[kind];
  const platform = normalisePlatform(deps.platform || process.platform);
  // `spec.env` is the environment being resolved in (the call-site input);
  // `deps.env` is the test seam and wins when explicitly supplied, so a test can
  // pin the environment regardless of what the caller passed. Note `||`, not a
  // merge: passing `{}` here deliberately means "resolve against an empty
  // environment", which is why test helpers must omit the key rather than
  // default it to `{}` when they intend to use `spec.env`.
  const env = deps.env || spec.env || process.env;
  const home = deps.home !== undefined ? deps.home : homedir();
  const exists = deps.exists || pathExists;
  const which = deps.which || ((name, e, p) => whichOnPath(name, e, p));
  const execProbe = deps.execProbe || ((bin, args, opts) => runVersionProbe(bin, args, opts));
  const timeoutMs = deps.timeoutMs || 4000;

  const ctx = { env, platform, home, exists, which, binaryName: descriptor.binaryName };
  const candidates = buildCandidates(descriptor, ctx);

  // A settings path that does not exist is blocking and must NOT fall back.
  const settingsPath = firstNonEmpty(env[descriptor.settingsKey]);
  if (settingsPath) {
    const spawnable = resolveWindowsSpawnableBin(settingsPath, exists, platform === 'win32');
    if (!exists(spawnable)) {
      return {
        ok: false,
        kind,
        reason: {
          kind: 'settings-invalid',
          path: settingsPath,
          detail: `Configured ${descriptor.settingsKey} does not exist`,
        },
        tried: [settingsPath],
      };
    }
  }

  const tried = [];
  let unverified = null;

  for (const candidate of candidates) {
    if (!candidate.bare && !exists(candidate.path)) continue;
    tried.push(candidate.path);

    const probe = execProbe(candidate.path, descriptor.versionArgs, { env, timeout: timeoutMs, platform });
    const version = probe && probe.ok
      ? String(probe.output || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null
      : null;

    if (version) {
      return {
        ok: true,
        kind,
        path: candidate.path,
        version,
        source: candidate.source,
        verified: true,
        spawn: { argv0: candidate.path, needsShell: needsShellOnWindows(candidate.path, platform), bare: candidate.bare },
      };
    }

    if (!unverified && !candidate.bare && exists(candidate.path)) {
      unverified = {
        ok: true,
        kind,
        path: candidate.path,
        version: null,
        source: candidate.source,
        verified: false,
        spawn: { argv0: candidate.path, needsShell: needsShellOnWindows(candidate.path, platform), bare: false },
      };
    }
  }

  if (unverified) return unverified;

  return {
    ok: false,
    kind,
    reason: {
      kind: 'cli-not-found',
      detail: `No usable ${descriptor.binaryName} executable found`,
    },
    tried,
  };
}

/**
 * Human-readable one-liner for a failed resolution (logs / UI).
 * @param {Resolution} resolution
 * @returns {string}
 */
export function describeResolveFailure(resolution) {
  if (!resolution || resolution.ok) return '';
  const reason = resolution.reason || {};
  if (reason.kind === 'settings-invalid') {
    return `Configured CLI path is invalid: ${reason.path}`;
  }
  const tried = Array.isArray(resolution.tried) && resolution.tried.length > 0
    ? ` (tried: ${resolution.tried.join(', ')})`
    : '';
  return `No opencode CLI found${tried}`;
}

/**
 * @typedef {object} Resolution
 * @property {boolean} ok
 * @property {'opencode'|'node'} kind
 * @property {string} [path]
 * @property {string|null} [version]   display-only; null when unprobeable
 * @property {'settings'|'env'|'known-dir'|'path'|'bare'} [source]
 * @property {boolean} [verified]
 * @property {{ argv0: string, needsShell: boolean, bare: boolean }} [spawn]
 * @property {{ kind: string, detail?: string, path?: string }} [reason]
 * @property {string[]} [tried]
 */
