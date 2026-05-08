/**
 * cross-model-review.test.js — Tests for STRAT-REV-7 cross-model adversarial synthesis.
 *
 * Tests the runCrossModelReview logic indirectly through its exported surface
 * and through mocked connector interactions.
 *
 * Because runCrossModelReview is not exported, we test it via:
 * 1. shouldRunCrossModel from review-lenses (diff-size gate)
 * 2. A synthetic harness that exercises the opt-out and dispatch paths
 *
 * Also validates canonical CrossModelReviewResult schema (STRAT-XMODEL-PARITY):
 * synthesis output routes through normalizeCrossModelResult — consensus/claude_only/codex_only
 * arrays contain canonical finding items with severity, confidence 1-10, applied_gate, lens.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunCrossModel } from '../lib/review-lenses.js';
import { normalizeCrossModelResult } from '../lib/review-normalize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreamWriter() {
  const events = [];
  return {
    events,
    write(event) { events.push(event); },
    writeCapabilityProfile() {},
    getEventsOfType(type) { return events.filter(e => e.type === type); },
  };
}

function makeConnector(responseText) {
  return {
    async *run() {
      yield { type: 'text', text: responseText };
    },
  };
}

function makeGetConnector(responseText) {
  const connector = makeConnector(responseText);
  return (_agentType, _opts) => connector;
}

/**
 * Inline reimplementation of the cross-model opt-out/skip logic.
 * Mirrors the production code in build.js so tests can verify behavior
 * without importing the full build module.
 */
async function crossModelEntryPoint(mergedResult, filesChanged, opts = {}, streamWriter = null, codexFactory = null) {
  // Opt-out: explicit flag
  if (opts.skipCrossModel) {
    if (streamWriter) streamWriter.write({ type: 'cross_model_review', status: 'skipped', reason: 'skipCrossModel flag set' });
    return { skipped: true, result: mergedResult };
  }

  // Opt-out: env var
  if (process.env.COMPOSE_CROSS_MODEL === '0') {
    if (streamWriter) streamWriter.write({ type: 'cross_model_review', status: 'skipped', reason: 'COMPOSE_CROSS_MODEL=0' });
    return { skipped: true, result: mergedResult };
  }

  // Diff size gate
  if (!shouldRunCrossModel(filesChanged)) {
    return { skipped: true, silent: true, result: mergedResult };
  }

  // Codex availability
  let codexConnector;
  try {
    codexConnector = codexFactory ? codexFactory() : null;
    if (!codexConnector) throw new Error('no codex connector');
  } catch (err) {
    const reason = `Codex unavailable: ${err.message}`;
    if (streamWriter) streamWriter.write({ type: 'cross_model_review', status: 'skipped', reason });
    return { skipped: true, result: mergedResult };
  }

  if (streamWriter) {
    streamWriter.write({ type: 'cross_model_review', status: 'started', filesChanged: filesChanged.length });
  }

  // Consume the connector (simulated Codex run)
  let codexOutput = '';
  for await (const chunk of codexConnector.run('prompt')) {
    if (chunk.type === 'text') codexOutput += chunk.text;
  }

  if (streamWriter) {
    streamWriter.write({ type: 'cross_model_review', status: 'complete', consensus: 0, claudeOnly: 0, codexOnly: 0 });
  }

  return { skipped: false, result: mergedResult, codexOutput };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-model review: diff-size gate', () => {
  it('skips silently for small diff (2 files)', async () => {
    const sw = makeStreamWriter();
    const result = await crossModelEntryPoint(
      { clean: true, findings: [] },
      ['a.js', 'b.js'],
      {},
      sw
    );
    assert.equal(result.skipped, true);
    // No stream events for silent small-diff skip
    const cmEvents = sw.getEventsOfType('cross_model_review');
    assert.equal(cmEvents.length, 0, 'should not emit events for small diff');
  });

  it('skips silently for medium diff (5 files)', async () => {
    const sw = makeStreamWriter();
    const result = await crossModelEntryPoint(
      { clean: true, findings: [] },
      Array.from({ length: 5 }, (_, i) => `f${i}.js`),
      {},
      sw
    );
    assert.equal(result.skipped, true);
    assert.equal(sw.getEventsOfType('cross_model_review').length, 0);
  });

  it('proceeds for large diff (9 files) when connector available', async () => {
    const sw = makeStreamWriter();
    const result = await crossModelEntryPoint(
      { clean: true, findings: [] },
      Array.from({ length: 9 }, (_, i) => `f${i}.js`),
      {},
      sw,
      () => makeConnector('[]')
    );
    assert.equal(result.skipped, false);
    const started = sw.getEventsOfType('cross_model_review').find(e => e.status === 'started');
    assert.ok(started, 'should emit cross_model_review started event');
    assert.equal(started.filesChanged, 9);
  });
});

