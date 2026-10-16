import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCliBinAndEngineMode } from './cli-path.js';
import { initEngineMode, isV2, getDetectedCliVersion } from '../services/opencode/opencode-serve-manager.js';

test('detectCliBinAndEngineMode correctly detects local environment and version', () => {
  const result = detectCliBinAndEngineMode();
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.isV2, 'boolean');
  if (result.version) {
    if (result.version.startsWith('1.')) {
      assert.equal(result.isV2, false, 'v1 version must set isV2 to false');
    } else {
      assert.equal(result.isV2, true, 'v2+ version must set isV2 to true');
    }
  }
});

test('initEngineMode locks the engine mode and is idempotent', () => {
  const mode1 = initEngineMode();
  const mode2 = initEngineMode();
  assert.equal(mode1.isV2, mode2.isV2);
  assert.equal(mode1.version, mode2.version);
  assert.equal(isV2(), mode1.isV2);
  assert.equal(getDetectedCliVersion(), mode1.version);
});
