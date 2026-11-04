import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  requestContext,
  currentContext,
  bindSession,
  bindSeq,
  runWithIdentity,
  EMPTY_CONTEXT,
} from '../../request-context.js';
import * as registry from './engine-registry.js';
import { setBaseUrl, resetClient } from './opencode-sdk-client.js';
import {
  markManualCompaction,
  clearManualCompaction,
  registerPendingCompaction,
  isCompactionPending,
  clearPendingCompactions,
} from './compaction-tracker.js';
import {
  _handleEvent,
  _activeTurns,
  _createTurn,
  _settleTurn,
  _emitTurnEndOnce,
  _trackSession,
  _resolveSession,
} from './opencode-daemon-service.js';

/**
 * These tests pin the contract that broke: session identity must be present on
 * every session-scoped line, and must NEVER be inferred from "the current
 * session". See docs/multi-session-identity-refactoring.md (INV-A).
 */

/** Capture every line emitted through the marker protocol during `fn`. */
function captureEmits(fn) {
  const captured = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    captured.push({ line: text.trim(), ctx: currentContext() });
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return captured;
}

test('currentContext: empty outside any record', () => {
  assert.deepEqual(currentContext(), { ...EMPTY_CONTEXT });
});

test('bindSession/bindSeq mutate the ACTIVE record only', () => {
  requestContext.run({ id: '7', sessionId: null, turnId: null, seq: null }, () => {
    assert.equal(bindSession('ses_a'), true);
    assert.equal(bindSeq(41), true);
    assert.deepEqual(currentContext(), { id: '7', sessionId: 'ses_a', turnId: null, seq: 41 });

    bindSession('ses_b', { turnId: 12 });
    assert.deepEqual(currentContext(), { id: '7', sessionId: 'ses_b', turnId: 12, seq: 41 });
  });
  // Record is scoped — nothing leaks out.
  assert.deepEqual(currentContext(), { ...EMPTY_CONTEXT });
});

test('bindSession returns false (does not silently succeed) with no active record', () => {
  assert.equal(bindSession('ses_a'), false);
  assert.equal(bindSeq(1), false);
});

test('runWithIdentity installs a full record for the duration of fn', () => {
  let inner = null;
  runWithIdentity({ sessionId: 'ses_a', turnId: 5, seq: 9 }, () => {
    inner = currentContext();
  });
  assert.deepEqual(inner, { id: null, sessionId: 'ses_a', turnId: 5, seq: 9 });
  assert.deepEqual(currentContext(), { ...EMPTY_CONTEXT });
});

test('SSE event with NO active turn still carries its own session identity', () => {
  // The historical bug: an event whose payload names a session but which has no
  // active turn used to fall through to `fn()` with no record at all, so its
  // output was attributed to whatever turn happened to be running.
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'permission.asked',
      properties: {
        sessionID: 'ses_other',
        id: 'per_x',
        action: 'read',
        resources: ['a.txt'],
      },
      durable: { aggregateID: 'ses_other', seq: 3 },
    });
  });

  const permission = emitted.find((e) => e.line.startsWith('[PERMISSION_REQUEST]'));
  assert.ok(permission, 'permission request must be emitted');
  assert.equal(permission.ctx.sessionId, 'ses_other');
  assert.equal(permission.ctx.id, null, 'no turn ⇒ no request id to claim');
  assert.equal(permission.ctx.seq, 3);
});

test('SSE session.updated with properties.info.id emits [SESSION_TITLE] with session identity', () => {
  _trackSession('ses_title_test', { directory: 'test-dir' });
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.updated',
      properties: {
        info: {
          id: 'ses_title_test',
          title: 'Greeting',
        },
      },
      durable: { aggregateID: 'ses_title_test', seq: 8 },
    });
  });

  const titleEvt = emitted.find((e) => e.line.startsWith('[SESSION_TITLE]'));
  assert.ok(titleEvt, '[SESSION_TITLE] must be emitted');
  assert.equal(titleEvt.ctx.sessionId, 'ses_title_test');
  assert.equal(titleEvt.ctx.id, null);
  assert.equal(titleEvt.ctx.seq, 8);
  const parsed = JSON.parse(titleEvt.line.replace(/^\[SESSION_TITLE\]\s*/, ''));
  const payload = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  assert.equal(payload.sessionId, 'ses_title_test');
  assert.equal(payload.title, 'Greeting');
});

