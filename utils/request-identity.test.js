import test from 'node:test';
import assert from 'node:assert/strict';
import { isTurnCommand, requestContextRecord } from './request-identity.js';

/**
 * Regression tests for the request→session identity rule.
 *
 * The host delivers a line that names a session to that session's sink and to
 * nothing else. So stamping `session` on a shared query's response payload
 * starves the query's own collector: history restore used to announce N
 * entries on the wire, collect none of them, and report "0 messages, success"
 * — a blank tab with no error. These cases pin the rule that prevents it.
 */

test('isTurnCommand recognises only send/shell across provider prefixes', () => {
  assert.equal(isTurnCommand('opencode.send'), true);
  assert.equal(isTurnCommand('opencode.shell'), true);
  assert.equal(isTurnCommand('send'), true);
  assert.equal(isTurnCommand('shell'), true);

  // Every shared query carries a sessionId param but is NOT session data.
  for (const method of [
    'opencode.listMessages',
    'opencode.getSessionInfo',
    'opencode.preconnect',
    'opencode.revert',
    'opencode.unrevert',
    'opencode.fork',
    'opencode.shareSession',
    'opencode.unshareSession',
    'opencode.summarize',
    'opencode.getContextUsage',
    'opencode.replyPermission',
    'opencode.replyQuestion',
    'opencode.rejectQuestion',
    'opencode.listModels',
    'opencode.findFiles',
    'opencode.abort',
  ]) {
    assert.equal(isTurnCommand(method), false, `${method} must not be a turn command`);
  }

  assert.equal(isTurnCommand(undefined), false);
  assert.equal(isTurnCommand(null), false);
  assert.equal(isTurnCommand(42), false);
  assert.equal(isTurnCommand(''), false);
});

test('a turn command takes its session identity from params', () => {
  const record = requestContextRecord({
    id: 'req-1',
    method: 'opencode.send',
    params: { sessionId: 'ses_abc', directory: '/w' },
  });
  assert.equal(record.id, 'req-1');
  assert.equal(record.sessionId, 'ses_abc');
  assert.equal(record.turnId, null);
  assert.equal(record.seq, null);
});

test('a shared query is NOT stamped with the session from its params', () => {
  // The regression: listMessages/getSessionInfo/... must stay id-attributable
  // so the host routes their output to the caller's collector.
  for (const method of [
    'opencode.listMessages',
    'opencode.getSessionInfo',
    'opencode.preconnect',
    'opencode.revert',
    'opencode.fork',
    'opencode.getContextUsage',
  ]) {
    const record = requestContextRecord({
      id: 'req-2',
      method,
      params: { sessionId: 'ses_abc', directory: '/w' },
    });
    assert.equal(record.sessionId, null,
      `${method} output must not be stamped with a session — the host would route it to the sink`);
    assert.equal(record.id, 'req-2', 'the request id must still be carried');
  }
});

test('a blank session id is normalised to null, not an empty string', () => {
  const record = requestContextRecord({
    id: 'req-3',
    method: 'opencode.send',
    params: { sessionId: '   ' },
  });
  assert.equal(record.sessionId, null);
});

test('a turn command for a brand-new session starts with no identity', () => {
  // The turn path binds it later via bindSession(); there is no guessing here.
  const record = requestContextRecord({ id: 'req-4', method: 'opencode.send', params: {} });
  assert.equal(record.sessionId, null);
  assert.equal(record.id, 'req-4');
});

test('a missing request is tolerated', () => {
  assert.deepEqual(requestContextRecord(undefined), { id: null, sessionId: null, turnId: null, seq: null });
  assert.deepEqual(requestContextRecord({}), { id: null, sessionId: null, turnId: null, seq: null });
});
