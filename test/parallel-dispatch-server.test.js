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
