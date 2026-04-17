# T2-F5-COMPOSE-MIGRATE-WORKTREE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Compose's server-dispatch routing to cover `isolation: "worktree"` parallel_dispatch steps by consuming `ts.diff` from `stratum_parallel_poll` and running the existing topological merge client-side. Gated by the existing `COMPOSE_SERVER_DISPATCH=1` flag plus `capture_diff: true` on the step.

**Architecture:** Extract the 90-line merge block (`build.js:2443-2535`) into a shared helper `applyTaskDiffsToBaseCwd`, reuse it from both consumer-dispatch (unchanged callers) and a new `applyServerDispatchDiffs` wrapper called from `executeParallelDispatchServer`. Extend `shouldUseServerDispatch` to accept worktree+capture_diff. On client-side merge conflict after server auto-advance: emit `build_error`, throw to abort the CLI build.

**Tech Stack:** Node.js 22 built-in test runner, `execSync` git subprocesses, `fs.mkdtempSync` for ephemeral patch dirs.

**Design doc:** `compose/docs/features/T2-F5-COMPOSE-MIGRATE-WORKTREE/design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `compose/lib/build.js` | Modify | Extract `applyTaskDiffsToBaseCwd` helper; extend `shouldUseServerDispatch`; extend `executeParallelDispatchServer`; wire both dispatch paths through the helper |
| `compose/test/parallel-dispatch-routing.test.js` | Modify | Add worktree+capture_diff routing cases |
| `compose/test/parallel-dispatch-server-worktree.test.js` | Create | Integration tests for the worktree server-dispatch path using real temp git repos |
| `compose/README.md` | Modify | Update `COMPOSE_SERVER_DISPATCH` description |
| `compose/CHANGELOG.md` | Modify | Entry |
| `compose/ROADMAP.md` | Modify | Mark complete in T2-F5-COMPOSE-MIGRATE section |
| `/Users/ruze/reg/my/forge/ROADMAP.md` | Modify | Outer Forge roadmap entry |

---

## Task 1: Extract `applyTaskDiffsToBaseCwd` helper (refactor, no behavior change)

**Files:**
- Modify: `compose/lib/build.js`

- [ ] **Step 1: Establish baseline test count**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

Record the numbers. Expected: ~1387 pass / 0 fail from the T2-F5-COMPOSE-MIGRATE ship. Refactor must preserve.

- [ ] **Step 2: Add the helper function**

In `compose/lib/build.js`, immediately before `async function executeParallelDispatch(` (around line 2272 after all the new COMP-RT/T2-F5 additions), insert:

```js
/**
 * Apply per-task unified diffs to a base working tree in topological order.
 * Shared between consumer-dispatch (existing executeParallelDispatch) and
 * server-dispatch (new executeParallelDispatchServer via applyServerDispatchDiffs).
 *
 * @param {object[]} tasks — ordered task definitions (must carry `id`, `depends_on`)
 * @param {Map<string,string>} diffMap — taskId → unified diff text
 * @param {string} baseCwd — target repo root
 * @param {object} streamWriter — stream for build events (nullable)
 * @param {string} stepId — parent step id (for event attribution)
 * @param {string} patchDir — directory to write temporary .patch files
 * @returns {{
 *   mergeStatus: 'clean' | 'conflict',
 *   appliedFiles: string[],
 *   conflictedTaskId: string | null,
 *   conflictError: string | null,
 * }}
 */
function applyTaskDiffsToBaseCwd(tasks, diffMap, baseCwd, streamWriter, stepId, patchDir) {
  if (diffMap.size === 0) {
    return { mergeStatus: 'clean', appliedFiles: [], conflictedTaskId: null, conflictError: null };
  }

  // Topological sort on depends_on edges (DFS with visited/visiting sets)
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const topoOrder = [];
  const visited = new Set();
  const visiting = new Set();
  const topoVisit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const t = taskMap.get(id);
    if (t) {
      for (const dep of (t.depends_on ?? [])) topoVisit(dep);
    }
    visiting.delete(id);
    visited.add(id);
    topoOrder.push(id);
  };
  for (const t of tasks) topoVisit(t.id);

  // Stash pre-existing dirty state in baseCwd (restore after)
  let stashCreated = false;
  try {
    const stashOut = execSync('git stash push -u -m "parallel-merge-snapshot"', {
      cwd: baseCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
    }).trim();
    stashCreated = !stashOut.includes('No local changes');
  } catch { /* no changes to stash — clean tree is fine */ }

  let mergeStatus = 'clean';
  let conflictedTaskId = null;
  let conflictError = null;
  const appliedFiles = new Set();

  for (const taskId of topoOrder) {
    const diff = diffMap.get(taskId);
    if (!diff) continue;

    const diffPath = join(patchDir, `${taskId}.patch`);
    try {
      writeFileSync(diffPath, diff, 'utf-8');
      execSync(`git apply --check "${diffPath}"`, {
        cwd: baseCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
      });
      execSync(`git apply "${diffPath}"`, {
        cwd: baseCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
      });

      try {
        const applied = execSync('git diff --name-only HEAD', {
          cwd: baseCwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
        }).trim();
        if (applied) {
          for (const f of applied.split('\n').filter(Boolean)) appliedFiles.add(f);
        }
      } catch { /* ignore */ }
    } catch (err) {
      mergeStatus = 'conflict';
      conflictedTaskId = taskId;
      conflictError = err.message;
      if (streamWriter) {
        streamWriter.write({
          type: 'build_error',
          message: `merge conflict applying ${taskId}: ${err.message}`,
          stepId,
        });
      }

      // Best-effort rollback
      try {
        execSync('git checkout -- .', {
          cwd: baseCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
        });
        execSync('git clean -fd', {
          cwd: baseCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
        });
      } catch { /* best-effort */ }

      break;
    } finally {
      try { unlinkSync(diffPath); } catch { /* ignore */ }
    }
  }

  // Restore stashed state
  if (stashCreated) {
    try {
      execSync('git stash pop', {
        cwd: baseCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
      });
    } catch { /* stash may have been consumed or conflict with patches */ }
  }

  return {
    mergeStatus,
    appliedFiles: [...appliedFiles],
    conflictedTaskId,
    conflictError,
  };
}
```

- [ ] **Step 3: Replace the inline merge block in `executeParallelDispatch`**

Find the inline merge block (around `build.js:2443-2535` — starting with `let mergeStatus = 'clean';` and ending near the `mergeStatus === 'conflict'` handling before `stratum.parallelDone` is called). Replace the topo-sort + stash + apply-loop + stash-restore logic with a call to the helper.

The existing surrounding code that updates `taskResults` with conflict info and calls `stratum.parallelDone` stays. Pattern:

```js
let mergeStatus = 'clean';
if (worktreeIsolation && taskDiffs.size > 0) {
  const result = applyTaskDiffsToBaseCwd(
    tasks, taskDiffs, baseCwd, streamWriter, dispStepId, parDir,
  );
  mergeStatus = result.mergeStatus;

  // Merge applied files into context (existing behavior)
  if (mergeStatus !== 'conflict' && result.appliedFiles.length > 0) {
    const existing = new Set(context.filesChanged ?? []);
    for (const f of result.appliedFiles) existing.add(f);
    context.filesChanged = [...existing];
  }

  // Mark conflicted task as failed in taskResults (existing behavior)
  if (mergeStatus === 'conflict' && result.conflictedTaskId) {
    const idx = taskResults.findIndex(r => r.task_id === result.conflictedTaskId);
    if (idx >= 0) {
      taskResults[idx].status = 'failed';
      taskResults[idx].error = `merge conflict: ${result.conflictError}`;
    }
  }
}
```

Keep the existing `streamWriter.write({ type: 'build_step_done', ... summary: ... })` that follows. Only the internal ~90 lines of merge mechanics are replaced.

- [ ] **Step 4: Run full test suite — expect no regressions**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

Expected: identical pass count to Step 1. If any consumer-dispatch test breaks, the extraction is behaviorally divergent — fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add lib/build.js
git commit -m "refactor(build): extract applyTaskDiffsToBaseCwd from executeParallelDispatch"
```

