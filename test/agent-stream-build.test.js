import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveStatus, mergeSourceStatus, CATEGORY_LABELS } from '../src/components/agent-stream-helpers.js';

describe('deriveStatus — build events', () => {
  it('returns working/thinking for build_step', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_step', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('returns working/thinking for build_step_done', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_step_done', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('returns working/waiting for build_gate', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_gate', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'waiting', _source: 'build' });
  });

  it('returns working/thinking for build_gate_resolved', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_gate_resolved', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('returns idle for build_end', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_end', _source: 'build' });
    assert.deepEqual(result, { status: 'idle', tool: null, category: null, _source: 'build' });
  });

  it('returns working/thinking for build_error', () => {
    const result = deriveStatus({ type: 'error', source: 'build', message: 'fail', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('returns working with tool for build tool_use events', () => {
    const result = deriveStatus({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] },
      _source: 'build',
    });
    assert.equal(result.status, 'working');
    assert.equal(result.tool, 'Read');
    assert.equal(result.category, 'reading');
    assert.equal(result._source, 'build');
  });

  it('returns working/thinking for build text events', () => {
    const result = deriveStatus({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
      _source: 'build',
    });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('never returns system/init for any build event type', () => {
    const buildEvents = [
      { type: 'system', subtype: 'build_start', _source: 'build' },
      { type: 'system', subtype: 'build_step', _source: 'build' },
      { type: 'system', subtype: 'build_step_done', _source: 'build' },
      { type: 'system', subtype: 'build_gate', _source: 'build' },
      { type: 'system', subtype: 'build_gate_resolved', _source: 'build' },
      { type: 'system', subtype: 'build_end', _source: 'build' },
      { type: 'error', source: 'build', message: 'x', _source: 'build' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] }, _source: 'build' },
    ];
    for (const evt of buildEvents) {
      const result = deriveStatus(evt);
      if (result) {
        // Must never produce a result that looks like system/init
        assert.notEqual(result.subtype, 'init', `Event ${evt.subtype} should not produce init`);
      }
    }
  });
});

describe('deriveStatus — interactive events', () => {
  it('returns working with tool for interactive tool_use', () => {
    const result = deriveStatus({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    });
    assert.equal(result.status, 'working');
    assert.equal(result.tool, 'Bash');
    assert.equal(result._source, undefined); // no build source
  });

  it('returns idle for result', () => {
    const result = deriveStatus({ type: 'result' });
    assert.deepEqual(result, { status: 'idle', tool: null, category: null });
  });
});

describe('mergeSourceStatus', () => {
  it('build idle does not clear interactive working', () => {
    const merged = mergeSourceStatus({
      build: { status: 'idle', tool: null, category: null },
      interactive: { status: 'working', tool: 'Read', category: 'reading' },
    });
    assert.equal(merged.status, 'working');
    assert.equal(merged.tool, 'Read');
  });

  it('interactive idle does not clear build working', () => {
    const merged = mergeSourceStatus({
      build: { status: 'working', tool: null, category: 'thinking' },
      interactive: { status: 'idle', tool: null, category: null },
    });
    assert.equal(merged.status, 'working');
  });

  it('both idle produces idle', () => {
    const merged = mergeSourceStatus({
      build: { status: 'idle', tool: null, category: null },
      interactive: { status: 'idle', tool: null, category: null },
    });
    assert.equal(merged.status, 'idle');
  });

  it('both null produces idle', () => {
    const merged = mergeSourceStatus({ build: null, interactive: null });
    assert.equal(merged.status, 'idle');
  });

  it('reconnect reset — build null, interactive working = working', () => {
    const merged = mergeSourceStatus({
      build: null,
      interactive: { status: 'working', tool: 'Edit', category: 'writing' },
    });
    assert.equal(merged.status, 'working');
  });

  it('reconnect reset — both null = idle', () => {
    const merged = mergeSourceStatus({ build: null, interactive: null });
    assert.equal(merged.status, 'idle');
  });

  it('concurrent build + interactive — build events do not disrupt interactive working', () => {
    // Interactive is working, build changes to working too — interactive still takes priority
    const merged = mergeSourceStatus({
      build: { status: 'working', tool: null, category: 'thinking' },
      interactive: { status: 'working', tool: 'Bash', category: 'executing' },
    });
    assert.equal(merged.status, 'working');
    assert.equal(merged.tool, 'Bash'); // interactive takes priority
    assert.equal(merged.category, 'executing');
  });
});

describe('CATEGORY_LABELS', () => {
  it('includes waiting label', () => {
    assert.equal(CATEGORY_LABELS.waiting, 'Waiting for gate approval');
  });
});

// ---------------------------------------------------------------------------
// COMP-AGENT-LANES (S03a) — per-worker lane reducer
// ---------------------------------------------------------------------------