describe('cross-model review: opt-out via skipCrossModel flag', () => {
  it('skips and emits skipped event when skipCrossModel=true', async () => {
    const sw = makeStreamWriter();
    const result = await crossModelEntryPoint(
      { clean: true, findings: [] },
      Array.from({ length: 12 }, (_, i) => `f${i}.js`),
      { skipCrossModel: true },
      sw
    );
    assert.equal(result.skipped, true);
    const skipped = sw.getEventsOfType('cross_model_review').find(e => e.status === 'skipped');
    assert.ok(skipped, 'should emit skipped event');
    assert.match(skipped.reason, /skipCrossModel/);
  });
});

describe('cross-model review: opt-out via COMPOSE_CROSS_MODEL=0', () => {
  before(() => { process.env.COMPOSE_CROSS_MODEL = '0'; });

  it('skips when env var is 0', async () => {
    const sw = makeStreamWriter();
    const result = await crossModelEntryPoint(
      { clean: true, findings: [] },
      Array.from({ length: 12 }, (_, i) => `f${i}.js`),
      {},
      sw
    );
    assert.equal(result.skipped, true);
    const skipped = sw.getEventsOfType('cross_model_review').find(e => e.status === 'skipped');
    assert.ok(skipped, 'should emit skipped event for env var opt-out');
    assert.match(skipped.reason, /COMPOSE_CROSS_MODEL=0/);
    // Restore
    delete process.env.COMPOSE_CROSS_MODEL;
  });
});

describe('cross-model review: Codex unavailable', () => {
  it('skips gracefully and emits skipped event when connector throws', async () => {
    const sw = makeStreamWriter();
    const result = await crossModelEntryPoint(
      { clean: true, findings: [] },
      Array.from({ length: 10 }, (_, i) => `f${i}.js`),
      {},
      sw,
      () => { throw new Error('opencode not found'); }
    );
    assert.equal(result.skipped, true);
    const skipped = sw.getEventsOfType('cross_model_review').find(e => e.status === 'skipped');
    assert.ok(skipped, 'should emit skipped event');
    assert.match(skipped.reason, /unavailable/i);
  });
});

describe('cross-model review: stream events', () => {
  it('emits started and complete events for large diff with connector', async () => {
    const sw = makeStreamWriter();
    await crossModelEntryPoint(
      { clean: true, findings: [] },
      Array.from({ length: 9 }, (_, i) => `f${i}.js`),
      {},
      sw,
      () => makeConnector('[]')
    );
    const types = sw.events.map(e => e.status);
    assert.ok(types.includes('started'), 'should include started status');
    assert.ok(types.includes('complete'), 'should include complete status');
  });

  it('complete event includes consensus/claudeOnly/codexOnly counts', async () => {
    const sw = makeStreamWriter();
    await crossModelEntryPoint(
      { clean: false, findings: [{ file: 'a.js', finding: 'issue', severity: 'high', confidence: 90 }] },
      Array.from({ length: 9 }, (_, i) => `f${i}.js`),
      {},
      sw,
      () => makeConnector('[]')
    );
    const complete = sw.getEventsOfType('cross_model_review').find(e => e.status === 'complete');
    assert.ok(complete, 'should emit complete event');
    assert.ok('consensus'  in complete, 'complete event should have consensus count');
    assert.ok('claudeOnly' in complete, 'complete event should have claudeOnly count');
    assert.ok('codexOnly'  in complete, 'complete event should have codexOnly count');
  });
});

// ---------------------------------------------------------------------------
// Canonical ReviewResult schema compatibility (STRAT-CLAUDE-EFFORT-PARITY)
// ---------------------------------------------------------------------------

