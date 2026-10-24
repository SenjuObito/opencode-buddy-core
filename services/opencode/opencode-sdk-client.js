/**
 * opencode-sdk-client.js
 *
 * Thin wrapper around the @opencode-ai/sdk v2 client for the persistent bridge.
 * Ported from the reference implementation
 * (opencode-x/src/webviewHost/services/OpenCodeClient.ts).
 *
 * The v2 SDK uses FLAT parameter format:
 *   { sessionID, directory, model, agent, parts, ... }
 * NOT the v1 nested format:
 *   { path: { id }, query: { directory }, body: { ... } }
 *
 * Routing: every exported function branches on `engineRegistry.isV2()`. That is
 * a *synchronous, side-effect-free* read, which is only safe because each
 * request path passes through `engineRegistry.ensure()` first — at the request
 * boundary in the two entry points (daemon.js dispatch, channel-manager's
 * handleOpenCodeCommand) and again in `_ensureReady` / `ensureServerReady`.
 * `ensure()` either locks a verified mode or throws EngineUnresolvedError, so a
 * request can never be sent down a guessed route (ADR-3).
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import * as serveManager from './opencode-serve-manager.js';
import * as engineRegistry from './engine-registry.js';
import { registerPendingCompaction, resolvePendingCompaction } from './compaction-tracker.js';

let _client = null;
let _baseUrl = null;

export function getEffectiveBaseUrl() {
  return _baseUrl || serveManager.getServerUrl() || serveManager.tryReadServiceInfo()?.url || 'http://localhost:4096';
}

export function getBaseUrl() {
  return getEffectiveBaseUrl();
}

/**
 * Neutral notice for a user-initiated stop.
 *
 * The server records "the user pressed stop" as `finish: 'error'` with
 * `error.type: 'aborted'` / `error.message: 'Step interrupted'`. Rendering that
 * verbatim — as `[Error: Step interrupted]` — reads like a crash in the middle
 * of the transcript. `aborted: true` rides along so the host can style it as a
 * state notice instead of an error bubble.
 */
const ABORTED_NOTICE = '已停止生成';

/**
 * Flatten a v2 tool result `content` array (`[{type:'text', text}]`) into text.
 *
 * v2 moved tool output out of `state.output` and into this array; reading only
 * `output` silently dropped every tool result on restore (the tool_use block
 * showed up with an empty result). v1 keeps the plain-string form, so a string
 * passes straight through.
 */
function flattenToolContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (typeof c === 'string') {
      parts.push(c);
    } else if (c && typeof c === 'object' && typeof c.text === 'string') {
      parts.push(c.text);
    }
  }
  return parts.join('\n');
}

