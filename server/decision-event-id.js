import { v5 as uuidv5 } from 'uuid';

const ROOT_NAMESPACE = '3a7c1b12-9c10-4d02-ae9e-5f0e8bf3b2e1';

export function branchDecisionEventId(featureCode, branchId) {
  const featureNs = uuidv5(String(featureCode), ROOT_NAMESPACE);
  return uuidv5(`branch:${branchId}`, featureNs);
}

export function shouldEmit(eventId, emittedSet) {
  if (!emittedSet) return true;
  if (emittedSet instanceof Set) return !emittedSet.has(eventId);
  if (Array.isArray(emittedSet)) return !emittedSet.includes(eventId);
  return true;
}

/**
 * Deterministic id for a phase_transition DecisionEvent.
 * Unique per (featureCode, fromPhase, toPhase, timestamp).
 */
export function phaseTransitionDecisionEventId(featureCode, fromPhase, toPhase, timestamp) {
  const featureNs = uuidv5(String(featureCode), ROOT_NAMESPACE);
  const from = fromPhase == null ? 'null' : String(fromPhase);
  return uuidv5(`phase_transition:${from}:${toPhase}:${timestamp}`, featureNs);
}

/**
 * Deterministic id for an iteration DecisionEvent.
 * stage ∈ 'start' | 'complete'
 */
export function iterationDecisionEventId(featureCode, loopId, stage) {
  const featureNs = uuidv5(String(featureCode), ROOT_NAMESPACE);
  return uuidv5(`iteration:${loopId}:${stage}`, featureNs);
}

/**
 * Deterministic id for a gate DecisionEvent (kind='gate').
 * Unique per (featureCode, gateLogEntryId).
 * Once entry.id is fixed, the event id is fixed — enabling reconciliation.
 *
 * @param {string} featureCode
 * @param {string} gateLogEntryId — UUID v4 of the GateLogEntry
 * @returns {string} UUID v5
 */
export function gateDecisionEventId(featureCode, gateLogEntryId) {
  const featureNs = uuidv5(String(featureCode), ROOT_NAMESPACE);
  return uuidv5(`gate:${gateLogEntryId}`, featureNs);
}