describe('cross-model review: canonical ReviewResult shape compatibility', () => {
  it('accepts canonical ReviewResult as mergedResult input', async () => {
    // Canonical ReviewResult (as produced by normalizeReviewResult)
    const canonicalResult = {
      clean: false,
      summary: '1 findings (1 must-fix, 0 should-fix, 0 nit).',
      findings: [
        {
          lens: 'security',
          file: 'auth.js',
          line: 42,
          severity: 'must-fix',
          finding: 'SQL injection risk',
          confidence: 9,
          applied_gate: 7,
          rationale: null,
        },
      ],
      meta: { agent_type: 'claude', model_id: 'claude-test' },
      lenses_run: ['security'],
      auto_fixes: [],
      asks: [],
    };

    const sw = makeStreamWriter();
    const result = await crossModelEntryPoint(
      canonicalResult,
      Array.from({ length: 9 }, (_, i) => `f${i}.js`),
      {},
      sw,
      () => makeConnector('[]')
    );

    // The entry point should not corrupt the canonical result
    assert.equal(result.result.clean, canonicalResult.clean);
    assert.ok(Array.isArray(result.result.findings), 'findings must remain array');
  });

  it('preserves clean=true from canonical ReviewResult through opt-out path', async () => {
    const canonicalResult = {
      clean: true,
      summary: '0 findings (0 must-fix, 0 should-fix, 0 nit).',
      findings: [],
      meta: { agent_type: 'claude', model_id: null },
      lenses_run: [],
      auto_fixes: [],
      asks: [],
    };

    const sw = makeStreamWriter();
    const result = await crossModelEntryPoint(
      canonicalResult,
      ['a.js', 'b.js'], // small diff — silent skip
      {},
      sw
    );

    assert.equal(result.skipped, true);
    assert.equal(result.result.clean, true);
    assert.ok(Array.isArray(result.result.lenses_run), 'lenses_run preserved');
  });

  it('synthesis output shape is CrossModelReviewResult — canonical ReviewResult + consensus/claude_only/codex_only', async () => {
    // STRAT-XMODEL-PARITY: synthesis output is now a canonical CrossModelReviewResult
    const rawSynthesis = JSON.stringify({
      summary: '2 consensus findings, 1 Claude-only.',
      consensus: [
        { lens: 'security', file: 'auth.js', line: 42, severity: 'must-fix', finding: 'SQL injection', confidence: 9, applied_gate: 7 },
      ],
      claude_only: [
        { lens: 'diff-quality', file: 'api.js', line: 10, severity: 'should-fix', finding: 'missing null check', confidence: 8, applied_gate: 7 },
      ],
      codex_only: [
        { lens: 'general', file: null, line: null, severity: 'should-fix', finding: 'unhandled promise rejection', confidence: 8, applied_gate: 7 },
      ],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 7 });

    // Must be a ReviewResult (canonical base)
    assert.ok('clean'    in result, 'must have clean field');
    assert.ok('summary'  in result, 'must have summary field');
    assert.ok('findings' in result, 'must have findings field');
    assert.ok('meta'     in result, 'must have meta field');
    assert.equal(result.meta.agent_type, 'claude');

    // Must have CrossModelReviewResult extension fields
    assert.ok('consensus'   in result, 'must have consensus array');
    assert.ok('claude_only' in result, 'must have claude_only array');
    assert.ok('codex_only'  in result, 'must have codex_only array');
    assert.ok(Array.isArray(result.consensus));
    assert.ok(Array.isArray(result.claude_only));
    assert.ok(Array.isArray(result.codex_only));

    // clean is false because there are must-fix findings
    assert.equal(result.clean, false);

    // findings is the union of all three arrays
    assert.equal(result.findings.length, 3);
  });
});

// ---------------------------------------------------------------------------
// normalizeCrossModelResult: canonical finding shape enforcement (STRAT-XMODEL-PARITY)
// ---------------------------------------------------------------------------

