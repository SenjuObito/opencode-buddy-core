import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderError, normalizeMessageEntry } from './opencode-sdk-client.js';

test('v1 APIError is flattened into the host error contract', () => {
  const entry = {
    info: {
      id: 'msg_1',
      role: 'assistant',
      finish: 'error',
      error: {
        name: 'APIError',
        data: {
          message: 'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go',
          statusCode: 429,
          isRetryable: false,
        },
      },
    },
    parts: [],
  };

  const normalized = normalizeMessageEntry(entry, 'ses_1');

  assert.deepEqual(normalized.info.error, {
    kind: 'APIError',
    message: 'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go',
    status: 429,
    retryable: false,
  });
  assert.equal(normalized.info.finish, 'error');
  assert.equal(normalized.parts.length, 1);
  assert.equal(normalized.parts[0].isError, true);
  assert.match(normalized.parts[0].text, /^\[Error: Free usage limit reached/);
});

test('v2 provider.quota is flattened into the same host error contract', () => {
  const entry = {
    info: {
      id: 'msg_2',
      role: 'assistant',
      finish: 'error',
      error: {
        type: 'provider.quota',
        message: 'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go',
        status: 429,
        response: { body: '{"type":"error"}' },
      },
    },
    parts: [],
  };

  const normalized = normalizeMessageEntry(entry, 'ses_2');

  assert.deepEqual(normalized.info.error, {
    kind: 'provider.quota',
    message: 'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go',
    status: 429,
    retryable: null,
  });
  assert.equal(normalized.parts.length, 1);
  assert.equal(normalized.parts[0].isError, true);
});

test('v1 and v2 quota errors produce the same host-visible message', () => {
  const message = 'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go';
  const v1 = normalizeMessageEntry({
    info: { role: 'assistant', finish: 'error', error: { name: 'APIError', data: { message, statusCode: 429 } } },
    parts: [],
  }, 'ses_1');
  const v2 = normalizeMessageEntry({
    info: { role: 'assistant', finish: 'error', error: { type: 'provider.quota', message, status: 429 } },
    parts: [],
  }, 'ses_2');

  assert.equal(v1.info.error.message, v2.info.error.message);
  assert.deepEqual(v1.parts, v2.parts);
});

test('v1 MessageAbortedError becomes a neutral aborted notice', () => {
  const normalized = normalizeMessageEntry({
    info: {
      role: 'assistant',
      finish: 'error',
      error: { name: 'MessageAbortedError', data: { message: 'Step interrupted' } },
    },
    parts: [],
  }, 'ses_1');

  assert.equal(normalized.info.aborted, true);
  assert.equal(normalized.parts[0].aborted, true);
  assert.doesNotMatch(normalized.parts[0].text, /^\[Error:/);
});

test('an existing text part is never duplicated by an error part', () => {
  const normalized = normalizeMessageEntry({
    info: {
      role: 'assistant',
      finish: 'error',
      error: { type: 'provider', message: 'upstream connect error' },
    },
    parts: [{ type: 'text', text: 'partial answer' }],
  }, 'ses_1');

  assert.deepEqual(normalized.parts, [{ type: 'text', text: 'partial answer' }]);
});

test('normalizeProviderError keeps the normalized kind idempotent', () => {
  const first = normalizeProviderError({ type: 'provider.quota', message: 'q', status: 429 });
  const second = normalizeProviderError(first);
  assert.equal(second.kind, 'provider.quota');
  assert.equal(second.message, 'q');
  assert.equal(second.status, 429);
});