function getAuthHeader() {
  const pwd = serveManager.getServerPassword();
  if (!pwd) return {};
  const encoded = Buffer.from(`opencode:${pwd}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

async function* subscribeEventsV2(baseUrl, password, directory, signal) {
  const headers = {};
  if (password) {
    headers.Authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
  }
  if (directory) {
    headers['x-opencode-directory'] = encodeURIComponent(directory);
  }

  const res = await fetch(`${baseUrl}/api/event`, { headers, signal });
  if (!res.ok) {
    throw new Error(`Failed to subscribe events: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep trailing incomplete chunk
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            yield parsed;
          } catch {
            // ignore non-json
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Get (creating on first use) the shared SDK client bound to the running
 * `opencode serve` instance.
 *
 * @param {string} [baseUrl] - server URL (http://localhost:4096)
 * @returns {ReturnType<typeof createOpencodeClient>}
 */
export function getClient(baseUrl) {
  const effective = baseUrl || getEffectiveBaseUrl();
  if (!_client || _baseUrl !== effective) {
    _baseUrl = effective;
    _client = createOpencodeClient({
      baseUrl: effective,
      fetch: async (req) => {
        const pwd = serveManager.getServerPassword();
        if (pwd && !req.headers.has('authorization')) {
          req.headers.set('authorization', 'Basic ' + Buffer.from(`opencode:${pwd}`).toString('base64'));
        }
        return fetch(req);
      },
    });
  }
  return _client;
}

/**
 * Reset the cached client (e.g. when the serve process is restarted on a
 * different port or the server URL changes).
 */
export function resetClient() {
  _client = null;
  _baseUrl = null;
}

/**
 * Rebind the client to a (possibly different) server URL. The actual client is
 * created lazily on the next call that needs it, so this is cheap even when the
 * URL hasn't changed.
 *
 * @param {string} baseUrl - server URL (http://localhost:4096)
 */
export function setBaseUrl(baseUrl) {
  if (_baseUrl !== baseUrl) {
    _client = null;
    _baseUrl = baseUrl;
  }
}

// ── Health ────────────────────────────────────────────────────────────────

/**
 * Ping the server by checking server status / session list.
 * @returns {Promise<boolean>}
 */
export async function health() {
  try {
    if (engineRegistry.isV2()) {
      const url = `${getEffectiveBaseUrl()}/api/info`;
      const res = await fetch(url, { headers: getAuthHeader() });
      return res.status === 200;
    }
    const client = getClient();
    const result = await client.session.list();
    return result.error === undefined || result.error === null;
  } catch {
    return false;
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────

/**
 * @param {string} [title]
 * @param {string} [directory]
 * @returns {Promise<object>} the created session (with `id`)
 */
export async function createSession(title, directory, selection) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session`;
    const body = {};
    if (title) body.title = title;
    if (directory) body.location = { directory };
    // v2 makes agent/model session-scoped, so creation is the natural place to
    // seed them: `POST /prompt` cannot carry either, and doing it here means a
    // brand-new session's first turn already runs on the right agent/model
    // instead of the catalog default.
    if (selection && selection.agent) body.agent = selection.agent;
    const modelRef = toV2ModelRef(selection && selection.model, selection && selection.variant);
    if (modelRef) body.model = modelRef;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Failed to create session: HTTP ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    return json.data || json;
  }
  const params = {};
  if (title) params.title = title;
  if (directory) params.directory = directory;
  const result = await getClient().session.create(params);
  if (result.error) {
    throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Normalize path for directory comparison (cross-platform, case-insensitive on Windows).
 *
 * Case folding is driven by the *shape of the path*, not only by the host OS: a
 * `C:/...` drive path or a `//server/share` UNC path can only come from a Windows
 * filesystem, which is case-insensitive there. Records written by a Windows host
 * (and tests that replay them) must not start matching case-sensitively just
 * because the check happens to run on Linux — e.g. in CI.
 */
export function normalizeDirForMatch(p) {
  if (!p || typeof p !== 'string') return '';
  let normalized = p.replace(/\\/g, '/');
  const isWindowsPath = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//');
  if (process.platform === 'win32' || isWindowsPath) {
    normalized = normalized.toLowerCase();
  }
  return normalized.replace(/\/+$/, '');
}

/**
 * Normalize a session summary so v1 and v2 consumers see the same fields.
 *
 * v2 exposes a nested `location.directory` and a `{providerID,id}` model
 * object; v1 exposes `directory` and (when present) a primitive model. The
 * host history layer should not have to unpack either shape.
 *
 * @param {object} session
 * @returns {object}
 */
function normalizeSessionSummary(session) {
  if (!session || typeof session !== 'object') return session;
  const directory = session.location?.directory || session.directory || '';
  let model = session.model;
  if (model && typeof model === 'object') {
    const providerID = typeof model.providerID === 'string' ? model.providerID : '';
    const id = typeof model.id === 'string' ? model.id : (typeof model.modelID === 'string' ? model.modelID : '');
    model = providerID && id ? `${providerID}/${id}` : (id || providerID || undefined);
  }
  const normalized = { ...session, directory };
  if (typeof model === 'string' && model) {
    normalized.model = model;
  } else {
    delete normalized.model;
  }
  return normalized;
}

/**
 * @param {string} [directory]
 * @param {number|string} [limit]
 * @param {string} [parentID] only sessions spawned by this session
 * @returns {Promise<object[]>}
 */
export async function listSessions(directory, limit, parentID) {
  if (engineRegistry.isV2()) {
    const query = new URLSearchParams();
    if (limit && Number(limit) > 0) query.set('limit', String(limit));
    // opencode v2 exposes child sessions through the same list route; the
    // parentID filter is server-side, so a long history cannot push a child
    // past the limit before we see it.
    if (parentID) query.set('parentID', parentID);
    const qs = query.toString();
    const url = `${getEffectiveBaseUrl()}/api/session${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      headers: getAuthHeader(),
    });
    if (!res.ok) {
      throw new Error(`Failed to list sessions: HTTP ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    const rawList = Array.isArray(json.items)
      ? json.items
      : (Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []));

    // Align v1/v2 session objects with the unified host shape.
    const unifiedList = rawList.map(normalizeSessionSummary);

    // Robust directory filtering for Windows (case-insensitive & slash-normalized)
    if (directory && typeof directory === 'string' && directory.trim()) {
      if (unifiedList.length === 0) return [];
      const target = normalizeDirForMatch(directory.trim());
      const filtered = unifiedList.filter(s => {
        const sessionDir = s.directory;
        return sessionDir && normalizeDirForMatch(sessionDir) === target;
      });
      return filtered;
    }

    return unifiedList;
  }
  const params = {};
  if (limit && Number(limit) > 0) params.limit = Number(limit);
  if (directory) params.directory = directory;
  const result = await getClient().session.list(params);
  if (result.error) {
    throw new Error(`Failed to list sessions: ${JSON.stringify(result.error)}`);
  }
  const sessions = (result.data ?? []).map(normalizeSessionSummary);
  if (!parentID) return sessions;
  // v1 has no parentID query parameter; filter the result instead. It is the
  // same contract for callers, and keeps the host free of engine branches.
  return sessions.filter(session => session && session.parentID === parentID);
}

/**
 * @param {string} id
 * @param {string} [directory]
 * @returns {Promise<object | null>}
 */
export async function getSession(id, directory) {
  if (engineRegistry.isV2()) {
    try {
      const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(id)}`;
      const res = await fetch(url, { headers: getAuthHeader() });
      if (!res.ok) return null;
      const json = await res.json();
      return json.data || json;
    } catch {
      return null;
    }
  }
  const params = { sessionID: id };
  if (directory) params.directory = directory;
  const result = await getClient().session.get(params);
  if (result.error) return null;
  return result.data;
}

/**
 * @param {string} id
 * @param {string} [directory]
 * @returns {Promise<void>}
 */
export async function deleteSession(id, directory) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: getAuthHeader(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete session: HTTP ${res.status} ${await res.text()}`);
    }
    return;
  }
  const params = { sessionID: id };
  if (directory) params.directory = directory;
  const result = await getClient().session.delete(params);
  if (result.error) {
    throw new Error(`Failed to delete session: ${JSON.stringify(result.error)}`);
  }
}

/**
 * @param {string} id
 * @param {string} title
 * @param {string} [directory]
 * @returns {Promise<object>}
 */
export async function updateSessionTitle(id, title, directory) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw new Error(`Failed to update session title: HTTP ${res.status} ${await res.text()}`);
    }
    return { id, title };
  }
  const params = { sessionID: id, title };
  if (directory) params.directory = directory;
  const result = await getClient().session.update(params);
  if (result.error) {
    throw new Error(`Failed to update session title: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * @param {string} id
 * @param {object} metadata
 * @param {string} [directory]
 * @returns {Promise<object>}
 */
export async function updateSessionMetadata(id, metadata, directory) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata }),
    });
    if (!res.ok) {
      throw new Error(`Failed to update session metadata: HTTP ${res.status} ${await res.text()}`);
    }
    return { id, metadata };
  }
  const params = { sessionID: id, metadata };
  if (directory) params.directory = directory;
  const result = await getClient().session.update(params);
  if (result.error) {
    throw new Error(`Failed to update session metadata: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Toggle favorite status of a session in session.metadata.
 * @param {string} id
 * @param {boolean} [targetState]
 * @param {string} [directory]
 * @returns {Promise<{ isFavorited: boolean, favoritedAt?: number }>}
 */
export async function toggleSessionFavorite(id, targetState, directory) {
  const session = await getSession(id, directory);
  const currentMeta = (session && typeof session.metadata === 'object' && session.metadata) || {};
  const isFavorited = targetState !== undefined ? Boolean(targetState) : !Boolean(currentMeta.isFavorited);
  const favoritedAt = isFavorited
    ? (typeof currentMeta.favoritedAt === 'number' ? currentMeta.favoritedAt : Date.now())
    : undefined;

  const updatedMeta = {
    ...currentMeta,
    isFavorited,
    ...(isFavorited ? { favoritedAt } : {}),
  };
  if (!isFavorited) {
    delete updatedMeta.favoritedAt;
  }

  await updateSessionMetadata(id, updatedMeta, directory);
  return { isFavorited, favoritedAt };
}

// ── Messaging ─────────────────────────────────────────────────────────────

/**
 * Send a prompt asynchronously to a session (returns once queued; streaming
 * arrives over the SSE event stream).
 *
 * @param {string} sessionId
 * @param {string} text
 * @param {object} [options]
 * @param {{ providerID: string, modelID: string }} [options.model]
 * @param {string} [options.system]
 * @param {string} [options.agent]
 * @param {Record<string, boolean>} [options.tools]
 * @param {string} [options.directory]
 * @param {string} [options.messageID]
 * @param {Array<object>} [options.parts] - extra parts (e.g. file parts for images)
 * @returns {Promise<void>}
 */
/**
 * File parts carry whole files as `data:` URLs. Logging them raw floods stderr,
 * which the host forwards to the UI as node_log, so replace payloads with a
 * size hint before serialising.
 *
 * @param {object} params
 * @returns {object}
 */
function redactParamsForLog(params) {
  if (!params || typeof params !== 'object' || !Array.isArray(params.parts)) {
    return params;
  }
  return {
    ...params,
    parts: params.parts.map((part) => {
      if (!part || typeof part !== 'object') return part;
      if (typeof part.url === 'string') {
        return { ...part, url: `<${part.url.split(':')[0]}: ${part.url.length} chars>` };
      }
      if (typeof part.text === 'string' && part.text.length > 200) {
        return { ...part, text: `<${part.text.length} chars>` };
      }
      return part;
    }),
  };
}

/**
 * Convert the host-side model ref to the shape opencode v2 expects.
 *
 * v1 and the host speak `{ providerID, modelID }`; v2's `Model.Ref` is
 * `{ id, providerID, variant }` with `required: [id, providerID]` and
 * `additionalProperties: false`. Sending `modelID` there is rejected, so the
 * rename has to happen exactly once, here.
 *
 * Returns null when the provider is unknown — `Model.Ref` requires a provider,
 * and a bare model id cannot be resolved without one.
 */
export function toV2ModelRef(model, variant) {
  if (!model || typeof model !== 'object') return null;
  const id = model.modelID || model.id;
  const providerID = model.providerID;
  if (!id || typeof id !== 'string' || !providerID || typeof providerID !== 'string') {
    return null;
  }
  const ref = { id, providerID };
  // 'default' is the UI's "use the model default" — it must NOT be forwarded as
  // a variant, or opencode would look up a level that no model declares. Omitting
  // the field is what actually produces `variant: "default"` server-side.
  const normalized = typeof variant === 'string' ? variant.trim() : '';
  if (normalized && normalized !== 'default') ref.variant = normalized;
  return ref;
}

/**
 * Set the agent for one session (v2 only).
 *
 * v2 moved agent/model from message scope to session scope: `POST /prompt` has
 * no `agent` field, so passing one there is silently ignored. The session keeps
 * whatever it was created with until this endpoint changes it.
 *
 * Returns false on v1 (callers fall back to the prompt body) so the same call
 * site can serve both engines.
 */
export async function setSessionAgent(sessionId, agent) {
  if (!engineRegistry.isV2()) return false;
  if (!sessionId || !agent || typeof agent !== 'string' || !agent.trim()) return false;
  const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/agent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: agent.trim() }),
  });
  if (!res.ok) {
    throw new Error(`Set session agent failed: HTTP ${res.status} ${await res.text()}`);
  }
  return true;
}

