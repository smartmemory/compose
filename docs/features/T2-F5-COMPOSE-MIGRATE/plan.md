# T2-F5-COMPOSE-MIGRATE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Compose's `parallel_dispatch` steps through Stratum's server-side `stratum_parallel_start` + `stratum_parallel_poll` tools (for `isolation: "none"` paths only), gated behind `COMPOSE_SERVER_DISPATCH=1`.

**Architecture:** Add two thin MCP client methods (`parallelStart`, `parallelPoll`), a new executor function (`executeParallelDispatchServer`) with a non-module-scoped emitted-states map, and a one-line routing check at the top of the existing `executeParallelDispatch`. No Stratum-side changes. `isolation: "worktree"` paths remain on consumer-dispatch.

**Tech Stack:** Node.js 22 built-in test runner (`node --test`), ES modules.

**Design doc:** `compose/docs/features/T2-F5-COMPOSE-MIGRATE/design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `compose/lib/stratum-mcp-client.js` | Modify | Add `parallelStart()` and `parallelPoll()` methods beside existing `parallelDone()` |
| `compose/lib/build.js` | Modify | Add routing check + `executeParallelDispatchServer()` + `emitPerTaskProgress()` helper |
| `compose/test/parallel-dispatch-routing.test.js` | Create | Unit tests for the flag+isolation routing decision |
| `compose/test/parallel-dispatch-server.test.js` | Create | Unit tests for `executeParallelDispatchServer` with mock client |
| `compose/README.md` | Modify | Document `COMPOSE_SERVER_DISPATCH` + `COMPOSE_SERVER_DISPATCH_POLL_MS` env vars |
| `compose/CHANGELOG.md` | Modify | Changelog entry (same commit as code) |

---

## Task 1: Add `parallelStart` + `parallelPoll` to the MCP client — tests first

**Files:**
- Test: `compose/test/stratum-mcp-client-parallel.test.js` (new)

- [ ] **Step 1: Check existing client test pattern**

```bash
cd /Users/ruze/reg/my/forge/compose
ls test/ | grep -i "stratum.*client\|mcp.*client"
```

If `test/stratum-mcp-client.test.js` exists, follow its pattern for mocking `#client`. Otherwise, use the pattern below (directly construct a client with an injected mock).

- [ ] **Step 2: Write failing tests**

Create `compose/test/stratum-mcp-client-parallel.test.js`:

```js
// compose/test/stratum-mcp-client-parallel.test.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

function makeMockClient(responses) {
  const calls = [];
  return {
    calls,
    mock: {
      callTool: async ({ name, arguments: args }) => {
        calls.push({ name, args });
        const next = responses.shift();
        if (next && next.error) throw next.error;
        return { content: [{ type: 'text', text: JSON.stringify(next ?? {}) }] };
      },
    },
  };
}

describe('StratumMcpClient.parallelStart', () => {
  it('calls stratum_parallel_start with snake_case args and returns parsed JSON', async () => {
    const { calls, mock } = makeMockClient([{ status: 'started', flow_id: 'f1', step_id: 's1', task_count: 3, tasks: ['a','b','c'] }]);
    const client = new StratumMcpClient();
    // The StratumMcpClient uses #client internally. Inject via the same pattern other tests use,
    // or use test-only setter if one exists. If not, the simplest path is to instantiate, then
    // monkey-patch the private field via a test helper. See comment in existing client tests.
    // If no pattern exists, add a minimal one in Task 1 Step 3.
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });
    // (Implementation uses this._testClient if set; see Task 2 Step 1.)

    const result = await client.parallelStart('flow-xyz', 'step-abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_parallel_start');
    assert.deepEqual(calls[0].args, { flow_id: 'flow-xyz', step_id: 'step-abc' });
    assert.equal(result.status, 'started');
    assert.equal(result.task_count, 3);
  });
});

describe('StratumMcpClient.parallelPoll', () => {
  it('calls stratum_parallel_poll with snake_case args and returns parsed JSON', async () => {
    const { calls, mock } = makeMockClient([{
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
      tasks: {}, require_satisfied: true, can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    }]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const result = await client.parallelPoll('flow-xyz', 'step-abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_parallel_poll');
    assert.deepEqual(calls[0].args, { flow_id: 'flow-xyz', step_id: 'step-abc' });
    assert.equal(result.can_advance, true);
    assert.equal(result.outcome.status, 'execute_step');
  });
});
```

