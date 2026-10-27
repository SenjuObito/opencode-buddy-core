/**
 * opencode-daemon-service.js
 *
 * Persistent query service for the opencode bridge (daemon mode).
 *
 * Unlike the old per-process `opencode run --format json` path, this keeps a
 * resident `opencode serve` + one @opencode-ai/sdk v2 client + a single global
 * SSE subscription alive across turns, and maps opencode SSE events straight to
 * the shared marker-protocol lines on stdout.
 *
 * Session state is keyed by `sessionID`: each send registers a "turn" for that
 * session; SSE events are routed by sessionID to the active turn and emitted as
 * markers. `session.idle` / `session.error` settle the turn.
 *
 * ── Stream protocol emitted to stdout (each line wrapped `{id, line}` by daemon) ──
 *   [MESSAGE_START] <sessionId>        canonical session id (create/reuse)
 *   [STREAM_START]
 *   [SESSION_ID] <sessionId>
 *   [CONTENT_DELTA] "<json text>"      text part deltas
 *   [THINKING_DELTA] "<json text>"     reasoning part deltas
 *   [MESSAGE] {...}                    tool_use / tool_result blocks
 *   [PERMISSION_REQUEST] {...}         permission.asked passthrough (Phase 4)
 *   [QUESTION_REQUEST] {...}           question.asked passthrough (Phase 4)
 *   [QUESTION_CLOSED] {...}            question replied/rejected server-side
 *   [PERMISSION_CLOSED] {...}          permission.replied server-side
 *   [SUBAGENT_STATUS] {...}            background child terminal (parent session envelope)
 *   [USAGE] {...}                      { input_tokens, output_tokens, ... }
 *   [MESSAGE_END] <full message json>
 *   [STREAM_END] <sessionId>
 *   {success, sessionId}               final request-result JSON
 */

import { selectWorkingDirectory } from '../../utils/path-utils.js';
import {
  beginStream,
  endStream,
  emitJsonStringMarker,
  emitSessionId,
  emitToolResultMessage,
  emitToolUseMessage,
  emitSendError,
  emitTurnEnd,
  emitUsage,
} from '../../utils/marker-protocol.js';
import {
  ATTACHMENT_ONLY_FALLBACK_TEXT,
  GROK_IMAGE_ONLY_FALLBACK_TEXT,
  buildFileParts,
  formatInlinedAttachments,
} from '../../utils/cli-image-input.js';
import * as serveManager from './opencode-serve-manager.js';
import * as engineRegistry from './engine-registry.js';
import * as sdk from './opencode-sdk-client.js';
import { isDefaultSessionTitle } from './opencode-sdk-client.js';
import { logInfo, logWarn, logError, logDebug } from '../../utils/logger.js';
import {
  normalizePermissionRequest,
  normalizeQuestionRequest,
} from './event-normalize.js';
import { resolvePendingCompaction } from './compaction-tracker.js';
import { getSubagentHistory } from './subagent-service.js';
import {
  canonicalStatus,
  createSubagentMonitor,
  isBackgroundLaunch,
  isSubagentToolName,
  parseSubagentNotice,
  summarizeMessages,
} from './subagent-monitor.js';
import { requestContext, bindSession, runWithIdentity } from '../../request-context.js';

// =============================================================================
// Module state
// =============================================================================

const DEFAULT_PORT = Number(process.env.OPENCODE_PORT) || 4096;

/** @type {boolean} opencode serve has been started (or reused) */
let _serveStarted = false;
/** @type {boolean} SDK client ready + SSE subscribed */
let _sdkPrepared = false;
/**
 * Per-directory SSE subscriptions. opencode's `event.subscribe` is scoped to a
 * working directory — an unscoped subscription only yields global
 * `server.connected`/`server.heartbeat` events, not `session.*`/`message.*`
 * ones. Turns are keyed by sessionID, but a session belongs to a directory, so
 * one stream per distinct directory keeps every turn fed.
 * @type {Map<string, { stream: AsyncIterable<object>, controller: AbortController }>}
 */
const _sseSubs = new Map();
/**
 * In-flight SSE subscription promises per directory, so concurrent first-callers
 * (e.g. preconnect + getModels) do not create duplicate subscriptions.
 * @type {Map<string, Promise<void>>}
 */
const _sseSubPromises = new Map();
/** @type {Map<string, object>} sessionID → turn record */
const _activeTurns = new Map();
/** @type {Map<string, { directory?: string }>} sessionID → session state */
const _sessions = new Map();
/**
 * Last title logged per session. `session.updated` repeats the same title on
 * every message update; the diagnostic line should only appear when it
 * changes, so a failing tab can be told apart from a noisy one.
 *
 * @type {Map<string, string>}
 */
const _lastTitleLogged = new Map();
const TITLE_LOG_LIMIT = 512;
/**
 * Last title *sent* to the host per session. The SSE event and the post-turn
 * reconcile both deliver the same value; the host must see it once.
 *
 * @type {Map<string, string>}
 */
const _lastEmittedTitle = new Map();
/** Sessions already asked to generate a title (one request per session). */
const _titleRequested = new Set();
/** Delays for the post-turn title reconcile, which stops on the first hit. */
const TITLE_RECONCILE_DELAYS_MS = [1200, 4000];
/** How long to wait for the engine's own generator before falling back. */
const TITLE_WAIT_DELAYS_MS = [1500, 2500];
/**
 * Canonical todo state per session.
 *
 * v1 publishes `todo.updated`; v2 has no todo event and only the
 * `todowrite` tool call. Both are normalized here so the host and webview
 * never have to branch on the engine or guess when a turn ends.
 *
 * @type {Map<string, { revision: number, signature: string, todos: object[] }>}
 */
const _sessionTodos = new Map();
let _todoRevision = 0;

/**
 * Background subagent watches (v1 `task`, v2 `subagent`).
 *
 * The parent tool part is a launch acknowledgement, so the terminal state is
 * resolved from the child session: the engine's own child-session terminal
 * event and its synthetic `<subagent … state=…>` notice both feed this watch
 * list, and only core's canonical transcript read is allowed to decide the
 * status that reaches the host.
 */
const _subagentMonitor = createSubagentMonitor();
/** Test seam: the canonical transcript reader (defaults to subagent-service). */
let _subagentHistoryReader = getSubagentHistory;

// ── Test seams ──────────────────────────────────────────────────────────────
// `_handleEvent`, `_activeTurns`, `_createTurn`, `_settleTurn` and
// `_emitTurnEndOnce` are exported (underscore-prefixed, like `_handleToolPart`)
// purely so the session-identity and turn-terminal contracts can be asserted
// without a live server: identity injection and turn settling are exactly where
// the multi-session defects lived. Not part of the public daemon API.
export { _handleEvent, _activeTurns, _createTurn, _settleTurn, _emitTurnEndOnce, trackSession as _trackSession, _resolveSession };

/** session 目录注册表上限：超限按插入序丢最旧（近似 LRU）。条目极小，但
 * 常驻 daemon 生命周期内无界增长没有任何收益。 */
const MAX_TRACKED_SESSIONS = 1000;

/** One delayed re-read of a child transcript that lagged its terminal event. */
const SUBAGENT_TERMINAL_RETRY_MS = 1_500;

function trackSession(sessionId, info) {
  if (!sessionId || typeof sessionId !== 'string') return;
  // 重新插入以刷新序（同一会话重复 touch 时视为最新）。
  _sessions.delete(sessionId);
  _sessions.set(sessionId, info);
  while (_sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = _sessions.keys().next().value;
    if (oldest === undefined) break;
    _sessions.delete(oldest);
  }
}

// ── Serve Process Exit & Watchdog Handling ──────────────────────────────────
// 当 opencode serve 意外退出或崩溃时，立即结算并熔断所有在途活跃 Turn，避免前端死锁
serveManager.onServeExit(({ code, signal, uptime, stderrTail }) => {
  const exitMsg = `OpenCode serve 进程异常退出 (退出码: ${code ?? signal ?? 'unknown'}, uptime: ${uptime}ms)`;
  console.error(`[OpenCodeDaemon:watchdog] Serve process died, settling ${_activeTurns.size} active turn(s)...`);
  // Drop the locked engine mode: the next request re-runs resolve → probe →
  // lock against the replacement process (INV-2: never flip v1 ↔ v2 directly).
  engineRegistry.invalidate('serve-exit');
  for (const [sessionId, turn] of _activeTurns) {
    if (turn.settled) continue;
    console.error(`[OpenCodeDaemon:watchdog] Aborting active turn for sessionId=${sessionId} due to serve process exit`);
    _settleTurn(turn, { success: false, error: { message: exitMsg }, reason: 'disconnected' });
  }
  // 终止所有 SSE 订阅
  for (const sub of _sseSubs.values()) {
    try {
      sub.controller.abort();
    } catch {
      // ignore
    }
  }
  _sseSubs.clear();
});



// =============================================================================
// Small helpers
// =============================================================================

/**
 * Look up the directory for a sessionID from the session registry.
 * Used by reply/reject calls that need the `directory` query parameter
 * so the opencode server can locate the question/permission in the
 * correct project scope.
 * @param {string} sessionId
 * @returns {string|undefined}
 */
export function getSessionDirectory(sessionId) {
  return sessionId ? _sessions.get(sessionId)?.directory : undefined;
}

/**
 * Parse a `provider/model` (or bare `model`) id into the SDK model object.
 * @param {string|undefined} model
 * @returns {{ providerID: string, modelID: string } | null}
 */
function resolveModelParam(model) {
  if (!model || typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower === '__config_default__' || lower === 'auto' || lower === 'default'
    || lower === '(default)' || lower === 'config-default'
    || lower === 'config_default' || lower === 'opencode default'
    || lower === 'opencode-default'
  ) {
    return null;
  }
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
  }
  // Bare model id — let the server resolve the default provider.
  return { providerID: '', modelID: trimmed };
}

/**
 * Resolve the opencode agent/mode. The UI calls it "mode" (cc-gui semantics),
 * opencode calls it "agent". Both are accepted.
 * @param {object} params
 * @returns {string|undefined}
 */
function resolveAgentParam(params) {
  const agent = params?.agent;
  const mode = params?.mode;
  if (typeof agent === 'string' && agent.trim()) return agent.trim();
  if (typeof mode === 'string' && mode.trim()) return mode.trim();
  return undefined;
}

function tokensToUsage(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const input = Number(tokens.input) || 0;
  const output = Number(tokens.output) || 0;
  const reasoning = Number(tokens.reasoning) || 0;
  const cacheRead = Number(cache.read) || 0;
  const cacheWrite = Number(cache.write) || 0;
  const total = Number(tokens.total) || (input + output + reasoning + cacheRead + cacheWrite);
  return {
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    total_tokens: total,
  };
}

function aggregateTurnUsage(turn, fallbackFinalMessage) {
  const msgs = Array.from(turn?.assistantMessagesMap?.values() || []);
  if (msgs.length > 0 && msgs.some((m) => m && m.tokens)) {
    let latestInput = 0;
    let latestCacheRead = 0;
    let latestCacheWrite = 0;
    let totalOutput = 0;
    let totalReasoning = 0;
    let totalCost = 0;

    for (const m of msgs) {
      const tok = m.tokens;
      if (tok && typeof tok === 'object') {
        const cache = tok.cache && typeof tok.cache === 'object' ? tok.cache : {};
        totalOutput += Number(tok.output) || 0;
        totalReasoning += Number(tok.reasoning) || 0;
        latestInput = Number(tok.input) || latestInput;
        latestCacheRead = Number(cache.read) || latestCacheRead;
        latestCacheWrite = Number(cache.write) || latestCacheWrite;
      }
      if (typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost > 0) {
        totalCost += m.cost;
      }
    }

    return {
      input_tokens: latestInput,
      output_tokens: totalOutput,
      reasoning_tokens: totalReasoning,
      cache_read_input_tokens: latestCacheRead,
      cache_creation_input_tokens: latestCacheWrite,
      total_tokens: latestInput + latestCacheRead + latestCacheWrite + totalOutput + totalReasoning,
      ...(totalCost > 0 ? { cost: totalCost } : {}),
    };
  }

  const stepTokensList = Array.from(turn?.stepTokensMap?.values() || []);
  if (stepTokensList.length > 0) {
    let latestInput = 0;
    let latestCacheRead = 0;
    let latestCacheWrite = 0;
    let totalOutput = 0;
    let totalReasoning = 0;
    for (const tok of stepTokensList) {
      if (tok && typeof tok === 'object') {
        const cache = tok.cache && typeof tok.cache === 'object' ? tok.cache : {};
        totalOutput += Number(tok.output) || 0;
        totalReasoning += Number(tok.reasoning) || 0;
        latestInput = Number(tok.input) || latestInput;
        latestCacheRead = Number(cache.read) || latestCacheRead;
        latestCacheWrite = Number(cache.write) || latestCacheWrite;
      }
    }
    const cost = typeof fallbackFinalMessage?.cost === 'number' ? fallbackFinalMessage.cost : undefined;
    return {
      input_tokens: latestInput,
      output_tokens: totalOutput,
      reasoning_tokens: totalReasoning,
      cache_read_input_tokens: latestCacheRead,
      cache_creation_input_tokens: latestCacheWrite,
      total_tokens: latestInput + latestCacheRead + latestCacheWrite + totalOutput + totalReasoning,
      ...(cost !== undefined ? { cost } : {}),
    };
  }

  const base = tokensToUsage(fallbackFinalMessage?.tokens ?? turn?.stepTokens);
  if (base && typeof fallbackFinalMessage?.cost === 'number') base.cost = fallbackFinalMessage.cost;
  return base;
}