/**
 * Set the model (and its reasoning variant) for one session (v2 only).
 *
 * `variant` rides on `Model.Ref` — v2 has no separate reasoning-effort channel,
 * so this is the only place `high` / `medium` can be expressed.
 */
export async function setSessionModel(sessionId, modelRef) {
  if (!engineRegistry.isV2()) return false;
  if (!sessionId || !modelRef || typeof modelRef !== 'object') return false;
  if (!modelRef.id || !modelRef.providerID) return false;
  const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/model`;

  const post = (payload) => fetch(url, {
    method: 'POST',
    headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: payload }),
  });

  const res = await post(modelRef);
  if (res.ok) return true;

  const errText = await res.text();
  // A model may not offer the requested reasoning variant (`low`/`high`/`max`
  // come from each model's own catalog entry; several models have none at all).
  // Dropping the variant still honours the user's *model* choice, whereas
  // failing the whole request blocks the turn. Only retry for that specific
  // rejection — any other error must surface unchanged.
  if (modelRef.variant && /variant/i.test(errText)) {
    const retry = await post({ id: modelRef.id, providerID: modelRef.providerID });
    if (retry.ok) return true;
    throw new Error(`Set session model failed: HTTP ${retry.status} ${await retry.text()}`);
  }
  throw new Error(`Set session model failed: HTTP ${res.status} ${errText}`);
}

export async function promptAsync(sessionId, text, options = {}) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/prompt`;
    // v2's prompt body accepts only {id, text, files, agents, skills, metadata,
    // delivery, resume}. `agent`, `model`, `system` and `tools` are NOT part of
    // it — v1 accepted them there, which is why this file used to forward them
    // and why v2 silently ran every turn on the session's old agent/model.
    // Session selection is applied separately via setSessionAgent/setSessionModel.
    const body = {
      text,
    };

    const files = [];
    const sourceParts = Array.isArray(options.parts) ? options.parts : [];
    for (const part of sourceParts) {
      if (!part || typeof part !== 'object') continue;
      const uri = part.url || part.uri || part.data;
      if (uri) {
        files.push({
          uri,
          name: part.filename || part.name || 'attachment',
        });
      }
    }
    if (Array.isArray(options.files)) {
      for (const f of options.files) {
        if (!f || typeof f !== 'object') continue;
        const uri = f.uri || f.url;
        if (uri) {
          files.push({
            uri,
            name: f.name || f.filename || 'attachment',
          });
        }
      }
    }
    if (files.length > 0) {
      body.files = files;
    }

    console.error('[opencode-sdk-client:v2] promptAsync:', JSON.stringify(redactParamsForLog(body)));
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Prompt failed: HTTP ${res.status} ${errText}`);
    }
    return;
  }

  const params = {
    sessionID: sessionId,
    parts: [{ type: 'text', text }],
  };
  if (options.messageID) params.messageID = options.messageID;
  if (options.model) params.model = options.model;
  if (options.variant) params.variant = options.variant;
  if (options.system) params.system = options.system;
  if (options.agent) params.agent = options.agent;
  if (options.tools) params.tools = options.tools;
  if (options.directory) params.directory = options.directory;
  if (Array.isArray(options.parts) && options.parts.length > 0) {
    params.parts = [...params.parts, ...options.parts];
  }

  console.error('[opencode-sdk-client] promptAsync:', JSON.stringify(redactParamsForLog(params)));
  const result = await getClient().session.promptAsync(params);
  if (result.error) {
    throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
  }
}

/**
 * Run a shell command in the session context (opencode `!` semantics).
 * The server executes the command, records it as a bash tool part, and
 * streams an AI reply over SSE (same as promptAsync).
 *
 * @param {string} sessionId
 * @param {string} command - shell command WITHOUT the leading `!`
 * @param {object} [options]
 * @param {{ providerID: string, modelID: string }} [options.model]
 * @param {string} [options.agent]
 * @param {string} [options.directory]
 * @returns {Promise<void>}
 */
export async function shellAsync(sessionId, command, options = {}) {
  const agent = (typeof options.agent === 'string' && options.agent.trim())
    ? options.agent.trim()
    : 'build';

  const baseUrl = getEffectiveBaseUrl();

  // OpenCode REST API routing (verified against the server's /openapi.json):
  // every route is served under the /api prefix — /api/session/{id}/shell.
  // The bare /session/{id}/shell form is NOT a route; it hits the web UI's SPA
  // fallback (200 + text/html).
  //
  // Order is deliberately independent of the engine mode: v1 already used the
  // /api form first (and kept the bare form as a fallback), so keeping that
  // order for both engines changes nothing for v1 and fixes the v2 primary,
  // which used to spend its first request on a route that only ever returned
  // the SPA HTML.
  const prefixlessUrl = `${baseUrl}/session/${encodeURIComponent(sessionId)}/shell`;
  const primaryUrl = `${baseUrl}/api/session/${encodeURIComponent(sessionId)}/shell`;
  const fallbackUrl = prefixlessUrl;

  const body = { command, agent };
  if (options.model) body.model = options.model;
  if (options.directory) body.directory = options.directory;

  const tryRequest = async (url) => {
    return await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  let res = await tryRequest(primaryUrl);
  const contentType = res.headers.get('content-type') || '';

  // If 404 Not Found, 405 Method Not Allowed, or received HTML fallback (SPA route fallback), retry fallback URL
  if (!res.ok || contentType.includes('text/html')) {
    console.warn(`[opencode-sdk-client] shellAsync primary url (${primaryUrl}) status=${res.status}, retrying fallback url (${fallbackUrl})`);
    try {
      const fallbackRes = await tryRequest(fallbackUrl);
      const fbContentType = fallbackRes.headers.get('content-type') || '';
      if (fallbackRes.ok && !fbContentType.includes('text/html')) {
        return;
      }
      if (fallbackRes.ok && fbContentType.includes('text/html')) {
        throw new Error(`Shell endpoint returned HTML (SPA fallback) on both primary and fallback routes`);
      }
      throw new Error(`Shell failed: HTTP ${fallbackRes.status} ${await fallbackRes.text()}`);
    } catch (fbErr) {
      if (res.ok && contentType.includes('text/html')) {
        throw new Error(`Shell endpoint not found on OpenCode server: ${fbErr.message}`);
      }
      throw new Error(`Shell failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
}

/**
 * @param {string} sessionId
 * @param {string} command
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {string} [options.agent]
 * @param {string} [options.directory]
 * @param {string} [options.messageID]
 * @param {string} [options.arguments]
 * @returns {Promise<object>}
 */