Run: `cd /Users/ruze/reg/my/forge/compose && node --test test/stratum-mcp-client-parallel.test.js`
Expected: FAIL — `parallelStart`/`parallelPoll` not defined, or test injection hook missing.

- [ ] **Step 3: Check `#callTool` to understand the injection hook**

```bash
sed -n '85,110p' /Users/ruze/reg/my/forge/compose/lib/stratum-mcp-client.js
```

Look for where `#callTool` references `this.#client.callTool`. If there's no test injection hook, add one inside `#callTool`:

```js
async #callTool(toolName, args) {
  const client = this._testClient ?? this.#client;   // ← add this line if not present
  if (!client) throw new Error('StratumMcpClient not connected');
  const result = await client.callTool({ name: toolName, arguments: args });
  // ... existing result parsing logic unchanged ...
}
```

Only add `this._testClient ?? this.#client` if no equivalent hook exists. If one does, use it in the tests instead.

- [ ] **Step 4: Commit the test-only injection hook (if added)**

```bash
cd /Users/ruze/reg/my/forge/compose
git add lib/stratum-mcp-client.js
git commit -m "test: allow test client injection via _testClient field"
```

If no hook was needed (an equivalent already exists), skip this commit.

---

## Task 2: Implement `parallelStart` and `parallelPoll`

**Files:**
- Modify: `compose/lib/stratum-mcp-client.js`

- [ ] **Step 1: Add methods beside `parallelDone`**

Open `compose/lib/stratum-mcp-client.js` and find `parallelDone` (around line 305). Immediately after the `parallelDone` method closing brace, but before the class closing brace, insert:

```js
  /**
   * Start server-side execution of a parallel_dispatch step (T2-F5-ENFORCE).
   * Returns {status: 'started', ...} on success, {error, message} on known error.
   * @param {string} flowId
   * @param {string} stepId
   * @returns {Promise<object>}
   */
  async parallelStart(flowId, stepId) {
    return this.#callTool('stratum_parallel_start', {
      flow_id: flowId,
      step_id: stepId,
    });
  }

  /**
   * Poll state of a server-dispatched parallel_dispatch step.
   * Returns an envelope with {summary, tasks, require_satisfied, can_advance, outcome}.
   * Break on `outcome != null`, not `can_advance` — see design doc §3.
   * @param {string} flowId
   * @param {string} stepId
   * @returns {Promise<object>}
   */
  async parallelPoll(flowId, stepId) {
    return this.#callTool('stratum_parallel_poll', {
      flow_id: flowId,
      step_id: stepId,
    });
  }
```

- [ ] **Step 2: Run the client tests**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/stratum-mcp-client-parallel.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Run full suite for regressions**

```bash
node --test test/*.test.js 2>&1 | tail -5
```

Expected: pass count unchanged from baseline (1371 after COMP-RT merge).

- [ ] **Step 4: Commit**

```bash
git add lib/stratum-mcp-client.js test/stratum-mcp-client-parallel.test.js
git commit -m "feat(t2-f5-compose-migrate): add parallelStart/parallelPoll MCP client methods"
```

---

## Task 3: Add `executeParallelDispatchServer` — write tests first

**Files:**
- Test: `compose/test/parallel-dispatch-server.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `compose/test/parallel-dispatch-server.test.js`:

```js
// compose/test/parallel-dispatch-server.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeParallelDispatchServer } from '../lib/build.js';

function makeStubStratum(startResult, pollResults) {
  const startCalls = [];
  const pollCalls = [];
  let pollIdx = 0;
  return {
    stratum: {
      parallelStart: async (flowId, stepId) => {
        startCalls.push({ flowId, stepId });
        return startResult;
      },
      parallelPoll: async (flowId, stepId) => {
        pollCalls.push({ flowId, stepId });
        const r = pollResults[pollIdx];
        pollIdx = Math.min(pollIdx + 1, pollResults.length - 1);
        return r;
      },
    },
    startCalls,
    pollCalls,
  };
}

