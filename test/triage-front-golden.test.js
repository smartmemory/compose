// COMP-TRIAGE-5 S04 — front-seam golden.
// Exercises the real applyFrontTriage wiring (estimateScope → validated persist).
// The build provider is the one storage seam we fake; everything else is real.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFrontTriage } from '../lib/lane-gate.js';

function fakeProvider(initial = null) {
  let store = initial;
  return {
    _get: () => store,
    async getFeature() { return store; },
    async createFeature(_code, obj) { store = { ...obj }; return store; },
    async putFeature(_code, obj) { store = { ...obj }; return store; },
  };
}

describe('COMP-TRIAGE-5 front-seam golden', () => {
  test('trivial one-line edit → lane trivial; persisted fields validated; profile carried through', async () => {
    const provider = fakeProvider(null); // feature.json missing → createFeature path
    const front = await applyFrontTriage({
      featureCode: 'FOO-1',
      request: 'fix typo in src/utils/format.js',
      provider,
      cachedFeature: null,
    });

    assert.equal(front.lane, 'trivial');

    const saved = provider._get();
    // The bug this feature fixes: complexity must be a valid enum label, never a
    // stringified tier ("0".."4").
    assert.ok(['S', 'M', 'L', 'XL'].includes(saved.complexity), `complexity "${saved.complexity}" must be in {S,M,L,XL}`);
    assert.equal(typeof saved.triageTier, 'number');
    assert.equal(saved.estimateSource, 'front');
    assert.equal(saved.status, 'PLANNED');
    // The lane's profile (which drives skip_if) is persisted faithfully.
    assert.deepEqual(saved.profile, front.buildProfile);
    assert.equal(typeof saved.profile.needs_architecture, 'boolean');
  });

  test('ambiguous request → clamped up to at least standard (never trivial)', async () => {
    const provider = fakeProvider(null);
    const front = await applyFrontTriage({
      featureCode: 'BAR-1',
      request: 'improve things',
      provider,
      cachedFeature: null,
    });
    assert.notEqual(front.lane, 'trivial');
  });

  test('no explicit request → falls back to the feature description, not the bare code', async () => {
    // The CLI build path does not thread a description; applyFrontTriage must use
    // the persisted feature.json description so the estimate has real signal.
    const existing = { code: 'QUX-1', status: 'PLANNED', description: 'fix typo in src/utils/format.js' };
    const provider = fakeProvider(existing);
    const front = await applyFrontTriage({ featureCode: 'QUX-1', request: undefined, provider, cachedFeature: existing });
    // The description is a clean one-line edit → trivial, proving the description
    // (not the signal-free code "QUX-1") drove the estimate.
    assert.equal(front.lane, 'trivial');
  });

  test('regression: never persists a bare tier string into complexity (build.js:997/1006 bypass)', async () => {
    const existing = { code: 'BAZ-1', status: 'PLANNED', description: 'x' };
    const provider = fakeProvider(existing);
    await applyFrontTriage({ featureCode: 'BAZ-1', request: 'add a flag to src/x.js', provider, cachedFeature: existing });
    const saved = provider._get();
    assert.ok(!/^[0-4]$/.test(String(saved.complexity)), `complexity must not be a bare tier string, got "${saved.complexity}"`);
  });
});
