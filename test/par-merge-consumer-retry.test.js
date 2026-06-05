/**
 * COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY — consumer-path parallel retry loop.
 *
 * Covers (per blueprint test plan):
 *   T2 — D5 opt-in wiring: pre_merge_gate omitted from planInputs by default,
 *        present iff resolved.
 *   T3 — anchor/entry-snapshot helpers.
 *   T4/T6 — retry loop, subset math, anchor seeding, bounce injection,
 *        base restore between rounds, single build_step_done, depth cap,
 *        mis-route marker.
 *   T5 — mis-route guard: marker terminates both outer loops, never single-agent retry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';

import {
  startFresh,
  buildAnchorCommit,
  captureEntrySnapshot,
  restoreToSnapshot,
  executeParallelDispatch,
  executeChildFlow,
  isParallelRetriesExhausted,
} from '../lib/build.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpDataDir() {
  const d = mkdtempSync(join(tmpdir(), 'cmqcr-data-'));
  return d;
}

/** Stub stratum whose .plan captures the planInputs it was called with. */
function captureStratum() {
  const calls = [];
  return {
    calls,
    async plan(specYaml, flowName, planInputs) {
      calls.push({ specYaml, flowName, planInputs });
      return { flow_id: 'flow-1', step_id: 'step-1', step_number: 1, total_steps: 4 };
    },
  };
}

const SPEC_YAML = `
version: "0.1"
flows:
  build:
    input: {}
    steps: []
`;

// ---------------------------------------------------------------------------
// T2 — D5 opt-in wiring (default-OFF, field-omitted)
// ---------------------------------------------------------------------------

describe('startFresh — D5 pre_merge_gate opt-in (T2)', () => {
  it('omits pre_merge_gate from planInputs when preMergeGate arg is undefined (byte-identical default)', async () => {
    const stratum = captureStratum();
    const dataDir = tmpDataDir();
    await startFresh(stratum, SPEC_YAML, 'FEAT-X', 'do the thing', dataDir, 'build', 'feature');
    assert.equal(stratum.calls.length, 1);
    const { planInputs } = stratum.calls[0];
    assert.deepEqual(planInputs, { featureCode: 'FEAT-X', description: 'do the thing' });
    assert.ok(!('pre_merge_gate' in planInputs), 'pre_merge_gate must be ABSENT, not []');
  });

  it('includes pre_merge_gate in planInputs when preMergeGate is provided', async () => {
    const stratum = captureStratum();
    const dataDir = tmpDataDir();
    const gate = ['pnpm lint', 'pnpm build'];
    await startFresh(stratum, SPEC_YAML, 'FEAT-X', 'do the thing', dataDir, 'build', 'feature', gate);
    const { planInputs } = stratum.calls[0];
    assert.deepEqual(planInputs, {
      featureCode: 'FEAT-X',
      description: 'do the thing',
      pre_merge_gate: ['pnpm lint', 'pnpm build'],
    });
  });

  it('an empty-array gate is still threaded through (caller decides; only undefined omits)', async () => {
    const stratum = captureStratum();
    const dataDir = tmpDataDir();
    await startFresh(stratum, SPEC_YAML, 'FEAT-X', 'd', dataDir, 'build', 'feature', []);
    const { planInputs } = stratum.calls[0];
    assert.ok('pre_merge_gate' in planInputs);
    assert.deepEqual(planInputs.pre_merge_gate, []);
  });

  it('bug mode is unaffected by preMergeGate (planInputs stays { task })', async () => {
    const stratum = captureStratum();
    const dataDir = tmpDataDir();
    await startFresh(stratum, SPEC_YAML, 'BUG-1', 'fix it', dataDir, 'bug-fix', 'bug', ['pnpm lint']);
    const { planInputs } = stratum.calls[0];
    assert.deepEqual(planInputs, { task: 'fix it' });
    assert.ok(!('pre_merge_gate' in planInputs));
  });
});

// ---------------------------------------------------------------------------
// T3 — Anchor commit + entry-snapshot helpers (W2)
// ---------------------------------------------------------------------------

