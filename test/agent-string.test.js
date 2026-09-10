import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_TIERS } from '../server/model-tiers.js';
import { validateAgentString } from '../lib/agent-string.js';

test('Claude accepts every tier from the model table, including coordinator', () => {
  for (const tier of Object.keys(MODEL_TIERS)) {
    assert.doesNotThrow(() => validateAgentString(`claude:orchestrator:${tier}`));
  }
});

test('Codex coordinator fails with the provider-naming message', () => {
  assert.throws(() => validateAgentString('codex::coordinator'), {
    message: 'Invalid agent string "codex::coordinator": tier "coordinator" is not available for provider "codex"',
  });
});

test('unknown tier error lists precisely the tiers in the model table', () => {
  assert.throws(() => validateAgentString('claude::bogus'), {
    message: `Invalid agent string "claude::bogus": unknown tier "bogus" (known: ${Object.keys(MODEL_TIERS).sort().join(', ')})`,
  });
});

test('bare providers and templates retain connector defaults', () => {
  for (const profile of ['claude', 'codex', 'claude:orchestrator']) {
    assert.doesNotThrow(() => validateAgentString(profile));
  }
});