export async function sendCommand(sessionId, command, options = {}) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/command`;
    const body = {
      name: command,
      text: options.arguments ?? '',
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Command failed: HTTP ${res.status} ${await res.text()}`);
    }
    const json = await res.json().catch(() => ({}));
    return json?.data || json;
  }

  const params = {
    sessionID: sessionId,
    command,
    arguments: options.arguments ?? '',
  };
  if (options.messageID) params.messageID = options.messageID;
  if (options.model) params.model = options.model;
  if (options.agent) params.agent = options.agent;
  if (options.variant) params.variant = options.variant;
  if (options.directory) params.directory = options.directory;
  if (Array.isArray(options.parts) && options.parts.length > 0) params.parts = options.parts;

  console.error('[opencode-sdk-client] sendCommand:', JSON.stringify(redactParamsForLog(params)));
  const result = await getClient().session.command(params);
  if (result.error) {
    throw new Error(`Command failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Abort an active session turn.
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<void>}
 */
export async function abort(sessionId, directory) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/interrupt`;
    await fetch(url, {
      method: 'POST',
      headers: getAuthHeader(),
    }).catch(() => {});
    return;
  }

  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  const result = await getClient().session.abort(params);
  if (result.error) {
    throw new Error(`Abort failed: ${JSON.stringify(result.error)}`);
  }
}

// ── Session share / revert / fork ─────────────────────────────────────────

/**
 * Summarize a session to reduce context size (opencode `/compact` semantics).
 *
 * 服务端 summarize 端点要求请求体 `{ providerID, modelID }`（缺省时返回
 * BadRequest "Expected object, got undefined"），因此这里必须先解析出会话
 * 实际使用的模型（见 resolveSummarizeModel）。
 *
 * @param {string} sessionId
 * @param {string} [directory]
 * @param {string} [model] host UI 选择的模型（"provider/model"，缺省表示用 opencode 默认）
 * @returns {Promise<void>}
 */
export async function summarizeSession(sessionId, directory, model) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/compact`;
    const waitPromise = registerPendingCompaction(sessionId, 60000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch (err) {
      resolvePendingCompaction(sessionId, false, err?.message || String(err));
      throw err;
    }
    if (!res.ok) {
      const errText = await res.text();
      resolvePendingCompaction(sessionId, false, `HTTP ${res.status}: ${errText}`);
      throw new Error(`Summarize failed: HTTP ${res.status} ${errText}`);
    }
    await waitPromise;
    return;
  }

  const resolved = await resolveSummarizeModel(model, sessionId, directory);
  console.error(`[summarize] model resolved: ${resolved ? `${resolved.providerID}/${resolved.modelID}` : 'FAILED (null)'}`);
  if (!resolved) {
    throw new Error('Summarize failed: cannot resolve model for session');
  }
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  // v2 flat 参数格式：providerID/modelID 由 SDK 归入请求体 body。
  params.providerID = resolved.providerID;
  params.modelID = resolved.modelID;
  console.error(`[summarize] POST /session/${sessionId}/summarize — waiting for LLM completion...`);
  const startedAt = Date.now();
  const result = await getClient().session.summarize(params);
  console.error(`[summarize] HTTP returned after ${Date.now() - startedAt}ms, error=${result.error ? JSON.stringify(result.error) : 'none'}`);
  if (result.error) {
    throw new Error(`Summarize failed: ${JSON.stringify(result.error)}`);
  }
}

/**
 * Resolve the model to summarize with, in priority order:
 *   1. host UI 选择（"provider/model" 字符串）；
 *   2. 会话运行时记录的模型（opencode 权威来源，session.model = { providerID, id }）；
 *   3. 最后一条 assistant 消息实际使用的模型。
 * 全部缺失（理论上仅空会话）时返回 null，由调用方报错。
 *
 * @param {string|undefined} model
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<{ providerID: string, modelID: string } | null>}
 */
async function resolveSummarizeModel(model, sessionId, directory) {
  if (typeof model === 'string') {
    const trimmed = model.trim();
    if (trimmed) {
      const slash = trimmed.indexOf('/');
      if (slash > 0 && slash < trimmed.length - 1) {
        return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
      }
    }
  }

  const session = await getSession(sessionId, directory);
  const sessionProviderID = typeof session?.model?.providerID === 'string' ? session.model.providerID.trim() : '';
  const sessionModelID = typeof session?.model?.id === 'string' ? session.model.id.trim() : '';
  if (sessionProviderID && sessionModelID) {
    return { providerID: sessionProviderID, modelID: sessionModelID };
  }

  // 兜底来源：拿不到就是「没有可参考的模型」，由调用方报错，不该因此中断 summarize。
  const messages = await listMessages(sessionId, directory, { tolerateError: true });
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (
      info?.role === 'assistant'
      && typeof info.providerID === 'string' && info.providerID
      && typeof info.modelID === 'string' && info.modelID
    ) {
      return { providerID: info.providerID, modelID: info.modelID };
    }
  }
  return null;
}

/**
 * Create a shareable link for a session.
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<object | null>} `{ url, ... }` on success
 */
export async function shareSession(sessionId, directory) {
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  console.error(`[DEBUG][ShareSession] request sessionID=${sessionId} directory=${directory ?? '-'}`);
  const result = await getClient().session.share(params);
  console.error(`[DEBUG][ShareSession] result.error=${JSON.stringify(result.error ?? null)} data=${JSON.stringify(result.data ?? null)}`);
  if (result.error) {
    throw new Error(`Share failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Remove the shareable link for a session.
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<void>}
 */
export async function unshareSession(sessionId, directory) {
  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  const result = await getClient().session.unshare(params);
  if (result.error) {
    throw new Error(`Unshare failed: ${JSON.stringify(result.error)}`);
  }
}

/**
 * Revert the session to the state before a given message.
 * @param {string} sessionId
 * @param {string} messageID
 * @param {string} [directory]
 * @returns {Promise<object | null>} updated session
 */
