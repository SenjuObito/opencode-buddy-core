import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCli, describeResolveFailure, CLI_DESCRIPTORS } from './cli-path.js';

/**
 * All resolver tests run through the injected seams (platform / home / exists /
 * which / execProbe), so Windows, macOS and Linux behaviour is verifiable on
 * any machine — the whole point of the resolver seam.
 *
 * The *environment* is intentionally passed through `spec.env` (the call-site
 * input), not through `deps`, because `deps.env` takes precedence over
 * `spec.env` in the resolver. Returning `env: {}` from this helper would
 * therefore silently blank out every `spec.env` — which is exactly the bug this
 * harness previously had. The key is only present when a test asks for it.
 */

/** Normalise a path for key lookups so Windows backslashes never decide a test. */
const norm = (p) => String(p).replace(/\\/g, '/');

/**
 * Build a deterministic deps bundle.
 *
 * `which` defaults to "nothing on PATH" so tests never spawn the host's real
 * `where.exe` / `which` and never pick up whatever opencode happens to be
 * installed on the machine running the suite.
 */
function deps({ platform = 'win32', env, home = '/home/u', files = [], versions = {}, which = () => null } = {}) {
  const fileSet = new Set(files.map(norm));
  const versionMap = new Map(Object.entries(versions).map(([k, v]) => [norm(k), v]));
  function exists(p) {
    return fileSet.has(norm(p));
  }
  function execProbe(bin, args, opts = {}) {
    const version = versionMap.get(norm(bin));
    if (version === undefined) return { ok: false, output: '', status: 1, error: null };
    return { ok: true, output: version, status: 0, error: null };
  }
  const bundle = { platform, home, exists, execProbe, which };
  if (env !== undefined) bundle.env = env;
  return bundle;
}

test('resolveCli: L0 settings path wins and is marked verified', () => {
  const bin = 'C:\\tools\\opencode.exe';
  const res = resolveCli(
    { kind: 'opencode', env: { OPENCODEBUDDY_CLI_PATH: bin, OPENCODE_BIN: 'C:\\other\\opencode.exe' } },
    deps({ files: [bin, 'C:\\other\\opencode.exe'], versions: { [bin]: 'opencode v2.0.27', 'C:/other/opencode.exe': 'opencode v1.9.0' } }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.source, 'settings');
  assert.equal(res.version, 'opencode v2.0.27');
  assert.equal(res.verified, true);
});

test('resolveCli: a missing settings path is a BLOCKING failure and does not fall back', () => {
  const res = resolveCli(
    { kind: 'opencode', env: { OPENCODEBUDDY_CLI_PATH: 'C:\\nope\\opencode.exe', OPENCODE_BIN: 'C:\\ok\\opencode.exe' } },
    deps({ files: ['C:\\ok\\opencode.exe'], versions: { 'C:/ok/opencode.exe': 'opencode v2.0.27' } }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason.kind, 'settings-invalid');
  assert.match(describeResolveFailure(res), /invalid/i);
});

test('resolveCli: L0 before L1 — settings is used even when env override is valid', () => {
  const settings = 'C:\\s\\opencode.exe';
  const envBin = 'C:\\e\\opencode.exe';
  const res = resolveCli(
    { kind: 'opencode', env: { OPENCODEBUDDY_CLI_PATH: settings, OPENCODE_PATH: envBin } },
    deps({ files: [settings, envBin], versions: { [settings]: 'opencode v2.0.27', [envBin]: 'opencode v2.0.27' } }),
  );
  assert.equal(res.source, 'settings');
  assert.equal(res.path.replace(/\\/g, '/'), settings.replace(/\\/g, '/'));
});

test('resolveCli: Windows prefers .exe over .cmd in the same known dir', () => {
  const dir = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const exe = `${dir}\\opencode.exe`;
  const cmd = `${dir}\\opencode.cmd`;
  const res = resolveCli(
    { kind: 'opencode', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } },
    deps({ files: [exe, cmd], versions: { [exe]: 'opencode v2.0.27', [cmd]: 'opencode v2.0.27' } }),
  );
  assert.equal(res.ok, true);
  assert.ok(res.path.endsWith('opencode.exe'), `expected .exe, got ${res.path}`);
  assert.equal(res.source, 'known-dir');
});

test('resolveCli: a Windows .cmd shim is verified and flagged as needing a shell', () => {
  const cmd = 'C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd';
  const res = resolveCli(
    { kind: 'opencode', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } },
    deps({ files: [cmd], versions: { [cmd]: 'opencode v2.0.27' } }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.spawn.needsShell, true);
  assert.equal(res.verified, true);
});

test('resolveCli: a bare (L4) candidate never needs an existence check and needs a shell on Windows', () => {
  const res = resolveCli(
    { kind: 'opencode', env: {} },
    deps({ files: [], versions: { opencode: 'opencode v2.0.27' } }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.source, 'bare');
  assert.equal(res.spawn.bare, true);
  assert.equal(res.spawn.needsShell, true);
});

test('resolveCli: existing but unprobeable candidates are accepted as UNVERIFIED, not as v1', () => {
  const cmd = 'C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd';
  const res = resolveCli(
    { kind: 'opencode', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } },
    deps({ files: [cmd], versions: {} }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.verified, false);
  assert.equal(res.version, null);
});

test('resolveCli: total failure reports cli-not-found with the attempted paths', () => {
  const res = resolveCli({ kind: 'opencode', env: {} }, deps({ files: [], versions: {} }));
  assert.equal(res.ok, false);
  assert.equal(res.reason.kind, 'cli-not-found');
  assert.ok(Array.isArray(res.tried));
  assert.match(describeResolveFailure(res), /No opencode CLI found/);
});

test('resolveCli: POSIX home candidates are honoured', () => {
  const bin = '/home/u/.opencode/bin/opencode';
  const res = resolveCli(
    { kind: 'opencode', env: {} },
    deps({ platform: 'linux', home: '/home/u', files: [bin], versions: { [bin]: 'opencode v2.0.27' } }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.path, bin);
  assert.equal(res.spawn.needsShell, false);
});

test('resolveCli: unset {env:VAR} placeholders never produce bogus candidates', () => {
  const res = resolveCli({ kind: 'opencode', env: {} }, deps({ files: [], versions: {} }));
  assert.equal(res.ok, false);
  for (const tried of res.tried) {
    assert.ok(!tried.includes('\u0000'), `placeholder leaked: ${tried}`);
  }
});

test('CLI_DESCRIPTORS: settings keys are distinct from shell env keys (source must stay attributable)', () => {
  assert.equal(CLI_DESCRIPTORS.opencode.settingsKey, 'OPENCODEBUDDY_CLI_PATH');
  assert.equal(CLI_DESCRIPTORS.node.settingsKey, 'OPENCODEBUDDY_NODE_BIN');
  assert.ok(!CLI_DESCRIPTORS.opencode.envKeys.includes('OPENCODEBUDDY_CLI_PATH'));
  assert.ok(!CLI_DESCRIPTORS.node.envKeys.includes('OPENCODEBUDDY_NODE_BIN'));
});