// =============================================================================
// Serve + SDK + SSE lifecycle
// =============================================================================

/**
 * Ensure `opencode serve` is running and the SDK/SSE plumbing is ready for the
 * given working directory. Idempotent — cheap after the first call, and one SSE
 * subscription is maintained per distinct directory.
 *
 * @param {string} directory - working directory to scope the SSE subscription to
 */
async function _ensureReady(directory) {
  // Reset auto-restart budget whenever user actively initiates a request
  serveManager.resetRestartAttempts();

  // Engine first: resolve CLI → make a server reachable → capability-probe →
  // lock the mode. "Process ready" and "engine ready" are two different things;
  // conflating them is what let requests go out on a guessed v1 route.
  await engineRegistry.ensure();

  // Path ①: re-launch serve on send if it crashed between requests.
  // `_serveStarted` stays true after a crash, so also check the live process.
  // (No-op when ensure() just started or reused a server.)
  if (!_serveStarted || !serveManager.isRunning()) {
    await serveManager.start(DEFAULT_PORT);
    _serveStarted = true;
  }
  const url = serveManager.getServerUrl() || `http://localhost:${DEFAULT_PORT}`;
  // (Re)bind the SDK client to the actual server URL.
  sdk.setBaseUrl(url);
    if (!_sseSubs.has(directory) && !_sseSubPromises.has(directory)) {
    const subPromise = (async () => {
      const controller = new AbortController();
      const stream = await sdk.subscribeEvents(directory, controller.signal);
      _sseSubs.set(directory, { stream, controller });
      // Kick off the per-directory event loop detached from the request context
      // that created it. The loop is long-lived; if it inherited a request id,
      // all subsequent SSE events would be mis-tagged to that stale id. It runs
      // with an empty identity record — `_handleEvent()` installs the correct
      // one per event, including for events that have no active turn.
      requestContext.run({ id: null, sessionId: null, turnId: null, seq: null }, () => {
        _runSseLoop(stream, directory).catch((err) => {
          logDebug('SSE loop exited:', err?.message || err);
        });
      });
    })();
    _sseSubPromises.set(directory, subPromise);
    try {
      await subPromise;
    } finally {
      _sseSubPromises.delete(directory);
    }
  } else if (_sseSubPromises.has(directory)) {
    await _sseSubPromises.get(directory);
  }
  _sdkPrepared = true;
}

async function _runSseLoop(stream, directory) {
  let unexpectedDeath = false;
  try {
    for await (const evt of stream) {
      try {
        _handleEvent(evt);
      } catch (err) {
        logDebug('event handler error:', err?.message || err);
      }
    }
    // The iterator ended without an exception — for a server-sent-events
    // subscription this only happens when the connection died silently.
    const sub = _sseSubs.get(directory);
    if (!(sub && sub.controller.signal.aborted)) {
      unexpectedDeath = true;
    }
  } catch (err) {
    // AbortController.abort() closes the stream with an AbortError — expected on shutdown.
    const sub = _sseSubs.get(directory);
    if (sub && sub.controller.signal.aborted) return;
    logDebug('SSE stream ended unexpectedly:', err?.message || err);
    unexpectedDeath = true;
  } finally {
    // A dead stream must be re-established on the next turn.
    const sub = _sseSubs.get(directory);
    if (sub && sub.stream === stream) {
      _sseSubs.delete(directory);
    }
  }

  if (unexpectedDeath) {
    // Without the event stream no `session.idle` can ever arrive, so any
    // in-flight turns would hang forever. Settle them with an error so the
    // host's send returns and the frontend loading state ends. The stream is
    // re-established on the next request via _ensureReady().
    logDebug('SSE stream died — failing all active turns for', directory);
    for (const [sessionID, turn] of _activeTurns) {
      if (turn.settled) continue;
      logDebug('failing active turn due to SSE death:', sessionID);
      _settleTurn(turn, { success: false, error: { message: 'Event stream disconnected' }, reason: 'disconnected' });
    }
  }
}

// =============================================================================
// SSE → marker mapping
// =============================================================================

/**
 * Route a single SSE event to its session's active turn (if any) and emit
 * markers. Uses `properties` (the runtime shape, verified against opencode
 * 1.18.x) with a `data` fallback for older/newer servers.
 */
/**
 * Server-provided monotonic sequence within a session (`durable.seq`).
 *
 * The aggregate of `durable` is the session (`aggregateID === sessionID`), so
 * this is a *session*-level counter, not a turn-level one. It is used for two
 * things: ordering events within a session, and defining `turnId` (see
 * `_handleEvent`). Servers that don't send it yield `null`, and consumers
 * degrade to arrival order.
 */
function _resolveSeq(evt, props) {
  const raw = props?.durable?.seq ?? evt?.durable?.seq ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function _handleEvent(evt) {
  const props = (evt && evt.properties && typeof evt.properties === 'object')
    ? evt.properties
    : ((evt && evt.data && typeof evt.data === 'object') ? evt.data : {});
  const type = typeof evt?.type === 'string' ? evt.type : '';
  const sessionID = props?.sessionID
    || props?.sessionId
    || props?.session_id
    || props?.info?.id
    || props?.info?.sessionID
    || props?.info?.sessionId
    || evt?.sessionID
    || evt?.sessionId
    || evt?.info?.id
    || evt?.properties?.sessionID
    || evt?.properties?.info?.id
    || evt?.data?.sessionID;
  const seq = _resolveSeq(evt, props);
  const turn = sessionID ? _activeTurns.get(sessionID) : null;
  if (turn) {
    turn.lastActivityAt = Date.now();
    // turnId is the `durable.seq` of the turn's FIRST event. Because `seq` is
    // monotonic per session, this makes turnIds strictly increasing and unique
    // across turns without inventing a counter (which would break on restart).
    if (turn.turnId == null && seq != null) turn.turnId = seq;
  }

  // Attach identity unconditionally. Even an event with no active turn — a
  // tracked session's `session.created`, a `message.removed`, a late error —
  // still knows which session it belongs to, and emitting it with no identity
  // is exactly what let it leak into an unrelated session. `fn()` bare is never
  // correct here.
  requestContext.run(
    {
      id: turn?.requestId ?? null,
      sessionId: sessionID ?? null,
      turnId: turn?.turnId ?? null,
      seq,
    },
    () => _dispatchInnerEvent(type, props, sessionID, turn),
  );
}

/**
 * Emit `[QUESTION_REQUEST]` for a question tool call, derived from the tool
 * event rather than from the `question.asked` SSE event.
 *
 * <p>Why derive it here: on opencode v2 the `question.asked` event's properties
 * carry neither `id` nor `sessionID` (verified against a live v2.0.27 server —
 * the daemon's own log prints an empty requestId and the line falls through to
 * raw stderr with no identity), so the marker it would emit has no envelope
 * identity and the host demotes it to a plain log line. The tool event, by
 * contrast, *does* resolve a session (that is how `emitToolUseMessage` reaches
 * the right tab) and carries the full `input.questions` payload.</p>
 *
 * <p>Engine scope: `session.tool.input` / `session.tool.called` are v2 event
 * names. v1 reports the same tool call through `message.part.updated` →
 * `_handleToolPart`, which is deliberately left alone — v1's `question.asked`
 * event does carry identity and already works. The two paths therefore never
 * both fire for one engine, and `turn.questionPrompted` makes that a guarantee
 * rather than an assumption.</p>
 *
 * @param {object} turn        active turn record (owns the de-dup set)
 * @param {string} sessionID   session the event belongs to
 * @param {string} callID      tool call id (also the webview's lookup key)
 * @param {string} name        resolved tool name
 * @param {object} input       tool input
 */
function maybeEmitQuestionPrompt(turn, sessionID, callID, name, input) {
  if (name !== 'question') return;
  if (!sessionID) return;
  if (turn.questionPrompted?.has(callID)) return;

  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length === 0) return;

  turn.questionPrompted.add(callID);

  // Reuse the canonical normalizer so the payload shape matches what the
  // `question.asked` path produces — the host parser and the webview card read
  // exactly one shape.
  const request = normalizeQuestionRequest({
    id: callID,
    sessionID,
    questions,
    tool: callID,
  });
  logDebug('question prompt derived from tool event:', callID, 'session:', sessionID,
    'questions:', request.questions.length);
  emitJsonStringMarker('[QUESTION_REQUEST]', request);
}

// ── canonical todos ─────────────────────────────────────────────────────────

function normalizeTodoStatus(value) {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (status === 'completed' || status === 'done') return 'completed';
  if (status === 'in_progress' || status === 'in-progress' || status === 'active' || status === 'running') {
    return 'in_progress';
  }
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'pending';
}

function normalizeTodoItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const candidates = [item.content, item.step, item.title, item.text, item.subject, item.description];
  const content = candidates.find((value) => typeof value === 'string' && value.trim());
  if (!content) return null;
  const normalized = {
    content: content.trim(),
    status: normalizeTodoStatus(item.status),
  };
  if (item.id !== undefined && item.id !== null) {
    normalized.id = String(item.id);
  }
  if (Array.isArray(item.blockedBy)) {
    normalized.blockedBy = item.blockedBy
      .map((id) => (id === undefined || id === null ? null : String(id)))
      .filter((id) => id !== null);
  }
  return normalized;
}

/**
 * Normalize a v1 `todo.updated` payload or a v2 `todowrite` input list.
 * Status is always one of pending/in_progress/completed/cancelled; the host
 * must not reinterpret `in_progress` as completed at turn end.
 */
export function normalizeTodoList(rawTodos) {
  if (!Array.isArray(rawTodos)) return null;
  return rawTodos.map(normalizeTodoItem).filter((item) => item !== null);
}

/**
 * Publish the latest canonical todo list for one session.
 *
 * Emits only on a real change. The first event establishes the list; an empty
 * array is meaningful and clears it. `revision` lets a client discard an older
 * snapshot that arrives after a newer one.
 *
 * @param {string} sessionID
 * @param {unknown} rawTodos
 * @param {string} source - event/tool name for diagnostics
 */
export function _emitTodos(sessionID, rawTodos, source = 'unknown') {
  if (!sessionID || typeof sessionID !== 'string') return;
  const todos = normalizeTodoList(rawTodos);
  if (todos === null) return;

  const signature = JSON.stringify(todos);
  const previous = _sessionTodos.get(sessionID);
  if (previous && previous.signature === signature) return;

  const revision = ++_todoRevision;
  _sessionTodos.set(sessionID, { revision, signature, todos });
  while (_sessionTodos.size > MAX_TRACKED_SESSIONS) {
    const oldest = _sessionTodos.keys().next().value;
    if (oldest === undefined) break;
    _sessionTodos.delete(oldest);
  }
  logDebug('todo updated:', sessionID, 'source:', source, 'count:', todos.length,
    'revision:', revision);
  emitJsonStringMarker('[TODO_UPDATED]', JSON.stringify({
    sessionID,
    revision,
    source,
    todos,
  }));
}