export async function revertSession(sessionId, messageID, directory) {
  if (engineRegistry.isV2()) {
    const headers = { ...getAuthHeader(), 'Content-Type': 'application/json' };
    if (directory) {
      headers['x-opencode-directory'] = encodeURIComponent(directory);
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const stageUrl = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/revert/stage${query}`;
    let res = await fetch(stageUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(messageID ? { messageID } : {}),
    });
    if (!res.ok && res.status === 404) {
      const fallbackUrl = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/revert${query}`;
      res = await fetch(fallbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(messageID ? { messageID } : {}),
      });
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Revert failed: HTTP ${res.status}${errText ? ` - ${errText}` : ''}`);
    }
    const json = await res.json().catch(() => ({}));
    return json?.data || json;
  }

  const params = { sessionID: sessionId, messageID };
  if (directory) params.directory = directory;
  console.error(`[DEBUG][RevertSession] request sessionID=${sessionId} messageID=${messageID}`);
  const result = await getClient().session.revert(params);
  console.error(`[DEBUG][RevertSession] result.error=${JSON.stringify(result.error ?? null)}`);
  if (result.error) {
    throw new Error(`Revert failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Restore all previously reverted messages in a session.
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {Promise<object | null>} updated session
 */
export async function unrevertSession(sessionId, directory) {
  if (engineRegistry.isV2()) {
    const headers = { ...getAuthHeader(), 'Content-Type': 'application/json' };
    if (directory) {
      headers['x-opencode-directory'] = encodeURIComponent(directory);
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    // Primary: OpenCode v2 REST endpoint is DELETE /api/session/{id}/revert
    const deleteUrl = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/revert${query}`;
    let res = await fetch(deleteUrl, {
      method: 'DELETE',
      headers,
    });
    // Fallback: in case an older or alternate v2 build uses POST /revert/clear or /unrevert
    if (!res.ok && res.status === 404) {
      const clearUrl = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/revert/clear${query}`;
      res = await fetch(clearUrl, {
        method: 'POST',
        headers,
      });
    }
    if (!res.ok && res.status === 404) {
      const fallbackUrl = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/unrevert${query}`;
      res = await fetch(fallbackUrl, {
        method: 'POST',
        headers,
      });
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Unrevert failed: HTTP ${res.status}${errText ? ` - ${errText}` : ''}`);
    }
    const text = await res.text().catch(() => '');
    try {
      const json = JSON.parse(text);
      return json?.data || json;
    } catch {
      return { success: true };
    }
  }

  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  console.error(`[DEBUG][UnrevertSession] request sessionID=${sessionId}`);
  const result = await getClient().session.unrevert(params);
  console.error(`[DEBUG][UnrevertSession] result.error=${JSON.stringify(result.error ?? null)}`);
  if (result.error) {
    throw new Error(`Unrevert failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * Fork a session at an optional message point. Returns the new session.
 * @param {string} sessionId
 * @param {string} [messageID]
 * @param {string} [directory]
 * @returns {Promise<object | null>} the forked session (with `id`)
 */
export async function forkSession(sessionId, messageID, directory) {
  if (engineRegistry.isV2()) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/fork`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(messageID ? { messageID } : {}),
    });
    if (!res.ok) {
      throw new Error(`Fork failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    return json.data || json;
  }

  const params = { sessionID: sessionId };
  if (messageID) params.messageID = messageID;
  if (directory) params.directory = directory;
  console.error(`[DEBUG][ForkSession] request sessionID=${sessionId} messageID=${messageID ?? '-'}`);
  const result = await getClient().session.fork(params);
  console.error(`[DEBUG][ForkSession] result.error=${JSON.stringify(result.error ?? null)} data.id=${result.data?.id ?? '-'}`);
  if (result.error) {
    throw new Error(`Fork failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

// ── SSE Events (real-time streaming) ──────────────────────────────────────

/**
 * Subscribe to the opencode SSE event stream.
 * Returns an async iterable of parsed events. Pass `signal` to close it.
 *
 * @param {string} [directory]
 * @param {AbortSignal} [signal]
 * @returns {Promise<AsyncIterable<object>>}
 */
export async function subscribeEvents(directory, signal) {
  if (engineRegistry.isV2()) {
    const baseUrl = getEffectiveBaseUrl();
    const pwd = serveManager.getServerPassword();
    return subscribeEventsV2(baseUrl, pwd, directory, signal);
  }

  const params = {};
  if (directory) params.directory = directory;
  const options = {};
  if (signal) options.signal = signal;
  const { stream } = await getClient().event.subscribe(params, options);
  return stream;
}

// ── Config ────────────────────────────────────────────────────────────────

/**
 * @param {string} [directory]
 * @returns {Promise<object[]>} provider list, each with `.models` keyed by model id
 */
export async function getProviders(directory) {
  if (engineRegistry.isV2()) {
    try {
      const baseUrl = getEffectiveBaseUrl();
      const [provRes, modRes] = await Promise.all([
        fetch(`${baseUrl}/api/provider`, { headers: getAuthHeader() }),
        fetch(`${baseUrl}/api/model`, { headers: getAuthHeader() }),
      ]);
      const provJson = provRes.ok ? await provRes.json() : {};
      const modJson = modRes.ok ? await modRes.json() : {};
      const provList = Array.isArray(provJson.data) ? provJson.data : (Array.isArray(provJson) ? provJson : []);
      const modList = Array.isArray(modJson.data) ? modJson.data : (Array.isArray(modJson) ? modJson : []);

      const providersMap = new Map();
      for (const p of provList) {
        if (p?.id) {
          providersMap.set(p.id, {
            id: p.id,
            name: p.name || p.id,
            models: {},
            options: p.options || {},
            _isPublicKey: p.options?.apiKey === 'public',
          });
        }
      }

      for (const m of modList) {
        const provId = m.providerID || 'opencode';
        if (!providersMap.has(provId)) {
          providersMap.set(provId, {
            id: provId,
            name: provId,
            models: {},
            _isPublicKey: m.settings?.apiKey === 'public',
          });
        }
        const providerObj = providersMap.get(provId);
        const mId = m.modelID || m.id;
        const variantsMap = {};
        if (Array.isArray(m.variants)) {
          for (const v of m.variants) {
            if (v && v.id) variantsMap[v.id] = v.settings || {};
          }
        }
        providerObj.models[mId] = {
          id: mId,
          name: m.name || mId,
          variants: variantsMap,
          ...(m.limit ? { limit: m.limit } : {}),
        };
      }

      return Array.from(providersMap.values());
    } catch (e) {
      console.error('[getProviders:v2] failed:', e);
      return [];
    }
  }

  const params = {};
  if (directory) params.directory = directory;
  const result = await getClient().config.providers(params);
  if (result.error) return [];
  const data = result.data;
  const providers = data?.providers ?? [];
  // Attach default-model map (per provider) for convenience.
  const defaults = data?.defaults ?? data?.default;
  for (const p of providers) {
    if (defaults) p._defaults = defaults;
    const opts = p?.options;
    p._isPublicKey = opts?.apiKey === 'public';
  }
  return providers;
}

/**
 * @param {string} [directory]
 * @returns {Promise<object[]>} agent list
 */
export async function getAgents(directory) {
  if (engineRegistry.isV2()) {
    try {
      const url = `${getEffectiveBaseUrl()}/api/agent`;
      const res = await fetch(url, { headers: getAuthHeader() });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
    } catch {
      return [];
    }
  }

  const params = {};
  if (directory) params.directory = directory;
  const result = await getClient().app.agents(params);
  if (result.error) return [];
  return result.data ?? [];
}

/**
 * @param {string} [directory]
 * @returns {Promise<object[]>} command list
 */
export async function getCommands(directory) {
  if (engineRegistry.isV2()) {
    try {
      const url = `${getEffectiveBaseUrl()}/api/command`;
      const res = await fetch(url, { headers: getAuthHeader() });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
    } catch {
      return [];
    }
  }

  try {
    const params = {};
    if (directory) params.directory = directory;
    const result = await getClient().command.list(params);
    if (result.error) return [];
    return result.data ?? [];
  } catch {
    return [];
  }
}

// ── Permissions & Questions ───────────────────────────────────────────────

/**
 * Reply to a pending v2 permission request. The generated v2 client maps flat
 * params via path/body spec keys: `requestID` lives in the path, `reply` in the
 * body (PermissionV2Reply = "once" | "always" | "reject").
 *
 * @param {string} sessionId
 * @param {string} permissionID - the request id from `permission.*.asked` `data.id`
 * @param {'once' | 'always' | 'reject'} reply
 * @param {string} [message]
 * @returns {Promise<void>}
 */
export async function replyPermission(sessionId, permissionID, reply, message, directory) {
  if (engineRegistry.isV2() && sessionId) {
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionID)}/reply`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: reply, message: message || null }),
    });
    if (!res.ok) {
      throw new Error(`replyPermission failed (${permissionID}): HTTP ${res.status}`);
    }
    console.error('[DEBUG][OpenCodeDaemon:v2] permission replied ok:', permissionID, '→', reply);
    return;
  }

  const client = getClient();
  const params = { requestID: permissionID, reply };
  if (message) params.message = message;
  if (directory) params.directory = directory;
  const result = await client.permission.reply(params);
  if (result.error) {
    throw new Error(`replyPermission failed (${permissionID}): ${summarizeError(result.error)}`);
  }
  console.error('[DEBUG][OpenCodeDaemon] permission replied ok:', permissionID, '→', reply);
}

/**
 * Reply to a pending question request. `answers` is an ordered array (one
 * element per `data.questions` entry) of selected label arrays
 * (QuestionAnswer = string[]), or a key-value object for v2 forms.
 *
 * @param {string} sessionId
 * @param {string} questionID - the request id from `question.*.asked` / `form.*.asked`
 * @param {string[][] | object} answers
 * @param {string} [directory] - project directory for server-side scoping
 * @returns {Promise<void>}
 */
export async function replyQuestion(sessionId, questionID, answers, directory) {
  const effectiveBaseUrl = getEffectiveBaseUrl();

  // 1. Direct Form API for v2 (OpenCode 2.0.27+ OpenAPI: session.form.reply)
  if (engineRegistry.isV2() && sessionId) {
    let targetForm = null;
    let formID = questionID;
    if (!questionID.startsWith('frm_')) {
      try {
        const formListUrl = `${effectiveBaseUrl}/api/session/${encodeURIComponent(sessionId)}/form`;
        const listRes = await fetch(formListUrl, { headers: getAuthHeader() });
        if (listRes.ok) {
          const formsJson = await listRes.json();
          const forms = Array.isArray(formsJson.items)
            ? formsJson.items
            : (Array.isArray(formsJson.data) ? formsJson.data : (Array.isArray(formsJson) ? formsJson : []));
          targetForm = forms.find(f =>
            f.id === questionID ||
            f.metadata?.tool?.id === questionID ||
            f.metadata?.tool?.callID === questionID ||
            f.metadata?.callID === questionID
          );
          if (targetForm?.id) {
            formID = targetForm.id;
          }
        }
      } catch (err) {
        console.warn(`[sdk:v2] list forms failed:`, err?.message || err);
      }
    }

    let answerObj = {};
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
      if (targetForm && Array.isArray(targetForm.fields)) {
        targetForm.fields.forEach((field, idx) => {
          const val = answers[field.key] ?? answers[field.label] ?? answers[field.title] ?? answers[field.name] ?? answers[String(idx)];
          if (val !== undefined) {
            answerObj[field.key] = Array.isArray(val) && !field.multiple && !field.multiSelect && val.length === 1 ? val[0] : val;
          }
        });
      }
      for (const [k, v] of Object.entries(answers)) {
        if (answerObj[k] === undefined) {
          answerObj[k] = v;
        }
      }
    } else if (Array.isArray(answers)) {
      answers.forEach((val, idx) => {
        let fieldKey = `q${idx}`;
        let isMulti = false;
        if (targetForm && Array.isArray(targetForm.fields) && targetForm.fields[idx]) {
          const f = targetForm.fields[idx];
          fieldKey = f.key || `q${idx}`;
          isMulti = f.type === 'multiselect' || Boolean(f.multiple || f.multiSelect);
        }
        const unwrapped = Array.isArray(val) && !isMulti && val.length === 1 ? val[0] : val;
        answerObj[fieldKey] = unwrapped;
      });
    }

    try {
      const formReplyUrl = `${effectiveBaseUrl}/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formID)}/reply`;
      console.log(`[sdk:v2] session.form.reply url=${formReplyUrl} body=`, JSON.stringify({ answer: answerObj }));
      const formRes = await fetch(formReplyUrl, {
        method: 'POST',
        headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: answerObj }),
      });
      if (formRes.ok) {
        console.error('[DEBUG][OpenCodeDaemon:v2] question form replied ok:', formID);
        return;
      }
      const errText = await formRes.text();
      console.warn(`[sdk:v2] form reply endpoint returned HTTP ${formRes.status}: ${errText}`);
    } catch (err) {
      console.warn(`[sdk:v2] form reply fetch failed:`, err?.message || err);
    }
  }

  const client = getClient();
  const formattedAnswers = Array.isArray(answers) ? answers : [];

  // 2. Try standard SDK session-scoped method (compatible with both v1 and v2)
  if (sessionId && client.session?.question?.reply) {
    try {
      console.log(`[sdk] session.question.reply sessionID=${sessionId} requestID=${questionID}`);
      const result = await client.session.question.reply({
        sessionID: sessionId,
        requestID: questionID,
        questionV2Reply: { answers: formattedAnswers },
        directory,
      });
      console.log(`[sdk] session.question.reply result=${JSON.stringify(result).substring(0, 500)}`);
      if (!result.error) {
        console.log(`[sdk] replyQuestion OK (session scope) questionID=${questionID}`);
        return;
      }
      console.warn(`[sdk] session.question.reply returned error, trying legacy fallback: ${summarizeError(result.error)}`);
    } catch (err) {
      console.warn(`[sdk] session.question.reply exception, trying legacy fallback:`, err?.message || err);
    }
  }

  // 3. Legacy SDK fallback (v1)
  const params = {
    requestID: questionID,
    answers: formattedAnswers,
  };
  if (directory) params.directory = directory;
  console.log(`[sdk] legacy replyQuestion params=${JSON.stringify({ requestID: questionID, directory })}`);
  const result = await client.question.reply(params);
  console.log(`[sdk] legacy replyQuestion result=${JSON.stringify(result).substring(0, 500)}`);
  if (result.error) {
    throw new Error(`replyQuestion failed (${questionID}): ${summarizeError(result.error)}`);
  }
  console.log(`[sdk] replyQuestion OK (legacy scope) questionID=${questionID}`);
}

/**
 * @param {string} sessionId
 * @param {string} questionID
 * @param {string} [directory]
 * @returns {Promise<void>}
 */
export async function rejectQuestion(sessionId, questionID, directory) {
  const effectiveBaseUrl = getEffectiveBaseUrl();

  // 1. Direct Form API for v2 (OpenCode 2.0.27+ OpenAPI: session.form.cancel)
  if (engineRegistry.isV2() && sessionId) {
    let formID = questionID;
    if (!questionID.startsWith('frm_')) {
      try {
        const formListUrl = `${effectiveBaseUrl}/api/session/${encodeURIComponent(sessionId)}/form`;
        const listRes = await fetch(formListUrl, { headers: getAuthHeader() });
        if (listRes.ok) {
          const formsJson = await listRes.json();
          const forms = Array.isArray(formsJson.items)
            ? formsJson.items
            : (Array.isArray(formsJson.data) ? formsJson.data : (Array.isArray(formsJson) ? formsJson : []));
          const targetForm = forms.find(f =>
            f.id === questionID ||
            f.metadata?.tool?.id === questionID ||
            f.metadata?.tool?.callID === questionID ||
            f.metadata?.callID === questionID
          );
          if (targetForm?.id) {
            formID = targetForm.id;
          }
        }
      } catch (err) {
        console.warn(`[sdk:v2] list forms failed:`, err?.message || err);
      }
    }

    try {
      const rejectUrl = `${effectiveBaseUrl}/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formID)}`;
      const res = await fetch(rejectUrl, {
        method: 'DELETE',
        headers: getAuthHeader(),
      });
      if (res.ok || res.status === 404) {
        console.error('[DEBUG][OpenCodeDaemon:v2] question form rejected ok:', formID);
        return;
      }
      console.warn(`[sdk:v2] form cancel endpoint returned HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      console.warn(`[sdk:v2] form cancel fetch failed:`, err?.message || err);
    }
  }

  const client = getClient();
  if (sessionId && client.session?.question?.reject) {
    try {
      console.log(`[sdk] session.question.reject sessionID=${sessionId} requestID=${questionID}`);
      const result = await client.session.question.reject({
        sessionID: sessionId,
        requestID: questionID,
        directory,
      });
      if (!result.error) {
        console.error('[DEBUG][OpenCodeDaemon] question rejected ok (session scope):', questionID);
        return;
      }
      console.warn(`[sdk] session.question.reject returned error, falling back to legacy: ${summarizeError(result.error)}`);
    } catch (err) {
      console.warn(`[sdk] session.question.reject exception:`, err?.message || err);
    }
  }

  const params = { requestID: questionID };
  if (directory) params.directory = directory;
  const result = await client.question.reject(params);
  if (result.error) {
    throw new Error(`rejectQuestion failed (${questionID}): ${summarizeError(result.error)}`);
  }
  console.error('[DEBUG][OpenCodeDaemon] question rejected ok (legacy scope):', questionID);
}

