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
    startCalls, pollCalls,
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
        a: { task_id: 'a', state: 'complete' },
        b: { task_id: 'b', state: 'complete' },
        c: { task_id: 'c', state: 'complete' },
      },
      require_satisfied: true, can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    };
    const { stratum, startCalls } = makeStubStratum(
      { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 3, tasks: ['a','b','c'] },
      [running, advancing],
    );
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const response = await executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, makeStreamWriter());
    assert.equal(startCalls.length, 1);
    assert.deepEqual(startCalls[0], { flowId: 'f1', stepId: 's1' });
    assert.equal(response.status, 'execute_step');
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
      tasks: {}, require_satisfied: true, can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    };
    const { stratum, pollCalls } = makeStubStratum(
      { error: 'already_started', message: 'already running' },
      [advancing],
    );
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const response = await executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, makeStreamWriter());
    assert.equal(response.status, 'execute_step');
    assert.ok(pollCalls.length >= 1);
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

// ===========================================================================
// COMP-GSD-5 Task 3: optional stuck detector wiring.
// Build mode passes NO detector → these paths never run (byte-identical).
// The gsd path passes a detector → record events + cancel on a stuck verdict.
// ===========================================================================

// A stub that, in addition to start/poll, drives an onEvent subscription
// (firing queued events between poll rounds) and records parallelAdvance.
function makeStubStratumWithEvents({ startResult, pollResults, eventsByPoll = [] }) {
  const startCalls = [];
  const pollCalls = [];
  const advanceCalls = [];
  let pollIdx = 0;
  let handler = null;
  return {
    stratum: {
      parallelStart: async (flowId, stepId) => {
        startCalls.push({ flowId, stepId });
        return startResult;
      },
      onEvent: (flowId, stepId, fn) => {
        handler = fn;
        return () => { handler = null; };
      },
      parallelPoll: async (flowId, stepId) => {
        // Fire any events scheduled to arrive BEFORE this poll round resolves
        // (simulates push events landing between polls).
        for (const ev of (eventsByPoll[pollIdx] ?? [])) {
          if (handler) handler(ev);
        }
        pollCalls.push({ flowId, stepId });
        const r = pollResults[pollIdx];
        pollIdx = Math.min(pollIdx + 1, pollResults.length - 1);
        return r;
      },
      parallelAdvance: async (flowId, stepId, mergeStatus) => {
        advanceCalls.push({ flowId, stepId, mergeStatus });
        return { status: 'ensure_failed', reason: 'cancelled_stuck', step_id: stepId };
      },
    },
    startCalls, pollCalls, advanceCalls,
  };
}

// Minimal 0.2.7 envelope factory for detector-facing events.
let _seq = 0;
function ev(kind, taskId, metadata) {
  return {
    schema_version: '0.2.7', flow_id: 'f1', step_id: 's1',
    seq: _seq++, ts: new Date().toISOString(), kind, task_id: taskId, metadata,
  };
}
function editEvent(taskId, filePath) {
  return ev('tool_use_summary', taskId, {
    tool: 'Edit', summary: 'edit', ok: true, duration_ms: 1,
    input: { file_path: filePath }, tool_use_id: `tu-${_seq}`,
  });
}

