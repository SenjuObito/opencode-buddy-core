import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  _activeTurns,
  _createTurn,
  _handleEvent,
  _handleSubagentChildTerminal,
  _handleToolPart,
  _reconcileSubagentsForParent,
  _resetSubagentsForTest,
  _setSubagentHistoryReaderForTest,
  _subagentMonitor,
} from './opencode-daemon-service.js';

const STATUS_PREFIX = '[SUBAGENT_STATUS] ';

function makeParentTurn(sessionId = 'ses_parent') {
  const turn = _createTurn('req_1', sessionId);
  _activeTurns.set(sessionId, turn);
  return turn;
}

function completedHistory(overrides = {}) {
  return {
    success: true,
    status: 'completed',
    childSessionID: 'ses_child',
    messages: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'child result' }] } }],
    ...overrides,
  };
}

/** Capture `[SUBAGENT_STATUS]` markers for the duration of `fn`. */
async function withStatusCapture(fn) {
  const emitted = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  process.stdout.write = function write(chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith(STATUS_PREFIX)) {
      emitted.push(JSON.parse(chunk.slice(STATUS_PREFIX.length)));
      return true;
    }
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    await fn(emitted);
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  return emitted;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function registerV2Launch(overrides = {}) {
  _handleEvent({
    type: 'session.tool.called',
    properties: {
      sessionID: 'ses_parent',
      toolID: 'call_sub',
      name: 'subagent',
      input: { background: true, description: 'Explore auth' },
      output: { sessionID: 'ses_child', status: 'running', output: ['working'] },
      ...overrides,
    },
  });
}

beforeEach(() => {
  _activeTurns.clear();
  _resetSubagentsForTest();
});

afterEach(() => {
  _activeTurns.clear();
  _resetSubagentsForTest();
});

test('v2 background launch registers a watch and the child terminal emits one status', async () => {
  makeParentTurn();
  registerV2Launch();

  assert.equal(_subagentMonitor.size, 1);
  assert.equal(_subagentMonitor.resolveByChild('ses_child')?.toolUseId, 'call_sub');

  _setSubagentHistoryReaderForTest(async () => completedHistory());
  const emitted = await withStatusCapture(() => _handleSubagentChildTerminal('ses_child', 'completed'));

  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    parentSessionId: 'ses_parent',
    toolUseId: 'call_sub',
    childSessionId: 'ses_child',
    status: 'completed',
    description: 'Explore auth',
    summary: 'child result',
  });
  assert.equal(_subagentMonitor.size, 0, 'the watch is dropped after emitting');
});

test('the child idle event reaches the same terminal through the event pipeline', async () => {
  makeParentTurn();
  registerV2Launch();
  _setSubagentHistoryReaderForTest(async () => completedHistory());

  const emitted = await withStatusCapture(async () => {
    _handleEvent({ type: 'session.execution.succeeded', properties: { sessionID: 'ses_child' } });
    await flush();
    await flush();
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].toolUseId, 'call_sub');
});

test('a still-running child transcript vetoes the emission and keeps the watch', async () => {
  makeParentTurn();
  registerV2Launch();
  _setSubagentHistoryReaderForTest(async () => ({ success: true, status: 'running', childSessionID: 'ses_child' }));

  const emitted = await withStatusCapture(() => _handleSubagentChildTerminal('ses_child', 'completed'));
  assert.equal(emitted.length, 0);
  assert.equal(_subagentMonitor.resolveByChild('ses_child')?.toolUseId, 'call_sub');
});

test('a failed transcript read falls back to the terminal event', async () => {
  makeParentTurn();
  registerV2Launch();
  _setSubagentHistoryReaderForTest(async () => {
    throw new Error('daemon offline');
  });

  const emitted = await withStatusCapture(() => _handleSubagentChildTerminal('ses_child', 'failed'));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 'failed');
});

test('the synthetic subagent notice emits the terminal state and its body as summary', async () => {
  makeParentTurn();
  registerV2Launch();

  const emitted = await withStatusCapture(() => {
    _handleEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_parent',
        part: {
          type: 'text',
          text: '<subagent sessionID="ses_child" state="completed" description="Explore auth">notice result</subagent>',
        },
      },
    });
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 'completed');
  assert.equal(emitted[0].summary, 'notice result');
});

