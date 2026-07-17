import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import {
  VOCABULARY_FILE,
  VOCABULARY_TEMPLATE,
  vocabularyEnabled,
  tagVocabularyViolations,
} from '../lib/vocabulary-inject.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vocab-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeVocab() {
  mkdirSync(join(dir, 'contracts'), { recursive: true });
  writeFileSync(join(dir, VOCABULARY_FILE), 'auth_token:\n  reject: [jwt]\n');
}

describe('vocabularyEnabled', () => {
  it('requires the vocabulary file', () => {
    assert.equal(vocabularyEnabled(dir, {}), false);
    writeVocab();
    assert.equal(vocabularyEnabled(dir, {}), true);
  });

  it('honors an explicit capability disable', () => {
    writeVocab();
    assert.equal(vocabularyEnabled(dir, { capabilities: { vocabularyCompliance: false } }), false);
  });
});

describe('tagVocabularyViolations', () => {
  it('marks vocabulary failures as must-fix without mutating the input', () => {
    const input = ["vocabulary violation: src/a.js:5 uses 'jwt'"];
    const output = tagVocabularyViolations(input);
    assert.match(output[0], /^must-fix:/);
    assert.doesNotMatch(input[0], /^must-fix:/);
  });

  it('leaves unrelated and non-array values unchanged', () => {
    assert.deepEqual(tagVocabularyViolations(['some other failure']), ['some other failure']);
    assert.equal(tagVocabularyViolations(undefined), undefined);
  });
});

describe('VOCABULARY_TEMPLATE', () => {
  it('is comments-only and documents the canonical/reject format', () => {
    assert.equal(YAML.parse(VOCABULARY_TEMPLATE), null);
    assert.match(VOCABULARY_TEMPLATE, /reject:/);
    assert.match(VOCABULARY_TEMPLATE, /canonical/i);
  });
});