test('SSE session.renamed emits [SESSION_TITLE] with session identity', () => {
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.renamed',
      properties: {
        sessionID: 'ses_renamed_test',
        title: 'New Discussion',
      },
      durable: { aggregateID: 'ses_renamed_test', seq: 12 },
    });
  });

  const titleEvt = emitted.find((e) => e.line.startsWith('[SESSION_TITLE]'));
  assert.ok(titleEvt, '[SESSION_TITLE] must be emitted for session.renamed');
  assert.equal(titleEvt.ctx.sessionId, 'ses_renamed_test');
  assert.equal(titleEvt.ctx.seq, 12);
  const parsed = JSON.parse(titleEvt.line.replace(/^\[SESSION_TITLE\]\s*/, ''));
  const payload = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  assert.equal(payload.sessionId, 'ses_renamed_test');
  assert.equal(payload.title, 'New Discussion');
});

// ── Revert lifecycle (v1 session info + v2 events) ──────────────────────────

function revertPayload(emitted) {
  const evt = emitted.find((e) => e.line.startsWith('[REVERT_STATE]'));
  assert.ok(evt, '[REVERT_STATE] must be emitted');
  const parsed = JSON.parse(evt.line.replace(/^\[REVERT_STATE\]\s*/, ''));
  return { evt, payload: typeof parsed === 'string' ? JSON.parse(parsed) : parsed };
}

test('v1 session.updated carries the revert pointer without an active turn', () => {
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.updated',
      properties: {
        info: {
          id: 'ses_revert_v1',
          revert: { messageID: 'msg_revert_v1' },
        },
      },
      durable: { aggregateID: 'ses_revert_v1', seq: 21 },
    });
  });

  const { evt, payload } = revertPayload(emitted);
  assert.equal(evt.ctx.sessionId, 'ses_revert_v1');
  assert.deepEqual(payload, { hasRevert: true, messageId: 'msg_revert_v1' });
});

test('v1 session.updated clears the pointer when info.revert is explicitly null', () => {
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.updated',
      properties: {
        info: {
          id: 'ses_revert_v1_clear',
          revert: null,
        },
      },
      durable: { aggregateID: 'ses_revert_v1_clear', seq: 22 },
    });
  });

  const { evt, payload } = revertPayload(emitted);
  assert.equal(evt.ctx.sessionId, 'ses_revert_v1_clear');
  assert.deepEqual(payload, { hasRevert: false, messageId: '' });
});

test('v2 session.revert.staged emits the new boundary without an active turn', () => {
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.revert.staged',
      // v2 SSE events use `data`; v1 uses `properties`. Pin the v2 shape here.
      data: {
        sessionID: 'ses_revert_v2',
        revert: { messageID: 'msg_revert_v2' },
      },
      durable: { aggregateID: 'ses_revert_v2', seq: 31 },
    });
  });

  const { evt, payload } = revertPayload(emitted);
  assert.equal(evt.ctx.sessionId, 'ses_revert_v2');
  assert.deepEqual(payload, { hasRevert: true, messageId: 'msg_revert_v2' });
});

test('v2 session.revert.committed clears the pointer without an active turn', () => {
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.revert.committed',
      data: {
        sessionID: 'ses_revert_v2',
        to: 'msg_revert_v2',
      },
      durable: { aggregateID: 'ses_revert_v2', seq: 32 },
    });
  });

  const { evt, payload } = revertPayload(emitted);
  assert.equal(evt.ctx.sessionId, 'ses_revert_v2');
  assert.deepEqual(payload, { hasRevert: false, messageId: '' });
});

test('v2 session.revert.cleared clears the pointer on unrevert', () => {
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.revert.cleared',
      data: { sessionID: 'ses_revert_v2_clear' },
      durable: { aggregateID: 'ses_revert_v2_clear', seq: 33 },
    });
  });

  const { evt, payload } = revertPayload(emitted);
  assert.equal(evt.ctx.sessionId, 'ses_revert_v2_clear');
  assert.deepEqual(payload, { hasRevert: false, messageId: '' });
});

test('SSE delta is attributed to the turn AND gets turnId from durable.seq', () => {
  const turn = _createTurn('7', 'ses_a');
  turn.promise = new Promise(() => {});
  _activeTurns.set('ses_a', turn);
  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'ses_a', partID: 'prt_1', delta: 'hello' },
        durable: { aggregateID: 'ses_a', seq: 1042 },
      });
    });
    assert.equal(turn.turnId, 1042, 'first event of the turn defines turnId');

    const delta = emitted.find((e) => e.line.startsWith('[CONTENT_DELTA]'));
    assert.ok(delta, 'delta must be emitted for an active turn');
    assert.equal(delta.ctx.sessionId, 'ses_a');
    assert.equal(delta.ctx.id, '7');
    assert.equal(delta.ctx.turnId, 1042);
    assert.equal(delta.ctx.seq, 1042);

    // Second event of the same turn keeps the turnId, advances seq.
    const second = captureEmits(() => {
      _handleEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'ses_a', partID: 'prt_1', delta: ' world' },
        durable: { aggregateID: 'ses_a', seq: 1043 },
      });
    });
    const delta2 = second.find((e) => e.line.startsWith('[CONTENT_DELTA]'));
    assert.equal(delta2.ctx.turnId, 1042, 'turnId is pinned to the turn, not the event');
    assert.equal(delta2.ctx.seq, 1043);
  } finally {
    _activeTurns.delete('ses_a');
  }
});

