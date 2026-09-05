import { test } from 'node:test';
import assert from 'node:assert/strict';

import { terminalOf } from '../lib/lifecycle-modes.js';
import { buildPhaseGraph, phaseToStatus, TERMINAL } from '../server/lifecycle-guard.js';

test('complete_backfilled is a terminal graph sink in every lifecycle mode', () => {
  for (const mode of ['build', 'fix', 'plan', 'judgment']) {
    assert.ok(terminalOf(mode).includes('complete_backfilled'), `${mode} declares the terminal`);
    const graph = buildPhaseGraph(mode);
    assert.deepEqual(graph.complete_backfilled, []);
    for (const [phase, targets] of Object.entries(graph)) {
      if (terminalOf(mode).includes(phase)) continue;
      assert.ok(targets.includes('complete_backfilled'), `${mode}:${phase} can backfill complete`);
      assert.ok(targets.indexOf('complete_backfilled') < targets.indexOf('killed'), `${mode}:${phase} orders backfill before killed`);
    }
  }
  assert.equal(phaseToStatus('complete_backfilled'), 'COMPLETE');
  assert.ok(TERMINAL.has('complete_backfilled'));
});