test('the notice can bind a child that the launch acknowledgement did not name', async () => {
  makeParentTurn();
  _handleEvent({
    type: 'session.tool.called',
    properties: {
      sessionID: 'ses_parent',
      toolID: 'call_sub',
      name: 'subagent',
      input: { background: true, description: 'Explore auth' },
    },
  });
  assert.equal(_subagentMonitor.resolveByChild('ses_child'), null);

  const emitted = await withStatusCapture(() => {
    _handleEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_parent',
        part: { type: 'text', text: '<subagent sessionID="ses_child" state="error" description="Explore auth">boom</subagent>' },
      },
    });
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 'failed', 'engine error maps to the host vocabulary');
  assert.equal(emitted[0].childSessionId, 'ses_child');
});

test('duplicate terminal triggers emit exactly once', async () => {
  makeParentTurn();
  registerV2Launch();
  _setSubagentHistoryReaderForTest(async () => completedHistory());

  const emitted = await withStatusCapture(async () => {
    await _handleSubagentChildTerminal('ses_child', 'completed');
    await _handleSubagentChildTerminal('ses_child', 'completed');
    await _reconcileSubagentsForParent('ses_parent');
    _handleEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_parent',
        part: { type: 'text', text: '<subagent sessionID="ses_child" state="completed">again</subagent>' },
      },
    });
    await flush();
  });

  assert.equal(emitted.length, 1);
});

test('foreground calls never register a watch', async () => {
  makeParentTurn();
  _handleEvent({
    type: 'session.tool.called',
    properties: {
      sessionID: 'ses_parent',
      toolID: 'call_sync',
      name: 'subagent',
      input: { description: 'Explore auth' },
    },
  });
  assert.equal(_subagentMonitor.size, 0);
});

test('an inline subagent publishes its terminal state when the parent result lands', async () => {
  const turn = makeParentTurn();
  const emitted = await withStatusCapture(() => {
    _handleToolPart({
      id: 'prt_sync',
      callID: 'call_sync',
      type: 'tool',
      tool: 'subagent',
      state: {
        status: 'completed',
        input: { description: 'Explore auth', agent: 'explore' },
        content: [{
          type: 'text',
          text: '<subagent sessionID="ses_child" state="completed">inline result</subagent>',
        }],
      },
    }, turn);
  });

  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    parentSessionId: 'ses_parent',
    toolUseId: 'call_sync',
    childSessionId: 'ses_child',
    status: 'completed',
    description: 'Explore auth',
    summary: 'inline result',
  });
  assert.equal(_subagentMonitor.size, 0, 'an inline call must not leave a watch behind');
});

test('an inline subagent stays silent until its result lands', async () => {
  const turn = makeParentTurn();
  const emitted = await withStatusCapture(() => {
    _handleToolPart({
      id: 'prt_sync',
      callID: 'call_sync',
      type: 'tool',
      tool: 'subagent',
      state: { status: 'running', input: { description: 'Explore auth' } },
    }, turn);
  });
  assert.equal(emitted.length, 0);
});

test('an inline subagent with no result text yet waits instead of completing', async () => {
  // Some builds deliver the launch ack in a later event. Emitting completed on
  // an empty terminal part would flip a background run on its acknowledgement.
  const turn = makeParentTurn();
  const emitted = await withStatusCapture(() => {
    _handleToolPart({
      id: 'prt_sync_empty',
      callID: 'call_sync_empty',
      type: 'tool',
      tool: 'subagent',
      state: { status: 'completed', input: { description: 'Explore auth' } },
    }, turn);
  });

  assert.equal(emitted.length, 0);
});

