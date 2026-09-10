/**
 * flow-state.js — small read-only helpers over persisted Stratum flow state.
 *
 * Reads the TS store (`STRATUM_STATE_ROOT/<flowId>.json` when configured,
 * otherwise `~/.stratum/ts/flows/<flowId>.json`).
 *
 * Shared by the gate handlers in build.js and new.js so the gate id can be made
 * round-aware (COMP-PLAN-GATE-LOOP).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Read Stratum's current round for a flow from its persisted state files.
 *
 * The TS running response does not carry the round, but the persisted flow
 * file does. Threading the round into the gate id
 * (`<flowId>:<stepId>:<round>`) makes each gate re-entry after a `revise` a
 * fresh, pending gate rather than colliding with the prior resolved gate and
 * replaying its stale outcome.
 *
 * Fresh TS runs have no `rounds` field and use round 0. A read failure must
 * never block a gate.
 *
 * @param {string} flowId
 * @returns {number}
 */
export function readFlowRound(flowId) {
  // TS store — STRATUM_STATE_ROOT-aware; flows are stored flat at the root.
  try {
    const tsRoot = process.env.STRATUM_STATE_ROOT || join(homedir(), '.stratum', 'ts', 'flows');
    const state = JSON.parse(readFileSync(join(tsRoot, `${flowId}.json`), 'utf-8'));
    const r = state?.rounds;
    return Number.isInteger(r) && r >= 0 ? r : 0;
  } catch { return 0; }
}

/** Strict persisted snapshot: callers must hold on unreadable or mismatched evidence. */
export function readFlowSnapshot(flowId, { revisionDigest, gateStepId, gateToken } = {}) {
  const refuse = message => { throw Object.assign(new Error(message), { code: 'WAVE_COST_UNVERIFIED' }); };
  if (typeof flowId !== 'string' || !/^[\w-]+$/.test(flowId)) refuse('Invalid flow identity');
  let state;
  try {
    const root = process.env.STRATUM_STATE_ROOT || join(homedir(), '.stratum', 'ts', 'flows');
    state = JSON.parse(readFileSync(join(root, `${flowId}.json`), 'utf8'));
  } catch (error) { refuse(`Cannot read persisted flow: ${error.message}`); }
  if (state?.id !== flowId || !revisionDigest || state.revisionDigest !== revisionDigest) refuse('Flow revision/identity differs');
  if (gateStepId && (state.steps?.[gateStepId]?.status !== 'waiting_gate'
    || state.steps[gateStepId].gateToken !== gateToken)) refuse('Persisted gate token differs');
  return state;
}

export function readFlowSpend(flowId, options, pending = []) {
  const snapshot = readFlowSnapshot(flowId, options);
  const fail = message => { throw Object.assign(new Error(message), { code: 'WAVE_COST_UNVERIFIED' }); };
  if (pending.some(p => p.state !== 'acknowledged')) fail('Unacknowledged usage receipts');
  if (!Array.isArray(snapshot.receipts)) fail('Missing receipt spine');
  const ids = new Set();
  let spent = 0;
  for (const receipt of snapshot.receipts) {
    if (!receipt.dispatchId || ids.has(receipt.dispatchId)) fail('Invalid/duplicate receipt identity');
    ids.add(receipt.dispatchId);
    const usd = receipt.amount?.usd;
    if (receipt.detail?.costUnknown) fail('Model call has no attributed cost');
    if (usd === undefined) {
      if (receipt.amount?.tokens > 0 || receipt.amount?.ms > 0) fail('Paid call cost missing');
      continue;
    }
    if (!Number.isFinite(usd) || usd < 0 || !['reported', 'estimated'].includes(receipt.usdSource)) fail('Unattributed USD');
    spent += usd;
  }
  for (const p of pending) if (!ids.has(p.dispatchId)) fail('Acknowledged receipt absent from snapshot');
  return { spent, input: snapshot.input };
}
