import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSdkModelEntry,
  parseOpenCodeModelsOutput,
  resolveContextWindow,
  resolveDefaultModelId,
} from './models-service.js';

test('parses provider/model lines and dedups', () => {
  const out = 'opencode/big-pickle\nanthropic/claude-fable-5\nopencode/big-pickle\n';
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['opencode/big-pickle', 'anthropic/claude-fable-5']);
  // UI groups by provider prefix, so the label carries the model name only.
  assert.equal(models[0].label, 'Big-Pickle');
});

test('handles CRLF and ANSI escape sequences (Windows terminals)', () => {
  const out = '\x1b[32mopencode/big-pickle\x1b[0m\r\n\x1b[2manthropic/claude-fable-5\x1b[0m\r\n';
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['opencode/big-pickle', 'anthropic/claude-fable-5']);
});

test('picks the model token even when the line has extra columns', () => {
  const out = 'default  anthropic/claude-fable-5  200k context\n';
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-fable-5']);
});

test('rejects Windows paths, URLs and UNC-ish tokens', () => {
  const out = [
    'Config loaded from C:/Users/x/.config/opencode/config.json',
    'Docs: https://opencode.ai/docs/models',
    'Share \\\\server\\share\\dir',
    'D:\\tools\\opencode.cmd run',
    'anthropic/claude-fable-5',
  ].join('\r\n');
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-fable-5']);
});

test('returns empty list for empty or unparseable output', () => {
  assert.deepEqual(parseOpenCodeModelsOutput(''), []);
  assert.deepEqual(parseOpenCodeModelsOutput('No providers configured.\nRun `opencode auth login`.'), []);
});

test('resolveDefaultModelId reads the global { providerID, modelID } shape', () => {
  assert.equal(
    resolveDefaultModelId('anthropic', { providerID: 'anthropic', modelID: 'claude-sonnet-5' }),
    'anthropic/claude-sonnet-5',
  );
});

test('resolveDefaultModelId tolerates per-provider map shapes', () => {
  assert.equal(
    resolveDefaultModelId('anthropic', { anthropic: 'claude-opus-5' }),
    'anthropic/claude-opus-5',
  );
  assert.equal(
    resolveDefaultModelId('anthropic', { anthropic: { modelID: 'claude-haiku-5' } }),
    'anthropic/claude-haiku-5',
  );
});

test('resolveDefaultModelId returns null for missing or malformed defaults', () => {
  assert.equal(resolveDefaultModelId('anthropic', null), null);
  assert.equal(resolveDefaultModelId('anthropic', {}), null);
  assert.equal(resolveDefaultModelId('anthropic', { providerID: 'anthropic' }), null);
  assert.equal(resolveDefaultModelId('anthropic', { modelID: 'claude-sonnet-5' }), null);
  assert.equal(resolveDefaultModelId(undefined, { providerID: 'a', modelID: 'b' }), 'a/b');
});

test('resolveContextWindow reads models.dev limit.context', () => {
  assert.equal(resolveContextWindow({ limit: { context: 1000000, output: 384000 } }), 1000000);
  assert.equal(resolveContextWindow({ limit: { context: 1048576 } }), 1048576);
});

test('resolveContextWindow ignores missing or nonsense limits', () => {
  assert.equal(resolveContextWindow(undefined), undefined);
  assert.equal(resolveContextWindow({}), undefined);
  assert.equal(resolveContextWindow({ limit: {} }), undefined);
  assert.equal(resolveContextWindow({ limit: { context: 0 } }), undefined);
  assert.equal(resolveContextWindow({ limit: { context: -1 } }), undefined);
  assert.equal(resolveContextWindow({ limit: { context: 'nope' } }), undefined);
  // limit.output alone is not a context window.
  assert.equal(resolveContextWindow({ limit: { output: 32000 } }), undefined);
});

