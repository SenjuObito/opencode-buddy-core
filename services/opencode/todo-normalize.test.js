import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _activeTurns,
  _createTurn,
  _emitTodos,
  _handleEvent,
  _handleToolPart,
  _resetTodosForTest,
  getSessionTodos,
  normalizeTodoList,
} from './opencode-daemon-service.js';

function collectTodoMarkers(run) {
  const emitted = [];
  const originalWrite = process.stdout.write;
  const originalError = console.error;
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.startsWith('[TODO_UPDATED] ')) {
      // emitJsonStringMarker writes `<tag> ${JSON.stringify(text)}`; unwrap
      // the outer string before parsing the canonical object.
      const raw = JSON.parse(chunk.slice('[TODO_UPDATED] '.length));
      emitted.push(JSON.parse(raw));
    }
    return true;
  };
  console.error = () => {};
  try {
    run();
  } finally {
    process.stdout.write = originalWrite;
    console.error = originalError;
  }
  return emitted;
}

function createTurn(sessionId = 'ses_todo') {
  return {
    sessionId,
    parts: new Map(),
    toolUseDone: new Set(),
    toolUseInput: new Map(),
    toolResultDone: new Set(),
    toolNames: new Map(),
  };
}

test('normalizeTodoList preserves v2 statuses including cancelled', () => {
  assert.deepEqual(normalizeTodoList([
    { content: '  inspect  ', status: 'in_progress' },
    { content: 'write', status: 'pending' },
    { content: 'done', status: 'completed' },
    { content: 'skip', status: 'cancelled' },
    { content: 'alias', status: 'canceled' },
    { content: 'running', status: 'running' },
  ]), [
    { content: 'inspect', status: 'in_progress' },
    { content: 'write', status: 'pending' },
    { content: 'done', status: 'completed' },
    { content: 'skip', status: 'cancelled' },
    { content: 'alias', status: 'cancelled' },
    { content: 'running', status: 'in_progress' },
  ]);
});

test('normalizeTodoList accepts v1 update_plan-ish keys and empty lists', () => {
  assert.deepEqual(normalizeTodoList([
    { step: 'first', status: 'active', id: 7 },
    { title: 'second', status: 'done' },
  ]), [
    { content: 'first', status: 'in_progress', id: '7' },
    { content: 'second', status: 'completed' },
  ]);
  assert.deepEqual(normalizeTodoList([]), []);
  assert.equal(normalizeTodoList('not-an-array'), null);
});

test('_emitTodos emits one canonical revision per real change', () => {
  _resetTodosForTest();
  const markers = collectTodoMarkers(() => {
    _emitTodos('ses_a', [
      { content: 'one', status: 'in_progress' },
      { content: 'two', status: 'pending' },
    ], 'todowrite');
    _emitTodos('ses_a', [
      { content: 'one', status: 'in_progress' },
      { content: 'two', status: 'pending' },
    ], 'todo.updated'); // same state: no second event
    _emitTodos('ses_a', [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'pending' },
    ], 'todowrite');
  });

  assert.equal(markers.length, 2);
  assert.equal(markers[0].sessionID, 'ses_a');
  assert.equal(markers[0].revision, 1);
  assert.equal(markers[0].todos[0].status, 'in_progress');
  assert.equal(markers[1].revision, 2);
  assert.equal(markers[1].todos[0].status, 'completed');
  assert.equal(getSessionTodos('ses_a')[0].status, 'completed');
});

test('_emitTodos clears a session with an explicit empty list', () => {
  _resetTodosForTest();
  const markers = collectTodoMarkers(() => {
    _emitTodos('ses_clear', [{ content: 'one', status: 'completed' }], 'todowrite');
    _emitTodos('ses_clear', [], 'todowrite');
  });
  assert.equal(markers.length, 2);
  assert.deepEqual(markers[1].todos, []);
  assert.deepEqual(getSessionTodos('ses_clear'), []);
});

test('v1 message.part.updated todowrite publishes canonical todos', () => {
  _resetTodosForTest();
  const turn = createTurn('ses_v1');
  const markers = collectTodoMarkers(() => {
    _handleToolPart({
      id: 'prt_1',
      callID: 'call_1',
      type: 'tool',
      tool: 'TodoWrite',
      state: {
        status: 'running',
        input: {
          todos: [
            { content: 'first', status: 'in_progress' },
            { content: 'second', status: 'pending' },
          ],
        },
      },
    }, turn);
  });

  assert.equal(markers.length, 1);
  assert.equal(markers[0].source, 'message.part.updated');
  assert.equal(markers[0].todos[0].status, 'in_progress');
  assert.equal(markers[0].todos[1].status, 'pending');
});

test('v1 todo.updated event uses the canonical normalizer', () => {
  _resetTodosForTest();
  const markers = collectTodoMarkers(() => {
    _handleEvent({
      type: 'todo.updated',
      properties: {
        sessionID: 'ses_event',
        todos: [
          { content: 'event task', status: 'in_progress' },
          { content: 'cancelled task', status: 'cancelled' },
        ],
      },
    });
  });

  assert.equal(markers.length, 1);
  assert.equal(markers[0].sessionID, 'ses_event');
  assert.equal(markers[0].todos[0].status, 'in_progress');
  assert.equal(markers[0].todos[1].status, 'cancelled');
});