/**
 * Compact, log-safe summary of a HeyApi/HTTP error object for error messages.
 * @param {unknown} error
 * @returns {string}
 */
function summarizeError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  const err = error;
  const status = err.status ?? err.response?.status;
  const body = err.detail ?? err.body ?? err.message ?? err.error;
  let bodyText = '';
  if (body != null) {
    try { bodyText = typeof body === 'string' ? body : JSON.stringify(body); } catch { bodyText = String(body); }
  }
  return `${status ? `HTTP ${status}` : 'error'}${bodyText ? `: ${String(bodyText).slice(0, 300)}` : ''}`;
}

// ── Messages ──────────────────────────────────────────────────────────────

/**
 * List a session's messages.
 *
 * 失败必须**可见**：过去这里 `if (result.error) return []`，把「查询失败」和
 * 「这个会话确实没有消息」压成同一个结果。宿主因此无法区分两者，只能把
 * 冷启动/服务端未就绪时的失败当成空会话展示（打开标签页得到一片空白，
 * 且没有任何错误提示）。现在默认抛出，由调用方决定是重试还是容忍。
 *
 * @param {string} sessionId
 * @param {string} [directory]
 * @param {{ tolerateError?: boolean }} [options] 容忍失败时返回 `[]`（供
 *   「拿不到就退回默认值」的调用方使用，例如 summarize 的模型兜底、
 *   回合结束时的最终消息抓取、上下文用量估算）。
 * @returns {Promise<object[]>} message entries `{ info, parts }`
 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Normalize the provider error shapes emitted by v1 and v2 into one contract.
 *
 * v1: { name: 'APIError', data: { message, statusCode, isRetryable } }
 * v2: { type: 'provider.quota', message, status, ... }
 *
 * The host must never have to know which engine produced the message.
 *
 * @param {unknown} error
 * @param {string} [finish]
 * @returns {{ kind: string, message: string, status: number|null, retryable: boolean|null }|null}
 */
