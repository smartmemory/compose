/**
 * gate-round-reentry.test.js — COMP-PLAN-GATE-LOOP regression coverage.
 *
 * Reproduces the plan-gate infinite loop: resolving a gate with `revise` routes
 * back through earlier steps and re-enters the same gate. Before the fix Compose
 * always passed round 1, so re-entry collided with the prior resolved gate id
 * (`<flowId>:<stepId>:1`) and replayed its stale `revise` outcome — explore →
 * gate → explore forever. The fix threads Stratum's current round (read from the
 * persisted flow file) into the gate id so each re-entry is a fresh, pending gate.
 *
 * All tests run in direct mode (no server) by using a port that is not in use.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VisionWriter } from '../lib/vision-writer.js';
import { readFlowRound } from '../lib/flow-state.js';
import { assertGateReentryWithinCap, MAX_GATE_REENTRIES } from '../lib/build.js';

describe('readFlowRound', () => {
  const flowsDir = path.join(os.homedir(), '.stratum', 'flows');
  const written = [];

  function writeFlow(contents) {
    fs.mkdirSync(flowsDir, { recursive: true });
    const flowId = `comp-test-${randomUUID()}`;
    const file = path.join(flowsDir, `${flowId}.json`);
    fs.writeFileSync(file, contents);
    written.push(file);
    return flowId;
  }

  after(() => {
    for (const f of written) fs.rmSync(f, { force: true });
  });

  it('reads the top-level round from the persisted flow file', () => {
    const flowId = writeFlow(JSON.stringify({ flow_id: 'x', round: 7, rounds: [] }));
    assert.equal(readFlowRound(flowId), 7);
  });

  it('treats round 0 (initial round) as valid', () => {
    const flowId = writeFlow(JSON.stringify({ round: 0 }));
    assert.equal(readFlowRound(flowId), 0);
  });

  it('fails open to 1 when the flow file is missing', () => {
    assert.equal(readFlowRound(`comp-test-missing-${randomUUID()}`), 1);
  });

  it('fails open to 1 when the flow file is corrupt', () => {
    const flowId = writeFlow('not valid json {{{');
    assert.equal(readFlowRound(flowId), 1);
  });

  it('fails open to 1 when round is absent or non-integer', () => {
    assert.equal(readFlowRound(writeFlow(JSON.stringify({}))), 1);
    assert.equal(readFlowRound(writeFlow(JSON.stringify({ round: 'five' }))), 1);
  });
});

describe('assertGateReentryWithinCap', () => {
  it('does not throw at or under the cap', () => {
    assert.doesNotThrow(() => assertGateReentryWithinCap(1, 'plan_design_gate'));
    assert.doesNotThrow(() => assertGateReentryWithinCap(MAX_GATE_REENTRIES, 'plan_design_gate'));
  });

  it('throws once the cap is exceeded, naming the step and the recovery path', () => {
    assert.throws(
      () => assertGateReentryWithinCap(MAX_GATE_REENTRIES + 1, 'plan_design_gate'),
      (err) => {
        assert.match(err.message, /plan_design_gate/);
        assert.match(err.message, /--resume/);
        return true;
      },
    );
  });

  it('honors a custom cap', () => {
    assert.doesNotThrow(() => assertGateReentryWithinCap(3, 'g', 3));
    assert.throws(() => assertGateReentryWithinCap(4, 'g', 3));
  });
});

describe('round-aware gate id breaks the revise replay loop', () => {
  let tmpDir;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-round-')); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('a revise re-entry at a new round mints a fresh pending gate instead of replaying the resolved one', async () => {
    const writer = new VisionWriter(tmpDir, { port: 19990 }); // unused port → direct mode

    // Round 1: create the gate and resolve it `revise` (what kicks off the loop).
    const g1 = await writer.createGate('flow-loop', 'plan_design_gate', 'item-x', { round: 1 });
    await writer.resolveGate(g1, 'revise');
    assert.ok(g1.endsWith(':plan_design_gate:1'));

    // BUG control: re-entering at the SAME round returns the prior gate id, which
    // is already resolved — exactly the stale-outcome replay that looped forever.
    const stale = await writer.createGate('flow-loop', 'plan_design_gate', 'item-x', { round: 1 });
    assert.equal(stale, g1);
    assert.equal((await writer.getGate(g1)).status, 'resolved');

    // FIX: re-entering at the next round mints a distinct, pending gate that
    // blocks for a fresh decision rather than replaying `revise`.
    const g2 = await writer.createGate('flow-loop', 'plan_design_gate', 'item-x', { round: 2 });
    assert.notEqual(g2, g1);
    assert.ok(g2.endsWith(':plan_design_gate:2'));
    assert.equal((await writer.getGate(g2)).status, 'pending');
  });
});