---

## Task 2: Extend `shouldUseServerDispatch` for worktree+capture_diff

**Files:**
- Modify: `compose/lib/build.js`
- Modify: `compose/test/parallel-dispatch-routing.test.js`

- [ ] **Step 1: Add failing tests**

Append to `test/parallel-dispatch-routing.test.js`:

```js
describe('shouldUseServerDispatch — worktree + capture_diff', () => {
  beforeEach(() => { delete process.env.COMPOSE_SERVER_DISPATCH; });
  afterEach(()  => { delete process.env.COMPOSE_SERVER_DISPATCH; });

  it('returns true for flag=1 + isolation=worktree + capture_diff=true', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree', capture_diff: true }), true);
  });

  it('returns false for flag=1 + isolation=worktree + capture_diff=false', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree', capture_diff: false }), false);
  });

  it('returns false for flag=1 + isolation=worktree + capture_diff absent', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree' }), false);
  });

  it('returns false for flag=1 + isolation=worktree + capture_diff="true" (string, strict bool check)', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree', capture_diff: 'true' }), false);
  });

  it('returns false for flag=0 + isolation=worktree + capture_diff=true (flag gate wins)', () => {
    // flag unset — existing tests already cover this, confirming it stays off for worktree too
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree', capture_diff: true }), false);
  });

  it('still returns true for flag=1 + isolation=none + capture_diff=true (v1 unchanged)', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'none', capture_diff: true }), true);
  });
});
```