/** Read the current canonical list (used by tests and future history APIs). */
export function getSessionTodos(sessionID) {
  return _sessionTodos.get(sessionID)?.todos ?? null;
}

/** Test seam: drop canonical todo state between isolated cases. */
export function _resetTodosForTest() {
  _sessionTodos.clear();
  _todoRevision = 0;
}

/**
 * One-shot diagnostic for events this build does not handle.
 *
 * A silent `default: break` is how a whole class of "the dialog never shows
 * up" bugs stays invisible: the server is emitting an event whose name or
 * shape this version does not know, and nothing anywhere says so. Logging each
 * unknown type once per process turns that into a one-line answer in
 * `~/.opencode-idea-gui/opencode-plugin.log`.
 */
const _unloggedEventTypes = new Set();

function noteUnhandledEventType(type) {
  if (!type || _unloggedEventTypes.has(type)) return;
  _unloggedEventTypes.add(type);
  logDebug('unhandled event type (no case in this build):', type);
}

/**
 * Send one session title to the host, exactly once per value.
 *
 * <p>The engine's placeholders (`New session - <ISO>`, `Child session - <ISO>`)
 * are not conversation titles: they are the state in which the engine's own
 * auto-title generator runs. Forwarding them would paint a raw ISO string on
 * the tab and then be replaced seconds later, so they are dropped here — the
 * host keeps its localized placeholder until the engine names the session.</p>
 *
 * @param {string} sessionId
 * @param {unknown} rawTitle
 */
function _emitSessionTitle(sessionId, rawTitle) {
  if (!sessionId || typeof rawTitle !== 'string') return;
  const title = rawTitle.trim();
  if (!title) return;
  if (isDefaultSessionTitle(title)) return;
  if (_lastEmittedTitle.get(sessionId) === title) return;
  _lastEmittedTitle.set(sessionId, title);
  if (_lastEmittedTitle.size > TITLE_LOG_LIMIT) {
    const oldest = _lastEmittedTitle.keys().next().value;
    if (oldest !== undefined) _lastEmittedTitle.delete(oldest);
  }
  if (_lastTitleLogged.get(sessionId) !== title) {
    _lastTitleLogged.set(sessionId, title);
    if (_lastTitleLogged.size > TITLE_LOG_LIMIT) {
      const oldest = _lastTitleLogged.keys().next().value;
      if (oldest !== undefined) _lastTitleLogged.delete(oldest);
    }
    logInfo('title-event', `session=${sessionId} title="${title}"`);
  }
  emitJsonStringMarker('[SESSION_TITLE]', { sessionId, title });
}

/**
 * Name a session that has none yet, using the engine only.
 *
 * <p>Two engine paths, in order:</p>
 * <ol>
 *   <li><b>Engine's own generator.</b> v2 exposes it as
 *   {@code PATCH /api/session/:id {title: ""}} — the call the engine's TUI
 *   makes when a title is cleared. When it works the name is stored and
 *   published by the engine itself.</li>
 *   <li><b>Engine text generation + store.</b> In opencode 2.1.4 the call
 *   above answers 204 but produces no title (verified against a bare engine:
 *   no {@code session.renamed}, no title in the DB, while
 *   {@code POST /api/session/:id/generate} answers normally on the same
 *   session). The fallback therefore asks the engine to generate the title
 *   text with the session's own model and stores the answer as the session
 *   title. The name is still the engine's, and it lands in the engine, so the
 *   tab and opencode's own UI show the same title — the plugin never invents
 *   one from message text.</li>
 * </ol>
 *
 * <p>Called once per session after a successful first turn; a session that is
 * already named is left alone, so a user rename is never overwritten.</p>
 *
 * @param {string} sessionId
 * @param {string} [directory]
 */
async function _ensureEngineTitle(sessionId, directory) {
  // v1 names a session itself once the first turn exists; asking would be a
  // wasted round-trip on every turn.
  if (!sessionId || !engineRegistry.isV2() || _titleRequested.has(sessionId)) return;
  _titleRequested.add(sessionId);
  try {
    if (await _sessionHasRealTitle(sessionId, directory)) return;

    let asked = false;
    try {
      asked = await sdk.generateSessionTitle(sessionId, directory);
    } catch (err) {
      logDebug('title-request failed:', err?.message || err);
    }
    if (asked) {
      logInfo('title-request', `session=${sessionId} asked the engine to generate a title`);
      if (await _waitForEngineTitle(sessionId, directory, TITLE_WAIT_DELAYS_MS)) return;
    }

    const text = await sdk.generateSessionTitleText(sessionId, directory);
    const title = sdk.sanitizeGeneratedTitle(text);
    if (!title) {
      // Let a later turn try again instead of leaving the session permanently
      // unnamed after one bad generation.
      _titleRequested.delete(sessionId);
      logDebug('title-request: engine returned no usable title for', sessionId);
      return;
    }
    await sdk.updateSessionTitle(sessionId, title, directory);
    logInfo('title-request', `session=${sessionId} named by the engine: "${title}"`);
    // The engine also publishes `session.renamed`; emitting here means the tab
    // does not depend on that event arriving.
    _emitSessionTitle(sessionId, title);
  } catch (err) {
    _titleRequested.delete(sessionId);
    logDebug('title-request failed:', err?.message || err);
  }
}

/** @returns {Promise<boolean>} whether the session already carries a real title */
async function _sessionHasRealTitle(sessionId, directory) {
  try {
    const info = await sdk.getSession(sessionId, directory);
    const title = typeof info?.title === 'string' ? info.title.trim() : '';
    return !!title && !isDefaultSessionTitle(title);
  } catch {
    return false;
  }
}

/** @returns {Promise<boolean>} true as soon as the engine stores a real title */
async function _waitForEngineTitle(sessionId, directory, delays) {
  for (const delay of delays) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      if (typeof timer?.unref === 'function') timer.unref();
    });
    if (await _sessionHasRealTitle(sessionId, directory)) return true;
  }
  return false;
}

/**
 * Re-read the session once after its turn settles and forward a title the SSE
 * stream did not deliver.
 *
 * <p>The engine generates the title asynchronously (a separate small-model
 * call forked at the first step), so the value can land just after the turn's
 * terminal event or be lost when the event stream reconnects mid-turn. One
 * read per settled turn is cheap and, unlike a poll, cannot rename anything:
 * it only mirrors whatever title the engine already has.</p>
 *
 * @param {string} sessionId
 */
function _scheduleTitleReconcile(sessionId) {
  if (!sessionId) return;
  const directory = _sessions.get(sessionId)?.directory;
  let attempt = 0;
  const tick = async () => {
    let info = null;
    try {
      info = await sdk.getSession(sessionId, directory);
    } catch {
      info = null;
    }
    const title = typeof info?.title === 'string' ? info.title : null;
    if (title && !isDefaultSessionTitle(title)) {
      requestContext.run({ id: null, sessionId }, () => {
        _emitSessionTitle(sessionId, title);
      });
      return;
    }
    attempt += 1;
    if (attempt < TITLE_RECONCILE_DELAYS_MS.length) {
      schedule(TITLE_RECONCILE_DELAYS_MS[attempt]);
    }
  };
  const schedule = (delay) => {
    try {
      const timer = setTimeout(tick, delay);
      if (typeof timer?.unref === 'function') timer.unref();
    } catch {
      // Timers unavailable (test seam/shutdown): skip the reconcile.
    }
  };
  schedule(TITLE_RECONCILE_DELAYS_MS[0]);
}

// =============================================================================
// Subagent lifecycle (v1 `task` / v2 `subagent`)
// =============================================================================

function _flattenText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(_flattenText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Resolve the child session id from a launch acknowledgement.
 *
 * v2 carries it as `metadata.sessionID` on the tool part and inside the ack
 * output object; v1 carries it on `state.metadata`/`state.output`. All shapes
 * are tolerated here so the watch registration never depends on the engine.
 */
function _childSessionIdFrom({ metadata, input, output } = {}) {
  const candidates = [
    metadata?.sessionID, metadata?.sessionId,
    output?.sessionID, output?.sessionId,
    output?.metadata?.sessionID, output?.metadata?.sessionId,
    input?.sessionID, input?.sessionId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const text = _flattenToolOutput(output);
  const match = /"sessionI[dD]"\s*:\s*"([^"]+)"/.exec(text);
  return match ? match[1] : null;
}

/**
 * A background launch acknowledgement looks like
 * `{ "sessionID": "ses_…", "status": "running", "output": [ … ] }`.
 *
 * The input flag is authoritative when present; this shape is the fallback for
 * engine builds that deliver the flag and the result in separate events.
 */
function _looksLikeLaunchAck(output) {
  const text = _flattenToolOutput(output);
  return text.length > 0
    && /"status"\s*:\s*"running"/.test(text)
    && /"sessionI[dD]"\s*:/.test(text);
}