test('an event for a session with no turn never claims the running turn id', () => {
  const turn = _createTurn('7', 'ses_a');
  turn.promise = new Promise(() => {});
  _activeTurns.set('ses_a', turn);
  try {
    // A permission prompt for a DIFFERENT session while ses_a is mid-turn.
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'permission.asked',
        properties: { sessionID: 'ses_b', id: 'per_x', action: 'read', resources: [] },
        durable: { aggregateID: 'ses_b', seq: 1 },
      });
    });
    const permission = emitted.find((e) => e.line.startsWith('[PERMISSION_REQUEST]'));
    assert.ok(permission);
    assert.equal(permission.ctx.sessionId, 'ses_b', 'must not be attributed to ses_a');
    assert.equal(permission.ctx.id, null, 'must not borrow the running turn request id');
  } finally {
    _activeTurns.delete('ses_a');
  }
});

test('a server without durable.seq degrades to null instead of inventing a number', () => {
  const turn = _createTurn('7', 'ses_a');
  turn.promise = new Promise(() => {});
  _activeTurns.set('ses_a', turn);
  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'ses_a', partID: 'prt_1', delta: 'x' },
      });
    });
    const delta = emitted.find((e) => e.line.startsWith('[CONTENT_DELTA]'));
    assert.equal(delta.ctx.seq, null);
    assert.equal(delta.ctx.turnId, null);
    assert.equal(delta.ctx.sessionId, 'ses_a', 'session identity does not depend on seq');
  } finally {
    _activeTurns.delete('ses_a');
  }
});

// ── Turn terminal (INV-C) ───────────────────────────────────────────────────

function makeTurnWithPromise(requestId, sessionId) {
  const turn = _createTurn(requestId, sessionId);
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = resolve;
    turn.reject = reject;
  });
  turn.promise.catch(() => {}); // this test asserts the reason, not the rejection
  return turn;
}

test('_settleTurn is idempotent and records why the turn ended', () => {
  const turn = makeTurnWithPromise('7', 'ses_a');
  _settleTurn(turn, { success: true, reason: 'idle' });
  assert.equal(turn.settled, true);
  assert.equal(turn.settleReason, 'idle');

  // A duplicate/late terminal signal must not re-settle.
  _settleTurn(turn, { success: false, reason: 'error' });
  assert.equal(turn.settleReason, 'idle', 'first settle wins');
});

test('_settleTurn defaults the reason when the caller does not supply one', () => {
  const ok = makeTurnWithPromise('7', 'ses_ok');
  _settleTurn(ok, { success: true });
  assert.equal(ok.settleReason, 'idle');

  const bad = makeTurnWithPromise('8', 'ses_bad');
  _settleTurn(bad, { success: false, error: new Error('boom') });
  assert.equal(bad.settleReason, 'error');
});

test('[TURN_END] carries sessionId + turnId + reason, and is emitted exactly once', () => {
  const turn = makeTurnWithPromise('7', 'ses_a');
  turn.turnId = 1042;

  const first = captureEmits(() => _emitTurnEndOnce(turn, 'aborted'));
  assert.equal(first.length, 1);
  assert.equal(
    first[0].line,
    '[TURN_END] {"sessionId":"ses_a","turnId":1042,"reason":"aborted"}',
  );
  // Identity envelope: the terminal event is attributable without parsing it.
  assert.equal(first[0].ctx.sessionId, 'ses_a');
  assert.equal(first[0].ctx.turnId, 1042);
  assert.equal(first[0].ctx.id, '7');

  const second = captureEmits(() => _emitTurnEndOnce(turn, 'idle'));
  assert.equal(second.length, 0, 'a second terminal event for the same turn is suppressed');
});

test('[TURN_END] still gets its identity when there is no ambient record (watchdog path)', () => {
  // The serve-exit watchdog settles turns with no AsyncLocalStorage record at
  // all; identity must come from the turn itself.
  const turn = makeTurnWithPromise('7', 'ses_a');
  turn.turnId = 9;
  assert.deepEqual({ ...currentContext() }, { ...EMPTY_CONTEXT });

  const emitted = captureEmits(() => _emitTurnEndOnce(turn, 'disconnected'));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].ctx.sessionId, 'ses_a');
  assert.equal(emitted[0].ctx.turnId, 9);
  assert.equal(emitted[0].ctx.id, '7');
});

