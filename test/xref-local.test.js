/**
 * xref-local.test.js — COMP-ROADMAP-XREF-PUSH-2 shared sibling containment guard.
 *
 * resolveSiblingRoot vets a bare repo token resolves to a DIRECT sibling of cwd
 * (lexical first, then realpath to defeat symlink escape). Covers repo-token
 * containment ONLY; to_code presence + feature read stay in the caller.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveSiblingRoot } from '../lib/xref-local.js';

function parentWithRepo() {
  const parent = mkdtempSync(join(tmpdir(), 'xref-local-'));
  const cwd = join(parent, 'repo');
  mkdirSync(cwd, { recursive: true });
  return { parent, cwd };
}

describe('resolveSiblingRoot', () => {
  test('accepts a real direct sibling', () => {
    const { parent, cwd } = parentWithRepo();
    mkdirSync(join(parent, 'sib'));
    assert.deepEqual(resolveSiblingRoot(cwd, 'sib'), { root: join(parent, 'sib') });
  });
  test('rejects an empty token (incomplete)', () => {
    const { cwd } = parentWithRepo();
    assert.match(resolveSiblingRoot(cwd, '').reason, /incomplete/);
  });
  test('rejects a token with a path separator', () => {
    const { cwd } = parentWithRepo();
    assert.match(resolveSiblingRoot(cwd, '../evil').reason, /not a valid sibling/);
    assert.match(resolveSiblingRoot(cwd, 'a/b').reason, /not a valid sibling/);
  });
  test('rejects . and ..', () => {
    const { cwd } = parentWithRepo();
    assert.match(resolveSiblingRoot(cwd, '.').reason, /not a valid sibling/);
    assert.match(resolveSiblingRoot(cwd, '..').reason, /not a valid sibling/);
  });
  test('rejects a missing sibling', () => {
    const { cwd } = parentWithRepo();
    assert.match(resolveSiblingRoot(cwd, 'nope').reason, /not found/);
  });
  test('rejects a valid-named sibling symlinked outside the parent (realpath escape)', () => {
    const { parent, cwd } = parentWithRepo();
    const outside = mkdtempSync(join(tmpdir(), 'xref-outside-'));
    symlinkSync(outside, join(parent, 'sib'));
    assert.match(resolveSiblingRoot(cwd, 'sib').reason, /escapes the workspace parent/);
  });
});