test('an inline subagent failure publishes failed', async () => {
  const turn = makeParentTurn();
  const emitted = await withStatusCapture(() => {
    _handleToolPart({
      id: 'prt_sync',
      callID: 'call_sync',
      type: 'tool',
      tool: 'subagent',
      state: { status: 'error', input: { description: 'Explore auth' }, error: 'boom' },
    }, turn);
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 'failed');
});

test('a v1 inline task without a notice still publishes completed', async () => {
  const turn = makeParentTurn();
  const emitted = await withStatusCapture(() => {
    _handleToolPart({
      id: 'prt_v1_sync',
      callID: 'call_v1_sync',
      type: 'tool',
      tool: 'task',
      state: { status: 'completed', input: { description: 'Legacy task' }, output: 'final answer' },
    }, turn);
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 'completed');
  assert.equal(emitted[0].childSessionId, null);
});

test('inline terminal signals from both transports emit once', async () => {
  const turn = makeParentTurn();
  const emitted = await withStatusCapture(() => {
    _handleToolPart({
      id: 'prt_sync',
      callID: 'call_sync',
      type: 'tool',
      tool: 'subagent',
      state: {
        status: 'completed',
        input: { description: 'Explore auth' },
        output: '<subagent sessionID="ses_child" state="completed">inline result</subagent>',
      },
    }, turn);
    _handleEvent({
      type: 'session.tool.success',
      properties: {
        sessionID: 'ses_parent',
        toolID: 'call_sync',
        name: 'subagent',
        content: [{ type: 'text', text: '<subagent sessionID="ses_child" state="completed">inline result</subagent>' }],
      },
    });
  });

  assert.equal(emitted.length, 1);
});

test('a v2 background ack carried in state.content registers a watch instead of completing', async () => {
  // Without flattening the content array, the XML ack would look like an inline
  // (sync) terminal result and the card would complete the instant it launched.
  const turn = makeParentTurn();
  const emitted = await withStatusCapture(() => {
    _handleToolPart({
      id: 'prt_bg_content',
      callID: 'call_bg_content',
      type: 'tool',
      tool: 'subagent',
      state: {
        status: 'completed',
        input: { description: 'Explore auth' },
        content: [{
          type: 'text',
          text: '<subagent sessionID="ses_bg" state="running" description="Explore auth">…</subagent>',
        }],
      },
    }, turn);
  });

  assert.equal(emitted.length, 0);
  assert.equal(_subagentMonitor.resolveByChild('ses_bg')?.toolUseId, 'call_bg_content');
});

test('a JSON launch ack inside a v2 content array is recognized as background', async () => {
  const turn = makeParentTurn();
  const emitted = await withStatusCapture(() => {
    _handleToolPart({
      id: 'prt_bg_json',
      callID: 'call_bg_json',
      type: 'tool',
      tool: 'subagent',
      state: {
        status: 'completed',
        input: { description: 'Explore auth' },
        content: [{
          type: 'text',
          text: JSON.stringify({ sessionID: 'ses_bg_json', status: 'running', output: ['working'] }),
        }],
      },
    }, turn);
  });

  assert.equal(emitted.length, 0);
  assert.equal(_subagentMonitor.resolveByChild('ses_bg_json')?.toolUseId, 'call_bg_json');
});

test('a failed launch drops the watch', async () => {
  makeParentTurn();
  registerV2Launch();
  assert.equal(_subagentMonitor.size, 1);

  const emitted = await withStatusCapture(() => {
    _handleEvent({
      type: 'session.tool.failed',
      properties: {
        sessionID: 'ses_parent',
        toolID: 'call_sub',
        error: 'unknown agent',
      },
    });
  });
  assert.equal(_subagentMonitor.size, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 'failed');
});

test('settle reconciliation resolves a child that finished before its watch existed', async () => {
  makeParentTurn();
  registerV2Launch();
  _setSubagentHistoryReaderForTest(async () => completedHistory());

  const emitted = await withStatusCapture(() => _reconcileSubagentsForParent('ses_parent'));
  assert.equal(emitted.length, 1);
  assert.equal(_subagentMonitor.size, 0);
});

test('v1 tool parts register through the same monitor', () => {
  const turn = makeParentTurn();
  _handleToolPart({
    id: 'prt_v1',
    callID: 'call_v1',
    type: 'tool',
    tool: 'task',
    state: {
      status: 'running',
      input: { run_in_background: true, description: 'Explore v1' },
      metadata: { sessionID: 'ses_v1' },
    },
  }, turn);

  assert.equal(_subagentMonitor.resolveByChild('ses_v1')?.toolUseId, 'call_v1');
  assert.equal(_subagentMonitor.resolveByChild('ses_v1')?.background, true);
});

test('a child session outside the watch list never emits', async () => {
  makeParentTurn();
  registerV2Launch();
  const emitted = await withStatusCapture(() => _handleSubagentChildTerminal('ses_unknown', 'completed'));
  assert.equal(emitted.length, 0);
});

test('a transcript that lags the terminal event is re-read exactly once', async () => {
  makeParentTurn();
  registerV2Launch();
  let reads = 0;
  _setSubagentHistoryReaderForTest(async () => {
    reads += 1;
    return reads === 1
      ? { success: true, status: 'running', childSessionID: 'ses_child' }
      : completedHistory();
  });

  const emitted = await withStatusCapture(async () => {
    await _handleSubagentChildTerminal('ses_child', 'completed');
    await new Promise((resolve) => setTimeout(resolve, 1_700));
  });

  assert.equal(reads, 2, 'one immediate read plus one bounded retry');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 'completed');
});