/** The tool input observed at call time, or the snapshot the turn kept. */
function _toolInputFrom(turn, callID, props) {
  if (props?.input && typeof props.input === 'object' && !Array.isArray(props.input)) return props.input;
  const raw = turn?.toolUseInput?.get(callID);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _subagentDescriptionFrom(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['description', 'summary', 'task']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Flatten a tool result from either engine: v1 sends a string, v2 a content array. */
function _flattenToolOutput(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  return sdk.flattenToolContent(output) || _flattenText(output);
}

/**
 * A notice that says the child started, not finished (`state="running"`).
 *
 * The input flag is authoritative for background launches, but some engine
 * builds drop it and only leave this acknowledgement, so it is a fallback in
 * exactly the same way as the `{"status":"running"}` object ack.
 */
function _isPendingSubagentState(state) {
  const value = typeof state === 'string' ? state.trim().toLowerCase() : '';
  return value === 'running' || value === 'pending' || value === 'started' || value === 'in_progress';
}

/**
 * Publish the canonical terminal state of a subagent call.
 *
 * Background launches carry an acknowledgement in the parent tool result; their
 * terminal state lives in the child session and is resolved by the watch list.
 * Inline (sync) calls are the opposite: the parent tool result IS the child's
 * final report, so it is terminal evidence and must be published here. Doing it
 * in core keeps `subagent.status` the single run-state contract for both modes:
 * the webview never has to decide that "a result means completed" once the
 * event has arrived.
 */
function _registerSubagentCall({
  parentSessionId,
  toolUseId,
  name,
  input,
  metadata,
  output,
  directory,
  terminal = false,
  isError = false,
}) {
  if (!isSubagentToolName(name) || !parentSessionId || !toolUseId) return null;
  const evidence = _flattenToolOutput(output);
  const notice = parseSubagentNotice(evidence);
  const background = isBackgroundLaunch(input)
    || _looksLikeLaunchAck(output)
    || _isPendingSubagentState(notice?.state);
  const description = _subagentDescriptionFrom(input) || notice?.description || '';
  const childSessionId = _childSessionIdFrom({ metadata, input, output })
    || notice?.childSessionId
    || null;

  if (!background) {
    if (!terminal) return null;
    // An inline call's result is the child's final report. No result text at
    // all is not terminal evidence: some builds deliver the launch ack in a
    // later event, and completing here would flip a background run on its ack.
    if (!isError && !notice && !evidence.trim()) return null;
    const call = { parentSessionId, toolUseId, description, childSessionId, directory };
    const status = canonicalStatus(notice?.state) || (isError ? 'failed' : 'completed');
    _emitSubagentStatus(call, status, { summary: notice?.body });
    logDebug('subagent', `inline terminal tool=${toolUseId} status=${status} parent=${parentSessionId}`);
    return call;
  }

  // A background launch that already failed never produced a child; publish the
  // failure instead of registering a watch that waits for a signal that cannot
  // arrive.
  if (terminal && isError) {
    const call = { parentSessionId, toolUseId, description, childSessionId, directory };
    _emitSubagentStatus(call, 'failed');
    return call;
  }

  const call = _subagentMonitor.register({
    parentSessionId,
    toolUseId,
    description,
    background,
    childSessionId,
    directory,
  });
  if (call) {
    logDebug('subagent', `watch registered tool=${toolUseId} parent=${parentSessionId} `
      + `child=${call.childSessionId || '-'} description=${call.description || '-'}`);
  }
  return call;
}

/**
 * Emit one terminal status for a watched subagent, exactly once.
 *
 * The marker is tagged with the PARENT session: the parent tab may be idle and
 * may not be streaming at all when a background child finishes, and the host
 * routes out-of-turn markers by that envelope session.
 */
function _emitSubagentStatus(call, status, { result, summary } = {}) {
  if (!call || !status || _subagentMonitor.hasEmitted(call.toolUseId)) return;
  if (!call.childSessionId) {
    const child = result?.childSessionID;
    if (typeof child === 'string' && child) call.childSessionId = child;
  }
  _subagentMonitor.markEmitted(call.toolUseId);

  // The notice body can be the child's whole report; keep the event payload
  // bounded the same way summarizeMessages bounds a transcript summary.
  const noticeText = typeof summary === 'string' ? summary.trim() : '';
  const clipped = noticeText.length > 500 ? `${noticeText.slice(0, 500)}…` : noticeText;
  const text = clipped || summarizeMessages(result?.messages);
  const payload = {
    parentSessionId: call.parentSessionId,
    toolUseId: call.toolUseId,
    childSessionId: call.childSessionId || null,
    status,
    ...(call.description ? { description: call.description } : {}),
    ...(text ? { summary: text } : {}),
  };
  logInfo('subagent', `terminal tool=${call.toolUseId} status=${status} `
    + `parent=${call.parentSessionId} child=${call.childSessionId || '-'}`);
  runWithIdentity(
    { sessionId: call.parentSessionId },
    () => emitJsonStringMarker('[SUBAGENT_STATUS]', payload),
  );
}

/**
 * Resolve a watch from one terminal signal.
 *
 * The child transcript is canonical, so a still-`running` transcript vetoes the
 * emission and keeps the watch (the notice path or the next parent settle will
 * try again). Only when the transcript cannot be read at all does the terminal
 * event itself decide the status.
 */
async function _resolveSubagentTerminal(call, hint) {
  if (!call) return false;
  let result = null;
  try {
    result = await _subagentHistoryReader({
      parentSessionId: call.parentSessionId,
      toolUseId: call.toolUseId,
      description: call.description,
      directory: call.directory,
    });
  } catch (error) {
    logWarn('subagent', `transcript read failed tool=${call.toolUseId} `
      + `${error?.message || String(error)}`);
  }

  const fromTranscript = result && result.success !== false ? canonicalStatus(result.status) : null;
  const status = fromTranscript || (result && result.success !== false ? null : canonicalStatus(hint));
  if (!status) {
    logDebug('subagent', `still running tool=${call.toolUseId} hint=${hint || '-'}`);
    return false;
  }
  _emitSubagentStatus(call, status, { result });
  return true;
}

function _handleSubagentChildTerminal(childSessionId, hint, { allowRetry = true } = {}) {
  const call = _subagentMonitor.resolveByChild(childSessionId);
  if (!call || call.inFlight) return Promise.resolve(false);
  call.inFlight = true;
  return _resolveSubagentTerminal(call, hint)
    .then((emitted) => {
      if (emitted || !allowRetry || !_subagentMonitor.get(call.toolUseId)) return emitted;
      // The child transcript can lag its terminal event by a few hundred ms.
      // One bounded re-read (never an interval); the notice path and the next
      // parent settle are still there if this also lands too early.
      const timer = setTimeout(() => {
        if (!_subagentMonitor.get(call.toolUseId)) return;
        _handleSubagentChildTerminal(childSessionId, hint, { allowRetry: false })
          .catch((error) => logWarn('subagent', `terminal retry failed ${error?.message || error}`));
      }, SUBAGENT_TERMINAL_RETRY_MS);
      timer.unref?.();
      return emitted;
    })
    .finally(() => {
      call.inFlight = false;
    });
}

/**
 * The engine writes a synthetic parent message when a background child ends:
 * {@code <subagent sessionID="…" state="completed" description="…">…</subagent>}.
 * Because it arrives outside any parent turn it must be handled here, not in
 * `_handlePartUpdated`.
 */
function _maybeHandleSubagentNotice(props, parentSessionId) {
  const part = props?.part;
  if (!part || part.type !== 'text') return;
  _handleSubagentNoticeText(part.text, parentSessionId);
}

/** `message.updated` can carry the whole part list instead of a single part. */
function _maybeHandleSubagentNoticeFromMessage(props, parentSessionId) {
  const parts = Array.isArray(props?.parts) ? props.parts : [];
  for (const part of parts) {
    if (!part || part.type !== 'text') continue;
    _handleSubagentNoticeText(part.text, parentSessionId);
  }
}

function _handleSubagentNoticeText(text, parentSessionId) {
  const notice = parseSubagentNotice(text);
  if (!notice) return;

  let call = _subagentMonitor.resolveByChild(notice.childSessionId);
  if (!call && parentSessionId) {
    call = _subagentMonitor.findByDescription(parentSessionId, notice.description);
    if (call) _subagentMonitor.attachChild(call.toolUseId, notice.childSessionId);
  }
  if (!call) return;
  const status = canonicalStatus(notice.state);
  if (!status) return;
  _emitSubagentStatus(call, status, { summary: notice.body });
}

/**
 * One-shot reconciliation when a parent turn settles.
 *
 * Not a timer: it runs once per settle and exists for the race where the child
 * finished before its watch was registered (or before the terminal event was
 * delivered). A still-running child simply stays watched.
 */
function _reconcileSubagentsForParent(parentSessionId) {
  if (!parentSessionId) return Promise.resolve([]);
  const pending = [];
  for (const call of _subagentMonitor.pendingForParent(parentSessionId)) {
    if (call.inFlight || _subagentMonitor.hasEmitted(call.toolUseId)) continue;
    call.inFlight = true;
    pending.push(_resolveSubagentTerminal(call, null).finally(() => {
      call.inFlight = false;
    }));
  }
  return Promise.all(pending);
}

/** Test seams for the subagent watch list (not part of the daemon API). */
export function _setSubagentHistoryReaderForTest(reader) {
  _subagentHistoryReader = typeof reader === 'function' ? reader : getSubagentHistory;
}

export function _resetSubagentsForTest() {
  _subagentMonitor.reset();
  _subagentHistoryReader = getSubagentHistory;
}

export { _subagentMonitor };
export {
  _handleSubagentChildTerminal,
  _reconcileSubagentsForParent,
};

function _dispatchInnerEvent(type, props, sessionID, turn) {
  switch (type) {
    case 'session.created':
    case 'session.updated':
    case 'session.renamed':
    case 'session.initialize': {
      // Track the session's directory. The [SESSION_ID] marker is emitted by the
      // send/preconnect path itself (authoritative), so we only record state here.
      const id = sessionID || props?.info?.id || props?.id || props?.sessionId;
      if (id) {
        if (!_sessions.has(id)) {
          trackSession(id, {
            directory: props?.info?.directory || props?.directory,
            revert: props?.info?.revert || props?.revert,
          });
        } else {
          const revert = props?.info?.revert;
          trackSession(id, {
            directory: props?.info?.directory || _sessions.get(id)?.directory,
            revert,
          });
        }
        const revert = props?.info?.revert;
        if (turn) {
          emitJsonStringMarker('[REVERT_STATE]', {
            hasRevert: !!revert,
            messageId: (revert && typeof revert.messageID === 'string') ? revert.messageID : '',
          });
        }
        // Emit session title update to frontend
        const rawTitle = props?.info?.title || props?.title || props?.name || props?.info?.name;
        _emitSessionTitle(id, rawTitle);
      }
      break;
    }
    case 'message.part.updated':
    case 'message.part.created':
      // Background children end outside the parent turn, so the engine's
      // synthetic notice has to be inspected before the turn gate.
      _maybeHandleSubagentNotice(props, sessionID);
      if (turn) _handlePartUpdated(props, turn);
      break;
    case 'message.part.delta':
      if (turn) _handlePartDelta(props, turn);
      break;
    case 'message.updated': {
      // Track assistant message info (id/role/tokens/cost) for MESSAGE_END and turn usage aggregation.
      if (turn && props?.info && typeof props.info === 'object') {
        const isAssistant = props.info.role === 'assistant' || props.info.type === 'assistant';
        if (isAssistant) {
          turn.lastInfo = props.info;
          if (props.info.id) {
            turn.assistantMessagesMap.set(props.info.id, props.info);
          }
        }
      }
      _maybeHandleSubagentNoticeFromMessage(props, sessionID);
      break;
    }
    case 'message.removed':
      // Where a revert actually lands. opencode's revert only writes a "void from
      // here on" pointer; the real deletion happens on the next prompt: the server
      // runs cleanup(session) first (removing every message from the revert point
      // onward) and only then persists the new user message. cleanup publishes
      // `message.removed` per deleted message.
      //
      // The host must mirror that deletion. Otherwise its state keeps carrying the
      // voided messages, and the next send pushes them straight back to the webview
      // — which is why reverted messages "came back to life" after sending.
      //
      // Not gated on `turn`: the turn is registered before promptAsync so it does
      // exist here, but a removal is authoritative state and should sync regardless.
      if (sessionID && _sessions.has(sessionID) && typeof props?.messageID === 'string' && props.messageID) {
        emitJsonStringMarker('[MESSAGE_REMOVED]', {
          sessionID,
          messageID: props.messageID,
        });
      }
      break;
    case 'session.reasoning.delta':
      if (turn && typeof props?.delta === 'string' && props.delta) {
        emitJsonStringMarker('[THINKING_DELTA]', props.delta);
      }
      break;
    case 'session.text.delta':
      if (turn && typeof props?.delta === 'string' && props.delta) {
        emitJsonStringMarker('[CONTENT_DELTA]', props.delta);
      }
      break;
    case 'session.step.ended': {
      if (turn && props?.tokens && typeof props.tokens === 'object') {
        const msgId = props.assistantMessageID || 'default';
        const info = {
          id: msgId,
          type: 'assistant',
          role: 'assistant',
          tokens: props.tokens,
          cost: props.cost,
        };
        turn.lastInfo = { ...(turn.lastInfo || {}), ...info };
        turn.assistantMessagesMap.set(msgId, turn.lastInfo);
      }
      break;
    }
    case 'session.usage.updated': {
      if (turn && props?.tokens && typeof props.tokens === 'object') {
        const msgId = props.assistantMessageID || turn.lastInfo?.id || 'default';
        turn.lastInfo = {
          ...(turn.lastInfo || {}),
          id: msgId,
          type: 'assistant',
          role: 'assistant',
          tokens: props.tokens,
          cost: props.cost,
        };
        turn.assistantMessagesMap.set(msgId, turn.lastInfo);
        const usage = tokensToUsage(props.tokens);
        if (usage) {
          if (typeof props.cost === 'number' && props.cost > 0) {
            usage.cost = props.cost;
          }
          emitUsage(usage);
        }
      }
      break;
    }
    case 'session.tool.input.started': {
      if (turn) {
        const callID = _resolveToolCallId(props, turn);
        const name = props.name || props.tool;
        if (callID && name) {
          turn.toolNames.set(callID, name);
        }
      }
      break;
    }
    case 'session.tool.called':
    case 'session.tool.input': {
      if (turn) {
        const callID = _resolveToolCallId(props, turn);
        let name = props.name || props.tool || (callID ? turn.toolNames.get(callID) : null) || 'tool';
        if (name === 'shell') name = 'bash';
        const input = (props.input && typeof props.input === 'object' && !Array.isArray(props.input))
          ? props.input
          : {};
        if (callID) {
          turn.toolNames.set(callID, name);
          const inputJson = JSON.stringify(input);
          const emittedJson = turn.toolUseInput.get(callID);
          if (emittedJson === undefined || (Object.keys(input).length > 0 && emittedJson !== inputJson)) {
            turn.toolUseInput.set(callID, inputJson);
            turn.toolUseDone.add(callID);
            emitToolUseMessage({ id: callID, name, input });
          }
          const todoTool = name.toLowerCase();
          if ((todoTool === 'todowrite' || todoTool === 'todo') && Array.isArray(input.todos)) {
            _emitTodos(sessionID || turn.sessionId, input.todos, type);
          }
          maybeEmitQuestionPrompt(turn, sessionID, callID, name, input);
          _registerSubagentCall({
            parentSessionId: sessionID || turn.sessionId,
            toolUseId: callID,
            name,
            input,
            metadata: props.metadata,
            output: props.output,
            directory: _sessions.get(sessionID || turn.sessionId)?.directory,
          });
        }
      }
      break;
    }
    case 'session.tool.success':
    case 'session.tool.failed': {
      if (turn) {
        const callID = _resolveToolCallId(props, turn);
        if (callID && !turn.toolResultDone.has(callID)) {
          turn.toolResultDone.add(callID);
          const isError = type === 'session.tool.failed' || Boolean(props.error);
          let content = '';
          if (isError) {
            content = props.error || '';
          } else if (Array.isArray(props.content)) {
            content = props.content.map(c => (typeof c === 'object' && c ? (c.text ?? JSON.stringify(c)) : String(c))).join('\n');
          } else {
            content = props.output ?? props.result ?? '';
          }
          emitToolResultMessage({ toolUseId: callID, content, isError });
          const name = turn.toolNames.get(callID) || props.name || props.tool || '';
          if (isSubagentToolName(name)) {
            _registerSubagentCall({
              parentSessionId: sessionID || turn.sessionId,
              toolUseId: callID,
              name,
              input: _toolInputFrom(turn, callID, props),
              metadata: props.metadata,
              output: props.output ?? props.content ?? props.result,
              directory: _sessions.get(sessionID || turn.sessionId)?.directory,
              terminal: true,
              isError,
            });
            // A failed launch never produced a child: do not keep a watch that
            // would otherwise wait for a terminal signal that cannot arrive.
            if (isError) _subagentMonitor.drop(callID);
          }
        }
      }
      break;
    }
    case 'session.shell.started':
      logDebug('session.shell.started:', props?.shell?.id, props?.shell?.command);
      break;
    case 'session.shell.ended': {
      const exitCode = props?.shell?.exit ?? props?.output?.exit ?? 0;
      const rawOutput = props?.output?.output || props?.output?.stdout || props?.output?.stderr || '';
      logDebug('session.shell.ended:', props?.shell?.id, 'exit:', exitCode, 'outputLen:', rawOutput.length);
      if (!turn || turn.toolUseDone.size === 0) {
        if (rawOutput) {
          emitJsonStringMarker('[CONTENT_DELTA]', rawOutput);
        } else if (exitCode !== 0) {
          emitJsonStringMarker('[CONTENT_DELTA]', `Process exited with code ${exitCode}\n`);
        }
      }
      if (turn) {
        _settleTurn(turn, { success: exitCode === 0, reason: exitCode === 0 ? 'idle' : 'error' });
      }
      break;
    }
    case 'session.status': {
      const status = props?.status;
      if (status && typeof status === 'object' && status.type === 'retry') {
        // 结构化透传，而不是拼一段字符串：opencode 的 retry 状态自带人话
        // (message) 和可点击的 action（free_tier_limit → opencode.ai/go 订阅页，
        // account_rate_limit → workspace 配额页）。宿主侧原来根本没有 [STATUS]
        // 分支，这个"到底为什么卡住"的唯一权威信号整条丢失，用户只能干等到
        // 180s 本地超时，看到"可能由于模型服务繁忙或额度耗尽"这种什么都没说的
        // 兜底文案。
        const rawAction = status.action;
        const action = (rawAction && typeof rawAction === 'object')
          ? {
            reason: rawAction.reason ?? null,
            provider: rawAction.provider ?? null,
            title: rawAction.title ?? null,
            message: rawAction.message ?? null,
            label: rawAction.label ?? null,
            link: rawAction.link ?? null,
          }
          : null;
        const payload = {
          sessionID: sessionID || '',
          type: 'retry',
          message: status.message || action?.message || 'OpenCode server rate limit / quota exceeded, retrying...',
          attempt: typeof status.attempt === 'number' ? status.attempt : null,
          next: typeof status.next === 'number' ? status.next : null,
          action,
        };
        // 记在本回合上：供报错文案引用。
        if (turn) turn.lastStatusMessage = payload.message;
        logInfo(`[session.status:retry] session=${sessionID} attempt=${payload.attempt} reason=${action?.reason || '-'} msg=${payload.message}`);
        emitJsonStringMarker('[STATUS]', payload);

        // 如果是免费额度已用尽（free_tier_limit）或超长退避（例如重试时间在 60 秒以上），
        // 这属于不可短时自动恢复的额度耗尽，继续等待只会导致前端一直 loading。
        // 立即结算该回合为失败，并让底层服务端 abort 该会话。
        const isFreeTierLimit = action?.reason === 'free_tier_limit'
          || (typeof payload.message === 'string' && /free usage exceeded|free_tier_limit/i.test(payload.message));
        const isFarFutureRetry = typeof payload.next === 'number' && payload.next - Date.now() > 60_000;

        if (turn && (isFreeTierLimit || isFarFutureRetry)) {
          emitJsonStringMarker('[TURN_ERROR]', {
            message: payload.message,
            error: payload.message,
            action: payload.action || null,
          });
          if (sessionID) {
            sdk.abort(sessionID).catch(() => {});
          }
          _settleTurn(turn, {
            success: false,
            error: new Error(payload.message),
            reason: isFreeTierLimit ? 'free_tier_limit' : 'quota_exceeded',
          });
        }
      }
      break;
    }
    case 'session.idle':
    case 'session.execution.succeeded':
      if (turn) _settleTurn(turn, { success: true });
      else if (sessionID) _handleSubagentChildTerminal(sessionID, 'completed');
      break;
    case 'session.step.failed':
    case 'session.next.step.failed': {
      // v2 reports the provider failure here before the terminal idle/end
      // event. Normalize it once so the host can show the real reason
      // immediately even if the later listMessages snapshot is delayed or lost.
      const raw = props?.error || props?.data?.error || { message: type };
      const normalized = sdk.normalizeProviderError(raw, 'error');
      if (normalized) {
        emitJsonStringMarker('[TURN_ERROR]', {
          sessionID: sessionID || '',
          ...normalized,
        });
      }
      break;
    }
    case 'session.compacted':
    case 'session.compaction.ended':
    case 'session.next.compaction.ended':
    case 'session.next.compaction.ended.1': {
      // 压缩完成信号。压缩不是 turn（无 active turn / done 信号可达 UI），
      // 必须经 marker 越权上报，宿主才能把结果送到对话列表。
      const compactSessionID = sessionID || props?.info?.id || props?.data?.sessionID || props?.sessionID || '';
      logDebug('session.compacted / compaction.ended:', compactSessionID);
      resolvePendingCompaction(compactSessionID, true);
      emitJsonStringMarker('[SESSION_COMPACT_RESULT]', JSON.stringify({
        sessionID: compactSessionID,
        success: true,
      }));
      break;
    }
    case 'session.compaction.started':
    case 'session.next.compaction.started':
    case 'session.next.compaction.started.1':
    case 'session.compaction.delta':
    case 'session.next.compaction.delta': {
      const compactSessionID = sessionID || props?.data?.sessionID || props?.sessionID || '';
      logDebug(`${type}:`, compactSessionID);
      break;
    }
    case 'session.compaction.failed':
    case 'session.next.compaction.failed':
    case 'session.error':
    case 'session.execution.failed': {
      const isCompactionFailed = type.includes('compaction');
      if (!turn && sessionID) _handleSubagentChildTerminal(sessionID, 'failed');
      const err = props?.error || props?.data?.error || { message: type };
      if (turn && !isCompactionFailed) {
        _settleTurn(turn, { success: false, error: err });
      }
      // 无 active turn 时的错误（如压缩失败）没有其他上报通道，
      // 同样走 marker，宿主按 sessionID + pending 状态过滤。有 active turn
      // 时错误属于当前对话 turn，不能误报为压缩失败。
      if (!turn || isCompactionFailed) {
        const compactSessionID = sessionID || props?.info?.id || props?.data?.sessionID || props?.sessionID || '';
        logDebug(`${type} (compaction / no turn):`, compactSessionID, JSON.stringify(err).substring(0, 200));
        resolvePendingCompaction(compactSessionID, false, err?.message || String(err));
        emitJsonStringMarker('[SESSION_COMPACT_RESULT]', JSON.stringify({
          sessionID: compactSessionID,
          success: false,
          error: err?.message || String(err),
        }));
      }
      break;
    }
    // Permission / question prompts — normalize v1+v2 event shapes into a
    // canonical payload the host can hand straight to the webview dialogs.
    case 'permission.asked':
    case 'permission.v2.asked':
    case 'permissionV2.asked':
    case 'permission.requested': {
      const normalized = normalizePermissionRequest(props);
      logDebug('permission asked:', normalized.permissionId, 'tool:', normalized.tool, 'session:', normalized.sessionId);
      emitJsonStringMarker('[PERMISSION_REQUEST]', normalized);
      break;
    }
    case 'form.created':
    case 'form.asked':
    case 'session.form.create':
    case 'session.form.created':
    case 'question.asked':
    case 'question.v2.asked':
    case 'questionV2.asked': {
      const request = normalizeQuestionRequest(props);
      logDebug('question/form asked:', request.requestId, 'session:', request.sessionId,
        'tool:', JSON.stringify(request.tool), 'questions:', request.questions.length,
        'rawProps:', JSON.stringify(props).slice(0, 500));
      emitJsonStringMarker('[QUESTION_REQUEST]', request);
      break;
    }
    // Lifecycle close events: the server may resolve/cancel a pending prompt
    // on its own (turn aborted/errored/expired, or answered via another
    // surface). The webview cards must be torn down accordingly or they stay
    // pending forever and later fail with "Question request not found".
    case 'form.replied':
    case 'form.discarded':
    case 'form.deleted':
    case 'session.form.cancel':
    case 'question.replied':
    case 'question.v2.replied':
    case 'questionV2.replied':
    case 'question.rejected':
    case 'question.v2.rejected':
    case 'questionV2.rejected': {
      const requestId = props?.requestID ?? props?.formID ?? props?.id ?? '';
      logDebug('question/form closed:', type, requestId);
      if (requestId) {
        // `sessionID` is in-band redundancy: the transport envelope already
        // carries it, but a close event is a *falling edge* (the one that used
        // to arrive with no identity at all), so the host cross-checks the two
        // and prefers the envelope when they disagree.
        emitJsonStringMarker('[QUESTION_CLOSED]', { requestId, sessionID: sessionID || '' });
      }
      break;
    }
    case 'permission.replied':
    case 'permission.v2.replied':
    case 'permissionV2.replied': {
      const permissionId = props?.permissionID ?? props?.requestID ?? props?.id ?? '';
      logDebug('permission closed:', type, permissionId);
      if (permissionId) {
        emitJsonStringMarker('[PERMISSION_CLOSED]', { permissionId, sessionID: sessionID || '' });
      }
      break;
    }
    case 'todo.updated': {
      const todos = props?.todos ?? props?.data?.todos;
      _emitTodos(sessionID || props?.sessionID || props?.data?.sessionID, todos, type);
      break;
    }
    default:
      noteUnhandledEventType(type);
      break;
  }
}

/**
 * Store the full part (needed because `message.part.delta` carries no part.type)
 * and react to tool / step-finish transitions.
 */
function _handlePartUpdated(props, turn) {
  const part = props?.part;
  if (!part || typeof part !== 'object') return;
  const partID = part.id;
  if (partID) turn.parts.set(partID, part);
  const ptype = part.type;
  if (ptype === 'tool') {
    const st = part.state && typeof part.state === 'object' ? part.state : {};
    const inputKeys = st.input && typeof st.input === 'object' ? Object.keys(st.input) : [];
    logDebug('_handlePartUpdated tool:', 'tool:', part.tool || part.name, 'status:', st.status, 'inputKeys:', inputKeys, 'inputPreview:', JSON.stringify(st.input ?? {}).substring(0, 200));
    _handleToolPart(part, turn);
  } else if (ptype === 'step-finish' && part.tokens) {
    turn.stepTokens = part.tokens;
    turn.stepTokensMap.set(part.id || String(turn.stepTokensMap.size), part.tokens);
  }
}

/**
 * Emit content/reasoning deltas. The part type comes from the tracked part
 * (delta events only carry `field` + `delta`).
 */
function _handlePartDelta(props, turn) {
  const partID = props?.partID;
  const delta = props?.delta;
  if (typeof delta !== 'string' || !delta) return;
  const part = partID ? turn.parts.get(partID) : null;
  const ptype = part?.type;
  if (ptype === 'reasoning') {
    emitJsonStringMarker('[THINKING_DELTA]', delta);
  } else if (ptype === 'text' || !ptype) {
    emitJsonStringMarker('[CONTENT_DELTA]', delta);
  }
}

/**
 * Map tool part state transitions onto marker-protocol tool_use / tool_result
 * `[MESSAGE]` blocks. A tool part is emitted once as `tool_use` and once as
 * `tool_result` (when it reaches a terminal state).
 */
export function _handleToolPart(part, turn) {
  const callID = _resolveToolCallId(part, turn);
  let name = part.tool || part.name || 'tool';
  if (name === 'shell') name = 'bash';
  if (callID && turn?.toolNames) {
    turn.toolNames.set(callID, name);
  }
  const state = (part.state && typeof part.state === 'object') ? part.state : {};
  const status = typeof state.status === 'string' ? state.status : '';
  // opencode 的 tool part 生命周期里 state.input 有三种形态：
  //   pending       → ""            （空字符串，参数尚未解析）
  //   input.ended   → "<json 文本>" （仍是字符串）
  //   running 及之后 → { ... }       （真正的参数对象）
  //
  // 旧实现在第一次 part.updated 就 emit，并用 toolUseDone 永久锁死，于是前端
  // 拿到的永远是 input:{} —— Edits 面板从 input 里取不到 path（opencode 的
  // edit/write 用 `path` 字段），编辑列表在对话中和对话结束后都恒为空。
  //
  // 现在改为：参数就绪（对象且非空）后补发一次。宿主的 MessageMerger 按
  // content 块的 id 原地替换（getContentBlockKey → baseContent[idx] = 新块），
  // 所以补发不会产生重复的工具卡片。
  const rawInput = state.input;
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const todoTool = name.toLowerCase();
  if ((todoTool === 'todowrite' || todoTool === 'todo') && Array.isArray(input.todos)) {
    _emitTodos(turn?.sessionId, input.todos, 'message.part.updated');
  }
  const inputJson = JSON.stringify(input);
  const emittedJson = turn.toolUseInput.get(callID);
  const inputReady = Object.keys(input).length > 0;
  logDebug('_handleToolPart:', 'name:', name, 'callID:', callID, 'status:', status,
    'inputKeys:', Object.keys(input), 'inputPreview:', inputJson.substring(0, 300),
    'toolUseDone:', turn.toolUseDone.has(callID), 'toolResultDone:', turn.toolResultDone.has(callID));

  if (emittedJson === undefined || (inputReady && emittedJson !== inputJson)) {
    turn.toolUseInput.set(callID, inputJson);
    turn.toolUseDone.add(callID);
    logDebug('emitToolUseMessage:', 'id:', callID, 'name:', name, 'status:', status, 'inputKeys:', Object.keys(input));
    emitToolUseMessage({ id: callID, name, input });
  }
  if ((status === 'completed' || status === 'error' || status === 'failed')
      && !turn.toolResultDone.has(callID)) {
    turn.toolResultDone.add(callID);
    const isError = status === 'error' || status === 'failed';
    // v2 moved the tool output out of `state.output` and into `state.content`
    // (`[{type:'text', text}]`). Reading only `output` emitted an empty
    // tool_result for every v2 part that reaches its terminal state here, and
    // `toolResultDone` then suppressed the richer `session.tool.success` path —
    // the card stayed empty/spinning even though the result existed. `listMessages`
    // already flattens this shape; reuse the same helper so the two paths agree.
    const output = state.output ?? state.content;
    const content = isError ? (state.error || '') : _flattenToolOutput(output);
    logDebug('emitToolResultMessage:', 'toolUseId:', callID, 'isError:', isError,
      'contentLength:', typeof content === 'string' ? content.length : 0);
    emitToolResultMessage({ toolUseId: callID, isError, content });
  }
  if (isSubagentToolName(name) && callID) {
    _registerSubagentCall({
      parentSessionId: turn.sessionId,
      toolUseId: callID,
      name,
      input,
      metadata: state.metadata,
      output: state.output ?? state.content,
      directory: _sessions.get(turn.sessionId)?.directory,
      terminal: status === 'completed' || status === 'error' || status === 'failed',
      isError: status === 'error' || status === 'failed',
    });
    if (status === 'error' || status === 'failed') _subagentMonitor.drop(callID);
  }
}

/**
 * 收尾兜底：用 turn.parts 中保存的最新 part 再走一次 _handleToolPart。
 * 万一某个 opencode 版本没有为 running 状态推送 message.part.updated，
 * 这里仍能把完整参数补发给前端（MessageMerger 按 id 原地替换，不重复）。
 */
function _reconcileToolParts(turn) {
  for (const part of turn.parts.values()) {
    if (!part || part.type !== 'tool') continue;
    _handleToolPart(part, turn);
  }
}

/**
 * Settle the active turn's promise (once).
 *
 * Idempotent by design (`turn.settled`): a duplicate or late terminal signal —
 * a second `session.idle`, an `error` after a local abort — is a no-op rather
 * than a second settle. The authoritative, session-scoped terminal *marker* is
 * emitted separately by `_emitTurnEndOnce()` from the send/shell completion
 * paths, so the wire order stays `[MESSAGE_END] [STREAM_END] [TURN_END]`.
 *
 * @param {object} turn
 * @param {{ success?: boolean, error?: any, reason?: string }} [opts]
 */
function _settleTurn(turn, { success, error, reason } = {}) {
  if (turn.settled) return;
  turn.settled = true;
  turn.settleReason = reason || (success ? 'idle' : 'error');
  // Tool-part reconciliation can emit `[MESSAGE]` blocks, including on the
  // watchdog path where there is no ambient identity — so give it one.
  runWithIdentity(
    {
      id: turn.requestId ?? null,
      sessionId: turn.sessionId ?? null,
      turnId: turn.turnId ?? null,
    },
    () => _reconcileToolParts(turn),
  );
  // One-shot subagent reconciliation: a background child that finished before
  // its watch was registered (or whose terminal event was missed) is resolved
  // here. This is not a poll — it runs once per settle and only touches calls
  // still pending for this parent.
  _reconcileSubagentsForParent(turn.sessionId);
  turn.success = success;
  if (success) {
    // The turn is over, so the engine has the first user message to name the
    // session from. Fire-and-forget: naming must never delay the turn result.
    void _ensureEngineTitle(turn.sessionId, _sessions.get(turn.sessionId)?.directory);
    // The engine may still be finishing the name; make sure the tab sees it
    // even if the title event was missed.
    _scheduleTitleReconcile(turn.sessionId);
    turn.resolve({ ok: true });
  } else {
    const errMsg = error instanceof Error ? error.message
      : typeof error === 'string' ? error
      : typeof error?.message === 'string' ? error.message
      : typeof error?.data?.message === 'string' ? error.data.message
      : typeof error?.data?.responseBody === 'string' ? error.data.responseBody
      : typeof error?.responseBody === 'string' ? error.responseBody
      : typeof error?.error === 'string' ? error.error
      : typeof error?.error?.message === 'string' ? error.error.message
      : JSON.stringify(error);
    turn.reject(new Error(errMsg));
  }
}

/**
 * Emit the turn's session-scoped terminal marker, exactly once.
 *
 * Called from the send/shell completion paths *after* the stream has been
 * closed, so a turn is declared over only once its last content has been
 * delivered. Carries `sessionId` + `turnId` so the receiver can clear the
 * correct session's running state even when that session is not the active one
 * (INV-C), and so a duplicate/late one for an already-settled turn is ignored.
 *
 * @param {object} turn
 * @param {'idle'|'aborted'|'error'|'timeout'|'disconnected'} reason
 */
function _emitTurnEndOnce(turn, reason) {
  if (!turn || turn.turnEndEmitted) return;
  turn.turnEndEmitted = true;
  runWithIdentity(
    {
      id: turn.requestId ?? null,
      sessionId: turn.sessionId ?? null,
      turnId: turn.turnId ?? null,
    },
    () => emitTurnEnd({ sessionId: turn.sessionId, turnId: turn.turnId, reason }),
  );
}

/**
 * @param {string|null} requestId - the request this turn answers (control plane)
 * @param {string} sessionId - the session the turn belongs to (data plane)
 */
function _createTurn(requestId = null, sessionId = null) {
  const now = Date.now();
  return {
    requestId,
    sessionId,
    // `turnId` is stamped from the first SSE event's `durable.seq`; null until
    // then (and on servers that don't provide one).
    turnId: null,
    settleReason: null,
    turnEndEmitted: false,
    createdAt: now,
    lastActivityAt: now,
    settled: false,
    success: false,
    promise: null,
    resolve: null,
    reject: null,
    aborted: false,
    parts: new Map(),
    toolPartToCallMap: new Map(),
    toolCallToPartMap: new Map(),
    toolUseDone: new Set(),
    // callID → 已发出的 tool_use input 的 JSON 快照。用于判断参数是否已
    // 从 pending 的空值晋级为真正的对象，从而决定是否需要补发。
    toolUseInput: new Map(),
    toolResultDone: new Set(),
    stepTokens: null,
    stepTokensMap: new Map(),
    lastInfo: null,
    assistantMessagesMap: new Map(),
    toolNames: new Map(),
    // 最近一次 session.status:retry 的人话原因，供 180s 兜底文案引用。
    lastStatusMessage: null,
    // callIDs whose question prompt has already been emitted. Tool input
    // arrives incrementally (`session.tool.input` can fire several times for
    // one call), so without this the webview would pop the same dialog again.
    questionPrompted: new Set(),
  };
}

export function _resolveToolCallId(propsOrPart, turn) {
  if (!propsOrPart) return 'tool-1';
  const explicitCallId = propsOrPart.callID || propsOrPart.callId || propsOrPart.toolID || propsOrPart.toolId || propsOrPart.state?.callID;
  const partId = propsOrPart.id;

  if (turn) {
    if (explicitCallId && partId) {
      turn.toolPartToCallMap?.set(partId, explicitCallId);
      turn.toolCallToPartMap?.set(explicitCallId, partId);
      return explicitCallId;
    }
    if (explicitCallId) {
      return explicitCallId;
    }
    if (partId) {
      if (turn.toolPartToCallMap?.has(partId)) {
        return turn.toolPartToCallMap.get(partId);
      }
      return partId;
    }
  }
  return explicitCallId || partId || 'tool-1';
}

// =============================================================================
// Session helpers
// =============================================================================

/**
 * Resolve the session for a request: reuse the caller's id when it exists,
 * otherwise create a new session.
 *
 * `selection` ({ agent, model, variant }) is forwarded to session creation so a
 * brand-new v2 session starts on the agent/model the user picked. v1 ignores it
 * — there the selection travels on every prompt instead.
 *
 * @param {string|null} requestedId
 * @param {string} directory
 * @param {{agent?: string, model?: object|null, variant?: string}} [selection]
 * @returns {Promise<{ id: string, created: boolean }>}
 */
async function _resolveSession(requestedId, directory, selection) {
  if (requestedId) {
    try {
      const existing = await sdk.getSession(requestedId, directory);
      if (existing?.id) {
        const existingDir = existing.location?.directory || existing.directory;
        if (existingDir && directory && sdk.normalizeDirForMatch(existingDir) !== sdk.normalizeDirForMatch(directory)) {
          logWarn('opencode-daemon-service', `Session ${requestedId} directory mismatch: session belongs to ${existingDir}, requested directory is ${directory}. Discarding stale session ID and creating new session.`);
        } else {
          trackSession(existing.id, { directory: existingDir || directory, revert: existing.revert });
          return { id: existing.id, created: false };
        }
      }
    } catch (err) {
      logDebug('getSession failed, will create:', err?.message || err);
    }
  }
  const created = await sdk.createSession('', directory, selection);
  const id = created?.id;
  if (!id) {
    throw new Error(`opencode createSession returned no id: ${JSON.stringify(created)}`);
  }
  trackSession(id, { directory, revert: created.revert });
  return { id, created: true };
}

/**
 * Session-scoped agent/model for opencode v2.
 *
 * v2 stores the selection on the session, so it must be pushed at three points
 * rather than on every turn:
 *
 *   1. session creation   — handled by `createSession(..., selection)`
 *   2. the user changing it — the next send sees a different key
 *   3. switching back to a session (tab switch) — `_lastSelectionSessionId`
 *      differs, which forces one re-apply even when the values look identical
 *
 * The point of (3) is calibration: a user may have changed the model from the
 * TUI, so the plugin's view can be stale. Re-applying on activation makes the
 * two converge without paying a round-trip on every message.
 *
 * Deliberately NOT a value cache that suppresses calls: `_appliedSelections`
 * only answers "has this exact selection been pushed for this session since it
 * was last activated". Same session + same selection + no switch => skip.
 */
let _lastSelectionSessionId = null;
const _appliedSelections = new Map();
/**
 * Upper bound for the marker map.
 *
 * The daemon has no session-close hook (the host closes tabs locally), so an
 * unbounded map would grow with every session ever touched. Markers are tiny
 * and a miss only costs one redundant re-apply, so evicting the oldest is safe.
 */
const _APPLIED_SELECTION_LIMIT = 256;

/** Key used to detect that the selection changed within one activation. */
function _selectionKey(agent, modelRef, variant) {
  return [
    agent || '',
    modelRef ? `${modelRef.providerID}/${modelRef.id}` : '',
    variant || '',
  ].join('|');
}

async function _syncSessionSelection(sessionId, { agent, model, variant }) {
  // v1 carries agent/model/variant on the prompt itself; nothing to push.
  if (!engineRegistry.isV2()) return;
  if (!sessionId) return;

  const modelRef = sdk.toV2ModelRef(model, variant);
  const key = _selectionKey(agent, modelRef, variant);
  const switched = _lastSelectionSessionId !== sessionId;
  _lastSelectionSessionId = sessionId;

  if (!switched && _appliedSelections.get(sessionId) === key) {
    return;
  }

  try {
    if (agent) await sdk.setSessionAgent(sessionId, agent);
    if (modelRef) await sdk.setSessionModel(sessionId, modelRef);
    _appliedSelections.set(sessionId, key);
    if (_appliedSelections.size > _APPLIED_SELECTION_LIMIT) {
      const oldest = _appliedSelections.keys().next().value;
      if (oldest !== undefined) _appliedSelections.delete(oldest);
    }
    logDebug(
      `session selection applied: session=${sessionId}`
      + ` agent=${agent || '-'} model=${modelRef ? `${modelRef.providerID}/${modelRef.id}` : '-'}`
      + ` variant=${variant || '-'}${switched ? ' (reactivated)' : ''}`
    );
  } catch (err) {
    // Never block the turn on a sync failure: the prompt still works, it may
    // just run on the previously selected agent/model. Clear the marker so the
    // next send retries.
    _appliedSelections.delete(sessionId);
    logDebug(`session selection sync failed: session=${sessionId}`, err?.message || err);
  }
}

/** Forget a closed session's selection marker (kept for hosts that can signal it). */
export function forgetSessionSelection(sessionId) {
  if (!sessionId) return;
  _appliedSelections.delete(sessionId);
  if (_lastSelectionSessionId === sessionId) _lastSelectionSessionId = null;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Send a message over the persistent opencode connection.
 *
 * @param {object} [params] - { sessionId?, message, model?, mode?, cwd?, attachments?, prompt? }
 */
export async function sendMessagePersistent(params = {}) {
  const safeParams = params || {};
  const startedAt = Date.now();

  const directory = selectWorkingDirectory(safeParams.cwd || null);
  await _ensureReady(directory);

  const rawMessage = typeof safeParams.message === 'string' ? safeParams.message : '';
  const requestedId = (typeof safeParams.sessionId === 'string' && safeParams.sessionId.trim())
    ? safeParams.sessionId.trim()
    : null;
  const agent = resolveAgentParam(safeParams);
  const model = resolveModelParam(safeParams.model);
  // 推理力度 → opencode model variant（docs/models#variants，按模型变化）。
  // 'default' is not a real variant: it means "send none" so opencode applies the
  // model's own catalog settings (a session with no variant reports back
  // `variant: "default"`). Normalising it here keeps v1 (prompt body) and v2
  // (Model.Ref) identical — neither engine ever receives the literal 'default'.
  const rawEffort = (typeof safeParams.reasoningEffort === 'string') ? safeParams.reasoningEffort.trim() : '';
  const variant = (rawEffort && rawEffort !== 'default') ? rawEffort : undefined;

  // 斜杠命令经 safeParams.command 走 /session/{id}/command（见下方分支）。
  if (safeParams.prompt) {
    logDebug('prompt (legacy slash-command text) ignored:', safeParams.prompt);
  }

  // ── Resolve/create the session ──────────────────────────────────────────
  const { id: sessionId, created } = await _resolveSession(
    requestedId,
    directory,
    { agent, model, variant },
  );
  // v2 keeps agent/model/variant on the session, so a fresh session already has
  // them (seeded at creation) and an existing one needs them re-applied when the
  // user changed the selection or switched back to this session.
  if (!created) {
    await _syncSessionSelection(sessionId, { agent, model, variant });
  }
  // Announce the canonical id before binding it. The marker is the host's
  // bootstrap signal: it must still carry the request id but no session, so the
  // host can attach the brand-new session to the pending send that created it
  // (docs/full-refactor-architecture-plan.md §8.2.1). Every later line is
  // stamped with the session bound below.
  emitSessionId(sessionId);
  bindSession(sessionId);

  // ── Build file parts for attachments (images + any other file type) ────
  // opencode FilePartInput: { type:'file', mime, filename?, url }
  // url is a `data:` URL (content travels inline, works against remote
  // servers too) or a `file://` URL for path-only @-references.
  // Non-multimodal text/code files are decoded to textAttachments and inlined
  // into promptText to prevent 400 errors from LLM providers.
  let fileParts = [];
  let textAttachments = [];
  let attachmentErrors = [];
  try {
    const built = buildFileParts(safeParams.attachments || []);
    fileParts = built.parts;
    textAttachments = built.textAttachments || [];
    attachmentErrors = built.errors;
  } catch (err) {
    logDebug('build attachment file parts failed:', err?.message || err);
    attachmentErrors.push(`attachments: ${err?.message || err}`);
  }
  for (const message of attachmentErrors) {
    console.error(`[opencode] attachment skipped — ${message}`);
    logDebug('attachment skipped:', message);
  }

  // opencode requires non-empty text even for attachment-only turns.
  const onlyImages = fileParts.length > 0
    && textAttachments.length === 0
    && fileParts.every((p) => String(p.mime).startsWith('image/'));
  const fallbackText = onlyImages
    ? GROK_IMAGE_ONLY_FALLBACK_TEXT
    : ATTACHMENT_ONLY_FALLBACK_TEXT;
  let promptText = rawMessage.trim();
  if (!promptText && (fileParts.length > 0 || textAttachments.length > 0)) {
    promptText = fallbackText;
  }

  if (textAttachments.length > 0) {
    const inlined = formatInlinedAttachments(textAttachments);
    promptText = (promptText ? promptText + inlined : inlined).trim();
  }

  // ── Normalize / Validate command parameter ──────────────────────────────
  let validSlashCommand = null;
  let commandArgs = '';
  if (typeof safeParams.command === 'string' && safeParams.command.trim()) {
    const rawCmd = safeParams.command.trim();
    // Valid slash command identifier: letters, numbers, _, -
    if (/^[a-zA-Z0-9_-]+$/.test(rawCmd)) {
      validSlashCommand = rawCmd;
      commandArgs = typeof safeParams.commandArguments === 'string' ? safeParams.commandArguments : '';
    } else {
      logDebug('Invalid slash command name ignored, falling back to prompt:', rawCmd);
      const fallbackMsg = rawCmd.startsWith('/') ? rawCmd : `/${rawCmd}`;
      const extraArgs = typeof safeParams.commandArguments === 'string' && safeParams.commandArguments.trim()
        ? ` ${safeParams.commandArguments.trim()}`
        : '';
      const combined = `${fallbackMsg}${extraArgs}`;
      promptText = promptText ? `${combined}\n${promptText}` : combined;
    }
  }

  if (!validSlashCommand && !promptText && fileParts.length === 0) {
    const errorMsg = attachmentErrors.length > 0
      ? `No supported attachments: ${attachmentErrors.join('; ')}`
      : 'Message content is empty';
    console.log(JSON.stringify({ success: false, error: errorMsg, elapsedMs: Date.now() - startedAt }));
    emitSendError(errorMsg, 'OpenCode');
    return;
  }

  // ── Route ! shell command directly to sendShellPersistent ───────────────
  if (!validSlashCommand && fileParts.length === 0 && textAttachments.length === 0 && promptText.startsWith('!') && promptText.length > 1) {
    const rawShellCmd = promptText.slice(1).trim();
    if (rawShellCmd) {
      logDebug('sendMessagePersistent routing ! command to sendShellPersistent:', rawShellCmd);
      return sendShellPersistent({
        ...safeParams,
        sessionId,
        command: rawShellCmd,
      });
    }
  }

  // ── Register turn + emit stream-start markers ───────────────────────────
  beginStream(sessionId);

  const currentReqId = requestContext.getStore()?.id ?? null;
  const turn = _createTurn(currentReqId, sessionId);
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = resolve;
    turn.reject = reject;
  });
  _activeTurns.set(sessionId, turn);

  logDebug(
    `send session=${sessionId} agent=${agent || '-'} model=${safeParams.model || '-'}`
    + ` command=${validSlashCommand || '-'} attachments=${fileParts.length}`
    + ` skipped=${attachmentErrors.length} promptLen=${promptText.length}`
  );

  try {
    if (validSlashCommand) {
      // opencode 原生斜杠命令：POST /session/{id}/command。回复经同一
      // SSE 事件流返回，turn/流式标记在上面已注册，与普通消息完全一致。
      // 注意：该端点 model 要求字符串（"provider/model"），与 promptAsync
      // 的 {providerID, modelID} 对象不同——传原始字符串。
      await sdk.sendCommand(sessionId, validSlashCommand, {
        arguments: commandArgs,
        model: typeof safeParams.model === 'string' && safeParams.model.trim() ? safeParams.model.trim() : undefined,
        agent,
        variant,
        directory,
        parts: fileParts,
      });
    } else {
      await sdk.promptAsync(sessionId, promptText, {
        model: model || undefined,
        agent,
        variant,
        directory,
        parts: fileParts,
      });
    }

    // Wait for session.idle / session.error / abort to settle the turn.
    await turn.promise;
  } catch (err) {
    if (turn.aborted) {
      // Graceful abort — clean "interrupted" result, no error toast.
      endStream({ sessionId });
      _emitTurnEndOnce(turn, 'aborted');
      console.log(JSON.stringify({ success: false, error: 'User interrupted', elapsedMs: Date.now() - startedAt }));
      return;
    }
    endStream({ sessionId });
    _emitTurnEndOnce(turn, turn.settleReason || 'error');
    const rawMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    let message = rawMsg;
    try {
      const parsed = JSON.parse(rawMsg);
      message = parsed?.message
        || parsed?.data?.message
        || parsed?.data?.responseBody
        || parsed?.responseBody
        || parsed?.error?.message
        || parsed?.error
        || rawMsg;
    } catch { /* not JSON, keep raw */ }
    console.log(JSON.stringify({ success: false, error: message, elapsedMs: Date.now() - startedAt }));
    emitSendError(message, 'OpenCode');
    return;
  } finally {
    _activeTurns.delete(sessionId);
    // 本回合产生了新的 token 用量，context usage 缓存失效。
    _contextUsageCache.delete(`${sessionId}::${directory || ''}`);
  }

  // ── Success: usage + full message + end markers ─────────────────────────
  // turn.lastInfo 由 SSE message.updated 积累（含 tokens）。它就绪时直接用，
  // 只有缺失才回退全量 listMessages——长会话每回合结束做一次 O(全部历史)
  // 的拉取是内存峰值与延迟的稳定增长点。
  const finalMessage = (turn.lastInfo && turn.lastInfo.tokens)
    ? turn.lastInfo
    : await _fetchFinalAssistantMessage(sessionId, directory);
  const usage = aggregateTurnUsage(turn, finalMessage);
  if (usage) emitUsage(usage);
  endStream({ sessionId, message: finalMessage || turn.lastInfo || { sessionID: sessionId } });
  _emitTurnEndOnce(turn, turn.aborted ? 'aborted' : 'idle');
  console.log(JSON.stringify({ success: true, sessionId }));
}

/**
 * Run a shell command in the session context (opencode native `!` semantics).
 * The server executes the command, records it as a bash tool part, and streams
 * an AI reply over SSE — same lifecycle as sendMessagePersistent.
 *
 * @param {object} [params] - { sessionId?, command, model?, mode?, cwd? }
 */
export async function sendShellPersistent(params = {}) {
  const safeParams = params || {};
  const startedAt = Date.now();

  const directory = selectWorkingDirectory(safeParams.cwd || null);
  await _ensureReady(directory);

  const rawCommand = typeof safeParams.command === 'string' ? safeParams.command.trim() : '';
  const requestedId = (typeof safeParams.sessionId === 'string' && safeParams.sessionId.trim())
    ? safeParams.sessionId.trim()
    : null;
  const agent = resolveAgentParam(safeParams);
  const model = resolveModelParam(safeParams.model);

  if (!rawCommand) {
    console.log(JSON.stringify({ success: false, error: 'Empty shell command', elapsedMs: Date.now() - startedAt }));
    return;
  }

  // ── Resolve/create the session ──────────────────────────────────────────
  const { id: sessionId, created } = await _resolveSession(
    requestedId,
    directory,
    { agent, model },
  );
  // Shell commands run under the session's agent too (plan mode gates bash), so
  // the same activation-time sync applies here.
  if (!created) {
    await _syncSessionSelection(sessionId, { agent, model });
  }
  emitSessionId(sessionId);
  bindSession(sessionId);

  // ── Register turn + emit stream-start markers ───────────────────────────
  beginStream(sessionId);

  const currentReqId = requestContext.getStore()?.id ?? null;
  const turn = _createTurn(currentReqId, sessionId);
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = resolve;
    turn.reject = reject;
  });
  _activeTurns.set(sessionId, turn);

  logDebug(`shell session=${sessionId} agent=${agent || '-'} cmdLen=${rawCommand.length}`);

  try {
    await sdk.shellAsync(sessionId, rawCommand, {
      model: model || undefined,
      agent,
      directory,
    });

    // Wait for session.shell.ended / session.idle / session.error / abort to settle the turn.
    let timerId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error('Shell execution timed out after 60s')), 60000);
    });
    try {
      await Promise.race([turn.promise, timeoutPromise]);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  } catch (err) {
    if (turn.aborted) {
      endStream({ sessionId });
      _emitTurnEndOnce(turn, 'aborted');
      console.log(JSON.stringify({ success: false, error: 'User interrupted', elapsedMs: Date.now() - startedAt }));
      return;
    }
    endStream({ sessionId });
    _emitTurnEndOnce(turn, turn.settleReason === 'disconnected' ? 'disconnected' : 'error');
    const rawMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    let message = rawMsg;
    try {
      const parsed = JSON.parse(rawMsg);
      message = parsed?.message || parsed?.data?.message || parsed?.error?.message || rawMsg;
    } catch { /* not JSON, keep raw */ }
    console.log(JSON.stringify({ success: false, error: message, elapsedMs: Date.now() - startedAt }));
    emitSendError(message, 'OpenCode');
    return;
  } finally {
    _activeTurns.delete(sessionId);
  }

  // ── Success: usage + full message + end markers ─────────────────────────
  // turn.lastInfo 由 SSE message.updated 积累（含 tokens）。它就绪时直接用，
  // 只有缺失才回退全量 listMessages——长会话每回合结束做一次 O(全部历史)
  // 的拉取是内存峰值与延迟的稳定增长点。
  const finalMessage = (turn.lastInfo && turn.lastInfo.tokens)
    ? turn.lastInfo
    : await _fetchFinalAssistantMessage(sessionId, directory);
  const usage = aggregateTurnUsage(turn, finalMessage);
  if (usage) emitUsage(usage);
  endStream({ sessionId, message: finalMessage || turn.lastInfo || { sessionID: sessionId } });
  _emitTurnEndOnce(turn, turn.aborted ? 'aborted' : 'idle');
  console.log(JSON.stringify({ success: true, sessionId }));
}