function git(cwd, cmd, input) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe', input }).trim();
}

/** Init a temp repo with one committed file, return its path. */
function initRepo(files = { 'a.txt': 'A\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'cmqcr-repo-'));
  git(dir, 'init -q');
  git(dir, 'config user.email t@t');
  git(dir, 'config user.name t');
  git(dir, 'config commit.gpgsign false');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, 'add -A');
  git(dir, 'commit -q -m initial');
  return dir;
}

/** Produce a diff (relative to HEAD) that adds `name` with `content`, leaving the worktree clean. */
function diffAddingFile(repo, name, content) {
  writeFileSync(join(repo, name), content);
  git(repo, `add ${name}`);
  const diff = git(repo, 'diff --cached HEAD') + '\n';
  git(repo, 'reset -q');
  rmSync(join(repo, name), { force: true });
  return diff;
}

describe('buildAnchorCommit (T3)', () => {
  it('builds a dangling commit whose tree = HEAD + good diffs, base worktree/index untouched', () => {
    const repo = initRepo();
    const head = git(repo, 'rev-parse HEAD');
    const diff = diffAddingFile(repo, 'b.txt', 'B\n');
    // precondition: worktree clean, b.txt absent
    assert.equal(git(repo, 'status --porcelain'), '');
    assert.ok(!existsSync(join(repo, 'b.txt')));

    const sha = buildAnchorCommit(repo, [diff], 'test-anchor');

    assert.equal(git(repo, `cat-file -t ${sha}`), 'commit');
    assert.equal(git(repo, `rev-parse ${sha}^`), head, 'anchor parent must be HEAD');
    assert.equal(git(repo, `show ${sha}:b.txt`), 'B', 'anchor tree must contain the applied diff');
    // base untouched
    assert.equal(git(repo, 'rev-parse HEAD'), head, 'HEAD must not move');
    assert.equal(git(repo, 'status --porcelain'), '', 'base worktree must stay clean');
    assert.ok(!existsSync(join(repo, 'b.txt')), 'diff must not land in the base worktree');
    rmSync(repo, { recursive: true, force: true });
  });

  it('a worktree created off the anchor sees the replayed good work', () => {
    const repo = initRepo();
    const diff = diffAddingFile(repo, 'b.txt', 'B\n');
    const sha = buildAnchorCommit(repo, [diff], 'anchor');
    const wt = mkdtempSync(join(tmpdir(), 'cmqcr-wt-'));
    rmSync(wt, { recursive: true, force: true }); // git worktree add needs a non-existent path
    git(repo, `worktree add "${wt}" ${sha} --detach`);
    assert.ok(existsSync(join(wt, 'b.txt')), 'retry worktree off anchor must see good work');
    assert.equal(readFileSync(join(wt, 'b.txt'), 'utf-8'), 'B\n');
    git(repo, `worktree remove "${wt}" --force`);
    rmSync(repo, { recursive: true, force: true });
  });

  it('empty good-diff list yields an anchor identical in tree to HEAD', () => {
    const repo = initRepo();
    const headTree = git(repo, 'rev-parse HEAD^{tree}');
    const sha = buildAnchorCommit(repo, [], 'empty');
    assert.equal(git(repo, `rev-parse ${sha}^{tree}`), headTree);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('captureEntrySnapshot / restoreToSnapshot (T3)', () => {
  it('capture leaves the real index and worktree untouched (incl. staged changes)', () => {
    const repo = initRepo();
    // entry state: a.txt modified (unstaged), c.txt staged, u.txt untracked
    writeFileSync(join(repo, 'a.txt'), 'A2\n');
    writeFileSync(join(repo, 'c.txt'), 'C\n');
    git(repo, 'add c.txt');
    writeFileSync(join(repo, 'u.txt'), 'U\n');
    const before = git(repo, 'status --porcelain');

    const snap = captureEntrySnapshot(repo);

    assert.equal(git(repo, `cat-file -t ${snap}`), 'commit');
    assert.equal(git(repo, 'status --porcelain'), before, 'real index/worktree must be byte-identical after capture');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A2\n');
    // c.txt is still STAGED (temp index did not clobber real index)
    assert.ok(git(repo, 'diff --cached --name-only').includes('c.txt'));
    rmSync(repo, { recursive: true, force: true });
  });

  it('restore brings working-tree content (tracked + untracked) back to the entry snapshot', () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'a.txt'), 'A2\n');   // entry: modified tracked
    writeFileSync(join(repo, 'u.txt'), 'U\n');    // entry: untracked
    const snap = captureEntrySnapshot(repo);

    // simulate a retry round mutating the base — UNSTAGED, exactly as
    // applyTaskDiffsToBaseCwd leaves it (`git apply`, not `git apply --cached`).
    writeFileSync(join(repo, 'a.txt'), 'ROUND\n');
    rmSync(join(repo, 'u.txt'), { force: true });
    writeFileSync(join(repo, 'r.txt'), 'ROUND-untracked\n');

    restoreToSnapshot(repo, snap);

    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A2\n', 'tracked file restored to entry content');
    assert.ok(existsSync(join(repo, 'u.txt')), 'entry untracked file re-materialized');
    assert.equal(readFileSync(join(repo, 'u.txt'), 'utf-8'), 'U\n');
    assert.ok(!existsSync(join(repo, 'r.txt')), "round's untracked file removed");
    assert.equal(git(repo, 'diff --cached HEAD'), '', 'index reset to HEAD (staging split not preserved)');
    rmSync(repo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// T4 / T6 — golden-flow integration: drive executeParallelDispatch with a
// stubbed stratum whose parallelDone returns ensure_failed once then complete.
// ---------------------------------------------------------------------------

/**
 * Build a stub stratum + recorders. The agent (stub `agentRun`) writes each
 * task's owned file into its worktree (cwd = .compose/par/<taskId>). t2 writes
 * "fail" on its first run (gate fails) and "PASS" thereafter; t1/t3 always pass.
 * parallelDone mirrors Stratum: any failed task ⇒ ensure_failed carrying the
 * failed surface; all-complete ⇒ complete.
 */
function makeDispatchHarness({ t2AlwaysFails = false } = {}) {
  const callsByTask = {};
  const promptsByTask = {};
  const seenF1ByTask = {};   // content of f1.txt each task sees on entry (anchor-seeding probe)
  const pdCalls = [];
  const events = [];

  const stratum = {
    onEvent: () => () => {},
    cancelAgentRun: async () => {},
    agentRun: async (_agentType, prompt, opts) => {
      const cwd = opts.cwd;
      const taskId = basename(cwd);
      callsByTask[taskId] = (callsByTask[taskId] ?? 0) + 1;
      (promptsByTask[taskId] ??= []).push(prompt);
      (seenF1ByTask[taskId] ??= []).push(
        existsSync(join(cwd, 'f1.txt')) ? readFileSync(join(cwd, 'f1.txt'), 'utf-8') : null,
      );
      const nth = callsByTask[taskId];
      // Tasks MODIFY committed tracked files (matches production; keeps files disjoint).
      if (taskId === 't1') writeFileSync(join(cwd, 'f1.txt'), 'one\n');
      else if (taskId === 't3') writeFileSync(join(cwd, 'f3.txt'), 'three\n');
      else if (taskId === 't2') {
        const pass = !t2AlwaysFails && nth >= 2;
        writeFileSync(join(cwd, 'f2.txt'), pass ? 'PASS-fixed\n' : 'fail\n');
      }
      return { text: 'done' };
    },
    parallelDone: async (flowId, stepId, taskResults, mergeArg) => {
      pdCalls.push({ taskResults: JSON.parse(JSON.stringify(taskResults)), mergeArg });
      const failed = taskResults.filter(r => r.status === 'failed');
      if (failed.length) {
        return { status: 'ensure_failed', step_id: stepId, flow_id: flowId, tasks: failed.map(r => ({ id: r.task_id })) };
      }
      return { status: 'complete', step_id: stepId, flow_id: flowId };
    },
  };
  const streamWriter = { write: (e) => events.push(e) };
  return { stratum, streamWriter, callsByTask, promptsByTask, seenF1ByTask, pdCalls, events };
}

/** Base repo where f1/f2/f3 are committed with PASS (the gate's clean baseline). */
function initIntegrationRepo() {
  return initRepo({ 'seed.txt': 'seed\n', 'f1.txt': 'PASS\n', 'f2.txt': 'PASS\n', 'f3.txt': 'PASS\n' });
}

function dispatchResponse(tasks) {
  return {
    tasks,
    intent_template: 'Implement {task.id}: own {task.files_owned}',
    agent: 'claude',
    flow_id: 'flow-exec',
    step_id: 'execute',
    step_number: 5,
    total_steps: 9,
    isolation: 'worktree',
    capture_diff: true,
    max_concurrent: 3,
    // Per-task gate: the task's f2.txt must contain PASS. t1/t3 never touch f2.txt
    // (their committed PASS survives); t2 fails until it writes a PASS-bearing fix.
    pre_merge_verify: ['grep -q PASS f2.txt'],
  };
}

const THREE_TASKS = [
  { id: 't1', files_owned: ['f1.txt'] },
  { id: 't2', files_owned: ['f2.txt'] },
  { id: 't3', files_owned: ['f3.txt'] },
];

describe('executeParallelDispatch — consumer-path retry loop (T4/T6)', () => {
  it('retries only the failed subset, seeds round-N worktree off the anchor, injects the bounce, merges to a clean complete', () => {
    const base = initIntegrationRepo();
    const h = makeDispatchHarness();
    const context = { featureCode: 'FEAT-X', filesChanged: [] };

    return executeParallelDispatch(
      dispatchResponse(THREE_TASKS), h.stratum, context, null, h.streamWriter, base, null,
    ).then((env) => {
      // terminal complete, not tagged exhausted
      assert.equal(env.status, 'complete');
      assert.ok(!env._parallelRetriesExhausted);

      // two rounds: ensure_failed then complete
      assert.equal(h.pdCalls.length, 2);
      assert.equal(h.pdCalls[0].taskResults.find(r => r.task_id === 't2').status, 'failed');
      assert.ok(h.pdCalls[0].mergeArg && Array.isArray(h.pdCalls[0].mergeArg.bounced_tasks),
        'round 0 sends a structured merge_status with bounced_tasks');
      assert.equal(h.pdCalls[0].mergeArg.bounced_tasks[0].reason, 'gate_failed');
      assert.ok(h.pdCalls[1].taskResults.every(r => r.status === 'complete'),
        'round 1 aggregate is all-complete (carried good + re-run)');

      // subset math: only t2 re-ran
      assert.equal(h.callsByTask.t1, 1, 't1 not re-run');
      assert.equal(h.callsByTask.t3, 1, 't3 not re-run');
      assert.equal(h.callsByTask.t2, 2, 't2 re-run once');

      // anchor seeding: round 0 t2 worktree is off HEAD (f1 = committed PASS); round 1
      // is off the anchor = HEAD + t1/t3's replayed diffs (f1 = t1's 'one').
      assert.equal(h.seenF1ByTask.t2[0], 'PASS\n', 'round-0 t2 worktree off HEAD sees the committed f1');
      assert.equal(h.seenF1ByTask.t2[1], 'one\n', "round-1 t2 worktree off anchor sees t1's replayed good diff");

      // bounce injection: round-1 prompt carries the gate bounce; round-0 does not
      assert.ok(!/rejected before merge/.test(h.promptsByTask.t2[0]), 'round-0 prompt has no bounce');
      assert.match(h.promptsByTask.t2[1], /Previous attempt was rejected before merge/);
      assert.match(h.promptsByTask.t2[1], /f2\.txt/);

      // exactly one terminal parent build_step_done (stepId === 'execute')
      const parentDone = h.events.filter(e => e.type === 'build_step_done' && e.stepId === 'execute');
      assert.equal(parentDone.length, 1, 'single terminal build_step_done for the parent step');

      // base holds the merged union exactly once (no doubling)
      assert.equal(readFileSync(join(base, 'f1.txt'), 'utf-8'), 'one\n');
      assert.equal(readFileSync(join(base, 'f2.txt'), 'utf-8'), 'PASS-fixed\n');
      assert.equal(readFileSync(join(base, 'f3.txt'), 'utf-8'), 'three\n');
      assert.deepEqual([...(context.filesChanged ?? [])].sort(), ['f1.txt', 'f2.txt', 'f3.txt']);

      rmSync(base, { recursive: true, force: true });
    });
  });

  it('depth cap: a task that never passes the gate is bounded to RETRY_CAP+1 rounds, tags _parallelRetriesExhausted, and leaves the base clean', () => {
    const base = initIntegrationRepo();
    const h = makeDispatchHarness({ t2AlwaysFails: true });
    const context = { featureCode: 'FEAT-X', filesChanged: [] };

    return executeParallelDispatch(
      dispatchResponse(THREE_TASKS), h.stratum, context, null, h.streamWriter, base, null,
    ).then((env) => {
      assert.equal(env._parallelRetriesExhausted, true, 'cap-exhausted envelope is tagged for the W4 mis-route guard');
      assert.equal(env.status, 'ensure_failed');
      // RETRY_CAP defaults to 2 ⇒ rounds 0,1,2 ⇒ 3 parallelDone calls, t2 ran 3×
      assert.equal(h.pdCalls.length, 3);
      assert.equal(h.callsByTask.t2, 3);
      assert.equal(h.callsByTask.t1, 1, 'good tasks never re-run across the retry rounds');

      // exhausted ⇒ base restored to entry (no partial union left behind; committed files unmodified)
      assert.equal(git(base, 'status --porcelain'), '', 'failed step leaves the base clean');
      assert.equal(readFileSync(join(base, 'f1.txt'), 'utf-8'), 'PASS\n', 'committed f1 restored, not left as t1 mutation');
      assert.equal(readFileSync(join(base, 'f2.txt'), 'utf-8'), 'PASS\n');

      // exactly one terminal parent build_step_done even across 3 rounds
      const parentDone = h.events.filter(e => e.type === 'build_step_done' && e.stepId === 'execute');
      assert.equal(parentDone.length, 1);

      rmSync(base, { recursive: true, force: true });
    });
  });

  it('isolation:none (e.g. review lenses) is NOT retried or tagged — raw envelope flows to the parent fix-loop', () => {
    // Regression guard: the retry loop + _parallelRetriesExhausted marker are
    // worktree-only. A non-worktree parallel step that ensure_fails must return
    // the RAW envelope so the parent (review) fix-loop handles it — not get killed.
    const base = initRepo({ 'seed.txt': 'seed\n' });
    let pdCalls = 0;
    let agentRuns = 0;
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async () => { agentRuns++; return { text: 'reviewed' }; },
      parallelDone: async (flowId, stepId) => {
        pdCalls++;
        // review lens "not clean" → ensure_failed carrying the parallel surface
        return { status: 'ensure_failed', step_id: stepId, flow_id: flowId, tasks: [{ id: 'lensA' }] };
      },
    };
    const events = [];
    const dr = {
      tasks: [{ id: 'lensA' }, { id: 'lensB' }],
      intent_template: 'Run {task.id}',
      agent: 'claude',
      flow_id: 'rf', step_id: 'review_lenses', step_number: 2, total_steps: 3,
      isolation: 'none',
    };

    return executeParallelDispatch(
      dr, stratum, { featureCode: 'X', filesChanged: [] }, null, { write: (e) => events.push(e) }, base, null,
    ).then((env) => {
      assert.equal(env.status, 'ensure_failed', 'raw ensure_failed envelope returned');
      assert.ok(!('_parallelRetriesExhausted' in env), 'non-worktree step is NOT tagged for the W4 guard');
      assert.equal(pdCalls, 1, 'no retry rounds for isolation:none');
      assert.equal(agentRuns, 2, 'both lenses ran exactly once');
      // pre-feature emit preserved: mergeStatus-based summary ("merged"), retries:0
      const done = events.filter(e => e.type === 'build_step_done' && e.stepId === 'review_lenses');
      assert.equal(done.length, 1);
      assert.match(done[0].summary, /tasks merged$/, 'isolation:none keeps the pre-feature mergeStatus summary');
      assert.equal(done[0].retries, 0);
      rmSync(base, { recursive: true, force: true });
    });
  });

  it('a no-bounce failure (agent error) is selected into the subset under a schema_failed envelope; no bounce is injected', () => {
    const base = initRepo({ 'seed.txt': 's\n', 'fa.txt': 'A0\n', 'fb.txt': 'B0\n' });
    const calls = {}; const prompts = {};
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async (_a, p, o) => {
        const id = basename(o.cwd);
        calls[id] = (calls[id] ?? 0) + 1;
        (prompts[id] ??= []).push(p);
        if (id === 'ta') writeFileSync(join(o.cwd, 'fa.txt'), 'A1\n');
        else if (id === 'tb') {
          if (calls[id] === 1) throw new Error('boom');   // round-0 failure with NO gate bounce
          writeFileSync(join(o.cwd, 'fb.txt'), 'B1\n');
        }
        return { text: 'ok' };
      },
      parallelDone: async (f, s, tr) => {
        const failed = tr.filter(r => r.status === 'failed');
        // exercise the schema_failed envelope branch (no bounce produced)
        return failed.length
          ? { status: 'schema_failed', step_id: s, flow_id: f, tasks: failed.map(r => ({ id: r.task_id })) }
          : { status: 'complete', step_id: s, flow_id: f };
      },
    };
    const dr = {
      tasks: [{ id: 'ta', files_owned: ['fa.txt'] }, { id: 'tb', files_owned: ['fb.txt'] }],
      intent_template: 'x', agent: 'claude', flow_id: 'f', step_id: 'execute', step_number: 1, total_steps: 2,
      isolation: 'worktree', capture_diff: true, max_concurrent: 2,
    };
    return executeParallelDispatch(
      dr, stratum, { featureCode: 'X', filesChanged: [] }, null, { write() {} }, base, null,
    ).then((env) => {
      assert.equal(env.status, 'complete');
      assert.ok(!env._parallelRetriesExhausted);
      assert.equal(calls.ta, 1, 'good task not re-run');
      assert.equal(calls.tb, 2, 'bounce-less failure still selected into the retry subset');
      assert.ok(!/rejected before merge/.test(prompts.tb[1]), 'no bounce injected when the failure produced none');
      assert.equal(readFileSync(join(base, 'fb.txt'), 'utf-8'), 'B1\n');
      rmSync(base, { recursive: true, force: true });
    });
  });

  it('a merge-conflict loser is retried off the anchor with a conflict bounce, then merges clean', () => {
    const base = initRepo({ 'seed.txt': 's\n', 'shared.txt': 'ORIG\n' });
    const calls = {}; const prompts = {};
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async (_a, p, o) => {
        const id = basename(o.cwd);
        calls[id] = (calls[id] ?? 0) + 1;
        (prompts[id] ??= []).push(p);
        // tx and ty both own shared.txt → their round-0 diffs conflict at merge.
        if (id === 'tx') writeFileSync(join(o.cwd, 'shared.txt'), 'X\n');
        else if (id === 'ty') writeFileSync(join(o.cwd, 'shared.txt'), calls[id] === 1 ? 'Y\n' : 'XY\n');
        return { text: 'ok' };
      },
      parallelDone: async (f, s, tr) => {
        const failed = tr.filter(r => r.status === 'failed');
        return failed.length
          ? { status: 'ensure_failed', step_id: s, flow_id: f, tasks: failed.map(r => ({ id: r.task_id })) }
          : { status: 'complete', step_id: s, flow_id: f };
      },
    };
    const dr = {
      tasks: [{ id: 'tx', files_owned: ['shared.txt'] }, { id: 'ty', files_owned: ['shared.txt'] }],
      intent_template: 'x', agent: 'claude', flow_id: 'f', step_id: 'execute', step_number: 1, total_steps: 2,
      isolation: 'worktree', capture_diff: true, max_concurrent: 2,
    };
    return executeParallelDispatch(
      dr, stratum, { featureCode: 'X', filesChanged: [] }, null, { write() {} }, base, null,
    ).then((env) => {
      assert.equal(env.status, 'complete');
      assert.equal(calls.tx, 1, 'conflict winner not re-run');
      assert.equal(calls.ty, 2, 'conflict loser re-run');
      assert.match(prompts.ty[1], /CONFLICTED/, 'merge-conflict bounce injected into the retry prompt');
      assert.equal(readFileSync(join(base, 'shared.txt'), 'utf-8'), 'XY\n', 'retry merged cleanly on top of the winner');
      rmSync(base, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// CONSUMER-RETRY-1 — review-scaffold branch on the consumer-dispatch path.
// The `if (isReview)` branch read `response.inputs` — but `response` is unbound
// inside executeParallelDispatch (only `dispatchResponse` is in scope), so a
// review/lens task that reached the scaffold threw a ReferenceError swallowed by
// the per-task try/catch, silently failing the lens. The existing isolation:none
// test never set lens_name/review_mode, so isReview stayed false and the bug
// stayed latent. This drives a real review dispatch through the scaffold.
// ---------------------------------------------------------------------------

describe('executeParallelDispatch — review-scaffold on the consumer path (CONSUMER-RETRY-1)', () => {
  it('a review/lens task reaches the scaffold without a ReferenceError and threads dispatchResponse.inputs (task + blueprint) into the dispatched prompt', () => {
    const base = initRepo({ 'seed.txt': 'seed\n' });
    const prompts = [];
    let agentRuns = 0;
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async (_agentType, prompt) => { agentRuns++; prompts.push(prompt); return { text: 'reviewed' }; },
      parallelDone: async (flowId, stepId, taskResults) => {
        const failed = taskResults.filter(r => r.status === 'failed');
        return failed.length
          ? { status: 'ensure_failed', step_id: stepId, flow_id: flowId, tasks: failed.map(r => ({ id: r.task_id })) }
          : { status: 'complete', step_id: stepId, flow_id: flowId };
      },
    };
    const events = [];
    const dr = {
      tasks: [{ id: 'lensA', lens_name: 'security' }],     // lens_name != null ⇒ isReview true
      intent_template: 'Run {task.id}',
      agent: 'claude',
      flow_id: 'rf', step_id: 'review_lenses', step_number: 2, total_steps: 3,
      isolation: 'none',
      // The dispatch carries task/blueprint context via inputs — exactly what the
      // scaffold must read off `dispatchResponse.inputs`, NOT the unbound `response`.
      inputs: { task: 'GOLDEN_TASK_DESC', blueprint: 'GOLDEN_BLUEPRINT_TEXT' },
    };

    return executeParallelDispatch(
      dr, stratum, { featureCode: 'X', filesChanged: [] }, null, { write: (e) => events.push(e) }, base, null,
    ).then((env) => {
      // Pre-fix: buildReviewPrompt({ taskDescription: response.inputs..., blueprint: response.inputs... })
      // throws ReferenceError (response undefined) → lensA fails → ensure_failed, agentRun never called.
      // (review-mode runAndNormalize may dispatch a follow-up repair pass when the stub
      //  output isn't valid ReviewResult JSON, so the count is >= 1, not exactly 1.)
      assert.ok(agentRuns >= 1, 'the review task reached agentRun (scaffold built without throwing)');
      assert.equal(env.status, 'complete', 'review task completed — no swallowed ReferenceError');
      // Post-fix: the scaffold is fed from dispatchResponse.inputs (not the unbound `response`).
      assert.ok(prompts.some(p => /## Task\n\nGOLDEN_TASK_DESC/.test(p)),
        'task description threaded from dispatchResponse.inputs.task');
      assert.ok(prompts.some(p => /## Blueprint\n\nGOLDEN_BLUEPRINT_TEXT/.test(p)),
        'blueprint threaded from dispatchResponse.inputs.blueprint');
      rmSync(base, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// T5 — Mis-route guard (W4): a parallel step that exhausted its own retry loop
// must terminate the outer loops, never get single-agent-retried.
// ---------------------------------------------------------------------------

describe('isParallelRetriesExhausted (T5)', () => {
  it('detects the explicit marker, not a tasks-array heuristic', () => {
    assert.equal(isParallelRetriesExhausted({ status: 'ensure_failed', _parallelRetriesExhausted: true }), true);
    assert.equal(isParallelRetriesExhausted({ status: 'ensure_failed', tasks: [{ id: 't1' }] }), false,
      'a terminal envelope carrying task metadata is NOT treated as exhausted');
    assert.equal(isParallelRetriesExhausted({ status: 'complete' }), false);
    assert.equal(isParallelRetriesExhausted(null), false);
  });
});

describe('executeChildFlow — mis-route guard (T5)', () => {
  it('a cap-exhausted parallel child step terminates without a single-agent fix (no double-handle)', () => {
    let agentRunCalls = 0;
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async () => { agentRunCalls++; return { text: '' }; },
      stepDone: async () => { throw new Error('stepDone must not be called for an exhausted parallel step'); },
    };
    const visionWriter = { updateItemPhase: async () => {}, updateItemStatus: async () => {} };
    const events = [];
    const streamWriter = { write: (e) => events.push(e) };
    const dataDir = mkdtempSync(join(tmpdir(), 'cmqcr-cf-'));

    const flowDispatch = {
      child_step: { status: 'ensure_failed', _parallelRetriesExhausted: true, step_id: 'execute', flow_id: 'cf' },
      child_flow_id: 'cf',
      parent_flow_id: 'pf',
      child_flow_name: 'sub',
    };

    return executeChildFlow(
      flowDispatch, stratum, { cwd: dataDir, featureCode: 'X' },
      visionWriter, 'item-1', dataDir, {}, null, streamWriter,
    ).then((result) => {
      assert.equal(result.status, 'killed', 'child flow terminates rather than fix-retrying');
      assert.equal(agentRunCalls, 0, 'the single-agent fix path is never entered');
      assert.ok(
        events.some(e => e.type === 'build_error' && /failed after retries/.test(e.message ?? '')),
        'a build_error is surfaced for the exhausted parallel step',
      );
      rmSync(dataDir, { recursive: true, force: true });
    });
  });
});

describe('runBuild ensure_failed branch — mis-route guard wiring (T5)', () => {
  const src = readFileSync(new URL('../lib/build.js', import.meta.url), 'utf-8');

  it('both outer loops guard on the marker BEFORE the single-agent retry machinery', () => {
    // runBuild: guard precedes buildRetryPrompt(response, ...)
    const runGuard = src.indexOf('if (isParallelRetriesExhausted(response))');
    const runRetry = src.indexOf('buildRetryPrompt(response, violations, context');
    assert.ok(runGuard !== -1, 'runBuild guard present');
    assert.ok(runRetry !== -1, 'runBuild single-agent retry present');
    assert.ok(runGuard < runRetry, 'runBuild guard must precede the single-agent retry');

    // executeChildFlow: guard precedes the fix-agent runAndNormalize(null, fixPrompt, ...)
    const cfGuard = src.indexOf('if (isParallelRetriesExhausted(resp))');
    const cfFix = src.indexOf('runAndNormalize(null, fixPrompt');
    assert.ok(cfGuard !== -1, 'child-flow guard present');
    assert.ok(cfFix !== -1, 'child-flow single-agent fix present');
    assert.ok(cfGuard < cfFix, 'child-flow guard must precede the single-agent fix');
  });
});
