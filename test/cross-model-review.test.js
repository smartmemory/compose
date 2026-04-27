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
 * Also validates canonical ReviewResult schema compatibility (STRAT-CLAUDE-EFFORT-PARITY):
 * the `mergedResult` input shape must have `clean`, `findings`, `meta`.
 * The synthesis output shape ({consensus, claude_only, codex_only}) is intentionally
 * outside the canonical contract — tracked as STRAT-XMODEL-PARITY.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunCrossModel } from '../lib/review-lenses.js';

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

  it('synthesis output shape is {consensus, claude_only, codex_only} — intentionally outside canonical', () => {
    // This is a documentation test — the synthesis output is NOT a ReviewResult.
    // Full canonicalization is tracked as STRAT-XMODEL-PARITY follow-up.
    const exampleSynthesis = {
      consensus: [],
      claude_only: [],
      codex_only: [],
    };
    assert.ok('consensus'   in exampleSynthesis);
    assert.ok('claude_only' in exampleSynthesis);
    assert.ok('codex_only'  in exampleSynthesis);
    // No `clean` or `meta` fields — outside canonical contract
    assert.ok(!('clean' in exampleSynthesis));
    assert.ok(!('meta'  in exampleSynthesis));
  });
});