function makeStreamWriter() {
  const events = [];
  return { events, write: (e) => events.push(e) };
}

const BASE_DISPATCH = {
  flow_id: 'f1', step_id: 's1',
  step_number: 2, total_steps: 5,
  tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  isolation: 'none',
};

describe('executeParallelDispatchServer — happy path', () => {
  it('returns outcome as the next dispatch when tasks complete', async () => {
    const running = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 3, running: 0, complete: 0, failed: 0, cancelled: 0 },
      tasks: {}, require_satisfied: false, can_advance: false, outcome: null,
    };
    const advancing = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
      tasks: {
        a: { task_id: 'a', state: 'complete' }, b: { task_id: 'b', state: 'complete' }, c: { task_id: 'c', state: 'complete' },
      },
      require_satisfied: true, can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    };
    const { stratum, startCalls } = makeStubStratum(
      { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 3, tasks: ['a','b','c'] },
      [running, advancing],
    );
    const sw = makeStreamWriter();
    // Use a very short poll interval in tests.
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';

    const response = await executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, sw);

    assert.equal(startCalls.length, 1);
    assert.deepEqual(startCalls[0], { flowId: 'f1', stepId: 's1' });
    assert.equal(response.status, 'execute_step');
    assert.equal(response.step_id, 'next');
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });
});

describe('executeParallelDispatchServer — failure path (the B3 fix)', () => {
  it('returns outcome even when can_advance stays false (all-failed under require:all)', async () => {
    const failed = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 0, failed: 3, cancelled: 0 },
      tasks: {
        a: { task_id: 'a', state: 'failed', error: 'boom' },
        b: { task_id: 'b', state: 'failed', error: 'boom' },
        c: { task_id: 'c', state: 'failed', error: 'boom' },
      },
      require_satisfied: false, can_advance: false,
      outcome: { status: 'ensure_failed', reason: 'require unsatisfied' },
    };
    const { stratum } = makeStubStratum(
      { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 3, tasks: ['a','b','c'] },
      [failed],
    );
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const response = await executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, makeStreamWriter());
    assert.equal(response.status, 'ensure_failed');
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });
});

describe('executeParallelDispatchServer — already_started recovery', () => {
  it('falls through to poll when _start returns already_started', async () => {
    const advancing = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
      tasks: {},
      require_satisfied: true, can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    };
    const { stratum, pollCalls } = makeStubStratum(
      { error: 'already_started', message: 'already running' },
      [advancing],
    );
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const response = await executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, makeStreamWriter());
    assert.equal(response.status, 'execute_step');
    assert.ok(pollCalls.length >= 1, 'poll must be called after already_started');
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });
});

describe('executeParallelDispatchServer — hard errors', () => {
  it('throws on wrong_step_type', async () => {
    const { stratum } = makeStubStratum({ error: 'wrong_step_type', message: 'not a parallel step' }, []);
    await assert.rejects(
      executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, null),
      /wrong_step_type/,
    );
  });

  it('throws on unexpected start envelope', async () => {
    const { stratum } = makeStubStratum({ status: 'weird' }, []);
    await assert.rejects(
      executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, null),
      /unexpected envelope/,
    );
  });

  it('throws on poll error', async () => {
    const { stratum } = makeStubStratum(
      { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 0, tasks: [] },
      [{ error: 'flow_not_found', message: 'gone' }],
    );
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    await assert.rejects(
      executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, null),
      /flow_not_found/,
    );
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });

  it('throws on already_advanced outcome (flow desync)', async () => {
    const { stratum } = makeStubStratum(
      { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 0, tasks: [] },
      [{
        flow_id: 'f1', step_id: 's1',
        summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
        tasks: {}, require_satisfied: true, can_advance: true,
        outcome: { status: 'already_advanced', aggregate: {} },
      }],
    );
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    await assert.rejects(
      executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, null),
      /already_advanced/,
    );
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });
});