test('_resolveSession creates new session if requested session belongs to different directory', async () => {
  registry.reset();
  registry.lock('v2', { probePath: '/api/info', status: 200, apiVersion: 2 });
  setBaseUrl('http://localhost:4096');
  resetClient();

  // Stub globalThis.fetch to return a session belonging to project-a
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url?.url ?? String(url);
    if (href.includes('/api/session/ses_old')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ id: 'ses_old', location: { directory: 'd:/source/repos/project-a' } }),
      };
    }
    if (href.includes('/api/session') && init?.method === 'POST') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ id: 'ses_new', location: { directory: 'd:/source/repos/project-b' } }),
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    // Requesting ses_old under project-b must NOT reuse ses_old; it must create a new session
    const resolved = await _resolveSession('ses_old', 'd:/source/repos/project-b');
    assert.equal(resolved.created, true);
    assert.equal(resolved.id, 'ses_new');
  } finally {
    globalThis.fetch = originalFetch;
    registry.reset();
  }
});

test('session.status:retry with free_tier_limit immediately settles the active turn', () => {
  const turn = _createTurn('10', 'ses_quota');
  let rejectedError = null;
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = resolve;
    turn.reject = (err) => { rejectedError = err; reject(err); };
  });
  // catch rejection so unhandled rejection doesn't fail the test runner
  turn.promise.catch(() => {});
  _activeTurns.set('ses_quota', turn);

  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'session.status',
        properties: {
          sessionID: 'ses_quota',
          status: {
            type: 'retry',
            attempt: 1,
            next: Date.now() + 3600000,
            message: 'Free usage exceeded, subscribe to Go',
            action: {
              reason: 'free_tier_limit',
              link: 'https://opencode.ai/go',
            },
          },
        },
      });
    });

    assert.equal(turn.settled, true, 'turn must be settled immediately');
    assert.equal(turn.success, false, 'turn must be settled as failure');
    assert.equal(turn.settleReason, 'free_tier_limit');
    assert.match(rejectedError?.message || '', /Free usage exceeded/);
    const statusLine = emitted.find((e) => e.line.startsWith('[STATUS]'));
    assert.ok(statusLine, '[STATUS] marker must be emitted');
  } finally {
    _activeTurns.delete('ses_quota');
  }
});

test('v2 SSE compaction events emit [COMPACTION_STARTED], [COMPACTION_DELTA], [COMPACTION_ENDED]', () => {
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.next.compaction.started',
      properties: {
        sessionID: 'ses_compact_auto',
        messageID: 'msg_cmp_1',
        reason: 'auto',
      },
    });
    _handleEvent({
      type: 'session.next.compaction.delta',
      properties: {
        sessionID: 'ses_compact_auto',
        text: 'Summary chunk 1',
      },
    });
    _handleEvent({
      type: 'session.next.compaction.ended',
      properties: {
        sessionID: 'ses_compact_auto',
        text: 'Full auto summary',
        reason: 'auto',
        tokens: { input: 1000, output: 100 },
      },
    });
  });

  const started = emitted.find((e) => e.line.startsWith('[COMPACTION_STARTED]'));
  assert.ok(started, '[COMPACTION_STARTED] must be emitted');
  const startedPayload = JSON.parse(started.line.substring('[COMPACTION_STARTED]'.length).trim());
  assert.equal(startedPayload.sessionID, 'ses_compact_auto');
  assert.equal(startedPayload.reason, 'auto');

  const delta = emitted.find((e) => e.line.startsWith('[COMPACTION_DELTA]'));
  assert.ok(delta, '[COMPACTION_DELTA] must be emitted');
  const deltaPayload = JSON.parse(delta.line.substring('[COMPACTION_DELTA]'.length).trim());
  assert.equal(deltaPayload.sessionID, 'ses_compact_auto');
  assert.equal(deltaPayload.text, 'Summary chunk 1');

  const ended = emitted.find((e) => e.line.startsWith('[COMPACTION_ENDED]'));
  assert.ok(ended, '[COMPACTION_ENDED] must be emitted');
  const endedPayload = JSON.parse(ended.line.substring('[COMPACTION_ENDED]'.length).trim());
  assert.equal(endedPayload.sessionID, 'ses_compact_auto');
  assert.equal(endedPayload.summary, 'Full auto summary');
  assert.equal(endedPayload.reason, 'auto');
  assert.equal(endedPayload.tokens.input, 1000);

  const compatResult = emitted.find((e) => e.line.startsWith('[SESSION_COMPACT_RESULT]'));
  assert.ok(compatResult, '[SESSION_COMPACT_RESULT] must also be emitted for backward compatibility');
});

