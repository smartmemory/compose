import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeParallelDispatchServer } from '../lib/build.js';

function initRepo(name, seedFiles = {}) {
  const repo = mkdtempSync(join(tmpdir(), `compose-defer-test-${name}-`));
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

function makeStubStratum({ startResult, pollResults, advanceResult }) {
  let pollIdx = 0;
  const advanceCalls = [];
  return {
    advanceCalls,
    stratum: {
      parallelStart: async () => startResult,
      parallelPoll: async () => {
        const r = pollResults[pollIdx];
        pollIdx = Math.min(pollIdx + 1, pollResults.length - 1);
        return r;
      },
      parallelAdvance: async (flowId, stepId, mergeStatus) => {
        advanceCalls.push({ flowId, stepId, mergeStatus });
        return advanceResult;
      },
    },
  };
}

function sw() {
  const events = [];
  return { events, write: (e) => events.push(e) };
}

describe('executeParallelDispatchServer — defer-advance happy path', () => {
  it('calls parallelAdvance(clean) when all diffs apply, returns advance result as response', async () => {
    const repo = initRepo('defer-happy', { 'a.txt': 'A\n' });
    const diffA = unifiedDiff(repo, () => writeFileSync(join(repo, 'a.txt'), 'A\nA2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'ta' }],
      isolation: 'worktree', capture_diff: true,
    };
    const sentinelPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 1, failed: 0, cancelled: 0 },
      tasks: { ta: { task_id: 'ta', state: 'complete', diff: diffA } },
      require_satisfied: true, can_advance: false,
      outcome: { status: 'awaiting_consumer_advance', aggregate: { merge_status: 'clean' } },
    };
    const advanceResult = { status: 'execute_step', step_id: 'next' };

    const { stratum, advanceCalls } = makeStubStratum({
      startResult: { status: 'started' },
      pollResults: [sentinelPoll],
      advanceResult,
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    try {
      const resp = await executeParallelDispatchServer(
        dispatch, stratum, { filesChanged: [] }, null, sw(), repo,
      );
      assert.equal(advanceCalls.length, 1);
      assert.equal(advanceCalls[0].mergeStatus, 'clean');
      assert.equal(resp.status, 'execute_step');
      assert.equal(resp.step_id, 'next');
      assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A\nA2\n');
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — defer-advance conflict path', () => {
  it('reports merge_status=conflict, does NOT throw, returns terminal failure envelope', async () => {
    const repo = initRepo('defer-conflict', { 'shared.txt': 'line1\nline2\n' });
    const diffX = unifiedDiff(repo, () => writeFileSync(join(repo, 'shared.txt'), 'X1\nline2\n'));
    const diffY = unifiedDiff(repo, () => writeFileSync(join(repo, 'shared.txt'), 'Y1\nline2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'tx' }, { id: 'ty' }],
      isolation: 'worktree', capture_diff: true,
    };
    const sentinelPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 2, failed: 0, cancelled: 0 },
      tasks: {
        tx: { task_id: 'tx', state: 'complete', diff: diffX },
        ty: { task_id: 'ty', state: 'complete', diff: diffY },
      },
      require_satisfied: true, can_advance: false,
      outcome: { status: 'awaiting_consumer_advance', aggregate: { merge_status: 'clean' } },
    };
    const advanceResult = {
      status: 'complete',
      output: { outcome: 'failed', merge_status: 'conflict' },
    };

    const { stratum, advanceCalls } = makeStubStratum({
      startResult: { status: 'started' },
      pollResults: [sentinelPoll],
      advanceResult,
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const streamWriter = sw();
    try {
      const resp = await executeParallelDispatchServer(
        dispatch, stratum, { filesChanged: [] }, null, streamWriter, repo,
      );
      assert.equal(advanceCalls.length, 1);
      assert.equal(advanceCalls[0].mergeStatus, 'conflict');
      assert.equal(resp.status, 'complete');
      assert.equal(resp.output?.outcome, 'failed');
      assert.equal(resp.output?.merge_status, 'conflict');
      assert.ok(streamWriter.events.some(
        e => e.type === 'build_error' && /Client-side merge conflict/.test(e.message),
      ));
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — defer-advance spec mispairing', () => {
  it('calls parallelAdvance(clean) defensively when sentinel arrives without capture_diff', async () => {
    const repo = initRepo('defer-mispair', { 'placeholder.txt': 'seed\n' });

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'ta' }],
      isolation: 'worktree',
      // capture_diff omitted — mispairing
    };
    const sentinelPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 1, failed: 0, cancelled: 0 },
      tasks: { ta: { task_id: 'ta', state: 'complete' } },
      require_satisfied: true, can_advance: false,
      outcome: { status: 'awaiting_consumer_advance', aggregate: {} },
    };
    const advanceResult = { status: 'execute_step', step_id: 'next' };

    const { stratum, advanceCalls } = makeStubStratum({
      startResult: { status: 'started' },
      pollResults: [sentinelPoll],
      advanceResult,
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const streamWriter = sw();
    try {
      const resp = await executeParallelDispatchServer(
        dispatch, stratum, { filesChanged: [] }, null, streamWriter, repo,
      );
      assert.equal(advanceCalls.length, 1);
      assert.equal(advanceCalls[0].mergeStatus, 'clean');
      assert.equal(resp.status, 'execute_step');
      assert.ok(streamWriter.events.some(
        e => e.type === 'build_error' && /without \(isolation:worktree \+ capture_diff/.test(e.message),
      ));
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — advance error propagates', () => {
  it('throws if parallelAdvance returns error envelope', async () => {
    const repo = initRepo('advance-err', { 'a.txt': 'A\n' });
    const diffA = unifiedDiff(repo, () => writeFileSync(join(repo, 'a.txt'), 'A\nA2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'ta' }],
      isolation: 'worktree', capture_diff: true,
    };
    const sentinelPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 1, failed: 0, cancelled: 0 },
      tasks: { ta: { task_id: 'ta', state: 'complete', diff: diffA } },
      require_satisfied: true, can_advance: false,
      outcome: { status: 'awaiting_consumer_advance', aggregate: {} },
    };
    const advanceResult = { error: 'spec_integrity_violation', message: 'tampered' };

    const { stratum } = makeStubStratum({
      startResult: { status: 'started' },
      pollResults: [sentinelPoll],
      advanceResult,
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    try {
      await assert.rejects(
        executeParallelDispatchServer(
          dispatch, stratum, { filesChanged: [] }, null, sw(), repo,
        ),
        /stratum_parallel_advance failed: spec_integrity_violation/,
      );
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
