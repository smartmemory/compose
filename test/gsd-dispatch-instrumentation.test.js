// test/gsd-dispatch-instrumentation.test.js
//
// COMP-GSD-7 S3 (integration): the gsd dispatch poll loop must persist per-task
// timing (timing.json) and diff snapshots (diffs/<id>.diff), and must NOT do so
// for non-gsd build mode (context.gsd absent → byte-identical).
//
// Real git repo + real diffs + real executeParallelDispatchServer — no mocking
// of the write path. Mirrors test/parallel-dispatch-server-worktree.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeParallelDispatchServer } from '../lib/build.js';

const FEATURE = 'COMP-INT-1';

function initRepo(name, seedFiles = {}) {
  const repo = mkdtempSync(join(tmpdir(), `gsd-instr-${name}-`));
  execSync('git init -q -b main', { cwd: repo });
  execSync('git config user.email "test@example.com"', { cwd: repo });
  execSync('git config user.name "Test"', { cwd: repo });
  for (const [path, content] of Object.entries(seedFiles)) {
    writeFileSync(join(repo, path), content);
    execSync(`git add ${path}`, { cwd: repo });
  }
  execSync('git commit -q -m init', { cwd: repo });
  return repo;
}

function unifiedDiff(repo, editFn) {
  editFn(repo);
  execSync('git add -A', { cwd: repo });
  const diff = execSync('git diff --cached HEAD', { cwd: repo, encoding: 'utf-8' });
  execSync('git reset --hard HEAD', { cwd: repo });
  return diff;
}

function makeStubStratum(startResult, pollResults) {
  let i = 0;
  return {
    parallelStart: async () => startResult,
    parallelPoll: async () => { const r = pollResults[i]; i = Math.min(i + 1, pollResults.length - 1); return r; },
  };
}

function buildScenario(name) {
  const repo = initRepo(name, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
  const diffA = unifiedDiff(repo, () => writeFileSync(join(repo, 'a.txt'), 'A\nA2\n'));
  const diffB = unifiedDiff(repo, () => writeFileSync(join(repo, 'b.txt'), 'B\nB2\n'));
  const dispatch = {
    flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
    tasks: [{ id: 'ta' }, { id: 'tb', depends_on: ['ta'] }],
    isolation: 'worktree', capture_diff: true,
  };
  const poll = {
    flow_id: 'f1', step_id: 's1',
    summary: { pending: 0, running: 0, complete: 2, failed: 0, cancelled: 0 },
    tasks: {
      ta: { task_id: 'ta', state: 'complete', diff: diffA },
      tb: { task_id: 'tb', state: 'complete', diff: diffB },
    },
    require_satisfied: true, can_advance: true,
    outcome: { status: 'execute_step', step_id: 'next' },
  };
  return { repo, dispatch, poll };
}

describe('COMP-GSD-7 dispatch instrumentation', () => {
  it('gsd path persists timing.json + per-task diff snapshots', async () => {
    const { repo, dispatch, poll } = buildScenario('gsd');
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    try {
      await executeParallelDispatchServer(
        dispatch, makeStubStratum({ status: 'started' }, [poll]),
        { cwd: repo, featureCode: FEATURE, gsd: true, filesChanged: [] },
        null, { write: () => {} }, repo,
      );

      const timingPath = join(repo, '.compose', 'gsd', FEATURE, 'timing.json');
      assert.ok(existsSync(timingPath), 'timing.json written');
      const timing = JSON.parse(readFileSync(timingPath, 'utf-8'));
      assert.ok(timing.ta && timing.ta.startedAt, 'ta has timing');
      assert.ok(timing.tb && timing.tb.startedAt, 'tb has timing');
      // First-poll-complete tasks → completedAt stamped, duration >= 0.
      assert.ok(typeof timing.ta.durationMs === 'number');

      const diffA = join(repo, '.compose', 'gsd', FEATURE, 'diffs', 'ta.diff');
      const diffB = join(repo, '.compose', 'gsd', FEATURE, 'diffs', 'tb.diff');
      assert.ok(existsSync(diffA) && existsSync(diffB), 'both diff snapshots written');
      assert.match(readFileSync(diffA, 'utf-8'), /a\.txt/);
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('build mode (no context.gsd) writes NO timing/diff sidecars', async () => {
    const { repo, dispatch, poll } = buildScenario('build');
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    try {
      await executeParallelDispatchServer(
        dispatch, makeStubStratum({ status: 'started' }, [poll]),
        { filesChanged: [] }, // build-mode context: no gsd marker
        null, { write: () => {} }, repo,
      );
      // The merge still applied (build behavior unchanged)…
      assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A\nA2\n');
      // …but no gsd report sidecars exist.
      assert.ok(!existsSync(join(repo, '.compose', 'gsd')), 'no .compose/gsd sidecars in build mode');
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
