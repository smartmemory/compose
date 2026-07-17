/**
 * Tests for lib/vocabulary-compliance.js (E3/F5) — the deterministic,
 * consumer-side port of the Python vocabulary_compliance ensure builtin, plus the
 * review_merge step-failure decision helper in lib/build.js.
 *
 * Run with: node --test test/vocabulary-compliance.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { vocabularyCompliance, loadVocabulary } from '../lib/vocabulary-compliance.js';
import { computeVocabularyStepFailure } from '../lib/build.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vocab-comp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeVocab(content) {
  mkdirSync(join(dir, 'contracts'), { recursive: true });
  writeFileSync(join(dir, 'contracts', 'vocabulary.yaml'), content);
  return join(dir, 'contracts', 'vocabulary.yaml');
}

describe('vocabularyCompliance', () => {
  it('flags a rejected alias appearing in a changed file', () => {
    const vocabPath = writeVocab('auth_token:\n  reject: [jwt]\n  reason: use auth_token\n');
    writeFileSync(join(dir, 'a.js'), 'const jwt = readToken();\n');
    const violations = vocabularyCompliance(vocabPath, ['a.js'], { cwd: dir });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^vocabulary violation: a\.js:1 uses 'jwt' — canonical is 'auth_token'/);
    assert.match(violations[0], /reason: use auth_token/);
  });

  it('is clean when no rejected alias appears', () => {
    const vocabPath = writeVocab('auth_token:\n  reject: [jwt]\n');
    writeFileSync(join(dir, 'a.js'), 'const auth_token = readToken();\n');
    assert.deepEqual(vocabularyCompliance(vocabPath, ['a.js'], { cwd: dir }), []);
  });

  it('emits one violation per OCCURRENCE, not per line (G5)', () => {
    const vocabPath = writeVocab('auth_token:\n  reject: [jwt]\n');
    writeFileSync(join(dir, 'a.js'), 'const jwt = jwt || makeJwt(jwt);\n');
    const violations = vocabularyCompliance(vocabPath, ['a.js'], { cwd: dir });
    // 'jwt' appears as a whole word three times on line 1 ('makeJwt' does not match).
    assert.equal(violations.length, 3, `expected one violation per occurrence; got ${violations.length}`);
    for (const v of violations) assert.match(v, /^vocabulary violation: a\.js:1 uses 'jwt'/);
  });

  it('matches whole words only (case-sensitive)', () => {
    const vocabPath = writeVocab('user_id:\n  reject: [uid]\n');
    writeFileSync(join(dir, 'a.js'), 'const uuid = 1; const UID = 2; const uid = 3;\n');
    const violations = vocabularyCompliance(vocabPath, ['a.js'], { cwd: dir });
    assert.equal(violations.length, 1, 'uuid and UID must not match; only the whole-word uid');
    assert.match(violations[0], /uses 'uid'/);
  });

  it('is inert (clean) when the vocabulary file is missing', () => {
    assert.deepEqual(vocabularyCompliance(join(dir, 'contracts', 'vocabulary.yaml'), ['a.js'], { cwd: dir }), []);
  });

  it('is inert when the vocabulary file is comments-only', () => {
    const vocabPath = writeVocab('# just a comment\n# another\n');
    writeFileSync(join(dir, 'a.js'), 'const jwt = 1;\n');
    assert.deepEqual(vocabularyCompliance(vocabPath, ['a.js'], { cwd: dir }), []);
  });

  it('returns schema errors as blocking violations (never throws)', () => {
    const vocabPath = writeVocab('auth_token: not-a-mapping\n');
    const violations = vocabularyCompliance(vocabPath, ['a.js'], { cwd: dir });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^vocabulary\.yaml schema error:/);
  });

  it('scans the git working tree via gitFallback when filesChanged is empty', () => {
    // no git repo here → gitChangedFiles returns null → clean (nothing we can do)
    const vocabPath = writeVocab('auth_token:\n  reject: [jwt]\n');
    assert.deepEqual(vocabularyCompliance(vocabPath, [], { cwd: dir, gitFallback: true }), []);
  });
});

describe('loadVocabulary', () => {
  it('rejects an alias that is also a canonical name', () => {
    const vocabPath = writeVocab('auth_token:\n  reject: [jwt]\njwt:\n  reject: [token]\n');
    assert.throws(() => loadVocabulary(vocabPath), /both a canonical/);
  });
});

describe('computeVocabularyStepFailure (review_merge decision)', () => {
  it('returns a failure summary listing violations at review_merge', () => {
    writeVocab('auth_token:\n  reject: [jwt]\n');
    writeFileSync(join(dir, 'a.js'), 'const jwt = 1;\n');
    const failure = computeVocabularyStepFailure({
      vocabOn: true, stepId: 'review_merge', cwd: dir, filesChanged: ['a.js'],
    });
    assert.ok(failure, 'a violation must yield a failure string');
    assert.match(failure, /vocabulary/);
    assert.match(failure, /jwt/);
  });

  it('returns null on a clean review_merge', () => {
    writeVocab('auth_token:\n  reject: [jwt]\n');
    writeFileSync(join(dir, 'a.js'), 'const auth_token = 1;\n');
    assert.equal(computeVocabularyStepFailure({
      vocabOn: true, stepId: 'review_merge', cwd: dir, filesChanged: ['a.js'],
    }), null);
  });

  it('returns null when vocabulary is disabled', () => {
    writeVocab('auth_token:\n  reject: [jwt]\n');
    writeFileSync(join(dir, 'a.js'), 'const jwt = 1;\n');
    assert.equal(computeVocabularyStepFailure({
      vocabOn: false, stepId: 'review_merge', cwd: dir, filesChanged: ['a.js'],
    }), null);
  });

  it('returns null for a non review_merge step even with violations', () => {
    writeVocab('auth_token:\n  reject: [jwt]\n');
    writeFileSync(join(dir, 'a.js'), 'const jwt = 1;\n');
    assert.equal(computeVocabularyStepFailure({
      vocabOn: true, stepId: 'blueprint', cwd: dir, filesChanged: ['a.js'],
    }), null);
  });
});
