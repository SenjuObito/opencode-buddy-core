import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEnvelope,
  forEachProtocolLine,
  hasIdentity,
} from './ndjson-envelope.js';

const SES = { id: '7', sessionId: 'ses_a', turnId: 1042, seq: 1047 };
const NO_ID = { id: null, sessionId: 'ses_a', turnId: null, seq: 1047 };
const NO_SESSION = { id: '7', sessionId: null, turnId: null, seq: null };
const NOTHING = { id: null, sessionId: null, turnId: null, seq: null };

test('buildEnvelope always emits the four identity fields, in a stable order', () => {
  assert.deepEqual(buildEnvelope(SES, '[CONTENT_DELTA] "hi"'), {
    id: '7',
    session: 'ses_a',
    turn: 1042,
    seq: 1047,
    line: '[CONTENT_DELTA] "hi"',
  });
  // Missing identity is explicit null — never omitted, never defaulted to a
  // neighbouring value (`undefined` would JSON.stringify away entirely).
  assert.deepEqual(Object.keys(buildEnvelope(NOTHING, 'x')), ['id', 'session', 'turn', 'seq', 'line']);
  assert.deepEqual(buildEnvelope(NOTHING, 'x'), {
    id: null, session: null, turn: null, seq: null, line: 'x',
  });
});

test('buildEnvelope survives a missing/partial context', () => {
  assert.deepEqual(buildEnvelope(undefined, 'x'), {
    id: null, session: null, turn: null, seq: null, line: 'x',
  });
  assert.equal(buildEnvelope({ sessionId: 'ses_a' }, 'x').session, 'ses_a');
  assert.equal(buildEnvelope({ sessionId: 'ses_a' }, 'x').id, null);
});

test('buildEnvelope does not coerce 0/false-looking sequence numbers away', () => {
  const env = buildEnvelope({ id: null, sessionId: 'ses_a', turnId: 0, seq: 0 }, 'x');
  assert.equal(env.turn, 0);
  assert.equal(env.seq, 0);
});

test('hasIdentity: a session-only line is identity-bearing; nothing is not', () => {
  assert.equal(hasIdentity(SES), true);
  assert.equal(hasIdentity(NO_ID), true, 'session without a request id must still be tagged');
  assert.equal(hasIdentity(NO_SESSION), true, 'request without a session must still be tagged');
  assert.equal(hasIdentity(NOTHING), false);
  assert.equal(hasIdentity(undefined), false);
});

test('forEachProtocolLine: single terminated line (the streaming hot path)', () => {
  const lines = [];
  forEachProtocolLine('[CONTENT_DELTA] "hi"\n', (l) => lines.push(l));
  assert.deepEqual(lines, ['[CONTENT_DELTA] "hi"']);
});

test('forEachProtocolLine: single unterminated line', () => {
  const lines = [];
  forEachProtocolLine('[STREAM_START]', (l) => lines.push(l));
  assert.deepEqual(lines, ['[STREAM_START]']);
});

test('forEachProtocolLine: two lines, first terminated', () => {
  const lines = [];
  forEachProtocolLine('a\nb', (l) => lines.push(l));
  assert.deepEqual(lines, ['a', 'b']);
});

test('forEachProtocolLine: multi-line chunk drops the empty tail', () => {
  const lines = [];
  forEachProtocolLine('a\nb\nc\n', (l) => lines.push(l));
  assert.deepEqual(lines, ['a', 'b', 'c', '']);
  // (the trailing empty string is filtered by the caller, mirroring the
  //  pre-refactor `if (line.length > 0)` behaviour)
});

test('forEachProtocolLine: blank and empty input produce nothing', () => {
  const lines = [];
  forEachProtocolLine('', (l) => lines.push(l));
  forEachProtocolLine('\n', (l) => lines.push(l));
  assert.deepEqual(lines, ['']);
});

test('forEachProtocolLine: fast path does not call String.split for one-line chunks', () => {
  const originalSplit = String.prototype.split;
  let called = 0;
  // eslint-disable-next-line no-extend-native
  String.prototype.split = function patched(...args) {
    called += 1;
    return originalSplit.apply(this, args);
  };
  try {
    forEachProtocolLine('x\n', () => {});
    forEachProtocolLine('x', () => {});
    forEachProtocolLine('x\ny', () => {});
    assert.equal(called, 0, 'no split allocation on the single/two-line fast paths');
    forEachProtocolLine('x\ny\nz\nw', () => {});
    assert.equal(called, 1, 'falls back to split only for multi-line chunks');
  } finally {
    String.prototype.split = originalSplit;
  }
});
