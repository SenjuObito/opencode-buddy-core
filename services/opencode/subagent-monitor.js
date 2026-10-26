/**
 * subagent-monitor.js
 *
 * In-memory watch list for background subagent calls.
 *
 * opencode names the tool `task` in v1 and `subagent` in v2, and switches the
 * background flag from `run_in_background` to `background`. Everything else is
 * the same contract: the parent tool part carries a launch acknowledgement, and
 * the terminal state belongs to the child session. The parent acknowledgement
 * is therefore never a completion signal.
 *
 * This module is deliberately pure state (no SDK calls, no timers) so the
 * daemon's event wiring stays testable and the host never has to understand the
 * engine difference.
 */

/** v1 `task`, v2 `subagent`, plus the agent alias used by some builds. */
export const SUBAGENT_TOOL_NAMES = new Set(['task', 'agent', 'subagent']);

const MAX_CALLS = 200;
const MAX_EMITTED = 500;

function text(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function isSubagentToolName(name) {
  return SUBAGENT_TOOL_NAMES.has(text(name).trim().toLowerCase());
}

/**
 * Background switch across engines: v1 `run_in_background`, v2 `background`.
 *
 * Both spellings are accepted on either engine on purpose — this is an
 * identification layer, not an engine probe. A foreground call simply never
 * registers a watch.
 */
export function isBackgroundLaunch(input) {
  const record = obj(input);
  if (!record) return false;
  return record.background === true || record.run_in_background === true;
}

const NOTICE_RE = /<subagent\b([^>]*)>([\s\S]*?)<\/subagent>/i;

function attribute(source, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
  const match = pattern.exec(source || '');
  return match ? match[1].trim() : '';
}

/**
 * Parse the engine's synthetic parent message that announces a background
 * subagent's terminal state:
 *
 *   <subagent sessionID="ses_child" state="completed" description="…">…</subagent>
 *
 * Returns null for any other text part.
 */
export function parseSubagentNotice(value) {
  const source = text(value);
  if (!source || !source.includes('<subagent')) return null;
  const match = NOTICE_RE.exec(source);
  if (!match) return null;
  const attributes = match[1];
  const childSessionId = attribute(attributes, 'sessionID')
    || attribute(attributes, 'sessionId')
    || attribute(attributes, 'session_id');
  if (!childSessionId) return null;
  return {
    childSessionId,
    state: attribute(attributes, 'state'),
    description: attribute(attributes, 'description'),
    body: match[2].trim(),
  };
}

const COMPLETED_STATES = new Set(['completed', 'complete', 'success', 'succeeded', 'done', 'finished', 'end_turn', 'stop']);
const FAILED_STATES = new Set(['error', 'failed', 'failure', 'errored']);
const STOPPED_STATES = new Set(['cancelled', 'canceled', 'aborted', 'interrupted', 'stopped']);

/**
 * Canonical terminal status, or null when the input is not terminal.
 *
 * `running` (and anything unknown) returns null: an unproven terminal signal
 * must never flip a card to completed.
 */
export function canonicalStatus(value) {
  const raw = text(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return null;
  if (COMPLETED_STATES.has(raw)) return 'completed';
  if (FAILED_STATES.has(raw)) return 'failed';
  if (STOPPED_STATES.has(raw)) return 'stopped';
  return null;
}

/**
 * The child's last assistant text, for the row's result summary.
 *
 * Accepts the already-shaped webview message list (`[{type, message:{content}}]`)
 * that core's subagent service returns, so no engine part knowledge leaks here.
 */
export function summarizeMessages(messages, limit = 500) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = obj(list[i]);
    if (!entry || entry.type !== 'assistant') continue;
    const content = Array.isArray(obj(entry.message)?.content) ? entry.message.content : [];
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const block = obj(content[j]);
      if (!block || block.type !== 'text') continue;
      const value = text(block.text).trim();
      if (!value) continue;
      return value.length > limit ? `${value.slice(0, limit)}…` : value;
    }
  }
  return '';
}

/**
 * @param {{ maxCalls?: number }} [options]
 */
