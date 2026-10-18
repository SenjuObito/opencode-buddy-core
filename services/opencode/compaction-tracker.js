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
}