describe('executeParallelDispatchServer — per-task progress streaming', () => {
  it('emits build_task_start/done once per task transition (no duplicates)', async () => {
    const polls = [
      { // all pending
        flow_id: 'f1', step_id: 's1',
        summary: { pending: 3, running: 0, complete: 0, failed: 0, cancelled: 0 },
        tasks: {
          a: { task_id: 'a', state: 'pending' }, b: { task_id: 'b', state: 'pending' }, c: { task_id: 'c', state: 'pending' },
        },
        require_satisfied: false, can_advance: false, outcome: null,
      },
      { // all running
        flow_id: 'f1', step_id: 's1',
        summary: { pending: 0, running: 3, complete: 0, failed: 0, cancelled: 0 },
        tasks: {
          a: { task_id: 'a', state: 'running' }, b: { task_id: 'b', state: 'running' }, c: { task_id: 'c', state: 'running' },
        },
        require_satisfied: false, can_advance: false, outcome: null,
      },
      { // poll-twice while still running (no new events)
        flow_id: 'f1', step_id: 's1',
        summary: { pending: 0, running: 3, complete: 0, failed: 0, cancelled: 0 },
        tasks: {
          a: { task_id: 'a', state: 'running' }, b: { task_id: 'b', state: 'running' }, c: { task_id: 'c', state: 'running' },
        },
        require_satisfied: false, can_advance: false, outcome: null,
      },
      { // all complete
        flow_id: 'f1', step_id: 's1',
        summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
        tasks: {
          a: { task_id: 'a', state: 'complete' }, b: { task_id: 'b', state: 'complete' }, c: { task_id: 'c', state: 'complete' },
        },
        require_satisfied: true, can_advance: true,
        outcome: { status: 'execute_step', step_id: 'next' },
      },
    ];
    const { stratum } = makeStubStratum(
      { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 3, tasks: ['a','b','c'] },
      polls,
    );
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const sw = makeStreamWriter();
    await executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, sw);

    const startEvents = sw.events.filter(e => e.subtype === 'build_task_start');
    const doneEvents = sw.events.filter(e => e.subtype === 'build_task_done');
    const stepStart = sw.events.filter(e => e.subtype === 'build_step_start');
    const stepDone = sw.events.filter(e => e.subtype === 'build_step_done');

    assert.equal(startEvents.length, 3, `expected 3 task start events, got ${startEvents.length}`);
    assert.equal(doneEvents.length, 3, `expected 3 task done events, got ${doneEvents.length}`);
    assert.equal(stepStart.length, 1);
    assert.equal(stepDone.length, 1);
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });
});
```

Run: `cd /Users/ruze/reg/my/forge/compose && node --test test/parallel-dispatch-server.test.js`
Expected: FAIL — `executeParallelDispatchServer` not exported.

---

## Task 4: Implement `executeParallelDispatchServer`

**Files:**
- Modify: `compose/lib/build.js`

- [ ] **Step 1: Locate the anchor**

```bash
grep -n "^async function executeParallelDispatch" /Users/ruze/reg/my/forge/compose/lib/build.js
```

You should see `executeParallelDispatch` at line ~2123. The new function goes **immediately before** it, so both are near each other for discoverability.

- [ ] **Step 2: Add the constants, helper, and new function**

Edit `compose/lib/build.js`. Immediately before the `async function executeParallelDispatch(` line, insert:

```js
// T2-F5-COMPOSE-MIGRATE — server-dispatch poll interval (env-overridable for tests).
const SERVER_DISPATCH_POLL_MS = () =>
  Number(process.env.COMPOSE_SERVER_DISPATCH_POLL_MS) || 500;

/**
 * Emit per-task state-transition events for a parallel_dispatch poll result.
 * Uses build_task_start/done subtypes (distinct from build_step_start/done)
 * to avoid stepId key collisions in downstream consumers.
 *
 * @param {object} streamWriter
 * @param {object} pollResult
 * @param {Map<string,string>} emittedStates — task_id → last emitted state
 */
function emitPerTaskProgress(streamWriter, pollResult, emittedStates) {
  if (!streamWriter) return;
  const stepId = pollResult.step_id;

  for (const [taskId, ts] of Object.entries(pollResult.tasks ?? {})) {
    const prev = emittedStates.get(taskId);
    if (prev === ts.state) continue;
    emittedStates.set(taskId, ts.state);

    if (ts.state === 'running') {
      streamWriter.write({
        type: 'system', subtype: 'build_task_start',
        stepId, taskId, parallel: true,
      });
    } else if (ts.state === 'complete' || ts.state === 'failed' || ts.state === 'cancelled') {
      streamWriter.write({
        type: 'system', subtype: 'build_task_done',
        stepId, taskId, parallel: true,
        status: ts.state,
        error: ts.error ?? null,
      });
    }
  }
}

/**
 * Server-dispatch execution path for parallel_dispatch steps. Called only
 * when COMPOSE_SERVER_DISPATCH=1 AND isolation='none'. Returns the next-step
 * dispatch envelope produced by stratum's auto-advance logic.
 *
 * @returns {Promise<object>} next dispatch envelope
 */
export async function executeParallelDispatchServer(
  dispatchResponse,
  stratum,
  context,
  progress,
  streamWriter,
) {
  const { flow_id: flowId, step_id: stepId,
          step_number: stepNum, total_steps: totalSteps,
          tasks } = dispatchResponse;
  const emittedStates = new Map();

  // 1. Step-level start event (mirrors existing consumer-dispatch envelope shape)
  if (streamWriter) {
    streamWriter.write({
      type: 'system', subtype: 'build_step_start',
      stepId, stepNum: `∥${stepNum}`, totalSteps,
      parallel: true, taskCount: tasks.length, flowId,
    });
  }

  // 2. Start server-side execution; tolerate already_started for crash-recovery
  const startResult = await stratum.parallelStart(flowId, stepId);
  if (startResult?.error) {
    if (startResult.error !== 'already_started') {
      throw new Error(
        `stratum_parallel_start failed: ${startResult.error}: ${startResult.message || ''}`,
      );
    }
    // fall through to poll
  } else if (startResult?.status !== 'started') {
    throw new Error(
      `stratum_parallel_start returned unexpected envelope: ${JSON.stringify(startResult)}`,
    );
  }

  // 3. Poll until outcome is present (NOT can_advance — see design doc §3).
  let pollResult;
  const intervalMs = SERVER_DISPATCH_POLL_MS();
  while (true) {
    pollResult = await stratum.parallelPoll(flowId, stepId);
    if (pollResult?.error) {
      throw new Error(
        `stratum_parallel_poll failed: ${pollResult.error}: ${pollResult.message || ''}`,
      );
    }
    emitPerTaskProgress(streamWriter, pollResult, emittedStates);
    if (pollResult.outcome != null) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // 4. Defensive: already_advanced means flow state desync
  if (pollResult.outcome.status === 'already_advanced') {
    throw new Error(
      `stratum_parallel_poll returned already_advanced for step ${stepId} — ` +
      `flow state desync. Aggregate: ${JSON.stringify(pollResult.outcome.aggregate)}`,
    );
  }

  // 5. Step-level done event
  if (streamWriter) {
    streamWriter.write({
      type: 'system', subtype: 'build_step_done',
      stepId, parallel: true,
      summary: pollResult.summary, flowId,
    });
  }

  return pollResult.outcome;
}
```

Note: `executeParallelDispatchServer` is **exported** (unlike the existing `executeParallelDispatch`) so tests can call it directly with a mock stratum client.

- [ ] **Step 3: Run the tests**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/parallel-dispatch-server.test.js
```

Expected: all 7 tests pass.

- [ ] **Step 4: Run full suite**

```bash
node --test test/*.test.js 2>&1 | tail -5
```

Expected: pass count = previous + 7.

- [ ] **Step 5: Commit**

```bash
git add lib/build.js test/parallel-dispatch-server.test.js
git commit -m "feat(t2-f5-compose-migrate): add executeParallelDispatchServer for server-dispatch"
```

---

## Task 5: Add routing decision — tests first

**Files:**
- Test: `compose/test/parallel-dispatch-routing.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `compose/test/parallel-dispatch-routing.test.js`:

```js
// compose/test/parallel-dispatch-routing.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseServerDispatch } from '../lib/build.js';

describe('shouldUseServerDispatch routing', () => {
  beforeEach(() => { delete process.env.COMPOSE_SERVER_DISPATCH; });
  afterEach(()  => { delete process.env.COMPOSE_SERVER_DISPATCH; });

  it('returns false when flag unset', () => {
    assert.equal(shouldUseServerDispatch({ isolation: 'none' }), false);
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree' }), false);
    assert.equal(shouldUseServerDispatch({}), false);
  });

  it('returns true for flag=1 + isolation=none', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'none' }), true);
  });

  it('returns false for flag=1 + isolation=worktree (fall-through)', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree' }), false);
  });

  it('returns false for flag=1 + isolation omitted (default worktree)', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({}), false);
  });

  it('returns false for flag=1 + isolation=branch (Stratum rejects it anyway)', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'branch' }), false);
  });

  it('returns false for flag value other than "1" (e.g., "0", "true")', () => {
    process.env.COMPOSE_SERVER_DISPATCH = 'true';
    assert.equal(shouldUseServerDispatch({ isolation: 'none' }), false);
    process.env.COMPOSE_SERVER_DISPATCH = '0';
    assert.equal(shouldUseServerDispatch({ isolation: 'none' }), false);
  });
});
```

Run: `cd /Users/ruze/reg/my/forge/compose && node --test test/parallel-dispatch-routing.test.js`
Expected: FAIL — `shouldUseServerDispatch` not exported.

---

## Task 6: Implement routing + wire into the main build loop

**Files:**
- Modify: `compose/lib/build.js`

- [ ] **Step 1: Add the `shouldUseServerDispatch` helper**

In `compose/lib/build.js`, immediately before the `SERVER_DISPATCH_POLL_MS` constant added in Task 4, add:

```js
/**
 * Decide whether to use server-side dispatch for a parallel_dispatch step.
 * Strict opt-in: requires both flag=1 AND isolation='none' (the only shape
 * Stratum v1 server-dispatch can handle safely). isolation='worktree' paths
 * remain on consumer-dispatch pending T2-F5-DIFF-EXPORT.
 *
 * @param {object} dispatchResponse
 * @returns {boolean}
 */
