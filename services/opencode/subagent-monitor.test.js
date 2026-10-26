import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalStatus,
  createSubagentMonitor,
  isBackgroundLaunch,
  isSubagentToolName,
  parseSubagentNotice,
  summarizeMessages,
} from './subagent-monitor.js';

test('recognises the tool name union across engines', () => {
  assert.equal(isSubagentToolName('task'), true);
  assert.equal(isSubagentToolName('subagent'), true);
  assert.equal(isSubagentToolName(' Subagent '), true);
  assert.equal(isSubagentToolName('bash'), false);
  assert.equal(isSubagentToolName(undefined), false);
});

test('recognises both background spellings', () => {
  assert.equal(isBackgroundLaunch({ background: true }), true);
  assert.equal(isBackgroundLaunch({ run_in_background: true }), true);
  assert.equal(isBackgroundLaunch({ background: false }), false);
  assert.equal(isBackgroundLaunch({}), false);
  assert.equal(isBackgroundLaunch(null), false);
});

test('parses the synthetic subagent notice', () => {
  const notice = parseSubagentNotice(
    '<subagent sessionID="ses_child" state="completed" description="Explore auth">all good</subagent>',
  );
  assert.deepEqual(notice, {
    childSessionId: 'ses_child',
    state: 'completed',
    description: 'Explore auth',
    body: 'all good',
  });
  assert.equal(parseSubagentNotice('plain text'), null);
  assert.equal(parseSubagentNotice('<subagent state="completed">x</subagent>'), null);
});

test('canonicalStatus maps every engine vocabulary and rejects running', () => {
  assert.equal(canonicalStatus('completed'), 'completed');
  assert.equal(canonicalStatus('end_turn'), 'completed');
  assert.equal(canonicalStatus('succeeded'), 'completed');
  assert.equal(canonicalStatus('error'), 'failed');
  assert.equal(canonicalStatus('failed'), 'failed');
  assert.equal(canonicalStatus('cancelled'), 'stopped');
  assert.equal(canonicalStatus('aborted'), 'stopped');
  assert.equal(canonicalStatus('running'), null);
  assert.equal(canonicalStatus('tool-calls'), null);
  assert.equal(canonicalStatus(''), null);
});

test('summarizeMessages reads the last assistant text block', () => {
  const messages = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'ignored' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'bash' }, { type: 'text', text: 'final answer' }] } },
  ];
  assert.equal(summarizeMessages(messages), 'final answer');
  assert.equal(summarizeMessages([]), '');
  assert.equal(summarizeMessages(['bad']), '');
});

test('monitor resolves a watched background child to its tool call', () => {
  const monitor = createSubagentMonitor();
  monitor.register({
    parentSessionId: 'ses_parent',
    toolUseId: 'call_a',
    description: 'Explore',
    background: true,
    childSessionId: 'ses_child',
  });

  const call = monitor.resolveByChild('ses_child');
  assert.equal(call.toolUseId, 'call_a');
  assert.equal(monitor.resolveByChild('ses_other'), null);
});

test('monitor never resolves a foreground call from a child signal', () => {
  const monitor = createSubagentMonitor();
  monitor.register({
    parentSessionId: 'ses_parent',
    toolUseId: 'call_sync',
    description: 'Explore',
    background: false,
    childSessionId: 'ses_child',
  });
  assert.equal(monitor.resolveByChild('ses_child'), null);
  assert.equal(monitor.pendingForParent('ses_parent').length, 0);
});

test('register is idempotent and upgrades the background flag', () => {
  const monitor = createSubagentMonitor();
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_a' });
  assert.equal(monitor.size, 1);
  monitor.register({
    parentSessionId: 'ses_parent',
    toolUseId: 'call_a',
    description: 'Explore',
    background: true,
    childSessionId: 'ses_child',
  });
  assert.equal(monitor.size, 1);
  assert.equal(monitor.resolveByChild('ses_child').description, 'Explore');
});

test('findByDescription prefers an exact match over a substring one', () => {
  const monitor = createSubagentMonitor();
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_old', description: 'Explore auth', background: true });
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_new', description: 'Explore auth again', background: true });
  monitor.register({ parentSessionId: 'ses_other', toolUseId: 'call_other', description: 'Explore auth', background: true });

  assert.equal(monitor.findByDescription('ses_parent', 'Explore auth').toolUseId, 'call_old');
  assert.equal(monitor.findByDescription('ses_parent', 'Explore auth again').toolUseId, 'call_new');
  // A partial match falls back to the newest launch.
  assert.equal(monitor.findByDescription('ses_parent', 'Explore').toolUseId, 'call_new');
  assert.equal(monitor.findByDescription('ses_parent', 'unrelated'), null);
  assert.equal(monitor.findByDescription('ses_missing', 'Explore auth'), null);
});

test('findByDescription still matches a launch that already knows its child', () => {
  const monitor = createSubagentMonitor();
  monitor.register({
    parentSessionId: 'ses_parent',
    toolUseId: 'call_a',
    description: 'Explore auth',
    background: true,
    childSessionId: 'ses_ack',
  });
  // The engine notice may name a different child id than the launch ack.
  assert.equal(monitor.findByDescription('ses_parent', 'Explore auth').toolUseId, 'call_a');
});

test('emitted dedupe drops the watch and survives re-registration', () => {
  const monitor = createSubagentMonitor();
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_a', background: true, childSessionId: 'ses_child' });
  monitor.markEmitted('call_a');

  assert.equal(monitor.hasEmitted('call_a'), true);
  assert.equal(monitor.resolveByChild('ses_child'), null);
  assert.equal(monitor.size, 0);

  // A late duplicate trigger must not emit a second terminal.
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_a', background: true, childSessionId: 'ses_child' });
  assert.equal(monitor.hasEmitted('call_a'), true);
});

test('drop removes a watch without recording a terminal', () => {
  const monitor = createSubagentMonitor();
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_a', background: true, childSessionId: 'ses_child' });
  monitor.drop('call_a');
  assert.equal(monitor.hasEmitted('call_a'), false);
  assert.equal(monitor.resolveByChild('ses_child'), null);
});

test('the monitor is bounded', () => {
  const monitor = createSubagentMonitor({ maxCalls: 2 });
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_1', background: true, childSessionId: 'ses_1' });
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_2', background: true, childSessionId: 'ses_2' });
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_3', background: true, childSessionId: 'ses_3' });

  assert.equal(monitor.size, 2);
  assert.equal(monitor.resolveByChild('ses_1'), null);
  assert.equal(monitor.resolveByChild('ses_3').toolUseId, 'call_3');
});

test('reset clears every index', () => {
  const monitor = createSubagentMonitor();
  monitor.register({ parentSessionId: 'ses_parent', toolUseId: 'call_a', background: true, childSessionId: 'ses_child' });
  monitor.markEmitted('call_a');
  monitor.reset();
  assert.equal(monitor.size, 0);
  assert.equal(monitor.hasEmitted('call_a'), false);
  assert.equal(monitor.resolveByChild('ses_child'), null);
});
