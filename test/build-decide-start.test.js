import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideBuildStart } from '../lib/build.js';

const flowId = 'flow-1';

const activeStates = [
  {
    name: 'none',
    active: null,
    pidAlive: false,
    flowTerminal: true,
    sameMode: true,
    expected: { none: 'fresh', resume: 'error', fresh: 'fresh' },
  },
  {
    name: 'terminal flow',
    active: { featureCode: 'FEAT-1', flowId, status: 'complete', mode: 'feature' },
    pidAlive: false,
    flowTerminal: true,
    sameMode: true,
    expected: { none: 'fresh', resume: 'error', fresh: 'fresh' },
  },
  {
    name: 'failed same mode with non-terminal flow',
    active: { featureCode: 'FEAT-1', flowId, status: 'failed', mode: 'feature' },
    pidAlive: false,
    flowTerminal: false,
    sameMode: true,
    expected: { none: 'resume', resume: 'resume', fresh: 'fresh' },
  },
  {
    name: 'running dead pid same mode',
    active: { featureCode: 'FEAT-1', flowId, status: 'running', mode: 'feature', pid: 999999 },
    pidAlive: false,
    flowTerminal: false,
    sameMode: true,
    expected: { none: 'resume', resume: 'resume', fresh: 'fresh' },
  },
  {
    name: 'running live foreign pid',
    active: { featureCode: 'FEAT-1', flowId, status: 'running', mode: 'feature', pid: 12345 },
    pidAlive: true,
    flowTerminal: false,
    sameMode: true,
    expected: { none: 'refuse', resume: 'refuse', fresh: 'refuse' },
  },
  {
    name: 'mode mismatch',
    active: { featureCode: 'FEAT-1', flowId, status: 'running', mode: 'bug' },
    pidAlive: false,
    flowTerminal: false,
    sameMode: false,
    expected: { none: 'fresh', resume: 'error', fresh: 'fresh' },
  },
];

const flagModes = [
  { name: 'none', opts: {} },
  { name: 'resume', opts: { resume: true, resumeFlowId: flowId } },
  { name: 'fresh', opts: { fresh: true } },
];

for (const state of activeStates) {
  for (const flag of flagModes) {
    test(`decideBuildStart: ${state.name} + ${flag.name}`, () => {
      const verdict = decideBuildStart({
        active: state.active,
        opts: flag.opts,
        pidAlive: state.pidAlive,
        flowTerminal: state.flowTerminal,
        sameMode: state.sameMode,
      });
      assert.equal(verdict.action, state.expected[flag.name]);
      assert.equal(typeof verdict.reason, 'string');
      assert.ok(verdict.reason.length > 0);
      if (verdict.action === 'resume') {
        assert.equal(verdict.flowId, flowId);
      }
    });
  }
}
