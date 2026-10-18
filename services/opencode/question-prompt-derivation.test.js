import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _handleEvent, _activeTurns, _createTurn } from './opencode-daemon-service.js';

/**
 * The question dialog is derived from the **tool** event, not from
 * `question.asked`.
 *
 * Why: on opencode v2.0.27 the `question.asked` event's properties carry
 * neither `id` nor `sessionID` (the daemon's own log prints an empty
 * requestId), so the marker it emits has no envelope identity and the host
 * demotes it to a plain log line — the dialog never appears. The tool event
 * *does* resolve a session (that is how `emitToolUseMessage` reaches the right
 * tab) and carries the full `input.questions` payload.
 *
 * The v1 path (`message.part.updated` → `_handleToolPart`) must stay quiet:
 * v1's `question.asked` event does carry identity and already works, so firing
 * from both paths would pop the same dialog twice. These cases pin that
 * separation — it is what keeps the fix v2-only without an engine branch.
 */

const QUESTIONS = [
  { question: '你希望哪个方向？', header: '方向', options: [{ label: 'A', description: '选项 A' }] },
  { question: '还有补充吗？', header: '补充', options: [] },
];

/** Capture `[QUESTION_REQUEST]` markers written to stdout. */
function collectQuestionRequests(run) {
  const emitted = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalError = console.error;
  process.stdout.write = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split('\n')) {
      if (line.startsWith('[QUESTION_REQUEST] ')) {
        emitted.push(JSON.parse(line.slice('[QUESTION_REQUEST] '.length)));
      }
    }
    return true;
  };
  console.log = () => {};
  console.error = () => {};
  try {
    run();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.error = originalError;
  }
  return emitted;
}

/** Install an active turn for `sessionId` and always clean it up. */
function withTurn(sessionId, fn) {
  const turn = _createTurn('req-1', sessionId);
  _activeTurns.set(sessionId, turn);
  try {
    return fn(turn);
  } finally {
    _activeTurns.delete(sessionId);
  }
}

const toolEvent = (sessionId, callID, name, input) => ({
  type: 'session.tool.input',
  properties: { sessionID: sessionId, callID, name, input },
});

test('v2 question tool event emits [QUESTION_REQUEST] with identity and questions', () => {
  withTurn('ses_q1', () => {
    const emitted = collectQuestionRequests(() => {
      _handleEvent(toolEvent('ses_q1', 'call-1', 'question', { questions: QUESTIONS }));
    });

    assert.equal(emitted.length, 1, 'a ready question tool call must prompt exactly once');
    const req = emitted[0];
    assert.equal(req.sessionId, 'ses_q1', 'the prompt must name the session the event belongs to');
    assert.equal(req.requestId, 'call-1', "requestId is the tool call id — the webview's lookup key");
    assert.equal(req.questions.length, 2, 'the full question list must travel with the prompt');
    assert.equal(req.questions[0].question, '你希望哪个方向？');
    assert.equal(req.questions[0].options[0].label, 'A');
  });
});

test('a repeated tool-input event for the same call id does not re-prompt', () => {
  withTurn('ses_q2', () => {
    const emitted = collectQuestionRequests(() => {
      // Tool input arrives incrementally: empty first, then the real object.
      _handleEvent(toolEvent('ses_q2', 'call-1', 'question', { questions: [] }));
      _handleEvent(toolEvent('ses_q2', 'call-1', 'question', { questions: QUESTIONS }));
      _handleEvent(toolEvent('ses_q2', 'call-1', 'question', { questions: QUESTIONS }));
    });

    assert.equal(emitted.length, 1, 'the dialog must not pop again on every input update');
  });
});

test('a non-question tool never produces a question prompt', () => {
  withTurn('ses_q3', () => {
    const emitted = collectQuestionRequests(() => {
      _handleEvent(toolEvent('ses_q3', 'call-1', 'bash', { command: 'ls' }));
      _handleEvent(toolEvent('ses_q3', 'call-2', 'edit', { path: 'a.ts' }));
    });

    assert.equal(emitted.length, 0);
  });
});

test('a question tool call with no questions does not prompt', () => {
  withTurn('ses_q4', () => {
    const emitted = collectQuestionRequests(() => {
      _handleEvent(toolEvent('ses_q4', 'call-1', 'question', {}));
      _handleEvent(toolEvent('ses_q4', 'call-2', 'question', { questions: 'not-an-array' }));
    });

    assert.equal(emitted.length, 0, 'an empty question list has nothing to ask');
  });
});

test('the v1 path (message.part.updated) does not prompt — no double dialog', () => {
  // This is the guard that keeps the fix v2-only without an engine branch:
  // v1 reports the same tool call through `message.part.updated`, and its own
  // `question.asked` event already carries identity. Emitting from both paths
  // would show the user two identical dialogs.
  withTurn('ses_q5', () => {
    const emitted = collectQuestionRequests(() => {
      _handleEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_q5',
          part: {
            id: 'prt_1',
            callID: 'call_v1',
            type: 'tool',
            tool: 'question',
            state: { status: 'running', input: { questions: QUESTIONS } },
          },
        },
      });
    });

    assert.equal(emitted.length, 0,
      'the v1 tool path must stay silent; v1 prompts via its own question.asked event');
  });
});

test('a question tool event for a session with no active turn is ignored', () => {
  // No turn => no identity to attach => emitting would produce an unattributable
  // marker, which is exactly the failure this derivation exists to avoid.
  const emitted = collectQuestionRequests(() => {
    _handleEvent(toolEvent('ses_never_registered', 'call-1', 'question', { questions: QUESTIONS }));
  });

  assert.equal(emitted.length, 0);
});