export function shouldUseServerDispatch(dispatchResponse) {
  return (
    process.env.COMPOSE_SERVER_DISPATCH === '1' &&
    (dispatchResponse?.isolation ?? 'worktree') === 'none'
  );
}
```

- [ ] **Step 2: Wire the routing check into the main build loop**

Find the main loop branch that calls `executeParallelDispatch` (around line 1334):

```bash
grep -n "executeParallelDispatch\b" /Users/ruze/reg/my/forge/compose/lib/build.js | head -5
```

The call site looks like:

```js
} else if (response.status === 'parallel_dispatch') {
  verifyPipelineIntegrity(specPath, specFileHash);
  response = await executeParallelDispatch(
    response, stratum, getConnector, context, progress, streamWriter, agentCwd,
  );
```

Replace the `response = await executeParallelDispatch(...)` call with a routing check:

```js
} else if (response.status === 'parallel_dispatch') {
  verifyPipelineIntegrity(specPath, specFileHash);
  if (shouldUseServerDispatch(response)) {
    response = await executeParallelDispatchServer(
      response, stratum, context, progress, streamWriter,
    );
  } else {
    response = await executeParallelDispatch(
      response, stratum, getConnector, context, progress, streamWriter, agentCwd,
    );
  }
```

Do not modify `executeParallelDispatch`'s body. Both paths remain callable.

- [ ] **Step 3: Run routing tests**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/parallel-dispatch-routing.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 4: Run full suite**

```bash
node --test test/*.test.js 2>&1 | tail -5
```

Expected: baseline + 7 (Task 4) + 6 (this task) = baseline + 13. No regressions.

- [ ] **Step 5: Commit**

```bash
git add lib/build.js test/parallel-dispatch-routing.test.js
git commit -m "feat(t2-f5-compose-migrate): route parallel_dispatch through server path when COMPOSE_SERVER_DISPATCH=1 (isolation:none only)"
```

---

## Task 7: Document the flag and update CHANGELOG + ROADMAP

**Files:**
- Modify: `compose/README.md`
- Modify: `compose/CHANGELOG.md`
- Modify: `compose/ROADMAP.md`

- [ ] **Step 1: Find an existing env-var section in README to mirror**

```bash
grep -n "^##\|^###\|COMPOSE_\|env var\|Environment" /Users/ruze/reg/my/forge/compose/README.md | head -20
```

If there's an "Environment Variables" section, add the two new flags there. If not, add a short subsection near the bottom of the README:

```markdown
### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `COMPOSE_SERVER_DISPATCH` | unset | Set to `1` to route `parallel_dispatch` steps with `isolation: "none"` (e.g., `parallel_review`) through Stratum's server-side executor. Code-writing steps (`isolation: "worktree"`) remain on consumer-dispatch. |
| `COMPOSE_SERVER_DISPATCH_POLL_MS` | `500` | Poll interval (ms) against `stratum_parallel_poll`. Lower = faster task-transition event propagation; higher = less MCP load. |
```

- [ ] **Step 2: Add a CHANGELOG entry**

Prepend to `compose/CHANGELOG.md` (under the most recent heading — inspect the existing style first):

```markdown
- T2-F5-COMPOSE-MIGRATE: server-side parallel dispatch for `isolation: "none"` steps behind `COMPOSE_SERVER_DISPATCH=1` flag. Code-writing paths (`isolation: "worktree"`) remain on consumer-dispatch pending T2-F5-DIFF-EXPORT. New client methods `parallelStart` / `parallelPoll` on `StratumMcpClient`.
```

Check the existing CHANGELOG structure with:
```bash
head -30 /Users/ruze/reg/my/forge/compose/CHANGELOG.md
```

Match its date/version format.

- [ ] **Step 3: Update ROADMAP**

```bash
grep -n "T2-F5-COMPOSE-MIGRATE" /Users/ruze/reg/my/forge/compose/ROADMAP.md
```

Change that row's status from `PLANNED` to `COMPLETE`, with a brief completion note matching the style of other completed items (see how T2-F5-ENFORCE is described).

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md ROADMAP.md
git commit -m "docs(t2-f5-compose-migrate): document COMPOSE_SERVER_DISPATCH flag + mark complete"
```

---

## Task 8: Full-suite integration check

- [ ] **Step 1: Run the full suite from a clean state**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/*.test.js 2>&1 | tail -8
```

Expected output format:
```
# tests <N>
# pass  <N>
# fail  0
```

Net new tests: approximately 15 (2 client + 7 server + 6 routing).

- [ ] **Step 2: Review the commit graph**

```bash
git log --oneline aabc992..HEAD
```

Expected: 4–5 commits (client methods + server function + routing + docs, optionally + test-hook).

- [ ] **Step 3: Manual smoke notes (not automated — do this after PR merge)**

Document in the feature folder (no commit needed):

```bash
cat > /Users/ruze/reg/my/forge/compose/docs/features/T2-F5-COMPOSE-MIGRATE/smoke-notes.md <<EOF
# Post-merge smoke test

Run a real feature build through \`compose build\` with a pipeline that includes
a \`parallel_review\` step (isolation: none). Compare two runs:

1. \`COMPOSE_SERVER_DISPATCH=1 compose build <feature>\`
2. \`compose build <feature>\`

Verify:
- Both builds produce the same review findings.
- Run (1) shows \`build_task_start\`/\`build_task_done\` events in the stream.
- Run (1) does not create a \`.compose/par/\` directory.
- No regressions in execute / other parallel_dispatch steps (which still use consumer-dispatch).
EOF
```

---

## Self-Review Checklist (already run — findings fixed)

- [x] Spec §1 routing decision → Task 5 + Task 6
- [x] Spec §2 executeParallelDispatchServer → Task 4
- [x] Spec §3 outcome shape translation + B3 loop-exit fix → Task 3 failure test + Task 4 implementation
- [x] Spec §4 per-task progress streaming with new subtypes → Task 3 streaming test + Task 4 helper
- [x] Spec §5 new client methods → Task 1 tests + Task 2 implementation
- [x] Spec §6 already_started recovery → Task 3 test + Task 4 code
- [x] Spec §6 error table (including flow_not_found, unknown_step) → Task 3 throw-on-poll-error test
- [x] Spec §8 testing: failure golden flow, hard errors, routing matrix, streaming → Tasks 3, 5
- [x] Spec sequencing step 6 (README + CHANGELOG same commit) → Task 7
