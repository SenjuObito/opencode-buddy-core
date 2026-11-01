/**
 * compaction-tracker.js
 *
 * Tracks pending session compaction operations in OpenCode v2.
 * In v2, POST /api/session/{sessionId}/compact is an asynchronous endpoint
 * that returns 204 No Content immediately while the actual compaction
 * runs in the background and emits SSE events:
 *   - session.compaction.ended / session.next.compaction.ended (success)
 *   - session.compaction.failed / session.next.compaction.failed (failure)
 *
 * This tracker allows summarizeSession to await the true outcome.
 */

const _pendingCompaction = new Map();

export function registerPendingCompaction(sessionId, timeoutMs = 60000) {
  if (!sessionId) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingCompaction.delete(sessionId);
      reject(new Error(`Session compaction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (_pendingCompaction.has(sessionId)) {
      clearTimeout(_pendingCompaction.get(sessionId).timer);
    }
    _pendingCompaction.set(sessionId, { resolve, reject, timer });
  });
}

export function resolvePendingCompaction(sessionId, success, error) {
  if (!sessionId) return false;
  const pending = _pendingCompaction.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
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
