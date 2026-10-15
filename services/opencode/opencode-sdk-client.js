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
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import * as serveManager from './opencode-serve-manager.js';

let _client = null;
let _baseUrl = null;

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
export function getClient(baseUrl = 'http://localhost:4096') {
  if (!_client || _baseUrl !== baseUrl) {
    _baseUrl = baseUrl;
    _client = createOpencodeClient({
      baseUrl,
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
    if (serveManager.isV2()) {
      const url = `${_baseUrl || 'http://localhost:4096'}/api/info`;
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
export async function createSession(title, directory) {
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session`;
    const body = {};
    if (title) body.title = title;
    if (directory) body.location = { directory };
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
 */
function normalizeDirForMatch(p) {
  if (!p || typeof p !== 'string') return '';
  let normalized = p.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized.replace(/\/+$/, '');
}

/**
 * @param {string} [directory]
 * @param {number|string} [limit]
 * @returns {Promise<object[]>}
 */
export async function listSessions(directory, limit) {
  if (serveManager.isV2()) {
    const query = new URLSearchParams();
    if (limit && Number(limit) > 0) query.set('limit', String(limit));
    const qs = query.toString();
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session${qs ? `?${qs}` : ''}`;
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

    // Align v2 session objects with unified directory property
    const unifiedList = rawList.map(s => {
      if (!s || typeof s !== 'object') return s;
      const dir = s.location?.directory || s.directory;
      return {
        ...s,
        directory: dir || '',
      };
    });

    // Robust directory filtering for Windows (case-insensitive & slash-normalized)
    if (directory && typeof directory === 'string' && directory.trim() && unifiedList.length > 0) {
      const target = normalizeDirForMatch(directory.trim());
      const filtered = unifiedList.filter(s => {
        const sessionDir = s.directory;
        return sessionDir && normalizeDirForMatch(sessionDir) === target;
      });
      // Fallback: if project-specific match has sessions, return them;
      // otherwise return all sessions so history list is never completely empty
      return filtered.length > 0 ? filtered : unifiedList;
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
  return result.data ?? [];
}

/**
 * @param {string} id
 * @param {string} [directory]
 * @returns {Promise<object | null>}
 */
export async function getSession(id, directory) {
  if (serveManager.isV2()) {
    try {
      const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(id)}`;
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
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(id)}`;
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
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(id)}`;
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
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(id)}`;
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

export async function promptAsync(sessionId, text, options = {}) {
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/prompt`;
    const body = {
      text,
    };
    if (options.agent) body.agent = options.agent;
    if (options.model) body.model = options.model;
    if (options.system) body.system = options.system;
    if (options.tools) body.tools = options.tools;

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

  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/shell`;
    const body = { command, agent };
    if (options.model) body.model = options.model;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Shell failed: HTTP ${res.status} ${await res.text()}`);
    }
    return;
  }

  const params = {
    sessionID: sessionId,
    command,
    agent,
  };
  if (options.model) params.model = options.model;
  if (options.directory) params.directory = options.directory;

  console.error('[opencode-sdk-client] shell:', JSON.stringify(params));
  const result = await getClient().session.shell(params);
  if (result.error) {
    throw new Error(`Shell failed: ${JSON.stringify(result.error)}`);
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
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/command`;
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
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/interrupt`;
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
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/compact`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`Summarize failed: HTTP ${res.status} ${await res.text()}`);
    }
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
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/revert`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(messageID ? { messageID } : {}),
    });
    if (!res.ok) {
      throw new Error(`Revert failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    return json.data || json;
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
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/fork`;
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
  if (serveManager.isV2()) {
    const baseUrl = _baseUrl || 'http://localhost:4096';
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
  if (serveManager.isV2()) {
    try {
      const baseUrl = _baseUrl || 'http://localhost:4096';
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
          limit: m.limit || { context: 200000 },
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
  if (serveManager.isV2()) {
    try {
      const url = `${_baseUrl || 'http://localhost:4096'}/api/agent`;
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
  if (serveManager.isV2()) {
    try {
      const url = `${_baseUrl || 'http://localhost:4096'}/api/command`;
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
  if (serveManager.isV2() && sessionId) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionID)}/reply`;
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
  if (serveManager.isV2() && sessionId) {
    let answerObj = {};
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
      answerObj = answers;
    } else {
      // Fetch form info to map array answers onto form field keys
      try {
        const formUrl = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(questionID)}`;
        const formRes = await fetch(formUrl, { headers: getAuthHeader() });
        if (formRes.ok) {
          const formJson = await formRes.json();
          const form = formJson.data || formJson;
          const fields = Array.isArray(form.fields) ? form.fields : [];
          const answersArr = Array.isArray(answers) ? answers : [];
          fields.forEach((field, idx) => {
            const val = answersArr[idx];
            if (val !== undefined) {
              if (field.type === 'multiselect') {
                answerObj[field.key] = Array.isArray(val) ? val : [val];
              } else {
                answerObj[field.key] = Array.isArray(val) ? val[0] : val;
              }
            }
          });
        }
      } catch (err) {
        console.warn(`[sdk:v2] failed to fetch form info for field mapping:`, err?.message || err);
      }
      if (Object.keys(answerObj).length === 0 && Array.isArray(answers)) {
        answers.forEach((val, idx) => {
          answerObj[String(idx)] = Array.isArray(val) ? (val.length === 1 ? val[0] : val) : val;
        });
      }
    }
    const replyUrl = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(questionID)}/reply`;
    const res = await fetch(replyUrl, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: answerObj }),
    });
    if (!res.ok) {
      throw new Error(`replyQuestion failed (${questionID}): HTTP ${res.status} ${await res.text()}`);
    }
    console.error('[DEBUG][OpenCodeDaemon:v2] question form replied ok:', questionID);
    return;
  }

  const client = getClient();
  const formattedAnswers = Array.isArray(answers) ? answers : [];

  if (sessionId && client.session?.question?.reply) {
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
    console.warn(`[sdk] session.question.reply returned error, falling back to legacy: ${summarizeError(result.error)}`);
  }

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
  if (serveManager.isV2() && sessionId) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(questionID)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: getAuthHeader(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`rejectQuestion failed (${questionID}): HTTP ${res.status} ${await res.text()}`);
    }
    console.error('[DEBUG][OpenCodeDaemon:v2] question form rejected ok:', questionID);
    return;
  }

  const client = getClient();
  if (sessionId && client.session?.question?.reject) {
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
export async function listMessages(sessionId, directory, options = {}) {
  if (serveManager.isV2()) {
    const url = `${_baseUrl || 'http://localhost:4096'}/api/session/${encodeURIComponent(sessionId)}/message`;
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
    const json = await res.json();
    const list = Array.isArray(json.items)
      ? json.items
      : (Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []));

    // OpenCode v2 returns messages in reverse chronological order (newest first).
    // Sort ascending by time.created/start to guarantee chronological order (oldest first),
    // matching v1 behavior so that user prompts precede assistant responses.
    const sortedList = [...list].sort((a, b) => {
      const ta = (a?.time && (a.time.created || a.time.start)) || 0;
      const tb = (b?.time && (b.time.created || b.time.start)) || 0;
      if (ta && tb && ta !== tb) return ta - tb;
      return 0;
    });
    if (list.length > 1 && sortedList.every((item, idx) => item === list[idx])) {
      sortedList.reverse();
    }

    // Convert v2 messages to v1 { info, parts } entries for host compatibility
    const entries = [];
    for (const m of sortedList) {
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'idle' || m.type === 'compaction') continue;

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
                  output: c.output || c.state?.output || '',
                  error: c.error || c.state?.error,
                },
              });
            }
          }
        }
        if (m.error || m.finish === 'error') {
          const errText = m.error?.message || (typeof m.error === 'string' ? m.error : (m.finish === 'error' ? 'Request ended with error' : ''));
          if (errText && !parts.some(p => p.type === 'text')) {
            parts.push({ type: 'text', text: `[Error: ${errText}]` });
          }
        }
      }
      entries.push({ info, parts });
    }
    return entries;
  }

  const params = { sessionID: sessionId };
  if (directory) params.directory = directory;
  const result = await getClient().session.messages(params);
  if (result.error) {
    if (options.tolerateError) return [];
    throw new Error(`Failed to list messages for session ${sessionId}: ${summarizeError(result.error)}`);
  }
  return result.data ?? [];
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
  if (serveManager.isV2()) {
    try {
      const numLimit = typeof limit === 'number' ? limit : (typeof limit === 'string' ? parseInt(limit, 10) || 20 : 20);
      const url = `${_baseUrl || 'http://localhost:4096'}/api/fs/find?query=${encodeURIComponent(query || '')}&limit=${numLimit}`;
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
  if (serveManager.isV2()) {
    try {
      const url = `${_baseUrl || 'http://localhost:4096'}/api/mcp`;
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