describe('normalizeCrossModelResult: canonical finding shape', () => {
  it('each finding in consensus/claude_only/codex_only has canonical severity, confidence 1-10, applied_gate, lens', async () => {
    const rawSynthesis = JSON.stringify({
      consensus: [
        { lens: 'security', file: 'auth.js', line: null, severity: 'MUST_FIX', finding: 'injection risk', confidence: 9, applied_gate: 7 },
      ],
      claude_only: [
        { lens: 'diff-quality', file: null, line: null, severity: 'warning', finding: 'missing check', confidence: 8, applied_gate: 7 },
      ],
      codex_only: [
        { lens: 'general', file: null, line: null, severity: 'nit', finding: 'style issue', confidence: 7, applied_gate: 7 },
      ],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 7 });

    // Check consensus
    assert.equal(result.consensus.length, 1);
    assert.equal(result.consensus[0].severity, 'must-fix', 'MUST_FIX normalized to must-fix');
    assert.ok(result.consensus[0].confidence >= 1 && result.consensus[0].confidence <= 10);
    assert.ok(typeof result.consensus[0].applied_gate === 'number');
    assert.ok(typeof result.consensus[0].lens === 'string');

    // Check claude_only
    assert.equal(result.claude_only.length, 1);
    assert.equal(result.claude_only[0].severity, 'should-fix', 'warning normalized to should-fix');

    // Check codex_only
    assert.equal(result.codex_only.length, 1);
    assert.equal(result.codex_only[0].severity, 'nit');
  });

  it('filters findings below confidence gate', async () => {
    const rawSynthesis = JSON.stringify({
      consensus: [
        { lens: 'security', file: null, line: null, severity: 'must-fix', finding: 'high confidence', confidence: 9, applied_gate: 7 },
        { lens: 'security', file: null, line: null, severity: 'must-fix', finding: 'low confidence', confidence: 3, applied_gate: 7 },
      ],
      claude_only: [],
      codex_only: [],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 7 });

    // Only the high-confidence finding should pass the gate
    assert.equal(result.consensus.length, 1);
    assert.equal(result.consensus[0].finding, 'high confidence');
  });

  it('stamps applied_gate on findings missing it', async () => {
    const rawSynthesis = JSON.stringify({
      consensus: [],
      claude_only: [
        { lens: 'general', file: null, line: null, severity: 'should-fix', finding: 'no gate field', confidence: 8 },
      ],
      codex_only: [],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 5 });

    assert.equal(result.claude_only.length, 1);
    assert.equal(result.claude_only[0].applied_gate, 5, 'applied_gate stamped from opts.confidenceGate');
  });

  it('clean=true when no must-fix or should-fix findings across all three arrays', async () => {
    const rawSynthesis = JSON.stringify({
      consensus: [
        { lens: 'general', file: null, line: null, severity: 'nit', finding: 'style nit', confidence: 8, applied_gate: 7 },
      ],
      claude_only: [],
      codex_only: [],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 7 });

    assert.equal(result.clean, true, 'clean=true when only nit findings remain');
  });

  it('falls back to claudeFindingsFallback and codexFindingsFallback on parse failure', async () => {
    const claudeFallback = [
      { lens: 'security', file: 'f.js', line: 1, severity: 'must-fix', finding: 'claude fallback', confidence: 9, applied_gate: 7 },
    ];
    const codexFallback = [
      { lens: 'general', file: null, line: null, severity: 'should-fix', finding: 'codex fallback', confidence: 7, applied_gate: 7 },
    ];

    const result = await normalizeCrossModelResult('not valid json at all %%%()', {
      confidenceGate: 7,
      claudeFindingsFallback: claudeFallback,
      codexFindingsFallback: codexFallback,
    });

    assert.equal(result.consensus.length, 0, 'no consensus on parse failure');
    assert.equal(result.claude_only.length, 1, 'claude fallback preserved');
    assert.equal(result.codex_only.length, 1, 'codex fallback preserved');
    assert.equal(result.clean, false, 'not clean when blocking findings exist');
  });

  // STRAT-REV-FU-3: fallback confidence invariant
  it('promotes fallback finding confidence to applied_gate when caller under-stamps it', async () => {
    // Regression: previously codexAsFallback shipped confidence=6 with gate=7,
    // causing all fallback findings to silently drop below the gate filter.
    // The normalizer must defensively promote fallback confidence so the
    // findings survive the same filter that drops genuine low-confidence model output.
    const claudeFallback = [
      { lens: 'security', file: 'auth.js', line: 1, severity: 'must-fix', finding: 'sql injection', confidence: 5, applied_gate: 7 },
    ];
    const codexFallback = [
      { lens: 'general', file: null, line: null, severity: 'should-fix', finding: 'codex sub-gate', confidence: 6, applied_gate: 7 },
    ];

    const result = await normalizeCrossModelResult('not valid json %%%()', {
      confidenceGate: 7,
      claudeFindingsFallback: claudeFallback,
      codexFindingsFallback: codexFallback,
    });

    assert.equal(result.claude_only.length, 1, 'under-confidence claude fallback survives the filter');
    assert.equal(result.codex_only.length, 1, 'under-confidence codex fallback survives the filter');
    assert.ok(result.claude_only[0].confidence >= result.claude_only[0].applied_gate, 'claude fallback confidence ≥ gate');
    assert.ok(result.codex_only[0].confidence >= result.codex_only[0].applied_gate, 'codex fallback confidence ≥ gate');
    assert.equal(result.clean, false, 'fallback findings still mark clean=false');
  });

  // STRAT-REV-FU-2: consensus promotion
  it('stamps consensus:true on findings in the consensus array', async () => {
    const rawSynthesis = JSON.stringify({
      consensus: [
        { lens: 'security', file: 'auth.js', line: 42, severity: 'must-fix', finding: 'sql injection', confidence: 8, applied_gate: 7 },
      ],
      claude_only: [
        { lens: 'diff-quality', file: 'api.js', line: 10, severity: 'should-fix', finding: 'claude-only', confidence: 7, applied_gate: 7 },
      ],
      codex_only: [
        { lens: 'general', file: null, line: null, severity: 'nit', finding: 'codex-only', confidence: 7, applied_gate: 7 },
      ],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 7 });

    assert.equal(result.consensus[0].consensus, true, 'consensus finding has consensus:true');
    assert.ok(!result.claude_only[0].consensus, 'claude_only finding has no consensus flag');
    assert.ok(!result.codex_only[0].consensus, 'codex_only finding has no consensus flag');
  });

  it('boosts confidence on consensus findings (both models agreed = higher conviction)', async () => {
    const rawSynthesis = JSON.stringify({
      consensus: [
        { lens: 'security', file: 'auth.js', line: 42, severity: 'must-fix', finding: 'sql injection', confidence: 8, applied_gate: 7 },
        { lens: 'security', file: 'auth.js', line: 50, severity: 'must-fix', finding: 'already maxed', confidence: 10, applied_gate: 7 },
      ],
      claude_only: [],
      codex_only: [],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 7 });

    assert.equal(result.consensus[0].confidence, 10, 'confidence 8 boosted to 10 (capped at max)');
    assert.equal(result.consensus[1].confidence, 10, 'already-maxed confidence stays at 10');
    assert.ok(result.consensus[0].confidence > 8, 'consensus boost applied');
  });

  it('top-level findings array carries consensus flag through merge', async () => {
    const rawSynthesis = JSON.stringify({
      consensus: [
        { lens: 'security', file: 'auth.js', line: 42, severity: 'must-fix', finding: 'sql injection', confidence: 9, applied_gate: 7 },
      ],
      claude_only: [
        { lens: 'diff-quality', file: 'api.js', line: 10, severity: 'should-fix', finding: 'claude-only', confidence: 8, applied_gate: 7 },
      ],
      codex_only: [],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 7 });

    const consensusInFindings = result.findings.filter(f => f.consensus === true);
    const otherInFindings = result.findings.filter(f => !f.consensus);
    assert.equal(consensusInFindings.length, 1, 'consensus flag preserved in merged findings[]');
    assert.equal(otherInFindings.length, 1, 'non-consensus findings present without flag');
  });

  it('does not modify confidence on findings parsed from valid synthesis output', async () => {
    // Sanity guard: the FU-3 promotion applies ONLY in the fallback branch.
    // A genuine low-confidence finding from a parsed synthesis must still drop.
    const rawSynthesis = JSON.stringify({
      consensus: [],
      claude_only: [
        { lens: 'security', file: null, line: null, severity: 'must-fix', finding: 'low conf', confidence: 5, applied_gate: 7 },
      ],
      codex_only: [],
    });

    const result = await normalizeCrossModelResult(rawSynthesis, { confidenceGate: 7 });
    assert.equal(result.claude_only.length, 0, 'parsed sub-gate finding still dropped (FU-3 only protects fallback path)');
  });
});