export function normalizeProviderError(error, finish) {
  if (error == null) {
    return finish === 'error'
      ? { kind: 'unknown', message: 'Request ended with error', status: null, retryable: null }
      : null;
  }
  if (typeof error === 'string') {
    return { kind: 'unknown', message: error, status: null, retryable: null };
  }
  if (typeof error !== 'object') {
    return { kind: 'unknown', message: String(error), status: null, retryable: null };
  }

  const type = typeof error.type === 'string' ? error.type : '';
  const name = typeof error.name === 'string' ? error.name : '';
  const kind = typeof error.kind === 'string' ? error.kind : '';
  const message = typeof error.message === 'string' ? error.message : '';
  if (message) {
    return {
      kind: type || name || kind || 'unknown',
      message,
      status: numberOrNull(error.status ?? error.statusCode),
      retryable: booleanOrNull(error.retryable ?? error.isRetryable),
    };
  }

  const data = error.data && typeof error.data === 'object' ? error.data : null;
  if (data) {
    const nestedMessage = typeof data.message === 'string' ? data.message
      : typeof data.type === 'string' ? data.type
      : '';
    if (nestedMessage) {
      return {
        kind: type || name || 'unknown',
        message: nestedMessage,
        status: numberOrNull(data.statusCode ?? data.status),
        retryable: booleanOrNull(data.isRetryable ?? data.retryable),
      };
    }
  }

  return {
    kind: type || name || 'unknown',
    message: name || type || 'Request ended with error',
    status: null,
    retryable: null,
  };
}

/**
 * Normalize one engine message entry into the host contract:
 * `{ info, parts }` with a flat, version-independent `info.error`.
 *
 * v1 returns `{ info, parts }` and may put the error under
 * `info.error.data.message`; v2 returns flattened messages and puts it under
 * `error.message`. Both are reduced here. A terminal error that produced no
 * text part also gets a synthetic error part so the host transcript always has
 * something to render.
 *
 * @param {{ info?: object, parts?: object[], error?: unknown, finish?: string }} entry
 * @param {string} sessionId
 * @returns {{ info: object, parts: object[] }}
 */
export function normalizeMessageEntry(entry, sessionId) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const info = source.info && typeof source.info === 'object' ? { ...source.info } : {};
  const parts = Array.isArray(source.parts) ? [...source.parts] : [];

  if (!info.sessionID) info.sessionID = sessionId;
  if (info.error == null && source.error != null) info.error = source.error;
  if (info.finish == null && source.finish != null) info.finish = source.finish;

  const error = normalizeProviderError(info.error, info.finish);
  if (error) {
    info.error = error;
    if (info.finish == null) info.finish = 'error';
    const aborted = error.kind === 'MessageAbortedError'
      || error.kind === 'aborted'
      || /interrupt|abort/i.test(error.message || '')
      || info.finish === 'interrupted';
    if (aborted) info.aborted = true;
    if (info.role === 'assistant' && !parts.some((part) => part && part.type === 'text')) {
      parts.push(aborted
        ? { type: 'text', text: ABORTED_NOTICE, aborted: true }
        : { type: 'text', text: `[Error: ${error.message}]`, isError: true });
    }
  }

  return { info, parts };
}

