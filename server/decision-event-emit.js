/**
 * decision-event-emit.js — Shared emit helper for COMP-OBS-TIMELINE.
 *
 * Central choke point for all DecisionEvent broadcasts. Builders produce
 * contract-clean event shapes; emitDecisionEvent wraps them in the canonical
 * envelope matching BRANCH's existing pattern (cc-session-watcher.js:151-166):
 *   { type: 'decisionEvent', event: { id, feature_code, timestamp, kind, title, metadata, roles } }
 *
 * Outcome mapping for iteration.metadata.outcome:
 *   server outcome     → schema enum
 *   'clean'            → 'pass'
 *   'max_reached'      → 'fail'
 *   'aborted'          → 'fail'
 *   'timeout'          → 'fail'
 *   'action_limit'     → 'fail'
 *   'retry' / null     → 'retry'
 */

import {
  phaseTransitionDecisionEventId,
  iterationDecisionEventId,
  gateDecisionEventId,
} from './decision-event-id.js';
import { mapResolveOutcomeToSchema } from './gate-log-store.js';

// Map server-side iteration outcome strings to the schema enum {pass|fail|retry}
function mapIterationOutcome(outcome) {
  if (!outcome || outcome === 'retry') return 'retry';
  if (outcome === 'clean' || outcome === 'pass') return 'pass';
  // max_reached | aborted | timeout | action_limit → fail
  return 'fail';
}

/**
 * Emit a DecisionEvent over broadcastMessage using the canonical envelope.
 * The envelope matches BRANCH's _buildForkEvent / broadcastMessage pattern.
 */
export function emitDecisionEvent(broadcastMessage, event) {
  broadcastMessage({ type: 'decisionEvent', event });
}

/**
 * Build a kind=phase_transition DecisionEvent.
 *
 * @param {{ featureCode, from, to, outcome, agent_id, timestamp }} params
 *   - from: previous phase string, or null for the initial lifecycle start
 *   - to: new phase string
 *   - outcome: optional outcome string (for context)
 *   - agent_id: optional operator/agent identifier
 */
export function buildPhaseTransitionEvent({ featureCode, from, to, outcome, agent_id, timestamp }) {
  const now = timestamp || new Date().toISOString();
  const fromStr = from == null ? 'null' : String(from);
  const id = phaseTransitionDecisionEventId(featureCode, from, to, now);
  return {
    id,
    feature_code: featureCode,
    timestamp: now,
    kind: 'phase_transition',
    title: from == null
      ? `Lifecycle started: ${to}`
      : `Phase: ${from} → ${to}${outcome === 'skipped' ? ' (skipped)' : outcome === 'killed' ? ' (killed)' : ''}`,
    metadata: {
      from_phase: fromStr,
      to_phase: String(to),
    },
    roles: [{ name: 'PRODUCER', agent_id: agent_id || null }],
  };
}

/**
 * Build a kind=iteration DecisionEvent.
 * Only called at loop start and loop complete — NOT per-attempt.
 *
 * @param {{ featureCode, loopId, loopType, stage, attempt, outcome, timestamp }} params
 *   - stage: 'start' | 'complete'
 *   - loopType: 'review' | 'coverage' | other
 *   - attempt: iteration count at the time of this event (0 for start)
 *   - outcome: server outcome string (see mapping above)
 */
export function buildIterationEvent({ featureCode, loopId, loopType, stage, attempt, outcome, timestamp }) {
  const now = timestamp || new Date().toISOString();
  const id = iterationDecisionEventId(featureCode, loopId, stage);
  const schemaOutcome = mapIterationOutcome(outcome);

  // Role assignment per design Decision 5
  let roles = [];
  if (loopType === 'review') {
    roles = [{ name: 'REVIEWER', agent_id: null }];
  } else if (loopType === 'coverage') {
    roles = [{ name: 'IMPLEMENTER', agent_id: null }];
  }

  // Title: descriptive for start vs complete
  let title;
  if (stage === 'start') {
    title = `Iteration loop started — ${loopType}`;
  } else {
    const cnt = attempt != null ? ` (${attempt} attempt${attempt !== 1 ? 's' : ''})` : '';
    title = `Iteration loop complete — ${loopType}${cnt}`;
  }

  const metadata = { iteration_id: loopId };
  // attempt is schema-optional; schema requires minimum: 1 so only include when >= 1
  if (attempt != null && attempt >= 1) metadata.attempt = attempt;
  if (stage !== 'start') metadata.outcome = schemaOutcome;

  return {
    id,
    feature_code: featureCode,
    timestamp: now,
    kind: 'iteration',
    title,
    metadata,
    roles,
  };
}

/**
 * Build a kind=gate DecisionEvent.
 *
 * @param {{ featureCode, gateLogEntryId, gateId, decision, timestamp }} params
 *   - decision: route outcome string (approve|revise|kill) — translated to schema enum internally
 */
export function buildGateEvent({ featureCode, gateLogEntryId, gateId, decision, timestamp }) {
  const now = timestamp || new Date().toISOString();
  const id = gateDecisionEventId(featureCode, gateLogEntryId);
  const schemaDecision = mapResolveOutcomeToSchema(decision);

  const outcomeLabels = { approve: 'approved', interrupt: 'interrupted', deny: 'denied' };
  const label = outcomeLabels[schemaDecision] || schemaDecision;

  return {
    id,
    feature_code: featureCode,
    timestamp: now,
    kind: 'gate',
    title: `Gate ${label}: ${gateId}`,
    metadata: {
      gate_id: gateId,
      decision: schemaDecision,
      gate_log_entry_id: gateLogEntryId,
    },
    roles: [],
  };
}
