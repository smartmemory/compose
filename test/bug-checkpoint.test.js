/**
 * bug-checkpoint.test.js — Unit tests for COMP-FIX-HARD T2.
 *
 * Run: node --test test/bug-checkpoint.test.js
 *
 * Coverage:
 *   - emit writes checkpoint.md with all required sections
 *   - current diff capped at 5000 chars
 *   - graceful "(unable to get diff)" fallback when not a git repo
 *   - regenerateBugIndex called exactly once after write (test-double injection)
 *   - Hypothesis ledger pointer text varies by hypotheses.jsonl presence
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { emitCheckpoint, __setRegenerateBugIndexForTest } = await import(
  `${REPO_ROOT}/lib/bug-checkpoint.js`
);

// Helper: stand up a tmp git repo with a tracked file and an unstaged change.
function makeGitRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'bug-checkpoint-test-'));
  execSync('git init -q', { cwd });
  execSync('git config user.email test@example.com', { cwd });
  execSync('git config user.name Test', { cwd });
  writeFileSync(join(cwd, 'a.txt'), 'original\n');
  execSync('git add a.txt', { cwd });
  execSync('git commit -q -m initial', { cwd });
  // Create an unstaged change so `git diff HEAD` produces output.
  writeFileSync(join(cwd, 'a.txt'), 'modified content\n');
  return cwd;
}

function makeNonGitDir() {
  return mkdtempSync(join(tmpdir(), 'bug-checkpoint-nogit-'));
}

// Install a stub regenerator and return its call log.
function installStubRegenerator() {
  const calls = [];
  __setRegenerateBugIndexForTest((cwd) => {
    calls.push(cwd);
  });
  return calls;
}

describe('bug-checkpoint.emitCheckpoint', () => {
  let cwd;

  afterEach(() => {
    if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
    __setRegenerateBugIndexForTest(null); // restore default
  });

  test('writes checkpoint.md with all required sections', async () => {
    cwd = makeGitRepo();
    mkdirSync(join(cwd, 'docs', 'bugs', 'BUG-1'), { recursive: true });
    installStubRegenerator();
    const ctx = { cwd, bug_code: 'BUG-1' };
    const terminal = {
      retries_exhausted: 5,
      violations: [{ rule: 'failed_test', detail: 'expected 1 got 2' }],
    };

    await emitCheckpoint(ctx, 'test', terminal);

    const cpPath = join(cwd, 'docs', 'bugs', 'BUG-1', 'checkpoint.md');
    assert.equal(existsSync(cpPath), true, 'checkpoint.md should exist');
    const content = readFileSync(cpPath, 'utf8');

    assert.match(content, /^# Checkpoint: BUG-1/m);
    assert.match(content, /\*\*Time:\*\* \d{4}-\d{2}-\d{2}T/);
    assert.match(content, /\*\*Step:\*\* test/);
    assert.match(content, /\*\*Retries exhausted:\*\* 5/);
    assert.match(content, /## Current Diff/);
    assert.match(content, /```diff/);
    assert.match(content, /## Last Failure/);
    assert.match(content, /failed_test/);
    assert.match(content, /## Hypothesis Ledger/);
    assert.match(content, /## To Resume/);
    assert.match(content, /compose fix BUG-1 --resume/);
    assert.match(content, /## Next Steps/);
    // Diff body should mention modified content from our git repo.
    assert.match(content, /modified content/);
  });

  test('current diff capped at 5000 chars when long', async () => {
    cwd = makeGitRepo();
    mkdirSync(join(cwd, 'docs', 'bugs', 'BIG'), { recursive: true });
    // Generate a large unstaged change.
    const big = 'x'.repeat(20000) + '\n';
    writeFileSync(join(cwd, 'a.txt'), big);
    installStubRegenerator();
    await emitCheckpoint({ cwd, bug_code: 'BIG' }, 'fix', { violations: [] });

    const content = readFileSync(join(cwd, 'docs', 'bugs', 'BIG', 'checkpoint.md'), 'utf8');
    const m = content.match(/```diff\n([\s\S]*?)\n```/);
    assert.ok(m, 'diff fence should be present');
    assert.ok(m[1].length <= 5000, `diff body length ${m[1].length} should be <= 5000`);
  });

  test('falls back to "(unable to get diff)" when not a git repo', async () => {
    cwd = makeNonGitDir();
    mkdirSync(join(cwd, 'docs', 'bugs', 'NOGIT'), { recursive: true });
    installStubRegenerator();
    await emitCheckpoint({ cwd, bug_code: 'NOGIT' }, 'diagnose', { violations: [] });

    const content = readFileSync(join(cwd, 'docs', 'bugs', 'NOGIT', 'checkpoint.md'), 'utf8');
    assert.match(content, /\(unable to get diff\)/);
  });

  test('calls regenerateBugIndex exactly once after writing', async () => {
    cwd = makeGitRepo();
    mkdirSync(join(cwd, 'docs', 'bugs', 'IDX'), { recursive: true });
    const calls = installStubRegenerator();
    await emitCheckpoint({ cwd, bug_code: 'IDX' }, 'test', { violations: [] });
    assert.equal(calls.length, 1, 'regenerateBugIndex should be called once');
    assert.equal(calls[0], cwd);
  });

  test('hypothesis ledger pointer says "(none yet)" when hypotheses.jsonl missing', async () => {
    cwd = makeGitRepo();
    mkdirSync(join(cwd, 'docs', 'bugs', 'NL'), { recursive: true });
    installStubRegenerator();
    await emitCheckpoint({ cwd, bug_code: 'NL' }, 'test', { violations: [] });
    const content = readFileSync(join(cwd, 'docs', 'bugs', 'NL', 'checkpoint.md'), 'utf8');
    const section = content.split('## Hypothesis Ledger')[1].split('##')[0];
    assert.match(section, /\(none yet\)/);
    assert.doesNotMatch(section, /hypotheses\.jsonl/);
  });

  test('hypothesis ledger points to file when hypotheses.jsonl exists', async () => {
    cwd = makeGitRepo();
    const bugDir = join(cwd, 'docs', 'bugs', 'WL');
    mkdirSync(bugDir, { recursive: true });
    writeFileSync(join(bugDir, 'hypotheses.jsonl'), '{"attempt":1}\n');
    installStubRegenerator();
    await emitCheckpoint({ cwd, bug_code: 'WL' }, 'test', { violations: [] });
    const content = readFileSync(join(bugDir, 'checkpoint.md'), 'utf8');
    const section = content.split('## Hypothesis Ledger')[1].split('##')[0];
    assert.match(section, /\[hypotheses\.jsonl\]\(\.\/hypotheses\.jsonl\)/);
  });
});