/**
 * Fetch the final assistant message for a completed turn (authoritative source
 * for tokens/parts in `[MESSAGE_END]`).
 */
async function _fetchFinalAssistantMessage(sessionId, directory) {
  try {
    // 仅用于补齐 token 统计，拿不到就退回 turn 自身的数据。
    const messages = await sdk.listMessages(sessionId, directory, { tolerateError: true });
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        // session.messages returns { info, parts } entries; info is the
        // assistant-message object (id/role/tokens/modelID/providerID/sessionID).
        const info = m && typeof m.info === 'object' ? m.info : m;
        if (info?.role === 'assistant') return info;
      }
    }
  } catch (err) {
    logDebug('listMessages failed:', err?.message || err);
  }
  return null;
}

/**
 * Pre-warm: ensure `opencode serve` + SDK client + SSE subscription are ready
 * and resolve (or create) a session so the host can reuse its id.
 *
 * @param {object} [params] - { sessionId?, cwd? }
 */
export async function preconnectPersistent(params = {}) {
  const safeParams = params || {};
  const directory = selectWorkingDirectory(safeParams.cwd || null);
  await _ensureReady(directory);

  const requestedId = (typeof safeParams.sessionId === 'string' && safeParams.sessionId.trim())
    ? safeParams.sessionId.trim()
    : null;
  if (requestedId) {
    const { id: sessionId } = await _resolveSession(requestedId, directory);
    bindSession(sessionId);
    emitSessionId(sessionId);
    console.log(`[STATUS] preconnect ready sessionId=${sessionId} server=${serveManager.getServerUrl() || '-'}`);
  } else {
    console.log(`[STATUS] preconnect ready server=${serveManager.getServerUrl() || '-'}`);
  }
}

