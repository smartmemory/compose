import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { extractConflictFiles, buildMergeConflictBounce, runPreMergeGateLocal } from '../lib/build.js';
import { resolvePreMergeGate } from '../lib/gsd.js';

// COMP-PAR-MERGE-QUEUE — Compose-side merge-conflict bounce + retry-prompt injection.

describe('extractConflictFiles', () => {
  it('extracts files from a "patch failed: path:line" git-apply error', () => {
    const err = 'error: patch failed: src/foo.ts:10\nerror: src/foo.ts: patch does not apply';
    assert.deepEqual(extractConflictFiles(err, []), ['src/foo.ts']);
  });

  it('extracts files from a "patch does not apply" message', () => {
    const err = 'error: lib/bar.js: patch does not apply';
    assert.deepEqual(extractConflictFiles(err, []), ['lib/bar.js']);
  });

  it('falls back to the task owned files when nothing parses', () => {
    assert.deepEqual(
      extractConflictFiles('totally opaque error', ['a.ts', 'b.ts']),
      ['a.ts', 'b.ts'],
    );
  });

  it('returns [] when no error and no owned files', () => {
    assert.deepEqual(extractConflictFiles('', []), []);
  });
});

describe('buildMergeConflictBounce', () => {
  it('produces a contract-shaped merge_conflict record', () => {
    const b = buildMergeConflictBounce('task-1', 'error: patch failed: x.ts:1', ['x.ts']);
    assert.equal(b.task_id, 'task-1');
    assert.equal(b.reason, 'merge_conflict');
    assert.deepEqual(b.files, ['x.ts']);
    assert.equal(b.command, null);
    assert.equal(b.exit_code, null);
    assert.match(b.excerpt, /patch failed/);
  });

  it('bounds the excerpt to ~2KB', () => {
    const big = 'x'.repeat(5000);
    const b = buildMergeConflictBounce('t', big, []);
    assert.ok(b.excerpt.length <= 2048);
  });
});

// Note: pre-merge bounce context is injected into a re-dispatched task's prompt
// SERVER-SIDE (Stratum ParallelExecutor._render_prompt), not via Compose's
// buildRetryPrompt — the server re-resolves tasks on each re-dispatch. The
// injection is covered by stratum-mcp/tests/test_par_merge_queue.py.

// COMP-PAR-MERGE-QUEUE-CONSUMER: the Compose-side per-task pre-merge gate runner
// (consumer-dispatch mirror of Stratum's worktree.run_pre_merge_gate).
describe('runPreMergeGateLocal', () => {
  function tmpDir() { return mkdtempSync(join(tmpdir(), 'pmg-local-')); }

  it('returns null when every command passes', () => {
    assert.equal(runPreMergeGateLocal(tmpDir(), ['git --version'], null, 30000), null);
  });

  it('returns null for an empty command list', () => {
    assert.equal(runPreMergeGateLocal(tmpDir(), [], null, 30000), null);
  });

  it('returns a gate_failed bounce on the first non-zero command', () => {
    const b = runPreMergeGateLocal(
      tmpDir(), ['git --version', 'sh -c "echo boom >&2; exit 3"'], null, 30000,
    );
    assert.ok(b);
    assert.equal(b.reason, 'gate_failed');
    assert.equal(b.command, 'sh -c "echo boom >&2; exit 3"');
    assert.equal(b.exit_code, 3);
    assert.match(b.excerpt, /boom/);
    assert.ok(Array.isArray(b.files));
  });

  it('bounds the excerpt to ~2KB', () => {
    const b = runPreMergeGateLocal(
      tmpDir(),
      ['sh -c "for i in $(seq 1 5000); do echo XXXXXXXXXX; done; exit 1"'],
      null, 30000,
    );
    assert.ok(b);
    assert.ok(b.excerpt.length <= 2048);
  });

  it('lists changed/untracked files in the bounce', () => {
    const dir = tmpDir();
    execSync('git init -q', { cwd: dir });
    writeFileSync(join(dir, 'foo.txt'), 'work\n');
    const b = runPreMergeGateLocal(dir, ['false'], null, 30000);
    assert.ok(b);
    assert.ok(b.files.includes('foo.txt'));
  });

  it('best-effort symlinks node_modules from base before running', () => {
    const base = tmpDir();
    const wt = tmpDir();
    mkdirSync(join(base, 'node_modules', 'pkg'), { recursive: true });
    runPreMergeGateLocal(wt, ['git --version'], base, 30000);
    // The symlink should exist and resolve to base's node_modules.
    assert.ok(existsSync(join(wt, 'node_modules', 'pkg')));
  });
});

describe('resolvePreMergeGate', () => {
  function tmpCwd(config) {
    const dir = mkdtempSync(join(tmpdir(), 'pmg-'));
    if (config !== undefined) {
      mkdirSync(join(dir, '.compose'), { recursive: true });
      writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify(config));
    }
    return dir;
  }

  it('defaults to lint+build (no test) when no config/override', () => {
    assert.deepEqual(resolvePreMergeGate(tmpCwd(), undefined), ['pnpm lint', 'pnpm build']);
  });

  it('honors an explicit override array', () => {
    assert.deepEqual(resolvePreMergeGate(tmpCwd(), ['cargo check']), ['cargo check']);
  });

  it('honors .compose/compose.json#preMergeGate', () => {
    const cwd = tmpCwd({ preMergeGate: ['npm run lint'] });
    assert.deepEqual(resolvePreMergeGate(cwd, undefined), ['npm run lint']);
  });

  it('falls back to the non-test subset of gateCommands', () => {
    const cwd = tmpCwd({ gateCommands: ['pnpm lint', 'pnpm build', 'pnpm test'] });
    assert.deepEqual(resolvePreMergeGate(cwd, undefined), ['pnpm lint', 'pnpm build']);
  });
});
