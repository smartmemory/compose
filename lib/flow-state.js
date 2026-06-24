/**
 * flow-state.js — small read-only helpers over the persisted Stratum flow state
 * (`~/.stratum/flows/<flowId>.json`).
 *
 * Shared by the gate handlers in build.js and new.js so the gate id can be made
 * round-aware (COMP-PLAN-GATE-LOOP).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Read Stratum's current round for a flow from its persisted state file.
 *
 * The await_gate dispatch Stratum returns does not carry the round, but the
 * persisted flow file does. Threading the round into the gate id
 * (`<flowId>:<stepId>:<round>`) makes each gate re-entry after a `revise` a
 * fresh, pending gate rather than colliding with the prior resolved gate and
 * replaying its stale outcome.
 *
 * Fail-open: returns 1 (the legacy default) if the file is missing, unreadable,
 * or lacks an integer round — a read failure must never block a gate.
 *
 * @param {string} flowId
 * @returns {number}
 */
export function readFlowRound(flowId) {
  try {
    const flowFile = join(homedir(), '.stratum', 'flows', `${flowId}.json`);
    const state = JSON.parse(readFileSync(flowFile, 'utf-8'));
    const r = state?.round;
    return Number.isInteger(r) && r >= 0 ? r : 1;
  } catch {
    return 1;
  }
}
