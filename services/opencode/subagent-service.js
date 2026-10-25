/**
 * subagent-service.js
 *
 * Canonical subagent history/status for opencode v1 and v2.
 *
 * The parent `subagent`/`task` tool part points at a child session. A launch
 * acknowledgement is not a terminal state: the child can keep running after the
 * parent tool part says `completed`. Status therefore comes from the child's
 * own transcript, never from the parent tool state.
 */

import { listMessages, listSessions } from './opencode-sdk-client.js';

const SUBAGENT_SESSION = /<subagent\b[^>]*\bsessionID\s*=\s*"([^"]+)"/i;
const POLL_TAIL_MESSAGES = 200;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function firstText(...values) {
  for (const value of values) {
    const text = textOf(value).trim();
    if (text) return text;
  }
  return '';
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function findTool(entries, toolUseId) {
  if (!toolUseId) return null;
  for (const entry of asArray(entries)) {
    const parts = asArray(obj(entry)?.parts);
    for (const part of parts) {
      const record = obj(part);
      if (!record) continue;
      const id = firstText(record.id, record.callID, record.callId);
      if (id !== toolUseId) continue;

      const state = obj(record.state) || {};
      const metadata = obj(state.metadata) || {};
      let childSessionId = firstText(metadata.sessionID, metadata.sessionId);
      const output = firstText(state.output, flattenContent(state.content));
      if (!childSessionId && output) {
        const match = SUBAGENT_SESSION.exec(output);
        if (match) childSessionId = match[1];
      }
      return {
        childSessionId: childSessionId || null,
        output,
      };
    }
  }
  return null;
}

export function childFromList(sessions, description) {
  const list = asArray(sessions);
  let bestId = null;
  let bestUpdated = Number.NEGATIVE_INFINITY;
  const wanted = textOf(description).trim().toLowerCase();
  for (const item of list) {
    const session = obj(item);
    if (!session) continue;
    const id = firstText(session.id);
    if (!id) continue;
    const title = firstText(session.title).toLowerCase();
    const matches = !wanted || title === wanted || title.includes(wanted);
    if (!matches) continue;
    const updated = Number(session?.time?.updated) || 0;
    if (updated >= bestUpdated) {
      bestUpdated = updated;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * The child transcript is authoritative.
 *
 * - last assistant error -> error
 * - last assistant finish stop/end_turn/completed -> completed
 * - tool-calls / length / empty finish -> still running
 * - no assistant yet -> running
 */
export function statusFromEntries(entries) {
  const list = asArray(entries);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = obj(list[i]);
    const info = obj(entry?.info);
    if (!info || info.role !== 'assistant') continue;
    if (info.error != null) return 'error';
    const finish = firstText(info.finish);
    if (finish === 'stop' || finish === 'end_turn' || finish === 'completed') {
      return 'completed';
    }
    return 'running';
  }
  return 'running';
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => firstText(obj(item)?.text))
    .filter(Boolean)
    .join('\n');
}

/**
 * Convert the child's `{info, parts}` entries into the webview's message shape.
 * This is data shaping, not engine-status inference; it is kept in core so the
 * host never has to understand v1/v2 transcript parts.
 */
export function convertEntries(entries) {
  const messages = [];
  for (const entry of asArray(entries)) {
    const record = obj(entry);
    const info = obj(record?.info);
    if (!info) continue;
    const role = firstText(info.role);
    if (role !== 'assistant' && role !== 'user') continue;

    const blocks = [];
    for (const part of asArray(record.parts)) {
      const item = obj(part);
      if (!item) continue;
      const type = firstText(item.type);
      if (type === 'text') {
        const text = firstText(item.text);
        if (text) blocks.push({ type: 'text', text });
      } else if (type === 'reasoning' || type === 'thinking') {
        const text = firstText(item.text, item.thinking);
        if (text) blocks.push({ type: 'thinking', thinking: text });
      } else if (type === 'tool' || type === 'tool_use') {
        const state = obj(item.state) || {};
        const input = state.input ?? item.input;
        blocks.push({
          type: 'tool_use',
          id: firstText(item.id, item.callID),
          name: firstText(item.tool, item.name, 'Tool'),
          ...(input != null ? { input } : {}),
        });
      }
    }
    if (blocks.length === 0) continue;

    const message = {
      type: role,
      message: { content: blocks },
    };
    const id = firstText(info.id);
    if (id) message.id = id;
    messages.push(message);
  }
  return messages;
}

function runningResponse(base, reason) {
  return {
    success: true,
    ...base,
    status: 'running',
    completed: false,
    messages: [],
    ...(reason ? { reason } : {}),
  };
}

/**
 * Load canonical subagent history/status.
 *
 * @param {object} params
 * @param {string} params.parentSessionId
 * @param {string} params.toolUseId
 * @param {string} [params.description]
 * @param {string} [params.directory]
 * @param {boolean} [params.poll]
 * @param {{ listMessages: Function, listSessions: Function }} [deps] test seam
 */
export async function getSubagentHistory(params = {}, deps = { listMessages, listSessions }) {
  const parentSessionId = textOf(params.parentSessionId);
  const toolUseId = textOf(params.toolUseId);
  const directory = params.directory || undefined;
  const poll = params.poll === true;
  const base = {
    parentSessionId,
    toolUseId,
    childSessionID: null,
  };
  if (!parentSessionId || !toolUseId) {
    return { ...runningResponse(base, 'Missing parent session or tool call'), success: false };
  }

  let parentEntries;
  try {
    parentEntries = await deps.listMessages(parentSessionId, directory);
  } catch (error) {
    return {
      ...runningResponse(base, 'Failed to load parent transcript'),
      success: false,
      error: error?.message || String(error),
    };
  }

  const found = findTool(parentEntries, toolUseId);
  if (!found) {
    return runningResponse(base, 'Subagent is still starting');
  }
  base.childSessionID = found.childSessionId || null;

  let childSessionId = found.childSessionId;
  if (!childSessionId) {
    try {
      const sessions = await deps.listSessions(directory, 200, parentSessionId);
      childSessionId = childFromList(sessions, params.description);
      base.childSessionID = childSessionId || null;
    } catch (error) {
      return {
        ...runningResponse(base, 'Failed to list child sessions'),
        success: false,
        error: error?.message || String(error),
      };
    }
  }
  if (!childSessionId) {
    return runningResponse(base, 'Subagent session is not available yet');
  }

  let childEntries;
  try {
    childEntries = await deps.listMessages(childSessionId, directory, {
      ...(poll ? { limit: POLL_TAIL_MESSAGES } : {}),
    });
  } catch (error) {
    return {
      ...runningResponse(base, 'Failed to load child transcript'),
      success: false,
      childSessionID: childSessionId,
      error: error?.message || String(error),
    };
  }

  const status = statusFromEntries(childEntries);
  return {
    success: true,
    ...base,
    childSessionID: childSessionId,
    status,
    completed: status !== 'running',
    messages: convertEntries(childEntries),
    ...(found.output ? { resultText: found.output } : {}),
  };
}
