import test from 'node:test';
import assert from 'node:assert/strict';
import * as registry from './engine-registry.js';
import { listMessages, setBaseUrl, resetClient } from './opencode-sdk-client.js';

/**
 * Shape tests for the v2 → host message normalization in `listMessages`.
 *
 * All three cases come from real transcripts read out of
 * `~/.local/share/opencode/opencode.db`:
 *
 *  1. **A user-initiated stop** is stored by the server as
 *     `finish: 'error'` + `error: {type: 'aborted', message: 'Step interrupted'}`.
 *     The old code turned that into a `[Error: Step interrupted]` text part, so
 *     pressing Stop mid-turn left what reads like a crash in the transcript.
 *     It must become a neutral notice with a structured marker instead.
 *
 *  2. **Tool output** lives in `state.content: [{type:'text', text}]` on v2, not
 *     in `state.output`. Reading only `output` dropped every tool result on
 *     restore.
 *
 *  3. **`state.error` is an object** (`{type, message}`) on v2 and a string on
 *     v1. The host must be able to read either; these cases pin what the
 *     normalizer hands over so the host's reader stays shape-agnostic.
 */

const SESSION_ID = 'ses_shape_tests';

function lockV2() {
  registry.lock('v2', { probePath: '/api/info', status: 200, apiVersion: 2 });
  setBaseUrl('http://localhost:4096');
  resetClient();
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => handler();
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Wrap one assistant message in the `{data: [...]}` envelope the route returns. */
function assistantEntry(extra) {
  return [{ id: 'msg_1', type: 'assistant', time: { created: 1 }, ...extra }];
}

test('a user-initiated stop becomes a neutral notice, not an [Error:] line', async () => {
  // The server only records the abort on the message; the assistant text that
  // was already streamed lives in *other* parts, so an interrupted turn
  // typically arrives with no text part at all — which is exactly why the old
  // `[Error: Step interrupted]` line showed up as the message's only content.
  lockV2();
  const stub = stubFetch(() => jsonResponse({
    data: assistantEntry({
      content: [{ type: 'reasoning', text: '让我想想…' }],
      finish: 'error',
      error: { type: 'aborted', message: 'Step interrupted' },
    }),
  }));
  try {
    const entries = await listMessages(SESSION_ID);
    const parts = entries[0].parts;
    const notice = parts.find((p) => p.type === 'text' && p.aborted);

    assert.ok(notice, 'the stop must be emitted as an aborted notice');
    assert.ok(!notice.text.startsWith('[Error:'), 'the raw server error must not be shown verbatim');
    assert.equal(notice.text, '已停止生成');
  } finally {
    stub.restore();
  }
});

test('an aborted turn that already streamed text keeps its text and adds no notice', async () => {
  // The notice exists to replace a *missing* body. When the assistant already
  // produced text, appending "已停止生成" would just be noise after it.
  lockV2();
  const stub = stubFetch(() => jsonResponse({
    data: assistantEntry({
      content: [{ type: 'text', text: '这是停止前已经输出的内容' }],
      finish: 'error',
      error: { type: 'aborted', message: 'Step interrupted' },
    }),
  }));
  try {
    const entries = await listMessages(SESSION_ID);
    const texts = entries[0].parts.filter((p) => p.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].text, '这是停止前已经输出的内容');
    assert.equal(texts[0].aborted, undefined);
  } finally {
    stub.restore();
  }
});

test('a genuine error keeps its error semantics and its text', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({
    data: assistantEntry({
      content: [],
      finish: 'error',
      error: { type: 'provider', message: 'upstream connect error' },
    }),
  }));
  try {
    const entries = await listMessages(SESSION_ID);
    const err = entries[0].parts.find((p) => p.type === 'text' && p.isError);

    assert.ok(err, 'a real failure must still be marked as an error');
    assert.match(err.text, /^\[Error: upstream connect error\]$/);
  } finally {
    stub.restore();
  }
});

test('a string error (v1 shape) still produces an error line', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({
    data: assistantEntry({ content: [], finish: 'error', error: 'plain string failure' }),
  }));
  try {
    const entries = await listMessages(SESSION_ID);
    const err = entries[0].parts.find((p) => p.type === 'text' && p.isError);
    assert.ok(err);
    assert.match(err.text, /^\[Error: plain string failure\]$/);
  } finally {
    stub.restore();
  }
});

test('tool output is flattened out of state.content', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({
    data: assistantEntry({
      content: [{
        type: 'tool',
        id: 'call-1',
        name: 'bash',
        state: {
          status: 'completed',
          input: { command: 'ls' },
          content: [
            { type: 'text', text: 'a.ts' },
            { type: 'text', text: 'b.ts' },
          ],
        },
      }],
    }),
  }));
  try {
    const entries = await listMessages(SESSION_ID);
    const tool = entries[0].parts.find((p) => p.type === 'tool');

    assert.ok(tool, 'the tool_use part must survive the round trip');
    assert.equal(tool.state.output, 'a.ts\nb.ts',
      'output lives in state.content on v2; reading only state.output dropped it');
  } finally {
    stub.restore();
  }
});

test('a string state.output (v1 shape) passes through untouched', async () => {
  lockV2();
  const stub = stubFetch(() => jsonResponse({
    data: assistantEntry({
      content: [{
        type: 'tool',
        id: 'call-1',
        name: 'bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'a.ts' },
      }],
    }),
  }));
  try {
    const entries = await listMessages(SESSION_ID);
    const tool = entries[0].parts.find((p) => p.type === 'tool');
    assert.equal(tool.state.output, 'a.ts');
  } finally {
    stub.restore();
  }
});

test('an object state.error is handed to the host as-is (v2 shape)', async () => {
  // The host reads either shape (`errorText()`); the normalizer's job is only to
  // not lose it. Dropping it here is what made errored tools look successful.
  lockV2();
  const stub = stubFetch(() => jsonResponse({
    data: assistantEntry({
      content: [{
        type: 'tool',
        id: 'call-1',
        name: 'bash',
        state: { status: 'error', input: {}, error: { type: 'aborted', message: 'Tool execution interrupted' } },
      }],
    }),
  }));
  try {
    const entries = await listMessages(SESSION_ID);
    const tool = entries[0].parts.find((p) => p.type === 'tool');
    assert.deepEqual(tool.state.error, { type: 'aborted', message: 'Tool execution interrupted' });
  } finally {
    stub.restore();
  }
});
