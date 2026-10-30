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

