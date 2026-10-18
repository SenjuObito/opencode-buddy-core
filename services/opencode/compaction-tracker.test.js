import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPendingCompaction,
  resolvePendingCompaction,
  isCompactionPending,
  clearPendingCompactions,
} from './compaction-tracker.js';

test('compaction-tracker: resolves successfully when ended', async () => {
  clearPendingCompactions();
  const sessionId = 'ses_test_1';
  const promise = registerPendingCompaction(sessionId, 5000);
  assert.equal(isCompactionPending(sessionId), true);

  const resolved = resolvePendingCompaction(sessionId, true);
  assert.equal(resolved, true);
  assert.equal(isCompactionPending(sessionId), false);

  await assert.doesNotReject(promise);
});

test('compaction-tracker: rejects when failed', async () => {
  clearPendingCompactions();
  const sessionId = 'ses_test_2';
  const promise = registerPendingCompaction(sessionId, 5000);
  assert.equal(isCompactionPending(sessionId), true);

  const resolved = resolvePendingCompaction(sessionId, false, 'Rate limit exceeded');
  assert.equal(resolved, true);
  assert.equal(isCompactionPending(sessionId), false);

  await assert.rejects(promise, {
    message: 'Rate limit exceeded',
  });
});

test('compaction-tracker: times out if no event received', async () => {
  clearPendingCompactions();
  const sessionId = 'ses_test_3';
  const promise = registerPendingCompaction(sessionId, 50);

  await assert.rejects(promise, /timed out/);
  assert.equal(isCompactionPending(sessionId), false);
});
