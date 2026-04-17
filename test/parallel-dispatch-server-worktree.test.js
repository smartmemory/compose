import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeParallelDispatchServer } from '../lib/build.js';

function initRepo(name, seedFiles = {}) {
  const repo = mkdtempSync(join(tmpdir(), `compose-wt-test-${name}-`));
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

// Produces a unified diff by editing a repo and diffing, then reverting.
function unifiedDiff(repo, editFn) {
  editFn(repo);
  execSync('git add -A', { cwd: repo });
  const diff = execSync('git diff --cached HEAD', { cwd: repo, encoding: 'utf-8' });
  execSync('git reset --hard HEAD', { cwd: repo });
  return diff;
}

function makeStubStratum(startResult, pollResults) {
  let pollIdx = 0;
  return {
    parallelStart: async () => startResult,
    parallelPoll: async () => {
      const r = pollResults[pollIdx];
      pollIdx = Math.min(pollIdx + 1, pollResults.length - 1);
      return r;
    },
  };
}

function sw() {
  const events = [];
  return { events, write: (e) => events.push(e) };
}

describe('executeParallelDispatchServer — isolation:worktree happy path', () => {
  it('applies clean diffs topologically and updates context.filesChanged', async () => {
    const repo = initRepo('happy', { 'a.txt': 'A\n', 'b.txt': 'B\n' });
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

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const streamWriter = sw();
    const context = { filesChanged: [] };

    try {
      const resp = await executeParallelDispatchServer(
        dispatch, makeStubStratum({ status: 'started' }, [poll]),
        context, null, streamWriter, repo,
      );
      assert.equal(resp.status, 'execute_step');
      assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A\nA2\n');
      assert.equal(readFileSync(join(repo, 'b.txt'), 'utf-8'), 'B\nB2\n');
      assert.ok(context.filesChanged.includes('a.txt'));
      assert.ok(context.filesChanged.includes('b.txt'));
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — merge conflict aborts build', () => {
  it('emits build_error + throws when two tasks modify the same line', async () => {
    const repo = initRepo('conflict', { 'shared.txt': 'line1\nline2\n' });
    const diffX = unifiedDiff(repo, () => writeFileSync(join(repo, 'shared.txt'), 'X1\nline2\n'));
    const diffY = unifiedDiff(repo, () => writeFileSync(join(repo, 'shared.txt'), 'Y1\nline2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'tx' }, { id: 'ty' }],
      isolation: 'worktree', capture_diff: true,
    };
    const poll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 2, failed: 0, cancelled: 0 },
      tasks: {
        tx: { task_id: 'tx', state: 'complete', diff: diffX },
        ty: { task_id: 'ty', state: 'complete', diff: diffY },
      },
      require_satisfied: true, can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    };

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const streamWriter = sw();
    const context = { filesChanged: [] };

    try {
      await assert.rejects(
        executeParallelDispatchServer(
          dispatch, makeStubStratum({ status: 'started' }, [poll]),
          context, null, streamWriter, repo,
        ),
        /client-side merge conflict/,
      );
      assert.ok(streamWriter.events.some(
        e => e.type === 'build_error' && /CLIENT-SIDE MERGE CONFLICT/.test(e.message),
      ));
      // Downstream event consumers expect start/done pairs per step — emit before throw.
      const done = streamWriter.events.find(e => e.type === 'build_step_done');
      assert.ok(done, 'build_step_done must be emitted before conflict throw');
      assert.equal(done.summary?.merge_status, 'conflict');
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — diff_error is surfaced and skipped', () => {
  it('task with diff_error is skipped, build continues on other diffs', async () => {
    const repo = initRepo('diff-err', { 'a.txt': 'A\n' });
    const diffA = unifiedDiff(repo, () => writeFileSync(join(repo, 'a.txt'), 'A\nA2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'ta' }, { id: 'tb' }],
      isolation: 'worktree', capture_diff: true,
    };
    const poll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 2, failed: 0, cancelled: 0 },
      tasks: {
        ta: { task_id: 'ta', state: 'complete', diff: diffA },
        tb: { task_id: 'tb', state: 'complete', diff: null, diff_error: 'CalledProcessError: git add -A failed' },
      },
      require_satisfied: true, can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    };

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const streamWriter = sw();
    const context = { filesChanged: [] };

    try {
      const resp = await executeParallelDispatchServer(
        dispatch, makeStubStratum({ status: 'started' }, [poll]),
        context, null, streamWriter, repo,
      );
      assert.equal(resp.status, 'execute_step');
      assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A\nA2\n');
      assert.ok(streamWriter.events.some(
        e => e.type === 'build_error' && /diff capture failed/.test(e.message),
      ));
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — failed task contributes no diff', () => {
  it('task in state:failed is skipped regardless of diff field', async () => {
    const repo = initRepo('failed-task', { 'a.txt': 'A\n' });
    const diffA = unifiedDiff(repo, () => writeFileSync(join(repo, 'a.txt'), 'A\nA2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'ta' }, { id: 'tb' }],
      isolation: 'worktree', capture_diff: true,
    };
    const poll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 1, failed: 1, cancelled: 0 },
      tasks: {
        ta: { task_id: 'ta', state: 'complete', diff: diffA },
        tb: { task_id: 'tb', state: 'failed', error: 'boom', diff: 'should be ignored' },
      },
      require_satisfied: false, can_advance: false,
      outcome: { status: 'ensure_failed', reason: 'require unsatisfied' },
    };

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const context = { filesChanged: [] };

    try {
      const resp = await executeParallelDispatchServer(
        dispatch, makeStubStratum({ status: 'started' }, [poll]),
        context, null, sw(), repo,
      );
      assert.equal(resp.status, 'ensure_failed');
      assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A\nA2\n');
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
