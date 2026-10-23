/**
 * engine-probe.js
 *
 * Determine the running opencode server's engine mode (v1 / v2) from its
 * **capabilities**, not from the CLI version string.
 *
 * Why capability probing (ADR-2): the CLI version string is an indirect
 * signal that requires a successful `--version` spawn (which was broken on
 * Windows for `.cmd` shims) and that would need a new rule for every future
 * major. The server itself knows which API it exposes, so we ask it.
 *
 *   GET /global/health (or /api/health, /api/info) → 200 + JSON ⇒ v2
 *   GET /config                                    → 200 + JSON ⇒ v1
 *   anything else                                  ⇒ unknown  (NEVER "default to v1")
 *
 * Note on the HTML SPA fallback: an unknown route returns 200 with
 * `text/html` from the web UI. Treating "any 200" as success is exactly what
 * turned the 2026-10-16 v1/v2 mix-up into a confusing
 * "Request is not supported by this version of OpenCode Server" error, so a
 * JSON content type is required here.
 */

/** Candidate routes for probing OpenCode v2 capabilities (ordered by priority). */
export const V2_PROBE_PATHS = ['/global/health', '/api/health', '/api/info'];

/** Server-reported API version → engine mode. Add `3: 'v3'` when v3 lands. */
export const ENGINE_BY_API_VERSION = {
  1: 'v1',
  2: 'v2',
};

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isJsonContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  return value.includes('application/json') || value.includes('+json');
}

/**
 * Single HTTP attempt with timeout, tolerant of a thrown/aborted fetch.
 *
 * @returns {Promise<{ status: number|null, contentType: string|null, text: string, error: string|null }>}
 */