test('a manual /compact is reported as reason=manual even when the engine says auto', () => {
  markManualCompaction('ses_compact_manual');
  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'session.next.compaction.started',
        properties: {
          sessionID: 'ses_compact_manual',
          messageID: 'msg_cmp_manual',
          reason: 'auto',
        },
      });
      _handleEvent({
        type: 'session.next.compaction.ended',
        properties: {
          sessionID: 'ses_compact_manual',
          text: 'Manual summary',
          reason: 'auto',
        },
      });
      // The mark is consumed by the terminal event; a later engine compaction
      // must not inherit it.
      _handleEvent({
        type: 'session.next.compaction.started',
        properties: {
          sessionID: 'ses_compact_manual',
          messageID: 'msg_cmp_auto',
          reason: 'auto',
        },
      });
    });

    const startedPayloads = emitted
      .filter((e) => e.line.startsWith('[COMPACTION_STARTED]'))
      .map((e) => JSON.parse(e.line.substring('[COMPACTION_STARTED]'.length).trim()));
    assert.equal(startedPayloads[0].reason, 'manual');
    assert.equal(startedPayloads[1].reason, 'auto', 'the manual mark must be cleared by the terminal event');

    const ended = emitted.find((e) => e.line.startsWith('[COMPACTION_ENDED]'));
    assert.ok(ended);
    assert.equal(
      JSON.parse(ended.line.substring('[COMPACTION_ENDED]'.length).trim()).reason,
      'manual',
    );
  } finally {
    clearManualCompaction('ses_compact_manual');
  }
});

test('a manual mark outlives a v1 turn and settles as manual', () => {
  const turn = {
    sessionId: 'ses_v1_manual',
    requestId: 'req_v1_manual',
    turnId: 102,
    settled: false,
    parts: new Map(),
    assistantMessagesMap: new Map(),
    resolve: () => {},
    reject: () => {},
  };
  _activeTurns.set('ses_v1_manual', turn);
  markManualCompaction('ses_v1_manual');

  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'message.updated',
        properties: {
          sessionID: 'ses_v1_manual',
          info: { id: 'msg_v1_manual_cmp', mode: 'compaction', role: 'assistant' },
        },
      });
      _settleTurn(turn, { success: true });
    });

    const started = emitted.find((e) => e.line.startsWith('[COMPACTION_STARTED]'));
    assert.ok(started);
    assert.equal(
      JSON.parse(started.line.substring('[COMPACTION_STARTED]'.length).trim()).reason,
      'manual',
    );
    const ended = emitted.find((e) => e.line.startsWith('[COMPACTION_ENDED]'));
    assert.ok(ended);
    assert.equal(
      JSON.parse(ended.line.substring('[COMPACTION_ENDED]'.length).trim()).reason,
      'manual',
    );
  } finally {
    _activeTurns.delete('ses_v1_manual');
    clearManualCompaction('ses_v1_manual');
  }
});

test('v1 compaction turn intercepts content delta as [COMPACTION_DELTA] and settles with [COMPACTION_ENDED]', () => {
  const turn = {
    sessionId: 'ses_v1_compact',
    requestId: 'req_v1',
    turnId: 101,
    settled: false,
    parts: new Map(),
    assistantMessagesMap: new Map(),
    resolve: () => {},
    reject: () => {},
  };
  _activeTurns.set('ses_v1_compact', turn);

  try {
    const emitted = captureEmits(() => {
      // 1. message.updated with mode: 'compaction'
      _handleEvent({
        type: 'message.updated',
        properties: {
          sessionID: 'ses_v1_compact',
          info: {
            id: 'msg_v1_cmp',
            mode: 'compaction',
            role: 'assistant',
          },
        },
      });

      // 2. session.text.delta should become [COMPACTION_DELTA], not [CONTENT_DELTA]
      _handleEvent({
        type: 'session.text.delta',
        properties: {
          sessionID: 'ses_v1_compact',
          delta: 'V1 summary part',
        },
      });

      // 3. Turn ends
      _settleTurn(turn, { success: true });
    });

    const started = emitted.find((e) => e.line.startsWith('[COMPACTION_STARTED]'));
    assert.ok(started, '[COMPACTION_STARTED] must be emitted for v1 compaction message');

    const contentDelta = emitted.find((e) => e.line.startsWith('[CONTENT_DELTA]'));
    assert.equal(contentDelta, undefined, '[CONTENT_DELTA] must NOT be emitted during compaction');

    const compDelta = emitted.find((e) => e.line.startsWith('[COMPACTION_DELTA]'));
    assert.ok(compDelta, '[COMPACTION_DELTA] must be emitted instead');
    const compDeltaPayload = JSON.parse(compDelta.line.substring('[COMPACTION_DELTA]'.length).trim());
    assert.equal(compDeltaPayload.text, 'V1 summary part');

    const ended = emitted.find((e) => e.line.startsWith('[COMPACTION_ENDED]'));
    assert.ok(ended, '[COMPACTION_ENDED] must be emitted upon turn settle');
    const endedPayload = JSON.parse(ended.line.substring('[COMPACTION_ENDED]'.length).trim());
    assert.equal(endedPayload.summary, 'V1 summary part');
  } finally {
    _activeTurns.delete('ses_v1_compact');
  }
});

