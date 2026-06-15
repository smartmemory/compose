/**
 * paths-core.test.js — coverage for lib/paths-core.js (COMP-PATHS-EXTERNAL S1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DEFAULT_PATHS, resolvePathValue, relForDisplay } from '../lib/paths-core.js';

describe('DEFAULT_PATHS', () => {
  test('has all six artifact keys with legacy values', () => {
    assert.deepEqual({ ...DEFAULT_PATHS }, {
      docs: 'docs',
      roadmap: 'ROADMAP.md',
      features: 'docs/features',
      journal: 'docs/journal',
      context: 'docs/context',
      ideabox: 'docs/product/ideabox.md',
    });
  });
});

describe('resolvePathValue', () => {
  const root = '/work/proj';
  test('in-root relative → joined under root', () => {
    assert.equal(resolvePathValue(root, 'docs/features', 'features'), '/work/proj/docs/features');
  });
  test('../-escaping relative → resolves outside root', () => {
    assert.equal(resolvePathValue(root, '../sib/features', 'features'), '/work/sib/features');
  });
  test('absolute → used as-is (normalized), NOT joined under root', () => {
    assert.equal(resolvePathValue(root, '/abs/x/features', 'features'), '/abs/x/features');
  });
  test('absent/empty/whitespace/non-string → default for key, under root', () => {
    for (const v of [undefined, null, '', '   ', 42, {}]) {
      assert.equal(resolvePathValue(root, v, 'roadmap'), '/work/proj/ROADMAP.md');
    }
  });
  test('always returns an absolute, normalized path', () => {
    const out = resolvePathValue(root, 'a/../b/./c', 'features');
    assert.ok(path.isAbsolute(out));
    assert.equal(out, '/work/proj/b/c');
  });
});

describe('relForDisplay', () => {
  const root = '/work/proj';
  test('in-root path → clean relative', () => {
    assert.equal(relForDisplay(root, '/work/proj/docs/features/X'), 'docs/features/X');
  });
  test('escaping path → absolute (no ../ soup)', () => {
    assert.equal(relForDisplay(root, '/work/sib/ROADMAP.md'), '/work/sib/ROADMAP.md');
  });
  test('exact root → "."', () => {
    assert.equal(relForDisplay(root, '/work/proj'), '.');
  });
});

describe('feature-validator shares the default table', () => {
  test('feature-validator does not define its own DEFAULT_PATHS', () => {
    const src = readFileSync('lib/feature-validator.js', 'utf-8');
    assert.ok(!/const\s+DEFAULT_PATHS\s*=\s*\{/.test(src),
      'feature-validator must import DEFAULT_PATHS, not define a local copy');
  });
});
