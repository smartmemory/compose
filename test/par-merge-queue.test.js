import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractConflictFiles, buildMergeConflictBounce } from '../lib/build.js';
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
