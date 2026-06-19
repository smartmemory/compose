/**
 * Tests for lib/vocabulary-inject.js (STRAT-VOCAB-3)
 * Run with: node --test test/vocabulary-inject.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import {
  VOCABULARY_FILE,
  VOCABULARY_ENSURE,
  VOCABULARY_TEMPLATE,
  vocabularyEnabled,
  injectVocabularyEnsure,
  tagVocabularyViolations,
} from '../lib/vocabulary-inject.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vocab-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeVocab(content = 'auth_token:\n  reject: [jwt]\n') {
  mkdirSync(join(dir, 'contracts'), { recursive: true });
  writeFileSync(join(dir, VOCABULARY_FILE), content);
}

// A minimal stand-in for the build/build-quick flow shape.
function buildSpec() {
  return {
    flows: {
      build: {
        steps: [
          { id: 'execute', type: 'parallel_dispatch' },
          { id: 'review', flow: 'parallel_review', ensure: ['result.clean == True'], depends_on: ['execute'] },
          { id: 'coverage', flow: 'coverage_check', ensure: ['result.passing == True'] },
        ],
      },
      // sub-flow that ALSO has a step id'd `review` — must NOT be touched
      // (this mirrors the real review_check sub-flow).
      review_check: { steps: [{ id: 'review', ensure: ['result.clean == True'] }] },
      parallel_review: { steps: [{ id: 'triage' }, { id: 'lenses' }] },
    },
  };
}

describe('vocabularyEnabled', () => {
  it('false when no vocab file exists', () => {
    assert.equal(vocabularyEnabled(dir, {}), false);
  });

  it('true when vocab file exists and capability unset (default-ON)', () => {
    writeVocab();
    assert.equal(vocabularyEnabled(dir, {}), true);
    assert.equal(vocabularyEnabled(dir, { capabilities: {} }), true);
  });

  it('false when capability explicitly disabled, even if file exists', () => {
    writeVocab();
    assert.equal(vocabularyEnabled(dir, { capabilities: { vocabularyCompliance: false } }), false);
  });

  it('true when capability explicitly enabled and file exists', () => {
    writeVocab();
    assert.equal(vocabularyEnabled(dir, { capabilities: { vocabularyCompliance: true } }), true);
  });
});

describe('injectVocabularyEnsure', () => {
  it('appends the vocab ensure to the build flow review step', () => {
    const spec = injectVocabularyEnsure(buildSpec());
    const review = spec.flows.build.steps.find((s) => s.id === 'review');
    assert.deepEqual(review.ensure, ['result.clean == True', VOCABULARY_ENSURE]);
  });

  it('does not touch other steps or sub-flows', () => {
    const spec = injectVocabularyEnsure(buildSpec());
    const coverage = spec.flows.build.steps.find((s) => s.id === 'coverage');
    assert.deepEqual(coverage.ensure, ['result.passing == True']);
    assert.deepEqual(spec.flows.parallel_review.steps.map((s) => s.id), ['triage', 'lenses']);
  });

  it('does NOT inject into the review_check sub-flow review step', () => {
    const spec = injectVocabularyEnsure(buildSpec()); // no flowName → build flow
    assert.deepEqual(spec.flows.review_check.steps[0].ensure, ['result.clean == True']);
  });

  it('targets the named executed flow', () => {
    const spec = {
      flows: {
        // first key is a sub-flow; build is NOT first — flowName must win
        review_check: { steps: [{ id: 'review', ensure: [] }] },
        custom_build: { steps: [{ id: 'review', ensure: ['result.clean == True'] }] },
      },
    };
    injectVocabularyEnsure(spec, 'custom_build');
    assert.deepEqual(spec.flows.custom_build.steps[0].ensure, ['result.clean == True', VOCABULARY_ENSURE]);
    assert.deepEqual(spec.flows.review_check.steps[0].ensure, []);
  });

  it('is idempotent — never adds the ensure twice', () => {
    let spec = injectVocabularyEnsure(buildSpec());
    spec = injectVocabularyEnsure(spec);
    const review = spec.flows.build.steps.find((s) => s.id === 'review');
    assert.equal(review.ensure.filter((e) => e === VOCABULARY_ENSURE).length, 1);
  });

  it('creates the ensure array if the review step had none', () => {
    const spec = { flows: { build: { steps: [{ id: 'review' }] } } };
    injectVocabularyEnsure(spec);
    assert.deepEqual(spec.flows.build.steps[0].ensure, [VOCABULARY_ENSURE]);
  });

  it('no-op when there is no review step', () => {
    const spec = { flows: { build: { steps: [{ id: 'execute' }] } } };
    const before = YAML.stringify(spec);
    injectVocabularyEnsure(spec);
    assert.equal(YAML.stringify(spec), before);
  });

  it('falls back to the first flow when there is no flow named build', () => {
    const spec = { flows: { other: { steps: [{ id: 'review', ensure: [] }] } } };
    injectVocabularyEnsure(spec);
    assert.deepEqual(spec.flows.other.steps[0].ensure, [VOCABULARY_ENSURE]);
  });
});

describe('tagVocabularyViolations', () => {
  it('prefixes vocabulary violation strings with must-fix', () => {
    const out = tagVocabularyViolations([
      "vocabulary violation: src/a.js:5 uses 'jwt' — canonical is 'auth_token'",
    ]);
    assert.equal(out[0], "must-fix: vocabulary violation: src/a.js:5 uses 'jwt' — canonical is 'auth_token'");
  });

  it('tags malformed / schema-error vocab-file failures as must-fix too', () => {
    const out = tagVocabularyViolations([
      'vocabulary.yaml malformed: cannot read contracts/vocabulary.yaml',
      'vocabulary.yaml schema error: top-level must be a mapping',
    ]);
    assert.match(out[0], /^must-fix: vocabulary\.yaml malformed:/);
    assert.match(out[1], /^must-fix: vocabulary\.yaml schema error:/);
  });

  it('leaves non-vocabulary strings unchanged', () => {
    const out = tagVocabularyViolations(['some other postcondition failed', 'vocabularies are nice']);
    assert.equal(out[0], 'some other postcondition failed');
    assert.equal(out[1], 'vocabularies are nice', 'must not match the word boundary loosely');
  });

  it('leaves non-string items unchanged', () => {
    const obj = { severity: 'should-fix', message: 'x' };
    assert.equal(tagVocabularyViolations([obj])[0], obj);
  });

  it('does not mutate the input array', () => {
    const input = ['vocabulary violation: a.js:1 uses x'];
    tagVocabularyViolations(input);
    assert.equal(input[0], 'vocabulary violation: a.js:1 uses x');
  });

  it('passes non-array input through', () => {
    assert.equal(tagVocabularyViolations(undefined), undefined);
  });
});

// Tie the injection to the REAL shipped pipelines — catches drift if the
// `review` step is renamed/removed or its first ensure changes.
describe('injectVocabularyEnsure on the real build pipelines', () => {
  const REPO_ROOT = new URL('..', import.meta.url).pathname;
  for (const file of ['build.stratum.yaml', 'build-quick.stratum.yaml']) {
    it(`pipelines/${file} has a build-flow review step that receives the ensure`, async () => {
      const { readFileSync } = await import('node:fs');
      const raw = readFileSync(join(REPO_ROOT, 'pipelines', file), 'utf-8');
      const spec = YAML.parse(raw);
      const review = spec.flows.build.steps.find((s) => s.id === 'review');
      assert.ok(review, `${file}: build flow must have a review step`);
      assert.ok(
        (review.ensure ?? []).includes('result.clean == True'),
        `${file}: review's first ensure should be result.clean == True`
      );

      const idsBefore = spec.flows.build.steps.map((s) => s.id);
      injectVocabularyEnsure(spec);
      const idsAfter = spec.flows.build.steps.map((s) => s.id);

      // Step list/order unchanged — only the review step's ensure grows.
      assert.deepEqual(idsAfter, idsBefore, `${file}: step list/order must not change`);
      const reviewAfter = spec.flows.build.steps.find((s) => s.id === 'review');
      assert.ok(reviewAfter.ensure.includes(VOCABULARY_ENSURE), `${file}: review ensure should include the vocab ensure`);
    });
  }
});

describe('VOCABULARY_TEMPLATE', () => {
  it('is inert — parses to empty (comments only)', () => {
    const parsed = YAML.parse(VOCABULARY_TEMPLATE);
    assert.ok(parsed === null || parsed === undefined, 'comments-only template must parse to null');
  });

  it('documents the format header and the canonical/reject shape', () => {
    assert.match(VOCABULARY_TEMPLATE, /contracts\/vocabulary\.yaml/);
    assert.match(VOCABULARY_TEMPLATE, /reject:/);
    assert.match(VOCABULARY_TEMPLATE, /canonical/i);
  });
});