import {
  applyLaneEvent,
  deriveParallelSummary,
  laneKey,
  compareLaneVersion,
  MAX_LANE_MESSAGES,
} from '../src/components/agent-stream-lanes.js';

function mkLane(over = {}) {
  return {
    flowId: 'f1', stepId: 'execute_tasks/0', itemIndex: 0,
    generation: 1, attempt: 1, label: 'Run task 0', agent: 'claude',
    ...over,
  };
}

function startMsg(lane) {
  return {
    type: 'system', subtype: 'build_step', parallel: true,
    stepNum: `∥${lane.itemIndex}`, stepId: lane.stepId, flowId: lane.flowId,
    lane, _source: 'build',
  };
}

function textMsg(lane, text) {
  return {
    type: 'assistant', message: { content: [{ type: 'text', text }] },
    lane, _source: 'build',
  };
}

function doneMsg(lane, status, outcome = status) {
  return {
    type: 'system', subtype: 'build_step_done', parallel: true,
    stepId: lane.stepId, flowId: lane.flowId, summary: 's',
    ...(status ? { status, outcome } : {}),
    lane, _source: 'build',
  };
}

describe('lane reducer — identity and creation', () => {
  it('creates a lane from a ∥ start event, keyed flowId:stepId:itemIndex', () => {
    const lanes = new Map();
    applyLaneEvent(lanes, startMsg(mkLane()));
    assert.equal(lanes.size, 1);
    const entry = lanes.get('f1:execute_tasks/0:0');
    assert.ok(entry, 'entry keyed by flowId:stepId:itemIndex');
    assert.equal(entry.status, 'working');
    assert.equal(entry.joinedMidBuild, false);
    assert.equal(entry.lane.label, 'Run task 0');
  });

  it('scopes lanes per run: same stepId different flowId → different lanes', () => {
    const lanes = new Map();
    applyLaneEvent(lanes, startMsg(mkLane({ flowId: 'f1' })));
    applyLaneEvent(lanes, startMsg(mkLane({ flowId: 'f2' })));
    assert.equal(lanes.size, 2);
  });

  it('marks a lane joinedMidBuild when output arrives before any start', () => {
    const lanes = new Map();
    applyLaneEvent(lanes, textMsg(mkLane(), 'hello'));
    const entry = [...lanes.values()][0];
    assert.equal(entry.joinedMidBuild, true);
    assert.equal(entry.status, 'working');
  });

  it('ignores messages without a lane', () => {
    const lanes = new Map();
    const changed = applyLaneEvent(lanes, { type: 'assistant', message: { content: [] } });
    assert.equal(changed, false);
    assert.equal(lanes.size, 0);
  });
});

describe('lane reducer — output routing', () => {
  it('routes each worker\'s output only to its own lane', () => {
    const lanes = new Map();
    const laneA = mkLane({ itemIndex: 0, label: 'worker A' });
    const laneB = mkLane({ itemIndex: 1, label: 'worker B' });
    applyLaneEvent(lanes, startMsg(laneA));
    applyLaneEvent(lanes, startMsg(laneB));
    applyLaneEvent(lanes, textMsg(laneA, 'from A'));
    applyLaneEvent(lanes, textMsg(laneB, 'from B'));
    const a = lanes.get(laneKey(laneA));
    const b = lanes.get(laneKey(laneB));
    assert.equal(a.messages.length, 1);
    assert.equal(b.messages.length, 1);
    assert.equal(a.messages[0].message.content[0].text, 'from A');
    assert.equal(b.messages[0].message.content[0].text, 'from B');
  });

  it('caps the per-lane message buffer', () => {
    const lanes = new Map();
    const lane = mkLane();
    applyLaneEvent(lanes, startMsg(lane));
    for (let i = 0; i < MAX_LANE_MESSAGES + 50; i++) {
      applyLaneEvent(lanes, textMsg(lane, `m${i}`));
    }
    const entry = lanes.get(laneKey(lane));
    assert.equal(entry.messages.length, MAX_LANE_MESSAGES);
    const last = entry.messages[entry.messages.length - 1];
    assert.equal(last.message.content[0].text, `m${MAX_LANE_MESSAGES + 49}`, 'cap drops oldest, keeps newest');
  });
});