export async function listMessages(sessionId, directory, options = {}) {
  if (engineRegistry.isV2()) {
    // OpenCode REST API routing:
    // The message list lives at /api/session/{id}/message. The bare
    // /session/{id}/message form is NOT a server route: it falls through to the
    // web UI's SPA handler and answers 200 + text/html, which then blows up as
    // `Unexpected token '<'` — a JSON parse error that says nothing about the
    // real problem (a wrong route). Verified against the server's own
    // /openapi.json route table.
    const url = `${getEffectiveBaseUrl()}/api/session/${encodeURIComponent(sessionId)}/message`
      + (options.limit && Number(options.limit) > 0 ? `?limit=${Number(options.limit)}` : '');
    let res;
    try {
      res = await fetch(url, { headers: getAuthHeader() });
    } catch (err) {
      if (options.tolerateError) return [];
      throw new Error(`Failed to list messages for session ${sessionId}: ${err?.message || err}`);
    }
    if (!res.ok) {
      if (options.tolerateError) return [];
      throw new Error(`Failed to list messages for session ${sessionId}: HTTP ${res.status}`);
    }
    // Guard the route, not the payload: an HTML body here always means the SPA
    // fallback answered, i.e. the engine's route table does not have this path.
    // Reporting that explicitly is far more actionable than letting res.json()
    // fail with a syntax error.
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (options.tolerateError) return [];
      throw new Error(
        `Failed to list messages for session ${sessionId}: ${url} returned `
        + `${contentType.split(';')[0] || 'no content-type'} instead of JSON `
        + `(the route does not exist on this engine build)`,
      );
    }
    // The body has to be read *here*: the route/`content-type` guard above only
    // proves the endpoint exists, not that we ever parsed what it returned.
    let json;
    try {
      json = await res.json();
    } catch (err) {
      if (options.tolerateError) return [];
      throw new Error(
        `Failed to list messages for session ${sessionId}: ${url} returned `
        + `unparseable JSON (${err?.message || err})`,
      );
    }
    let list = Array.isArray(json.items)
      ? json.items
      : (Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []));

    // OpenCode v2 returns messages in reverse chronological order (newest first).
    // Sort ascending by numerical timestamp to guarantee chronological order (oldest first),
    // matching v1 behavior so that user prompts precede assistant responses.
    const extractTimeMs = (m) => {
      if (!m || typeof m !== 'object') return 0;
      const raw = m.time?.created ?? m.time?.start ?? m.time ?? m.timestamp ?? m.createdAt
        ?? m.info?.time?.created ?? m.info?.time?.start ?? m.info?.time ?? m.info?.timestamp ?? 0;
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return 0;
    };

    const sortedList = [...list].sort((a, b) => {
      const diff = extractTimeMs(a) - extractTimeMs(b);
      return Number.isFinite(diff) ? diff : 0;
    });

    // Convert/normalize v2 messages to standard { info, parts } entries for host compatibility
    const entries = [];
    for (const m of sortedList) {
      if (!m || typeof m !== 'object') continue;

      // Case A: Server already returned standard { info, parts } format
      if (m.info && typeof m.info === 'object' && Array.isArray(m.parts)) {
        if (m.info.role === 'compaction') {
          m.info.isCompactSummary = true;
          if (!m.info.compactMetadata) {
            const summaryPart = m.parts.find(p => p.type === 'text');
            m.info.compactMetadata = {
              trigger: 'manual',
              userContext: summaryPart?.text || '',
            };
          }
        }
        entries.push(normalizeMessageEntry({
          info: {
            ...m.info,
            sessionID: m.info.sessionID || sessionId,
          },
          parts: m.parts,
        }, sessionId));
        continue;
      }

      // Case B: Flattened format { type, text, content, ... }
      if (m.type === 'idle') continue;

      if (m.type === 'compaction') {
        const summary = m.summary || m.content || m.text || '';
        const summaryText = typeof summary === 'string' ? summary : (summary?.text || JSON.stringify(summary));
        const info = {
          id: m.id || `compact_${Date.now()}`,
          role: 'compaction',
          time: m.time || {},
          isCompactSummary: true,
          compactMetadata: {
            trigger: m.reason || 'manual',
            userContext: summaryText,
            ...(m.metadata && typeof m.metadata === 'object' ? m.metadata : {}),
          },
          sessionID: sessionId,
        };
        const parts = [{ type: 'text', text: summaryText }];
        entries.push(normalizeMessageEntry({ info, parts }, sessionId));
        continue;
      }

      const role = m.type === 'user' ? 'user' : (m.type === 'assistant' ? 'assistant' : m.type);
      const modelStr = m.model ? (m.model.providerID && m.model.id ? `${m.model.providerID}/${m.model.id}` : m.model.id) : undefined;
      const info = {
        id: m.id,
        role,
        time: m.time || {},
        model: modelStr,
        tokens: m.tokens,
        cost: m.cost,
        providerID: m.model?.providerID,
        modelID: m.model?.id,
        sessionID: sessionId,
        // Kept so callers can distinguish a settled turn from a still-running
        // one without guessing from the message list (subagent history needs
        // this to stop polling).
        finish: m.finish,
        error: m.error,
      };

      const parts = [];
      if (role === 'user') {
        if (typeof m.text === 'string' && m.text) {
          parts.push({ type: 'text', text: m.text });
        } else if (m.payload && typeof m.payload.text === 'string') {
          parts.push({ type: 'text', text: m.payload.text });
        } else if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === 'text') parts.push({ type: 'text', text: c.text });
            else if (c.type === 'file') parts.push({ type: 'file', ...c });
          }
        }
      } else if (role === 'assistant') {
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (!c || typeof c !== 'object') continue;
            if (c.type === 'reasoning') {
              parts.push({ type: 'reasoning', text: c.text || '' });
            } else if (c.type === 'text') {
              parts.push({ type: 'text', text: c.text || '' });
            } else if (c.type === 'tool' || c.type === 'tool_use') {
              parts.push({
                type: 'tool',
                id: c.id,
                callID: c.id || c.callID,
                tool: c.tool || c.name,
                state: {
                  status: c.state?.status || 'completed',
                  input: c.input || c.state?.input || {},
                  output: (typeof c.output === 'string' && c.output)
                    || flattenToolContent(c.state?.output)
                    || flattenToolContent(c.state?.content)
                    || '',
                  error: c.error || c.state?.error,
                  metadata: c.metadata || c.state?.metadata,
                },
              });
            }
          }
        }
      }
      entries.push(normalizeMessageEntry({ info, parts }, sessionId));
    }
    return entries;
  }

  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  if (options.limit && Number(options.limit) > 0) params.limit = Number(options.limit);
  const result = await getClient().session.messages(params);
  if (result.error) {
    if (options.tolerateError) return [];
    throw new Error(`Failed to list messages for session ${sessionId}: ${summarizeError(result.error)}`);
  }
  const entries = Array.isArray(result.data) ? result.data : [];
  return entries.map((entry) => normalizeMessageEntry(entry, sessionId));
}

// ── Filesystem ───────────────────────────────────────────────────────────

/**
 * Find ranked filesystem entries via the server `fs.find` endpoint —— 与
 * opencode TUI @-mention 列表同源（服务端 fff 引擎已完成 frecency + 模糊
 * 排序，调用方直接信任顺序）。
 *
 * @param {object} [options]
 * @param {string} [options.query] search text (empty → default ranked set)
 * @param {string} [options.limit] e.g. "20"
 * @param {string} [options.directory] base directory for relative paths
 * @returns {Promise<Array<{ path: string, type: 'file' | 'directory' }>>}
 */
export async function findFiles({ query = '', limit = '20', directory } = {}) {
  if (engineRegistry.isV2()) {
    try {
      const numLimit = typeof limit === 'number' ? limit : (typeof limit === 'string' ? parseInt(limit, 10) || 20 : 20);
      const url = `${getEffectiveBaseUrl()}/api/fs/find?query=${encodeURIComponent(query || '')}&limit=${numLimit}`;
      const res = await fetch(url, { headers: getAuthHeader() });
      if (!res.ok) return [];
      const json = await res.json();
      const list = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
      return list.map((item) => {
        if (typeof item === 'string') return { path: item, type: 'file' };
        if (item && typeof item === 'object') return { path: item.path || item.name || '', type: item.type || 'file' };
        return { path: String(item), type: 'file' };
      }).filter((e) => Boolean(e.path));
    } catch (err) {
      console.error(`[findFiles:v2] error:`, err);
      return [];
    }
  }

  try {
    const numLimit = typeof limit === 'number' ? limit : (typeof limit === 'string' ? parseInt(limit, 10) || 20 : 20);
    const result = await getClient().find.files({
      query: typeof query === 'string' ? query : '',
      limit: numLimit,
      directory: directory || undefined,
    });
    if (result.error || !result.data) return [];
    const list = Array.isArray(result.data) ? result.data : (result.data?.data || []);
    return list.map((item) => {
      if (typeof item === 'string') {
        return { path: item, type: 'file' };
      }
      if (item && typeof item === 'object') {
        return { path: item.path || item.name || '', type: item.type || 'file' };
      }
      return { path: String(item), type: 'file' };
    }).filter((e) => Boolean(e.path));
  } catch (err) {
    console.error(`[findFiles] error:`, err);
    return [];
  }
}

// ── MCP ──────────────────────────────────────────────────────────────────

/**
 * Enumerate MCP server connection status via `mcp.status`.
 * @param {string} [directory]
 * @returns {Promise<Array<{ name: string, status?: string, error?: string }>>}
 */
export async function getMcpStatus(directory) {
  if (engineRegistry.isV2()) {
    try {
      const url = `${getEffectiveBaseUrl()}/api/mcp`;
      const res = await fetch(url, { headers: getAuthHeader() });
      if (!res.ok) return [];
      const json = await res.json();
      const list = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
      return list.map((item) => ({
        name: typeof item === 'string' ? item : (item.name || item.id || 'mcp'),
        status: item.status || 'connected',
        error: item.error,
      }));
    } catch {
      return [];
    }
  }

  try {
    const params = {};
    if (directory) params.directory = directory;
    const result = await getClient().mcp.status(params);
    if (result.error) return [];
    const map = result.data ?? {};
    if (!map || typeof map !== 'object') return [];
    return Object.entries(map).map(([name, status]) => {
      const info = status && typeof status === 'object' ? status : {};
      return {
        name,
        status: typeof info.status === 'string' ? info.status : 'unknown',
        error: typeof info.error === 'string' ? info.error : undefined,
      };
    });
  } catch {
    return [];
  }
}
