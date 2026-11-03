import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPendingCompaction,
  armPendingCompactionTimeout,
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

test('compaction-tracker: timeout can be armed after a no-timeout registration', async () => {
  clearPendingCompactions();
  const sessionId = 'ses_test_4';
  const promise = registerPendingCompaction(sessionId, 0);
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(isCompactionPending(sessionId), true);

  assert.equal(armPendingCompactionTimeout(sessionId, 20), true);
  await assert.rejects(promise, /timed out/);
  assert.equal(isCompactionPending(sessionId), false);
});

test('compaction-tracker: arming a resolved waiter is a no-op', async () => {
  clearPendingCompactions();
  const sessionId = 'ses_test_5';
  const promise = registerPendingCompaction(sessionId, 0);

  resolvePendingCompaction(sessionId, true);
  assert.equal(armPendingCompactionTimeout(sessionId, 20), false);
  await assert.doesNotReject(promise);
});