describe('lane reducer — terminal rule', () => {
  it('closes a lane only on done-with-explicit-status: failed done → failed', () => {
    const lanes = new Map();
    const lane = mkLane();
    applyLaneEvent(lanes, startMsg(lane));
    applyLaneEvent(lanes, doneMsg(lane, 'failed'));
    assert.equal(lanes.get(laneKey(lane)).status, 'failed');
  });

  it('succeeded done → succeeded', () => {
    const lanes = new Map();
    const lane = mkLane();
    applyLaneEvent(lanes, startMsg(lane));
    applyLaneEvent(lanes, doneMsg(lane, 'succeeded'));
    assert.equal(lanes.get(laneKey(lane)).status, 'succeeded');
  });

  it('a done WITHOUT explicit status does not close the lane', () => {
    const lanes = new Map();
    const lane = mkLane();
    applyLaneEvent(lanes, startMsg(lane));
    applyLaneEvent(lanes, doneMsg(lane, null));
    assert.equal(lanes.get(laneKey(lane)).status, 'working', 'no status → lane stays open');
  });

  it('an advisory error appends a diagnostic without closing the lane', () => {
    const lanes = new Map();
    const lane = mkLane();
    applyLaneEvent(lanes, startMsg(lane));
    applyLaneEvent(lanes, { type: 'error', message: 'advisory oops', lane, _source: 'build' });
    const entry = lanes.get(laneKey(lane));
    assert.equal(entry.status, 'working', 'advisory error must not close the lane');
    assert.ok(
      entry.messages.some((m) => m.type === 'error' && m.message === 'advisory oops'),
      'advisory error renders as in-lane diagnostic',
    );
  });

  it('an error explicitly marked lane-terminal closes the lane as failed', () => {
    const lanes = new Map();
    const lane = mkLane();
    applyLaneEvent(lanes, startMsg(lane));
    applyLaneEvent(lanes, { type: 'error', message: 'fatal', laneTerminal: true, lane, _source: 'build' });
    assert.equal(lanes.get(laneKey(lane)).status, 'failed');
  });
});

describe('lane reducer — version rule (generation, attempt)', () => {
  it('compareLaneVersion orders by generation then attempt', () => {
    assert.ok(compareLaneVersion([1, 1], [1, 2]) < 0);
    assert.ok(compareLaneVersion([2, 1], [1, 9]) > 0);
    assert.equal(compareLaneVersion([1, 2], [1, 2]), 0);
  });

  it('a retry (higher attempt) resets the lane: fresh messages, working status', () => {
    const lanes = new Map();
    const v1 = mkLane({ attempt: 1 });
    applyLaneEvent(lanes, startMsg(v1));
    applyLaneEvent(lanes, textMsg(v1, 'old output'));
    applyLaneEvent(lanes, doneMsg(v1, 'failed'));
    const v2 = mkLane({ attempt: 2 });
    applyLaneEvent(lanes, startMsg(v2));
    const entry = lanes.get(laneKey(v2));
    assert.equal(lanes.size, 1, 'same identity — one lane');
    assert.equal(entry.status, 'working', 'retry reopens the lane');
    assert.equal(entry.messages.length, 0, 'retry clears prior output');
    assert.deepEqual(entry.version, [1, 2]);
  });

  it('a stale terminal event from a superseded attempt cannot close the new attempt', () => {
    const lanes = new Map();
    const v2 = mkLane({ attempt: 2 });
    applyLaneEvent(lanes, startMsg(v2));
    const changed = applyLaneEvent(lanes, doneMsg(mkLane({ attempt: 1 }), 'failed'));
    assert.equal(changed, false, 'stale event rejected');
    assert.equal(lanes.get(laneKey(v2)).status, 'working');
  });

  it('a higher generation supersedes regardless of attempt', () => {
    const lanes = new Map();
    applyLaneEvent(lanes, startMsg(mkLane({ generation: 1, attempt: 3 })));
    applyLaneEvent(lanes, textMsg(mkLane({ generation: 1, attempt: 3 }), 'gen1'));
    applyLaneEvent(lanes, startMsg(mkLane({ generation: 2, attempt: 1 })));
    const entry = [...lanes.values()][0];
    assert.deepEqual(entry.version, [2, 1]);
    assert.equal(entry.messages.length, 0);
  });
});

describe('lane reducer — legacy summary parity', () => {
  it('derives the legacy parallelTasks shape from lanes', () => {
    const lanes = new Map();
    const a = mkLane({ itemIndex: 0, stepId: 's/0' });
    const b = mkLane({ itemIndex: 1, stepId: 's/1' });
    const c = mkLane({ itemIndex: 2, stepId: 's/2' });
    applyLaneEvent(lanes, startMsg(a));
    applyLaneEvent(lanes, startMsg(b));
    applyLaneEvent(lanes, startMsg(c));
    applyLaneEvent(lanes, doneMsg(a, 'succeeded'));
    applyLaneEvent(lanes, doneMsg(b, 'failed'));
    const summary = deriveParallelSummary(lanes);
    assert.equal(summary.total, 3);
    assert.equal(summary.completed, 1);
    assert.equal(summary.failed, 1, 'a failed worker counts failed, not complete (the :211-215 bug)');
    assert.equal(summary.active, 1);
    assert.equal(summary.tasks['s/0'], 'complete');
    assert.equal(summary.tasks['s/1'], 'failed');
    assert.equal(summary.tasks['s/2'], 'working');
  });

  it('returns null for an empty lane map (counter hidden)', () => {
    assert.equal(deriveParallelSummary(new Map()), null);
  });
});
