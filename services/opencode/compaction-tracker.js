/**
 * compaction-tracker.js
 *
 * Tracks pending session compaction operations in OpenCode v1 and v2.
 * In v2, POST /api/session/{sessionId}/compact is an asynchronous endpoint
 * that returns 204 No Content immediately while the actual compaction
 * runs in the background and emits SSE events:
 *   - session.compaction.ended / session.next.compaction.ended (success)
 *   - session.compaction.failed / session.next.compaction.failed (failure)
 *
 * In v1, the summarize HTTP request itself waits for the LLM, but its response
 * can still race the terminal SSE event. The pending waiter is registered
 * before the request so a terminal that lands first is not lost; its timeout is
 * armed only after the HTTP call returns, so a long compaction is not cut off
 * by the v2 terminal budget.
 *
 * This tracker allows summarizeSession to await the true outcome.
 */

const _pendingCompaction = new Map();

/**
 * Register a compaction waiter.
 *
 * @param {string} sessionId
 * @param {number} [timeoutMs] 0 registers the waiter without a timeout. The v1
 *   summarize path uses this while the synchronous HTTP request is in flight,
 *   then calls armPendingCompactionTimeout once it is waiting for SSE.
 */
export function registerPendingCompaction(sessionId, timeoutMs = 60000) {
  if (!sessionId) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        _pendingCompaction.delete(sessionId);
        reject(new Error(`Session compaction timed out after ${timeoutMs}ms`));
      }, timeoutMs)
      : null;

    if (_pendingCompaction.has(sessionId)) {
      const previous = _pendingCompaction.get(sessionId);
      if (previous.timer) clearTimeout(previous.timer);
    }
    _pendingCompaction.set(sessionId, { resolve, reject, timer });
  });
}

/** Start (or restart) the timeout once the waiter is waiting for a terminal. */
export function armPendingCompactionTimeout(sessionId, timeoutMs = 60000) {
  if (!sessionId || timeoutMs <= 0) return false;
  const pending = _pendingCompaction.get(sessionId);
  if (!pending) return false;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    if (_pendingCompaction.get(sessionId) !== pending) return;
    _pendingCompaction.delete(sessionId);
    pending.reject(new Error(`Session compaction timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  pending.timer.unref?.();
  return true;
}

export function resolvePendingCompaction(sessionId, success, error) {
  if (!sessionId) return false;
  const pending = _pendingCompaction.get(sessionId);
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    _pendingCompaction.delete(sessionId);
    if (success) {
      pending.resolve(true);
    } else {
      pending.reject(new Error(error || 'Session compaction failed'));
    }
    return true;
  }
  return false;
}

export function isCompactionPending(sessionId) {
  return _pendingCompaction.has(sessionId);
}

export function clearPendingCompactions() {
  for (const [, pending] of _pendingCompaction) {
    clearTimeout(pending.timer);
  }
  _pendingCompaction.clear();
  _manualCompaction.clear();
}

// ── Manual (/compact) compaction tracking ──────────────────────────────────
//
// The engine runs a user-issued `/compact` through the same pipeline as its own
// context-window compaction, and its SSE payloads carry no trigger identity —
// `reason` is either absent or "auto". The host needs the distinction to word
// the indicator, so `summarizeSession` marks the session before it starts the
// request and the SSE handlers read (and then clear) that mark.
//
// The TTL is a safety net only: a compaction that never reports ended/failed
// must not leave the session permanently labelled "manual".
const MANUAL_TTL_MS = 5 * 60 * 1000;
const _manualCompaction = new Map();

export function markManualCompaction(sessionId, timeoutMs = MANUAL_TTL_MS) {
  if (!sessionId) return;
  _manualCompaction.set(sessionId, Date.now() + timeoutMs);
}

export function isManualCompaction(sessionId) {
  if (!sessionId) return false;
  const expiresAt = _manualCompaction.get(sessionId);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    _manualCompaction.delete(sessionId);
    return false;
  }
  return true;
}

export function clearManualCompaction(sessionId) {
  if (!sessionId) return;
  _manualCompaction.delete(sessionId);
}

/**
 * The trigger for the compaction of `sessionId`, as reported on the wire.
 *
 * A live manual mark always wins: the engine cannot distinguish the two, so its
 * own `reason` field is only trusted when no manual request is outstanding.
 *
 * @param {string} sessionId
 * @param {string} [engineReason] the engine's own `reason`, if any
 * @returns {'manual'|'auto'|string}
 */
export function compactionReasonFor(sessionId, engineReason) {
  if (isManualCompaction(sessionId)) return 'manual';
  return engineReason || 'auto';
}