test('v1 session.compacted without a turn keeps the manual reason and resolves pending after the marker', async () => {
  const sessionId = 'ses_v1_no_turn_manual';
  clearPendingCompactions();
  markManualCompaction(sessionId);

  const order = [];
  const pending = registerPendingCompaction(sessionId, 0);
  pending.then(() => order.push('resolved'), () => order.push('rejected'));

  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'session.compacted',
        properties: {
          sessionID: sessionId,
          reason: 'auto',
          text: 'v1 summary',
        },
      });
      order.push('emitted');
    });

    assert.equal(isCompactionPending(sessionId), false);
    await pending;
    assert.deepEqual(order, ['emitted', 'resolved']);

    const ended = emitted.find((e) => e.line.startsWith('[COMPACTION_ENDED]'));
    assert.ok(ended);
    const endedPayload = JSON.parse(ended.line.substring('[COMPACTION_ENDED]'.length).trim());
    assert.equal(endedPayload.reason, 'manual');
    assert.equal(endedPayload.summary, 'v1 summary');
  } finally {
    clearPendingCompactions();
    clearManualCompaction(sessionId);
  }
});

test('v1 compaction failure resolves pending after [COMPACTION_FAILED]', async () => {
  const sessionId = 'ses_v1_no_turn_failed';
  clearPendingCompactions();
  markManualCompaction(sessionId);

  const order = [];
  const pending = registerPendingCompaction(sessionId, 0);
  pending.then(() => order.push('resolved'), () => order.push('rejected'));

  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'session.compaction.failed',
        properties: {
          sessionID: sessionId,
          reason: 'auto',
          error: { message: 'v1 compaction failed' },
        },
      });
      order.push('emitted');
    });

    assert.equal(isCompactionPending(sessionId), false);
    await assert.rejects(pending, /v1 compaction failed/);
    assert.deepEqual(order, ['emitted', 'rejected']);

    const failed = emitted.find((e) => e.line.startsWith('[COMPACTION_FAILED]'));
    assert.ok(failed);
    assert.equal(
      JSON.parse(failed.line.substring('[COMPACTION_FAILED]'.length).trim()).reason,
      'manual',
    );
  } finally {
    clearPendingCompactions();
    clearManualCompaction(sessionId);
  }
});

test('v1 turn compaction resolves pending after [COMPACTION_ENDED]', async () => {
  const sessionId = 'ses_v1_settle_pending';
  clearPendingCompactions();
  const turn = {
    sessionId,
    requestId: 'req_v1_settle',
    turnId: 103,
    settled: false,
    isCompaction: true,
    compactionMessageID: 'msg_v1_settle',
    compactionSummary: 'v1 turn summary',
    compactionReason: 'manual',
    compactionStartedAt: Date.now(),
    parts: new Map(),
    assistantMessagesMap: new Map(),
    toolUseDone: new Set(),
    toolResultDone: new Set(),
    toolUseInput: new Map(),
    toolNames: new Map(),
    resolve: () => {},
    reject: () => {},
  };
  _activeTurns.set(sessionId, turn);

  const order = [];
  const pending = registerPendingCompaction(sessionId, 0);
  pending.then(() => order.push('resolved'), () => order.push('rejected'));

  try {
    const emitted = captureEmits(() => {
      _settleTurn(turn, { success: true });
      order.push('emitted');
    });

    await pending;
    assert.deepEqual(order, ['emitted', 'resolved']);

    const ended = emitted.find((e) => e.line.startsWith('[COMPACTION_ENDED]'));
    assert.ok(ended);
    assert.equal(
      JSON.parse(ended.line.substring('[COMPACTION_ENDED]'.length).trim()).summary,
      'v1 turn summary',
    );
  } finally {
    _activeTurns.delete(sessionId);
    clearPendingCompactions();
  }
});

// ── v1 automatic compaction (part-driven) ──────────────────────────────────
// v1 emits no `session.compaction.started/ended` for an automatic compaction:
// it writes a `compaction` part on the triggering user message, streams the
// summary as ordinary part deltas, and closes with `session.compacted`
// ({sessionID} only). These tests pin the contract that both hosts rely on.

function readMarkers(emitted, prefix) {
  return emitted
    .filter((e) => e.line.startsWith(prefix))
    .map((e) => JSON.parse(e.line.substring(prefix.length).trim()));
}

function installCompactionTurn(sessionId, requestId = 'req_compact') {
  const turn = _createTurn(requestId, sessionId);
  // `_createTurn` leaves the promise hooks null; the live send path installs
  // them. Settling in a test only needs a no-op terminal.
  turn.resolve = () => {};
  turn.reject = () => {};
  _activeTurns.set(sessionId, turn);
  return turn;
}