Run: `node --test test/parallel-dispatch-routing.test.js` — expect 1st, 6th to fail (others pass through existing logic).

- [ ] **Step 2: Extend the routing helper**

In `compose/lib/build.js`, update `shouldUseServerDispatch`:

```js
export function shouldUseServerDispatch(dispatchResponse) {
  if (process.env.COMPOSE_SERVER_DISPATCH !== '1') return false;
  const isolation = dispatchResponse?.isolation ?? 'worktree';
  if (isolation === 'none') return true;
  if (isolation === 'worktree' && dispatchResponse?.capture_diff === true) return true;
  return false;
}
```

Strict `=== true` makes "true" (string) reject per spec.

- [ ] **Step 3: Run routing tests — expect all pass**

```bash
node --test test/parallel-dispatch-routing.test.js
```

- [ ] **Step 4: Full suite**

```bash
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

Expected: baseline + 6 new.

- [ ] **Step 5: Commit**

```bash
git add lib/build.js test/parallel-dispatch-routing.test.js
git commit -m "feat(t2-f5-migrate-worktree): route worktree+capture_diff through server-dispatch"
```

---

## Task 3: Wire diff consumption + merge into `executeParallelDispatchServer`

**Files:**
- Modify: `compose/lib/build.js`

- [ ] **Step 1: Add `applyServerDispatchDiffs` wrapper**

In `compose/lib/build.js`, immediately after `applyTaskDiffsToBaseCwd` (added in Task 1), add:

```js
import { mkdtempSync, rmSync } from 'node:fs';  // add to existing top-of-file fs import
import { tmpdir } from 'node:os';                 // add to existing os import

/**
 * Server-dispatch helper: read task diffs from the poll envelope, apply them
 * topologically to baseCwd, and on conflict throw so the CLI halts.
 * Called from executeParallelDispatchServer when isolation:worktree + capture_diff.
 */
