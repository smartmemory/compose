/**
 * Tests for STRAT-TIER:
 *   - server/model-tiers.js: MODEL_TIERS, resolveTierModel
 *   - lib/agent-string.js: parseAgentString (tier extension), resolveAgentConfig (modelID)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_TIERS, resolveTierModel, TIER_THINKING, resolveTierThinking } from '../server/model-tiers.js';
import { parseAgentString, resolveAgentConfig } from '../lib/agent-string.js';

// ---------------------------------------------------------------------------
// resolveTierModel
// ---------------------------------------------------------------------------

describe('resolveTierModel', () => {
  test('critical resolves to Opus', () => {
    assert.strictEqual(resolveTierModel('critical'), 'claude-opus-5');
  });

  test('standard resolves to Sonnet', () => {
    assert.strictEqual(resolveTierModel('standard'), 'claude-sonnet-5');
  });

  test('fast resolves to Haiku', () => {
    assert.strictEqual(resolveTierModel('fast'), 'claude-haiku-4-5-20251001');
  });

  test('unknown tier returns null', () => {
    assert.strictEqual(resolveTierModel('unknown'), null);
  });

  test('null returns null', () => {
    assert.strictEqual(resolveTierModel(null), null);
  });

  test('undefined returns null', () => {
    assert.strictEqual(resolveTierModel(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// MODEL_TIERS export shape
// ---------------------------------------------------------------------------

describe('MODEL_TIERS', () => {
  test('exports the four expected tiers', () => {
    assert.ok('critical' in MODEL_TIERS);
    assert.ok('standard' in MODEL_TIERS);
    assert.ok('fast' in MODEL_TIERS);
    assert.ok('coordinator' in MODEL_TIERS);
  });
});

// ---------------------------------------------------------------------------
// resolveTierThinking
// ---------------------------------------------------------------------------

describe('resolveTierThinking', () => {
  test('critical → adaptive + xhigh', () => {
    assert.deepStrictEqual(resolveTierThinking('critical'), { mode: 'adaptive', effort: 'xhigh' });
  });
  test('standard → adaptive + high', () => {
    assert.deepStrictEqual(resolveTierThinking('standard'), { mode: 'adaptive', effort: 'high' });
  });
  test('fast → off + null (Haiku does not accept effort)', () => {
    assert.deepStrictEqual(resolveTierThinking('fast'), { mode: 'off', effort: null });
  });
  // C12: codex reserves `low` effort for trivial mechanical work; the fast tier
  // picks the cheap model, it does not drop reasoning to the floor.
  test('codex tiers run high effort, and fast runs medium — never low', () => {
    assert.deepStrictEqual(resolveTierThinking('critical', 'codex'), { mode: null, effort: 'high' });
    assert.deepStrictEqual(resolveTierThinking('standard', 'codex'), { mode: null, effort: 'high' });
    assert.deepStrictEqual(resolveTierThinking('fast', 'codex'), { mode: null, effort: 'medium' });
  });
  test('unknown tier returns null', () => {
    assert.strictEqual(resolveTierThinking('unknown'), null);
  });
  test('null returns null', () => {
    assert.strictEqual(resolveTierThinking(null), null);
  });
});

describe('TIER_THINKING', () => {
  test('exports config for all four tiers', () => {
    assert.ok('critical' in TIER_THINKING);
    assert.ok('standard' in TIER_THINKING);
    assert.ok('fast' in TIER_THINKING);
    assert.ok('coordinator' in TIER_THINKING);
  });
});

// ---------------------------------------------------------------------------
// parseAgentString — tier extension
// ---------------------------------------------------------------------------

describe('parseAgentString — tier extension', () => {
  test('"claude::fast" → provider=claude, template=null, tier=fast', () => {
    const r = parseAgentString('claude::fast');
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, null);
    assert.strictEqual(r.tier, 'fast');
  });

  test('"claude:read-only-reviewer:critical" → parses all three parts', () => {
    const r = parseAgentString('claude:read-only-reviewer:critical');
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, 'read-only-reviewer');
    assert.strictEqual(r.tier, 'critical');
  });

  test('"claude::standard" → provider=claude, template=null, tier=standard', () => {
    const r = parseAgentString('claude::standard');
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, null);
    assert.strictEqual(r.tier, 'standard');
  });

  // Backward compat — existing format must still work
  test('"claude" → tier=null (backward compat)', () => {
    const r = parseAgentString('claude');
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, null);
    assert.strictEqual(r.tier, null);
  });

  test('"claude:read-only-reviewer" → tier=null (backward compat)', () => {
    const r = parseAgentString('claude:read-only-reviewer');
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, 'read-only-reviewer');
    assert.strictEqual(r.tier, null);
  });

  test('null → default claude with tier=null (backward compat)', () => {
    const r = parseAgentString(null);
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, null);
    assert.strictEqual(r.tier, null);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentConfig — modelID field
// ---------------------------------------------------------------------------

describe('resolveAgentConfig — modelID', () => {
  test('"claude::fast" returns Haiku modelID', () => {
    const cfg = resolveAgentConfig('claude::fast');
    assert.strictEqual(cfg.provider, 'claude');
    assert.strictEqual(cfg.tier, 'fast');
    assert.strictEqual(cfg.modelID, 'claude-haiku-4-5-20251001');
  });

  test('"claude::critical" returns Opus modelID', () => {
    const cfg = resolveAgentConfig('claude::critical');
    assert.strictEqual(cfg.tier, 'critical');
    assert.strictEqual(cfg.modelID, 'claude-opus-5');
  });

  test('"claude" → modelID=null (no tier, uses connector default)', () => {
    const cfg = resolveAgentConfig('claude');
    assert.strictEqual(cfg.tier, null);
    assert.strictEqual(cfg.modelID, null);
  });

  test('null → modelID=null (backward compat)', () => {
    const cfg = resolveAgentConfig(null);
    assert.strictEqual(cfg.modelID, null);
    assert.strictEqual(cfg.tier, null);
  });

  test('"claude:read-only-reviewer:critical" → Opus modelID + tools preserved', () => {
    const cfg = resolveAgentConfig('claude:read-only-reviewer:critical');
    assert.strictEqual(cfg.provider, 'claude');
    assert.strictEqual(cfg.template, 'read-only-reviewer');
    assert.strictEqual(cfg.tier, 'critical');
    assert.strictEqual(cfg.modelID, 'claude-opus-5');
    assert.deepStrictEqual(cfg.allowedTools, ['Read', 'Grep', 'Glob', 'Agent']);
    assert.deepStrictEqual(cfg.disallowedTools, ['Edit', 'Write', 'Bash']);
  });

  test('"claude::critical" → thinking=adaptive + effort=xhigh', () => {
    const cfg = resolveAgentConfig('claude::critical');
    assert.deepStrictEqual(cfg.thinking, { type: 'adaptive' });
    assert.strictEqual(cfg.effort, 'xhigh');
  });

  test('"claude::fast" → thinking=disabled + effort=null', () => {
    const cfg = resolveAgentConfig('claude::fast');
    assert.deepStrictEqual(cfg.thinking, { type: 'disabled' });
    assert.strictEqual(cfg.effort, null);
  });

  test('"claude" (no tier) → thinking=null + effort=null', () => {
    const cfg = resolveAgentConfig('claude');
    assert.strictEqual(cfg.thinking, null);
    assert.strictEqual(cfg.effort, null);
  });
});


test('coordinator routes only Claude to Fable with adaptive high thinking', () => {
  assert.equal(resolveTierModel('coordinator', 'claude'), 'claude-fable-5-1');
  assert.equal(resolveTierModel('coordinator', 'codex'), null);
  assert.deepEqual(resolveTierThinking('coordinator'), { mode: 'adaptive', effort: 'high' });
  assert.equal(resolveTierThinking('coordinator', 'codex'), null);
  const config = resolveAgentConfig('claude:orchestrator:coordinator');
  assert.equal(config.modelID, 'claude-fable-5-1');
  assert.deepEqual(config.thinking, { type: 'adaptive' });
  assert.equal(config.effort, 'high');
});

test('existing Codex model routes are unchanged', () => {
  assert.equal(resolveTierModel('critical', 'codex'), 'gpt-6-astra');
  assert.equal(resolveTierModel('standard', 'codex'), 'gpt-5.6-terra');
  assert.equal(resolveTierModel('fast', 'codex'), 'gpt-5.3-codex-spark');
});