describe('executeParallelDispatchServer — stuck detector (COMP-GSD-5)', () => {
  it('with NO detector, behavior is unchanged (happy path returns outcome)', async () => {
    const running = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 3, running: 0, complete: 0, failed: 0, cancelled: 0 },
      tasks: {}, require_satisfied: false, can_advance: false, outcome: null,
    };
    const advancing = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
      tasks: { a: { task_id: 'a', state: 'complete' } },
      require_satisfied: true, can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    };
    const { stratum, advanceCalls } = makeStubStratumWithEvents({
      startResult: { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 3, tasks: ['a','b','c'] },
      pollResults: [running, advancing],
    });
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    // 6-arg call (no opts) — exactly how build mode invokes it.
    const response = await executeParallelDispatchServer(BASE_DISPATCH, stratum, {}, null, makeStreamWriter());
    assert.equal(response.status, 'execute_step');
    assert.equal(response.stuck, undefined, 'no detector → no stuck field on outcome');
    assert.equal(advanceCalls.length, 0, 'no detector → never cancels');
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });

  it('a stuck verdict cancels via parallelAdvance(conflict) and returns a stuck outcome', async () => {
    const { GsdStuckDetector } = await import('../lib/gsd-stuck.js');
    const detector = new GsdStuckDetector({ sameFileEdits: 3 });

    // Task `a` is running across several polls; on the 2nd/3rd poll it has
    // edited the same file 3×. Outcome stays null so the loop keeps polling
    // until the detector forces a cancel.
    const runningPoll = (n) => ({
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 1, complete: 0, failed: 0, cancelled: 0 },
      tasks: { a: { task_id: 'a', state: 'running' } },
      require_satisfied: false, can_advance: false, outcome: null,
      _n: n,
    });

    const { stratum, advanceCalls, pollCalls } = makeStubStratumWithEvents({
      startResult: { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 1, tasks: ['a'] },
      pollResults: [runningPoll(0), runningPoll(1), runningPoll(2), runningPoll(3)],
      // Three same-file edits arrive across the first three poll rounds.
      eventsByPoll: [
        [editEvent('a', 'lib/foo.js')],
        [editEvent('a', 'lib/foo.js')],
        [editEvent('a', 'lib/foo.js')],
      ],
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const sw = makeStreamWriter();
    // 7-arg call (gsd path) — opts.stuckDetector supplied.
    const response = await executeParallelDispatchServer(
      BASE_DISPATCH, stratum, {}, null, sw, undefined, { stuckDetector: detector },
    );

    assert.equal(advanceCalls.length, 1, 'should cancel exactly once');
    assert.deepEqual(advanceCalls[0], { flowId: 'f1', stepId: 's1', mergeStatus: 'conflict' });
    assert.ok(response.stuck, 'outcome carries a stuck verdict');
    assert.equal(response.stuck.signal, 'same_file');
    assert.equal(response.stuck.taskId, 'a', 'verdict identifies the stuck task');
    assert.ok(pollCalls.length <= 4, 'loop broke promptly on the stuck verdict');
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });

  it('records events keyed by event.task_id (a stuck task does not implicate a sibling)', async () => {
    const { GsdStuckDetector } = await import('../lib/gsd-stuck.js');
    const detector = new GsdStuckDetector({ sameFileEdits: 3 });
    const runningPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 2, complete: 0, failed: 0, cancelled: 0 },
      tasks: { a: { task_id: 'a', state: 'running' }, b: { task_id: 'b', state: 'running' } },
      require_satisfied: false, can_advance: false, outcome: null,
    };
    const { stratum, advanceCalls } = makeStubStratumWithEvents({
      startResult: { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 2, tasks: ['a','b'] },
      pollResults: [runningPoll, runningPoll, runningPoll, runningPoll],
      // a edits foo 3×; b only edits once → only a should trip.
      eventsByPoll: [
        [editEvent('a', 'lib/foo.js'), editEvent('b', 'lib/bar.js')],
        [editEvent('a', 'lib/foo.js')],
        [editEvent('a', 'lib/foo.js')],
      ],
    });
    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const response = await executeParallelDispatchServer(
      BASE_DISPATCH, stratum, {}, null, makeStreamWriter(), undefined, { stuckDetector: detector },
    );
    assert.equal(advanceCalls.length, 1);
    assert.equal(response.stuck.taskId, 'a', 'only task a is stuck (events were keyed by task_id)');
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });
});

describe('executeParallelDispatchServer — per-task progress streaming', () => {
  it('emits build_task_start/done once per transition (no duplicates)', async () => {
    const polls = [
      { flow_id: 'f1', step_id: 's1',
        summary: { pending: 3, running: 0, complete: 0, failed: 0, cancelled: 0 },
        tasks: { a: { task_id:'a',state:'pending' }, b: { task_id:'b',state:'pending' }, c: { task_id:'c',state:'pending' } },
        require_satisfied: false, can_advance: false, outcome: null },
      { flow_id: 'f1', step_id: 's1',
        summary: { pending: 0, running: 3, complete: 0, failed: 0, cancelled: 0 },
        tasks: { a: { task_id:'a',state:'running' }, b: { task_id:'b',state:'running' }, c: { task_id:'c',state:'running' } },
        require_satisfied: false, can_advance: false, outcome: null },
      { flow_id: 'f1', step_id: 's1',
        summary: { pending: 0, running: 3, complete: 0, failed: 0, cancelled: 0 },
        tasks: { a: { task_id:'a',state:'running' }, b: { task_id:'b',state:'running' }, c: { task_id:'c',state:'running' } },
        require_satisfied: false, can_advance: false, outcome: null },
      { flow_id: 'f1', step_id: 's1',
        summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
        tasks: { a: { task_id:'a',state:'complete' }, b: { task_id:'b',state:'complete' }, c: { task_id:'c',state:'complete' } },
        require_satisfied: true, can_advance: true,
        outcome: { status: 'execute_step', step_id: 'next' } },
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
    const stepStart = sw.events.filter(e => e.type === 'build_step_start');
    const stepDone = sw.events.filter(e => e.type === 'build_step_done');
    assert.equal(startEvents.length, 3);
    assert.equal(doneEvents.length, 3);
    assert.equal(stepStart.length, 1);
    assert.equal(stepDone.length, 1);
    delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
  });
});
