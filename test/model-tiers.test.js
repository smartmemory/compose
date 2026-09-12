/**
 * Tests for STRAT-TIER:
 *   - server/model-tiers.js: MODEL_TIERS, resolveTierModel
 *   - lib/agent-string.js: parseAgentString (tier extension), resolveAgentConfig (modelID)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_TIERS, CODEX_MODEL_TIERS, resolveTierModel, TIER_THINKING, resolveTierThinking } from '../server/model-tiers.js';
import { parseAgentString, resolveAgentConfig } from '../lib/agent-string.js';
import recordSchema from '../contracts/routing-record.schema.json' with { type: 'json' };
import startSchema from '../contracts/routing-start.schema.json' with { type: 'json' };

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
  test('exports the five expected tiers', () => {
    assert.ok('critical' in MODEL_TIERS);
    assert.ok('standard' in MODEL_TIERS);
    assert.ok('fast' in MODEL_TIERS);
    assert.ok('budget' in MODEL_TIERS);
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
  test('exports config for all five tiers', () => {
    assert.ok('critical' in TIER_THINKING);
    assert.ok('standard' in TIER_THINKING);
    assert.ok('fast' in TIER_THINKING);
    assert.ok('budget' in TIER_THINKING);
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


// ---------------------------------------------------------------------------
// budget — the Codex-only mirror of coordinator (COMP-MODEL-ROUTE, 2026-09-12)
// ---------------------------------------------------------------------------

test('budget routes only Codex, to luna, at medium effort', () => {
  assert.equal(resolveTierModel('budget', 'codex'), 'gpt-5.6-luna');
  assert.equal(resolveTierModel('budget', 'claude'), null);
  assert.deepEqual(resolveTierThinking('budget', 'codex'), { mode: null, effort: 'medium' });
  assert.equal(resolveTierThinking('budget', 'claude'), null);
  const config = resolveAgentConfig('codex:reviewer:budget');
  assert.equal(config.modelID, 'gpt-5.6-luna');
  assert.equal(config.effort, 'medium');
});

// budget is ADDRESSABLE, not LADDERED: it is deliberately absent from the cost ladder
// in lib/routing-ledger.js, so it is nameable but is not an auto-escalation candidate
// and does not enter floor computation. Ladder membership is an S2/S3 decision (Q3).
test('budget is priced, so a luna dispatch is attributable', async () => {
  const { MODEL_PRICING, calculateCost } = await import('../lib/model-pricing.js');
  const luna = MODEL_PRICING[resolveTierModel('budget', 'codex')];
  assert.deepEqual(luna, { inputPerMTok: 0.2, outputPerMTok: 1.2 });
  // A priced model yields a non-zero cost, so the ledger never marks it missing-usd.
  assert.ok(calculateCost('gpt-5.6-luna', 1_000_000, 1_000_000) > 0);
});

// ---------------------------------------------------------------------------
// Contract drift: the tier vocabulary is frozen into persisted routing records.
// A tier added to the table but not to the schemas makes every record carrying it
// fail validation at the ledger boundary — this test is the control for that.
// ---------------------------------------------------------------------------

describe('tier enums in the routing contracts track the model table', () => {
  const expected = [null, ...Object.keys(MODEL_TIERS)].sort((a, b) => String(a).localeCompare(String(b)));

  /** Every `enum` in the schema that looks like a tier enum (contains 'critical'). */
  function tierEnums(node, found = []) {
    if (Array.isArray(node)) { for (const v of node) tierEnums(v, found); return found; }
    if (node && typeof node === 'object') {
      if (Array.isArray(node.enum) && node.enum.includes('critical')) found.push(node.enum);
      for (const v of Object.values(node)) tierEnums(v, found);
    }
    return found;
  }

  for (const [name, schema] of [['routing-record', recordSchema], ['routing-start', startSchema]]) {
    test(`${name} tier enums equal the model table`, () => {
      const enums = tierEnums(schema);
      assert.ok(enums.length > 0, `no tier enum found in ${name}`);
      for (const e of enums) {
        assert.deepEqual(
          [...e].sort((a, b) => String(a).localeCompare(String(b))),
          expected,
          `${name} tier enum drifted from MODEL_TIERS`
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Every routable tier model must be priced in BOTH tables, by an EXACT key.
//
// experiment-pricing.js falls back to the first key that PREFIXES the model ID, and the
// legacy `gpt-5` key prefixes every gpt-5.x model. `gpt-5.6-luna` hit that fallback and
// priced at 10/40 instead of 0.2/1.2 — a silent 35.7x overstatement, no null to flag it.
// This test is the control: a new tier model with no exact key fails here, loudly.
// ---------------------------------------------------------------------------

describe('routable tier models are priced in both tables', () => {
  // KNOWN DIVERGENCE, filed not fixed: experiment-pricing retains pre-cut rates
  // (terra 2.5/15, sol 5/30) while model-pricing carries the 2026-09-12 verified
  // figures (terra 2/12, sol 4/20). Reconciling them is an owner decision because the
  // experiment table is documented as retaining historical rates for old receipts.
  const KNOWN_DIVERGENT = new Set(['gpt-5.6-terra', 'gpt-5.6-sol']);

  const routable = [...new Set(
    [...Object.values(MODEL_TIERS), ...Object.values(CODEX_MODEL_TIERS)].filter(m => m !== null)
  )];

  test('every tier model has a non-null price in model-pricing', async () => {
    const { MODEL_PRICING } = await import('../lib/model-pricing.js');
    for (const model of routable) {
      if (!model.startsWith('gpt-')) continue; // Claude rates live on the prefix path
      assert.ok(MODEL_PRICING[model], `${model} is routable but unpriced in model-pricing.js`);
    }
  });

  test('every Codex tier model resolves to an EXACT experiment-pricing key, not a prefix', async () => {
    const { MODEL_PRICING } = await import('../lib/model-pricing.js');
    const { lookupExperimentPricing } = await import('../lib/experiment-pricing.js');
    for (const model of Object.values(CODEX_MODEL_TIERS)) {
      if (model === null) continue;
      const experiment = lookupExperimentPricing(model);
      assert.ok(experiment, `${model} is routable but unpriced in experiment-pricing.js`);
      if (KNOWN_DIVERGENT.has(model)) continue;
      assert.deepEqual(
        experiment, MODEL_PRICING[model],
        `${model} prices differ between the two tables — a prefix fallback is the usual cause`
      );
    }
  });
});