test('v1 auto compaction: part starts the card, summary is isolated, answer returns to CONTENT_DELTA', () => {
  const sessionId = 'ses_v1_auto_part';
  const turn = installCompactionTurn(sessionId);

  try {
    const emitted = captureEmits(() => {
      // Old v1 shape: the part owns the session identity; properties does not.
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_cmp_1',
            messageID: 'msg_user_1',
            sessionID: sessionId,
            type: 'compaction',
            auto: true,
          },
        },
      });
      // Streaming info has neither `mode` nor a top-level sessionID.
      _handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_cmp_1',
            sessionID: sessionId,
            role: 'assistant',
            summary: true,
            tokens: { input: 1200, output: 80 },
          },
        },
      });
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_sum_1', messageID: 'msg_cmp_1', sessionID: sessionId, type: 'text' },
        },
      });
      _handleEvent({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg_cmp_1',
          partID: 'prt_sum_1',
          field: 'text',
          delta: 'first summary',
        },
      });
      // Reasoning produced while the summary is written must not leak.
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_reason_1', messageID: 'msg_cmp_1', sessionID: sessionId, type: 'reasoning' },
        },
      });
      _handleEvent({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg_cmp_1',
          partID: 'prt_reason_1',
          field: 'reasoning',
          delta: 'private reasoning',
        },
      });
      _handleEvent({
        type: 'session.compacted',
        properties: { sessionID: sessionId },
      });

      // The engine continues the same turn: this is the real answer.
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_answer_1', messageID: 'msg_answer_1', sessionID: sessionId, type: 'text' },
        },
      });
      _handleEvent({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg_answer_1',
          partID: 'prt_answer_1',
          field: 'text',
          delta: 'the real answer',
        },
      });

      // A second automatic compaction in the same turn gets its own lifecycle.
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_cmp_2',
            messageID: 'msg_user_2',
            sessionID: sessionId,
            type: 'compaction',
            auto: true,
          },
        },
      });
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_sum_2', messageID: 'msg_cmp_2', sessionID: sessionId, type: 'text' },
        },
      });
      _handleEvent({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_cmp_2', sessionID: sessionId, role: 'assistant', mode: 'compaction' },
        },
      });
      _handleEvent({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg_cmp_2',
          partID: 'prt_sum_2',
          field: 'text',
          delta: 'second summary',
        },
      });
      _handleEvent({
        type: 'session.compacted',
        properties: { sessionID: sessionId },
      });

      // The fallback terminal must not emit a third card.
      _settleTurn(turn, { success: true });
    });

    const started = readMarkers(emitted, '[COMPACTION_STARTED]');
    assert.equal(started.length, 2, 'one STARTED per compaction, not per signal');
    assert.deepEqual(started.map((p) => p.reason), ['auto', 'auto']);

    const compactionDeltas = readMarkers(emitted, '[COMPACTION_DELTA]');
    assert.deepEqual(
      compactionDeltas.map((p) => p.text),
      ['first summary', 'second summary'],
      'only the two summaries may use the compaction channel',
    );

    const content = emitted
      .filter((e) => e.line.startsWith('[CONTENT_DELTA]'))
      .map((e) => JSON.parse(e.line.substring('[CONTENT_DELTA]'.length).trim()));
    assert.deepEqual(content, ['the real answer'], 'the answer must leave the compaction channel');
    assert.equal(
      emitted.find((e) => e.line.startsWith('[THINKING_DELTA]')),
      undefined,
      'reasoning during compaction must not reach the host',
    );

    const ended = readMarkers(emitted, '[COMPACTION_ENDED]');
    assert.equal(ended.length, 2, 'turn settle must not duplicate the terminal');
    assert.equal(ended[0].summary, 'first summary');
    assert.equal(ended[0].messageID, 'msg_cmp_1');
    assert.deepEqual(ended[0].tokens, { input: 1200, output: 80 });
    assert.equal(ended[1].summary, 'second summary');
    assert.equal(ended[1].messageID, 'msg_cmp_2');
  } finally {
    _activeTurns.delete(sessionId);
  }
});

test('v1 message.updated resolves the turn from info.sessionID, never from info.id', () => {
  const sessionId = 'ses_v1_info_session';
  const turn = installCompactionTurn(sessionId);
  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_cmp_info', sessionID: sessionId, role: 'assistant', mode: 'compaction' },
        },
      });
      _handleEvent({
        type: 'session.compacted',
        properties: { sessionID: sessionId },
      });
      _settleTurn(turn, { success: true });
    });

    const started = readMarkers(emitted, '[COMPACTION_STARTED]');
    assert.equal(started.length, 1);
    assert.equal(started[0].sessionID, sessionId, 'info.id is a message id and must not name the session');
    assert.equal(started[0].messageID, 'msg_cmp_info');

    const ended = readMarkers(emitted, '[COMPACTION_ENDED]');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].messageID, 'msg_cmp_info');
  } finally {
    _activeTurns.delete(sessionId);
  }
});