async function attempt(fetchImpl, url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    const contentType = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-type')
      : null;
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    return { status: res.status, contentType, text, error: null };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      status: null,
      contentType: null,
      text: '',
      error: aborted ? 'timeout' : (err?.code || err?.message || 'fetch-failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function buildHeaders({ password, directory }) {
  const headers = {};
  if (password) {
    headers.Authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  }
  if (directory) {
    headers['x-opencode-directory'] = encodeURIComponent(directory);
  }
  return headers;
}

/**
 * Probe the engine mode of a running opencode server.
 *
 * Network-level failures (connection refused, timeout) are retried up to
 * `retries` times; **content mismatches are not retried** (retrying a wrong
 * answer only wastes time and cannot change the verdict).
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - e.g. http://localhost:4096
 * @param {string|null} [opts.password] - Basic auth password (v2)
 * @param {string} [opts.directory] - project directory to scope the probe to
 * @param {number} [opts.timeoutMs] - per-attempt timeout (default 3000)
 * @param {number} [opts.retries] - retries for network failures (default 1)
 * @param {typeof fetch} [opts.fetchImpl] - injection seam for tests
 * @returns {Promise<{ engine: 'v1'|'v2'|'unknown', apiVersion: number|null,
 *                     tries: number, evidence: Evidence }>}
 *
 * @typedef {object} Evidence
 * @property {string|null} probePath  route that produced the verdict
 * @property {number|null} status     HTTP status of that attempt
 * @property {string|null} contentType
 * @property {number|null} apiVersion
 * @property {number} observedAt      epoch ms
 * @property {string|null} error      network error, when no HTTP verdict was reached
 */
export async function probeEngine(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = Number.isInteger(opts.retries) ? opts.retries : DEFAULT_RETRIES;
  const password = opts.password || null;
  const directory = opts.directory || null;

  let tries = 0;
  let lastError = null;

  if (!baseUrl || typeof fetchImpl !== 'function') {
    return {
      engine: 'unknown',
      apiVersion: null,
      tries: 0,
      evidence: {
        probePath: null,
        status: null,
        contentType: null,
        apiVersion: null,
        observedAt: Date.now(),
        error: !baseUrl ? 'no-base-url' : 'no-fetch',
      },
    };
  }

  const runWithRetry = async (path, headers) => {
    let result = null;
    for (let i = 0; i <= retries; i++) {
      tries += 1;
      result = await attempt(fetchImpl, `${baseUrl}${path}`, { headers, timeoutMs });
      if (result.status !== null) return result;
      lastError = result.error;
      if (i < retries) await sleep(RETRY_DELAY_MS);
    }
    return result;
  };

  const authHeaders = buildHeaders({ password, directory });
  const anonHeaders = buildHeaders({ password: null, directory });

  // ── v2 probe ─────────────────────────────────────────────────────────────
  // OpenCode 1.19+ official endpoint is /global/health (returning { healthy: true, version: ... }).
  // We also check /api/health and /api/info for backward compatibility with mocks and older setups.
  const infoAttempts = password
    ? [authHeaders, anonHeaders]
    : [anonHeaders];

  let decisive = null;

  for (const v2Path of V2_PROBE_PATHS) {
    let matchedInPath = false;
    for (const headers of infoAttempts) {
      const info = await runWithRetry(v2Path, headers);
      if (info.status !== null) {
        decisive = { ...info, probePath: v2Path };
      }
      const parsed = info.status === 200 && isJsonContentType(info.contentType)
        ? parseJson(info.text)
        : null;
      if (parsed) {
        matchedInPath = true;
        const reported = Number(parsed.apiVersion);
        let apiVersion = null;
        if (Number.isFinite(reported)) {
          apiVersion = reported;
        } else if (typeof parsed.version === 'string' && parsed.version.trim()) {
          // 严格按版本号（1.x 为 v1，2.0+ 为 v2）判定
          const match = parsed.version.trim().match(/^v?(\d+)/i);
          if (match) {
            const major = parseInt(match[1], 10);
            apiVersion = major === 1 ? 1 : (major >= 2 ? 2 : null);
          }
        }

        if (apiVersion === null) {
          apiVersion = v2Path.startsWith('/api/') ? 2 : 1;
        }

        const engine = ENGINE_BY_API_VERSION[apiVersion] || 'unknown';
        if (engine !== 'unknown') {
          return {
            engine,
            apiVersion,
            tries,
            evidence: {
              probePath: v2Path,
              status: info.status,
              contentType: info.contentType,
              apiVersion,
              observedAt: Date.now(),
              error: null,
            },
          };
        }
        // Server reported an API version we do not know yet: report unknown rather
        // than guessing (this is the v3 forward-compat hole, surfaced explicitly).
        return {
          engine: 'unknown',
          apiVersion,
          tries,
          evidence: {
            probePath: v2Path,
            status: info.status,
            contentType: info.contentType,
            apiVersion,
            observedAt: Date.now(),
            error: 'unsupported-api-version',
          },
        };
      }
      // 401/403 with credentials is worth retrying anonymously; any other outcome
      // (404 SPA fallback, HTML, 5xx) will not change with a different header.
      if (!(info.status === 401 || info.status === 403)) break;
    }
    // If this route matched, we would have returned above.
    // If it returned 401/403 even after anon retry, server requires valid auth on v2 route.
    if (decisive && (decisive.status === 401 || decisive.status === 403)) {
      break;
    }
  }

  // ── v1: /config ──────────────────────────────────────────────────────────
  // Try anonymous first (v1 usually has no auth), then with credentials in case
  // a password-protected v1 server returns 401.
  let config = await runWithRetry('/config', anonHeaders);
  if (config.status === 401 || config.status === 403) {
    config = await runWithRetry('/config', authHeaders);
  }
  if (config.status !== null) {
    decisive = { ...config, probePath: '/config' };
  }

  if (config.status === 200 && isJsonContentType(config.contentType) && parseJson(config.text)) {
    return {
      engine: 'v1',
      apiVersion: 1,
      tries,
      evidence: {
        probePath: '/config',
        status: config.status,
        contentType: config.contentType,
        apiVersion: 1,
        observedAt: Date.now(),
        error: null,
      },
    };
  }

  // Neither capability matched.
  const lastDecisive = decisive || { status: null, contentType: null, probePath: null };
  return {
    engine: 'unknown',
    apiVersion: null,
    tries,
    evidence: {
      probePath: lastDecisive.probePath || null,
      status: lastDecisive.status,
      contentType: lastDecisive.contentType,
      apiVersion: null,
      observedAt: Date.now(),
      error: lastDecisive.status === null ? (lastError || 'no-response') : 'no-capability-match',
    },
  };
}

/**
 * Human-readable explanation of an inconclusive probe (logs / UI).
 * @param {{ engine: string, evidence: Evidence }} result
 * @returns {string}
 */
export function describeProbeFailure(result) {
  const ev = (result && result.evidence) || {};
  if (ev.error === 'unsupported-api-version') {
    return `Server reports unknown API version ${ev.apiVersion} — this plugin supports v1/v2 only`;
  }
  if (ev.error === 'no-capability-match') {
    return `Server on the configured port answered HTTP ${ev.status} (${ev.contentType || 'no content-type'}) but exposed neither /global/health (v2) nor /config (v1). Another process may be listening on this port.`;
  }
  if (ev.status === null) {
    return `No HTTP response from the opencode server (${ev.error || 'unknown error'})`;
  }
  return `Could not determine opencode engine mode (HTTP ${ev.status})`;
}
