// test/gsd-diff-capture.test.js
//
// COMP-GSD-7 S3: per-task diff snapshot persistence (.compose/gsd/<f>/diffs/).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEATURE = 'COMP-GSD-7';

let mod;
let cwd;

describe('gsd-diff-capture', () => {
  beforeEach(async () => {
    mod = await import(`${REPO_ROOT}/lib/gsd-diff-capture.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-diff-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test('gsdTaskDiffPath points at .compose/gsd/<f>/diffs/<id>.diff', () => {
    assert.equal(
      mod.gsdTaskDiffPath(cwd, FEATURE, 'task-a'),
      join(cwd, '.compose', 'gsd', FEATURE, 'diffs', 'task-a.diff'),
    );
  });

  test('writeGsdTaskDiff creates the file and round-trips content', () => {
    const diff = 'diff --git a/x b/x\n+line\n';
    const p = mod.writeGsdTaskDiff(cwd, FEATURE, 'task-a', diff);
    assert.equal(p, mod.gsdTaskDiffPath(cwd, FEATURE, 'task-a'));
    assert.ok(existsSync(p));
    assert.equal(readFileSync(p, 'utf-8'), diff);
  });

  test('writeGsdTaskDiff is atomic (no .tmp left behind)', () => {
    const p = mod.writeGsdTaskDiff(cwd, FEATURE, 'task-a', 'x');
    assert.ok(!existsSync(`${p}.tmp`));
  });

  test('overwrites an existing snapshot', () => {
    mod.writeGsdTaskDiff(cwd, FEATURE, 'task-a', 'first');
    const p = mod.writeGsdTaskDiff(cwd, FEATURE, 'task-a', 'second');
    assert.equal(readFileSync(p, 'utf-8'), 'second');
  });
});