async function applyServerDispatchDiffs(
  taskList, pollTasks, baseCwd, streamWriter, stepId, context,
) {
  const diffMap = new Map();
  for (const [taskId, ts] of Object.entries(pollTasks ?? {})) {
    if (ts?.state !== 'complete') continue;
    if (ts?.diff_error) {
      if (streamWriter) {
        streamWriter.write({
          type: 'build_error', stepId,
          message: `Task ${taskId} completed but diff capture failed: ${ts.diff_error}. Its changes were NOT applied.`,
        });
      }
      continue;
    }
    if (ts?.diff != null) diffMap.set(taskId, ts.diff);
  }

  if (diffMap.size === 0) return;

  // Fresh temp dir per invocation so concurrent builds don't collide
  const patchDir = mkdtempSync(join(tmpdir(), 'compose-server-patch-'));
  try {
    const { mergeStatus, conflictedTaskId, conflictError, appliedFiles } =
      applyTaskDiffsToBaseCwd(taskList, diffMap, baseCwd, streamWriter, stepId, patchDir);

    if (mergeStatus === 'conflict') {
      if (streamWriter) {
        streamWriter.write({
          type: 'build_error', stepId,
          message:
            `CLIENT-SIDE MERGE CONFLICT applying diff for task ${conflictedTaskId}: ${conflictError}. ` +
            `The flow has already advanced server-side (merge_status reported as "clean"). ` +
            `Working tree may contain partial merge state. Run 'stratum resume' after resolving.`,
        });
      }
      throw new Error(
        `parallel_dispatch[${stepId}]: client-side merge conflict on task ${conflictedTaskId}`,
      );
    }

    if (appliedFiles.length > 0) {
      const set = new Set(context.filesChanged ?? []);
      for (const f of appliedFiles) set.add(f);
      context.filesChanged = [...set];
    }
  } finally {
    try { rmSync(patchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
```

- [ ] **Step 2: Call it from `executeParallelDispatchServer`**

In `executeParallelDispatchServer`, after the `already_advanced` throw and before the `build_step_done` event, add:

```js
// T2-F5-COMPOSE-MIGRATE-WORKTREE: apply diffs locally when isolation:worktree
const isolation = dispatchResponse.isolation ?? 'worktree';
if (isolation === 'worktree' && dispatchResponse.capture_diff === true) {
  await applyServerDispatchDiffs(
    dispatchResponse.tasks ?? [],
    pollResult.tasks,
    context?.baseCwd ?? process.cwd(),
    streamWriter,
    stepId,
    context ?? {},
  );
}

// existing: build_step_done event, return outcome
```

Note: `context.baseCwd` may not always be set — the existing consumer path uses an `agentCwd` variable passed from the main build loop. Verify how it's wired in the main loop call site (around `build.js:1334`) and either:
- Thread `agentCwd` into `executeParallelDispatchServer` as a parameter (matches consumer-dispatch), OR
- Read it off `context` consistently.

Inspect:
```bash
grep -n "agentCwd\|context.baseCwd\|context\.cwd" /Users/ruze/reg/my/forge/compose/lib/build.js | head -10
```

Pick whichever matches the existing pattern. If consumer-dispatch uses `agentCwd` as a parameter, thread it identically into server-dispatch and update both the routing call site and `executeParallelDispatchServer`'s signature.

- [ ] **Step 3: Run full suite — expect no regressions**

```bash
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

No new tests yet — those come in Task 4. Just confirm nothing broke.

- [ ] **Step 4: Commit**

```bash
git add lib/build.js
git commit -m "feat(t2-f5-migrate-worktree): consume ts.diff from poll + apply via shared helper"
```

---

## Task 4: Integration tests for worktree server-dispatch

**Files:**
- Create: `compose/test/parallel-dispatch-server-worktree.test.js`

- [ ] **Step 1: Write the tests**

Create `compose/test/parallel-dispatch-server-worktree.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

function unifiedDiff(repo, editFn) {
  // Capture a diff by editing, staging, diffing, then reverting.
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
    const context = { baseCwd: repo, filesChanged: [] };

    try {
      const resp = await executeParallelDispatchServer(
        dispatch, makeStubStratum({ status: 'started' }, [poll]),
        context, null, streamWriter,
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
    const context = { baseCwd: repo, filesChanged: [] };

    try {
      await assert.rejects(
        executeParallelDispatchServer(
          dispatch, makeStubStratum({ status: 'started' }, [poll]),
          context, null, streamWriter,
        ),
        /client-side merge conflict/,
      );
      // Build error emitted
      assert.ok(streamWriter.events.some(
        e => e.type === 'build_error' && /CLIENT-SIDE MERGE CONFLICT/.test(e.message),
      ));
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
    const context = { baseCwd: repo, filesChanged: [] };

    try {
      const resp = await executeParallelDispatchServer(
        dispatch, makeStubStratum({ status: 'started' }, [poll]),
        context, null, streamWriter,
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
    const context = { baseCwd: repo, filesChanged: [] };

    try {
      const resp = await executeParallelDispatchServer(
        dispatch, makeStubStratum({ status: 'started' }, [poll]),
        context, null, sw(),
      );
      assert.equal(resp.status, 'ensure_failed');
      // Only ta's diff was applied
      assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A\nA2\n');
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the new test file**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/parallel-dispatch-server-worktree.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 3: Full suite**

```bash
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

Expected: baseline + 4 new.

- [ ] **Step 4: Commit**

```bash
git add test/parallel-dispatch-server-worktree.test.js
git commit -m "test(t2-f5-migrate-worktree): integration tests for worktree server-dispatch + merge"
```

---

## Task 5: Docs

**Files:**
- Modify: `compose/README.md`
- Modify: `compose/CHANGELOG.md`
- Modify: `compose/ROADMAP.md`
- Modify: `/Users/ruze/reg/my/forge/ROADMAP.md`

- [ ] **Step 1: Update README env var description**

Find the `COMPOSE_SERVER_DISPATCH` row (added by T2-F5-COMPOSE-MIGRATE). Replace its description with:

```
Set to `1` to route `parallel_dispatch` steps through Stratum's server-side executor. Covers `isolation: "none"` unconditionally, and `isolation: "worktree"` steps that declare `capture_diff: true` (Compose consumes diffs from poll response and merges them client-side). Other worktree steps remain on consumer-dispatch.
```

- [ ] **Step 2: CHANGELOG entry**

Prepend under `## [Unreleased]` (or the compose project's equivalent) matching the existing entry format:

```
- T2-F5-COMPOSE-MIGRATE-WORKTREE: server-dispatch now covers `isolation: "worktree"` parallel_dispatch steps that opt in via `capture_diff: true`. New `applyServerDispatchDiffs` wrapper + shared `applyTaskDiffsToBaseCwd` helper extracted from `executeParallelDispatch`; both dispatch paths merge through the same code. Client-side merge conflicts emit `build_error` and throw to halt the CLI (flow state stays advanced server-side; manual resume). Known trade-off documented: merge_status gap until T2-F5-CONSUMER-MERGE-STATUS lands Stratum-side defer-advance.
```

- [ ] **Step 3: Mark ROADMAP complete**

In `compose/ROADMAP.md`, find the T2-F5-COMPOSE-MIGRATE section (added in the previous feature). Either add a new row or update the header to indicate both isolation modes are now covered:

```
## T2-F5-COMPOSE-MIGRATE: Server-Side Dispatch — COMPLETE (both isolation modes)
```

Add a new item row or update existing descriptions to note the worktree path shipped.

- [ ] **Step 4: Outer Forge ROADMAP**

Add a row in `/Users/ruze/reg/my/forge/ROADMAP.md` below the existing T2-F5-COMPOSE-MIGRATE line:

```
| ~~T2-F5-COMPOSE-MIGRATE-WORKTREE~~ | **COMPLETE** — Extended server-dispatch routing to `isolation: "worktree"` parallel_dispatch steps that declare `capture_diff: true`. Compose reads `ts.diff` from poll response, applies via shared topological-merge helper (extracted from `executeParallelDispatch`). Client-side merge conflicts throw to halt the CLI; flow state stays advanced (known trade-off until T2-F5-CONSUMER-MERGE-STATUS). 10 new tests. | M | COMPLETE |
```

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md ROADMAP.md
git commit -m "docs(t2-f5-migrate-worktree): env var + changelog + roadmap"
```

The outer Forge ROADMAP is outside any git repo — no commit.

---

## Task 6: Integration review + smoke notes

- [ ] **Step 1: Final full-suite run**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

Expected: baseline_from_task1 + 10 new (6 routing + 4 server-worktree).

- [ ] **Step 2: Claude-based final integration review**

Dispatch `superpowers:code-reviewer` with the cumulative diff since the design commit. Focus the prompt on:
- Does the extracted helper preserve every event and error-handling path from the original inline block?
- Is the `agentCwd` / `context.baseCwd` threading correct in both dispatch paths?
- Does the conflict-throws-halts-build interaction actually halt the main build loop cleanly, or does the throw get swallowed somewhere?
- Any interaction with COMP-RT's `CoalescingBuffer` — does emitting `build_error` during a flush cycle cause reordering?

Address any blockers; ship WARNs as follow-ups.

- [ ] **Step 3: Write smoke notes**

```bash
cat > /Users/ruze/reg/my/forge/compose/docs/features/T2-F5-COMPOSE-MIGRATE-WORKTREE/smoke-notes.md <<'EOF'
# Post-merge smoke test

Run a real `compose build` against a feature whose pipeline has an `execute`
step with `isolation: worktree` + `capture_diff: true`. Compare three runs:

1. `compose build <feature>` (default — consumer-dispatch)
2. `COMPOSE_SERVER_DISPATCH=1 compose build <feature>` (server-dispatch + worktree)
3. Force a merge conflict (two tasks editing the same line): assert the build
   halts with "client-side merge conflict" and the repo is left in a resolvable state.

Verify:
- Same final code output for runs 1 and 2.
- No `.compose/par/` directory created in run 2.
- `build_task_start`/`build_task_done` events stream per-task in run 2.
- Run 3 halts cleanly; `stratum resume` after manual resolution re-enters at the next step.
EOF
```

Not committed — notes file for the implementer/next agent.

---

## Self-Review Checklist

- [x] Design §1 routing extension → Task 2
- [x] Design §3 extract shared helper → Task 1
- [x] Design §4 applyServerDispatchDiffs wrapper + conflict throw → Task 3
- [x] Design §4b already_advanced interaction → existing throw, no new code
- [x] Design §6 routing tests extended → Task 2
- [x] Design §6 integration tests (happy, conflict, diff_error, failed-task) → Task 4
- [x] Design §8 docs → Task 5
- [x] No Stratum-side changes → design §5, no stratum tasks