export function createSubagentMonitor({ maxCalls = MAX_CALLS } = {}) {
  /** @type {Map<string, object>} toolUseId -> call (insertion order is LRU) */
  const calls = new Map();
  /** @type {Map<string, string>} childSessionId -> toolUseId */
  const byChild = new Map();
  /** @type {Set<string>} toolUseIds that already emitted a terminal */
  const emitted = new Set();
  /** @type {string[]} FIFO of `emitted`, so the dedupe set stays bounded */
  const emittedOrder = [];

  function touch(call) {
    calls.delete(call.toolUseId);
    calls.set(call.toolUseId, call);
  }

  function attach(call, childSessionId) {
    if (!call || !childSessionId) return;
    if (call.childSessionId && call.childSessionId !== childSessionId) {
      byChild.delete(call.childSessionId);
    }
    call.childSessionId = childSessionId;
    byChild.set(childSessionId, call.toolUseId);
  }

  function evict() {
    while (calls.size > maxCalls) {
      const oldest = calls.keys().next().value;
      if (oldest === undefined) break;
      const call = calls.get(oldest);
      calls.delete(oldest);
      if (call?.childSessionId && byChild.get(call.childSessionId) === oldest) {
        byChild.delete(call.childSessionId);
      }
    }
  }

  function rememberEmitted(toolUseId) {
    if (!toolUseId || emitted.has(toolUseId)) return;
    emitted.add(toolUseId);
    emittedOrder.push(toolUseId);
    while (emittedOrder.length > MAX_EMITTED) {
      const oldest = emittedOrder.shift();
      if (oldest) emitted.delete(oldest);
    }
  }

  return {
    register({ parentSessionId, toolUseId, description, background, childSessionId, directory } = {}) {
      const parent = text(parentSessionId).trim();
      const id = text(toolUseId).trim();
      if (!parent || !id) return null;
      let call = calls.get(id);
      if (!call) {
        call = {
          parentSessionId: parent,
          toolUseId: id,
          description: '',
          background: false,
          childSessionId: null,
          directory: directory || undefined,
          inFlight: false,
        };
      }
      const summary = text(description).trim();
      if (summary) call.description = summary;
      if (background === true) call.background = true;
      if (directory && !call.directory) call.directory = directory;
      attach(call, text(childSessionId).trim() || null);
      touch(call);
      evict();
      return call;
    },

    attachChild(toolUseId, childSessionId) {
      const call = calls.get(text(toolUseId).trim());
      if (!call) return null;
      attach(call, text(childSessionId).trim() || null);
      return call;
    },

    get(toolUseId) {
      return calls.get(text(toolUseId).trim()) || null;
    },

    /** Only watched (background) calls resolve from a child terminal signal. */
    resolveByChild(childSessionId) {
      const id = text(childSessionId).trim();
      if (!id) return null;
      const toolUseId = byChild.get(id);
      if (!toolUseId) return null;
      const call = calls.get(toolUseId);
      return call && call.background ? call : null;
    },

    /**
     * Match the engine notice's description against a pending launch.
     *
     * An exact description wins over a substring match, and a newer launch wins
     * among equals: a session can spawn the same description twice.
     */
    findByDescription(parentSessionId, description) {
      const parent = text(parentSessionId).trim();
      const wanted = text(description).trim().toLowerCase();
      if (!parent || !wanted) return null;
      const candidates = [...calls.values()]
        .filter((call) => call.parentSessionId === parent && call.background);
      const fuzzy = [];
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const have = candidates[i].description.toLowerCase();
        if (!have) continue;
        if (have === wanted) return candidates[i];
        if (have.includes(wanted) || wanted.includes(have)) fuzzy.push(candidates[i]);
      }
      return fuzzy[0] || null;
    },

    pendingForParent(parentSessionId) {
      const parent = text(parentSessionId).trim();
      if (!parent) return [];
      return [...calls.values()].filter((call) =>
        call.parentSessionId === parent && call.background && !emitted.has(call.toolUseId));
    },

    hasEmitted(toolUseId) {
      return emitted.has(text(toolUseId).trim());
    },

    markEmitted(toolUseId) {
      const id = text(toolUseId).trim();
      if (!id) return;
      rememberEmitted(id);
      const call = calls.get(id);
      if (call?.childSessionId && byChild.get(call.childSessionId) === id) {
        byChild.delete(call.childSessionId);
      }
      calls.delete(id);
    },

    /** Drop a watch without recording a terminal (launch failure, abort). */
    drop(toolUseId) {
      const id = text(toolUseId).trim();
      const call = calls.get(id);
      if (!call) return;
      if (call.childSessionId && byChild.get(call.childSessionId) === id) {
        byChild.delete(call.childSessionId);
      }
      calls.delete(id);
    },

    reset() {
      calls.clear();
      byChild.clear();
      emitted.clear();
      emittedOrder.length = 0;
    },

    get size() {
      return calls.size;
    },
  };
}
