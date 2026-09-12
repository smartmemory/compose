import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_TIERS, CODEX_MODEL_TIERS } from '../server/model-tiers.js';
import { validateAgentString } from '../lib/agent-string.js';

// Every tier the Claude table actually maps to a model must validate for Claude.
// Tiers present in the shared vocabulary but null for Claude (`budget`) are the
// provider-unavailable case and are covered by the rejection test below.
test('Claude accepts every tier its model table resolves, including coordinator', () => {
  for (const [tier, model] of Object.entries(MODEL_TIERS)) {
    if (model === null) continue;
    assert.doesNotThrow(() => validateAgentString(`claude:orchestrator:${tier}`));
  }
});

test('Codex accepts every tier its model table resolves, including budget', () => {
  for (const [tier, model] of Object.entries(CODEX_MODEL_TIERS)) {
    if (model === null) continue;
    assert.doesNotThrow(() => validateAgentString(`codex:reviewer:${tier}`));
  }
});

test('Codex coordinator fails with the provider-naming message', () => {
  assert.throws(() => validateAgentString('codex::coordinator'), {
    message: 'Invalid agent string "codex::coordinator": tier "coordinator" is not available for provider "codex"',
  });
});

// budget is coordinator's mirror: a known tier name that no Claude model backs.
test('Claude budget fails with the provider-naming message, not unknown-tier', () => {
  assert.throws(() => validateAgentString('claude::budget'), {
    message: 'Invalid agent string "claude::budget": tier "budget" is not available for provider "claude"',
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
