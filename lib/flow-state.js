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