test('buildSdkModelEntry carries contextWindow through to the catalog entry', () => {
  const entry = buildSdkModelEntry('deepseek', 'DeepSeek', 'deepseek-v4-pro', {
    name: 'DeepSeek V4 Pro',
    limit: { context: 1000000, output: 384000 },
  });
  assert.deepEqual(entry, {
    id: 'deepseek/deepseek-v4-pro',
    label: 'Deepseek-V4-Pro',
    description: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
  });
});

test('buildSdkModelEntry omits contextWindow when the limit is unknown', () => {
  const entry = buildSdkModelEntry('opencode', 'opencode', 'big-pickle', {});
  assert.equal('contextWindow' in entry, false);
  assert.equal(entry.description, 'opencode big-pickle');
});

test('buildSdkModelEntry keeps variants alongside the context window', () => {
  const entry = buildSdkModelEntry('anthropic', 'Anthropic', 'claude-sonnet-5', {
    variants: { high: {}, low: {}, disabledOne: { disabled: true } },
    limit: { context: 200000 },
  });
  assert.deepEqual(entry.variants, ['high', 'low']);
  assert.equal(entry.contextWindow, 200000);
});

test('buildSdkModelEntry reports an explicit empty list when no variant is usable', () => {
  const allDisabled = buildSdkModelEntry('anthropic', 'Anthropic', 'claude-sonnet-5', {
    variants: { v1: { disabled: true }, v2: { disabled: true } },
  });
  // Present-and-empty means "this model has no usable variants" → the UI hides
  // the selector. Absent means "unknown" (opencode v1 ships no catalog) → the UI
  // keeps its legacy list. The two must not be collapsed into one.
  assert.deepEqual(allDisabled.variants, []);

  const emptyVariants = buildSdkModelEntry('anthropic', 'Anthropic', 'claude-sonnet-5', {
    variants: {},
  });
  assert.deepEqual(emptyVariants.variants, []);
});

test('parseOpenCodeModelsOutput parses tab-delimited output with multiple columns', () => {
  const out = 'opencode\topencode/nemotron-3-ultra-free\t1M context\nopenai\topenai/gpt-5.5\t200k context\n';
  const models = parseOpenCodeModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['opencode/nemotron-3-ultra-free', 'openai/gpt-5.5']);
  assert.equal(models[0].label, 'Nemotron-3-Ultra-Free');
});

// ---------------------------------------------------------------------------
// Variant tri-state
//
// opencode exposes `variants` per model, and the set differs wildly: some models
// have none at all, deepseek/glm only have low/high/max, others add xhigh. The
// UI needs to tell "this model has none" (hide the selector) apart from "we don't
// know" (opencode v1 ships no catalog → keep the legacy list). Collapsing both to
// `undefined` made the selector offer `high` on models that reject it, and every
// send failed with `Variant unavailable`.
// ---------------------------------------------------------------------------

test('buildSdkModelEntry reports an empty variant list as an explicit empty array', () => {
  const entry = buildSdkModelEntry('opencode', 'OpenCode', 'mimo-v2.6-flash-free', {
    name: 'Mimo',
    variants: {},
  });
  // Must be present-and-empty, NOT absent: absent means "unknown".
  assert.deepEqual(entry.variants, []);
});

test('buildSdkModelEntry omits variants entirely when the catalog has no field', () => {
  const entry = buildSdkModelEntry('opencode', 'OpenCode', 'legacy-model', { name: 'Legacy' });
  assert.equal('variants' in entry, false);
});

test('buildSdkModelEntry keeps only enabled variants and drops disabled ones', () => {
  const entry = buildSdkModelEntry('opencode', 'OpenCode', 'deepseek', {
    name: 'DeepSeek',
    variants: {
      low: {},
      high: { reasoningEffort: 'high' },
      max: { disabled: true },
    },
  });
  assert.deepEqual(entry.variants, ['low', 'high']);
});

test('buildSdkModelEntry accepts the v2 array form of variants', () => {
  const entry = buildSdkModelEntry('opencode', 'OpenCode', 'beam-free', {
    name: 'Beam',
    variants: [{ id: 'low' }, { id: 'xhigh' }],
  });
  assert.deepEqual(entry.variants, ['low', 'xhigh']);
});