/**
 * Abort the active turn(s). Bypasses the command queue in daemon.js (runs
 * immediately, like the claude abort path).
 *
 * The turn is settled **locally and immediately** in addition to the HTTP
 * abort. Waiting for the server to echo a terminal event is not sufficient:
 * opencode does not always answer an abort, and the old code then sat on
 * `TURN_TIMEOUT_MS` (180 s) with the UI still spinning — that is literally the
 * "stop button doesn't stop the spinner" symptom. Settling here makes the local
 * teardown independent of server behaviour; the HTTP abort still runs so the
 * server stops generating.
 *
 * @param {string} [targetSessionId] - Optional session ID to abort. If omitted, aborts all active turns.
 */
export async function abortCurrentTurn(targetSessionId) {
  // 防御：opencode 只接受 `ses_*` 形式的 session id，其它值会被服务端以
  // `Expected a string starting with "ses"` 拒绝。而这里的失败是静默的
  // （catch 里只 logDebug），对外表现为「UI 已经停止 loading、服务端仍在重试」。
  // 历史上 channelId（随机 UUID）正是从这个口子进来的，所以在此收口：
  // 非 `ses_` 的目标一律降级为「中止所有活跃 turn」。
  let target = typeof targetSessionId === 'string' ? targetSessionId.trim() : '';
  if (target && !target.startsWith('ses')) {
    logDebug(`abort: non-session target "${target}" ignored (expected ses_*); falling back to all active turns`);
    target = '';
  }
  const sessions = target
    ? [target] // 只要指定了 target，即使 _activeTurns 没命中（或还在排队初始化），也无条件通知底层服务端 abort
    : [..._activeTurns.keys()];
  if (sessions.length === 0) return;
  for (const sessionId of sessions) {
    const turn = _activeTurns.get(sessionId);
    if (turn) {
      turn.aborted = true;
      // Rejects the awaiting send → it closes the stream and emits
      // `[TURN_END] {reason:'aborted'}` in the normal, ordered position.
      _settleTurn(turn, {
        success: false,
        error: new Error('User interrupted'),
        reason: 'aborted',
      });
    }
    try {
      await sdk.abort(sessionId);
    } catch (err) {
      logDebug('abort failed:', err?.message || err);
    }
  }
}