test('v1 message.updated falls back to parentID when it carries no sessionID', () => {
  const sessionId = 'ses_v1_parent_index';
  const turn = installCompactionTurn(sessionId);
  try {
    const emitted = captureEmits(() => {
      // Index the triggering user message first (part events carry sessionID
      // even on builds where message.updated does not).
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_parent', messageID: 'msg_parent', sessionID: sessionId, type: 'text' },
        },
      });
      _handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_cmp_parent',
            parentID: 'msg_parent',
            role: 'assistant',
            mode: 'compaction',
          },
        },
      });
      _handleEvent({
        type: 'session.compacted',
        properties: { sessionID: sessionId },
      });
      _settleTurn(turn, { success: true });
    });

    const started = readMarkers(emitted, '[COMPACTION_STARTED]');
    assert.equal(started.length, 1);
    assert.equal(started[0].sessionID, sessionId);
    assert.equal(started[0].messageID, 'msg_cmp_parent');
    assert.equal(readMarkers(emitted, '[COMPACTION_ENDED]').length, 1);
  } finally {
    _activeTurns.delete(sessionId);
  }
});

test('v1 compaction: session.text.delta accumulates the summary and resets before the answer', () => {
  const sessionId = 'ses_v1_text_delta';
  const turn = installCompactionTurn(sessionId);
  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_cmp_text',
            messageID: 'msg_user_text',
            sessionID: sessionId,
            type: 'compaction',
            auto: true,
          },
        },
      });
      _handleEvent({
        type: 'session.text.delta',
        properties: { sessionID: sessionId, delta: 'summary via text' },
      });
      _handleEvent({
        type: 'session.text.delta',
        properties: { sessionID: sessionId, delta: ' and more' },
      });
      _handleEvent({
        type: 'session.compacted',
        properties: { sessionID: sessionId },
      });
      _handleEvent({
        type: 'session.text.delta',
        properties: { sessionID: sessionId, delta: 'answer via text' },
      });
      _settleTurn(turn, { success: true });
    });

    assert.deepEqual(
      readMarkers(emitted, '[COMPACTION_DELTA]').map((p) => p.text),
      ['summary via text', ' and more'],
    );
    const ended = readMarkers(emitted, '[COMPACTION_ENDED]');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].summary, 'summary via text and more');
    assert.deepEqual(
      emitted
        .filter((e) => e.line.startsWith('[CONTENT_DELTA]'))
        .map((e) => JSON.parse(e.line.substring('[CONTENT_DELTA]'.length).trim())),
      ['answer via text'],
    );
  } finally {
    _activeTurns.delete(sessionId);
  }
});

test('v1 session.compacted with no tracked compaction and no summary does not invent an empty card', () => {
  const sessionId = 'ses_v1_empty_compacted';
  const emitted = captureEmits(() => {
    _handleEvent({
      type: 'session.compacted',
      properties: { sessionID: sessionId },
    });
  });

  assert.equal(readMarkers(emitted, '[COMPACTION_ENDED]').length, 0);
  const result = emitted.find((e) => e.line.startsWith('[SESSION_COMPACT_RESULT]'));
  assert.ok(result, 'the compatibility result marker still resolves the command plane');
  const outer = JSON.parse(result.line.substring('[SESSION_COMPACT_RESULT]'.length).trim());
  const payload = typeof outer === 'string' ? JSON.parse(outer) : outer;
  assert.equal(payload.success, true);
});

test('a late message.updated for an already-failed compaction does not start it again', () => {
  const sessionId = 'ses_v1_late_update';
  const turn = installCompactionTurn(sessionId);
  try {
    const emitted = captureEmits(() => {
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_cmp_late',
            messageID: 'msg_user_late',
            sessionID: sessionId,
            type: 'compaction',
            auto: true,
          },
        },
      });
      _handleEvent({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_cmp_late', sessionID: sessionId, role: 'assistant', mode: 'compaction' },
        },
      });
      _handleEvent({
        type: 'session.compaction.failed',
        properties: {
          sessionID: sessionId,
          error: { message: 'engine aborted the compaction' },
        },
      });
      // A duplicate terminal update arrives after the failure.
      _handleEvent({
        type: 'message.updated',
        properties: {
          info: { id: 'msg_cmp_late', sessionID: sessionId, role: 'assistant', mode: 'compaction' },
        },
      });
      _settleTurn(turn, { success: true });
    });

    assert.equal(readMarkers(emitted, '[COMPACTION_STARTED]').length, 1);
    assert.equal(readMarkers(emitted, '[COMPACTION_FAILED]').length, 1);
    assert.equal(readMarkers(emitted, '[COMPACTION_ENDED]').length, 0);
  } finally {
    _activeTurns.delete(sessionId);
  }
});

