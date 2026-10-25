import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  childFromList,
  convertEntries,
  findTool,
  getSubagentHistory,
  statusFromEntries,
} from './subagent-service.js';

function entry(role, finish, parts = [], error = null) {
  return {
    info: {
      id: `msg_${role}_${finish ?? 'none'}`,
      role,
      ...(finish ? { finish } : {}),
      ...(error ? { error } : {}),
    },
    parts,
  };
}

function parentWithChild(childSessionID = 'ses_child') {
  return [{
    info: { id: 'msg_parent', role: 'assistant' },
    parts: [{
      type: 'tool',
      id: 'call_task',
      tool: 'subagent',
      state: {
        status: 'completed',
        metadata: { sessionID: childSessionID },
      },
    }],
  }];
}

test('findTool reads child session from v2 metadata', () => {
  const found = findTool(parentWithChild(), 'call_task');
  assert.equal(found.childSessionId, 'ses_child');
});

test('findTool falls back to the v1 subagent wrapper', () => {
  const entries = [{
    info: { id: 'msg_parent', role: 'assistant' },
    parts: [{
      type: 'tool',
      id: 'call_task',
      tool: 'subagent',
      state: {
        status: 'completed',
        output: '<subagent sessionID="ses_from_text" state="completed">ok</subagent>',
      },
    }],
  }];
  assert.equal(findTool(entries, 'call_task').childSessionId, 'ses_from_text');
});

test('findTool ignores unrelated tool parts', () => {
  const entries = [{
    info: { role: 'assistant' },
    parts: [{ type: 'tool', id: 'call_read', tool: 'read', state: {} }],
  }];
  assert.equal(findTool(entries, 'call_task'), null);
});

test('childFromList matches the description and picks the newest', () => {
  const sessions = [
    { id: 'ses_old', title: 'Other task', time: { updated: 10 } },
    { id: 'ses_match', title: 'Explore repo', time: { updated: 20 } },
  ];
  assert.equal(childFromList(sessions, 'Explore repo'), 'ses_match');
});

test('statusFromEntries treats a running child as running, never as the parent ack', () => {
  assert.equal(statusFromEntries([entry('assistant', 'tool-calls')]), 'running');
  assert.equal(statusFromEntries([]), 'running');
  assert.equal(statusFromEntries([entry('user', null)]), 'running');
});

test('statusFromEntries reads the child terminal finish or error', () => {
  assert.equal(statusFromEntries([entry('assistant', 'tool-calls'), entry('assistant', 'stop')]), 'completed');
  assert.equal(
    statusFromEntries([entry('assistant', 'stop', [], { type: 'tool.execution', message: 'failed' })]),
    'error',
  );
});

test('convertEntries turns child parts into the process-card message shape', () => {
  const messages = convertEntries([entry('assistant', 'stop', [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'report' },
    { type: 'tool', id: 'call_read', tool: 'read', state: { input: { path: '/repo/a.txt' } } },
  ])]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'assistant');
  const blocks = messages[0].message.content;
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'thinking');
  assert.equal(blocks[0].thinking, 'thinking');
  assert.equal(blocks[1].text, 'report');
  assert.equal(blocks[2].type, 'tool_use');
  assert.equal(blocks[2].name, 'read');
  assert.deepEqual(blocks[2].input, { path: '/repo/a.txt' });
});

test('getSubagentHistory follows the child transcript from running to completed', async () => {
  let childFinish = 'tool-calls';
  const deps = {
    listMessages: async (sessionID) => {
      if (sessionID === 'ses_parent') return parentWithChild();
      return [entry('assistant', childFinish, [{ type: 'text', text: 'child report' }])];
    },
    listSessions: async () => [],
  };

  const running = await getSubagentHistory({
    parentSessionId: 'ses_parent',
    toolUseId: 'call_task',
  }, deps);
  assert.equal(running.success, true);
  assert.equal(running.status, 'running');
  assert.equal(running.completed, false);
  assert.equal(running.childSessionID, 'ses_child');

  childFinish = 'stop';
  const completed = await getSubagentHistory({
    parentSessionId: 'ses_parent',
    toolUseId: 'call_task',
    poll: true,
  }, deps);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completed, true);
  assert.equal(completed.messages.length, 1);
});

test('getSubagentHistory falls back to parentID child sessions', async () => {
  const deps = {
    listMessages: async (sessionID) => {
      if (sessionID === 'ses_parent') return [{
        info: { role: 'assistant' },
        parts: [{
          type: 'tool',
          id: 'call_task',
          tool: 'subagent',
          state: { status: 'completed', input: { description: 'Explore repo' } },
        }],
      }];
      if (sessionID === 'ses_child') return [entry('assistant', 'task-calls')];
      return [];
    },
    listSessions: async () => [{ id: 'ses_child', title: 'Explore repo', time: { updated: 5 } }],
  };

  const history = await getSubagentHistory({
    parentSessionId: 'ses_parent',
    toolUseId: 'call_task',
    description: 'Explore repo',
  }, deps);
  assert.equal(history.childSessionID, 'ses_child');
  assert.equal(history.status, 'running');
});

test('getSubagentHistory reports a fetch failure as running, not completed', async () => {
  const deps = {
    listMessages: async () => { throw new Error('bridge down'); },
    listSessions: async () => [],
  };
  const history = await getSubagentHistory({
    parentSessionId: 'ses_parent',
    toolUseId: 'call_task',
  }, deps);
  assert.equal(history.success, false);
  assert.equal(history.status, 'running');
  assert.equal(history.completed, false);
  assert.match(history.error, /bridge down/);
});