/** @type {Map<string, { usedTokens: number|null, maxTokens: number|null, at: number }>} */
const _contextUsageCache = new Map();
const CONTEXT_USAGE_CACHE_TTL_MS = 30_000;

/**
 * Best-effort context usage for a session. opencode does not expose a context
 * window the way claude does — surface token usage from the last assistant
 * message (used/max when known). 结果按 sessionId+directory 做 30s TTL 缓存：
 * 该查询可能被前端频繁触发，而全量 listMessages 在长会话上代价很高。
 *
 * @param {object} [params] - { sessionId?, cwd? }
 */
export async function getContextUsagePersistent(params = {}) {
  const safeParams = params || {};
  let usedTokens = null;
  let maxTokens = null;

  const sessionId = (typeof safeParams.sessionId === 'string' && safeParams.sessionId.trim())
    ? safeParams.sessionId.trim()
    : null;
  if (sessionId) {
    const directory = selectWorkingDirectory(safeParams.cwd || null);
    const cacheKey = `${sessionId}::${directory || ''}`;
    const cached = _contextUsageCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CONTEXT_USAGE_CACHE_TTL_MS) {
      usedTokens = cached.usedTokens;
      maxTokens = cached.maxTokens;
    } else {
      try {
        // 用量估算的兜底：失败就退回缓存/默认值，不要中断状态推送。
        const messages = await sdk.listMessages(sessionId, directory, { tolerateError: true });
        let foundModelId = safeParams.model || null;
        let foundProviderId = null;
        if (Array.isArray(messages)) {
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i];
            const info = m && typeof m.info === 'object' ? m.info : m;
            const isAssistant = info?.role === 'assistant' || info?.type === 'assistant';
            if (isAssistant && info?.tokens) {
              const cache = info.tokens.cache && typeof info.tokens.cache === 'object' ? info.tokens.cache : {};
              const inp = Number(info.tokens.input) || 0;
              const out = Number(info.tokens.output) || 0;
              const rzn = Number(info.tokens.reasoning) || 0;
              const cr = Number(cache.read) || 0;
              const cw = Number(cache.write) || 0;
              usedTokens = Number(info.tokens.total) || (inp + out + rzn + cr + cw);
              foundModelId = info.modelID || foundModelId;
              foundProviderId = info.providerID || null;
              break;
            }
          }
        }
        if (foundModelId) {
          try {
            const providers = await sdk.getProviders(directory);
            if (Array.isArray(providers)) {
              for (const p of providers) {
                if (foundProviderId && p?.id !== foundProviderId) continue;
                const bareModel = typeof foundModelId === 'string' ? foundModelId.split('/').pop() : '';
                const mInfo = p?.models?.[foundModelId]
                  || (bareModel ? p?.models?.[bareModel] : null)
                  || Object.values(p?.models || {}).find(m => m?.id === foundModelId || m?.id === bareModel || m?.name === foundModelId || m?.name === bareModel);
                if (mInfo?.limit?.context) {
                  const limit = Number(mInfo.limit.context);
                  if (Number.isFinite(limit) && limit > 0) {
                    maxTokens = limit;
                    break;
                  }
                }
              }
            }
          } catch (e) {
            logDebug('getContextUsage getProviders failed:', e?.message || e);
          }
        }
        _contextUsageCache.set(cacheKey, { usedTokens, maxTokens, at: Date.now() });
        if (_contextUsageCache.size > 100) {
          const oldest = _contextUsageCache.keys().next().value;
          if (oldest !== undefined) _contextUsageCache.delete(oldest);
        }
      } catch (err) {
        logDebug('getContextUsage listMessages failed:', err?.message || err);
      }
    }
  }
  console.log(JSON.stringify({ success: true, data: { usedTokens, maxTokens, sessionId: sessionId || null } }));
}

/**
 * Shut down the persistent opencode runtime: abort any active turns, close the
 * SSE subscription and stop the serve process.
 */
export async function shutdownPersistentRuntimes() {
  // Abort active turns so awaiting sends settle (as "interrupted").
  for (const sessionId of [..._activeTurns.keys()]) {
    const turn = _activeTurns.get(sessionId);
    if (turn) turn.aborted = true;
    try {
      await sdk.abort(sessionId);
    } catch {
      // best-effort
    }
  }
  _activeTurns.clear();

  // Close every per-directory SSE subscription.
  for (const sub of _sseSubs.values()) {
    try {
      sub.controller.abort();
    } catch {
      // best-effort
    }
  }
  _sseSubs.clear();

  try {
    await serveManager.stop();
  } catch (err) {
    logDebug('serve stop failed:', err?.message || err);
  }
  _serveStarted = false;
  sdk.resetClient();
  _sessions.clear();
}
