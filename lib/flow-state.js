/**
 * flow-state.js — small read-only helpers over persisted Stratum flow state.
 *
 * Reads the TS store (`STRATUM_STATE_ROOT/<flowId>.json` when configured,
 * otherwise `~/.stratum/ts/flows/<flowId>.json`).
 *
 * Shared by the gate handlers in build.js and new.js so the gate id can be made
 * round-aware (COMP-PLAN-GATE-LOOP).
 */
import { readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { canonicalRoutingJson, routingDigest, routingRefuse } from './model-router.js';

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

/** Routing state is execution evidence: no cost error codes or permissive epoch fallback. */
export function validateRoutingSnapshot(snapshot, { revisionDigest, rootDigest, planIntentId, workspaceRoot } = {}) {
  const refuse = message => routingRefuse('ROUTING_STATE_UNVERIFIED', message);
  const input = snapshot?.input;
  if (!snapshot || typeof snapshot.id !== 'string' || !/^[\w-]+$/.test(snapshot.id)
    || typeof snapshot.revisionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.revisionDigest)
    || !snapshot.spec || !snapshot.steps || Array.isArray(snapshot.steps)) refuse('Missing routing run identity/spec/steps');
  if (revisionDigest && snapshot.revisionDigest !== revisionDigest) refuse('Recorded revision differs');
  if (routingDigest(snapshot.spec) !== snapshot.revisionDigest) refuse('Persisted effective spec digest differs');
  if (!input || input.route_mode !== 'shadow' || typeof input.routing_start !== 'string'
    || typeof input.routing_root !== 'string' || typeof input.routing_plan_intent !== 'string') refuse('Missing recorded routing transport');
  let start;
  try { start = JSON.parse(input.routing_start); } catch { refuse('Malformed routing start transport'); }
  if (!start || typeof start !== 'object' || Array.isArray(start)) refuse('Routing start must be an object');
  const { rootDigest: recordedDigest, ...payload } = start;
  if (canonicalRoutingJson(start) !== input.routing_start || routingDigest(payload) !== recordedDigest || recordedDigest !== input.routing_root
    || (rootDigest && rootDigest !== recordedDigest) || (planIntentId && input.routing_plan_intent !== planIntentId)) refuse('Recorded routing input identity differs');
  if (typeof snapshot.workspaceRoot !== 'string' || realpathSync(snapshot.workspaceRoot) !== start.workspaceRoot) refuse('Missing or mismatched workspace identity');
  if (workspaceRoot && realpathSync(workspaceRoot) !== realpathSync(snapshot.workspaceRoot)) refuse('Recorded workspace differs');
  return snapshot;
}
export function readRoutingSnapshot(runId, options = {}) {
  try {
    if (typeof runId !== 'string' || !/^[\w-]+$/.test(runId)) throw Error('Invalid run id');
    const stateRoot = options.stateRoot ?? process.env.STRATUM_STATE_ROOT ?? join(homedir(), '.stratum/ts/flows');
    const path = join(stateRoot, `${runId}.json`);
    if (lstatSync(path).isSymbolicLink()) throw Error('Symlink flow state refused');
    const snapshot = JSON.parse(readFileSync(path, 'utf8'));
    if (snapshot.id !== runId) throw Error('Recorded run id differs');
    return validateRoutingSnapshot(snapshot, options);
  } catch (error) { routingRefuse('ROUTING_STATE_UNVERIFIED', error.message); }
}
export function findRoutingPlanRuns({ stateRoot = process.env.STRATUM_STATE_ROOT ?? join(homedir(), '.stratum/ts/flows'), workspaceRoot, planIntentId, rootDigest }) {
  try {
    if (!planIntentId || !rootDigest || !workspaceRoot) throw Error('Plan scan requires complete identity');
    const matches = [];
    for (const file of readdirSync(stateRoot).filter(name => name.endsWith('.json'))) {
      const path = join(stateRoot, file);
      if (lstatSync(path).isSymbolicLink()) throw Error('Unverifiable flow file');
      // An unreadable file might be the lost acknowledgement: uniqueness cannot be certified.
      const snapshot = JSON.parse(readFileSync(path, 'utf8'));
      if (snapshot.input?.routing_plan_intent !== planIntentId) continue;
      if (`${snapshot.id}.json` !== file) throw Error('Flow filename/identity mismatch');
      matches.push(validateRoutingSnapshot(snapshot, { workspaceRoot, planIntentId, rootDigest }));
    }
    return matches;
  } catch (error) { routingRefuse('ROUTING_STATE_UNVERIFIED', error.message); }
}
export function routingStepEpoch(snapshot, scopedStep) {
  if (!Object.hasOwn(snapshot.steps ?? {}, scopedStep)) routingRefuse('ROUTING_STATE_UNVERIFIED', 'Cannot infer epoch without an existing step');
  const step = snapshot.steps[scopedStep];
  if (!step || typeof step.status !== 'string') routingRefuse('ROUTING_STATE_UNVERIFIED', 'Unverified step state');
  const epoch = step.epoch === undefined ? 0 : step.epoch;
  if (!Number.isInteger(epoch) || epoch < 0) routingRefuse('ROUTING_STATE_UNVERIFIED', 'Invalid engine epoch');
  return epoch;
}
