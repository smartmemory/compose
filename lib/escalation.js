/**
 * escalation.js — Pure escalation decision for the triage lane ladder.
 *
 * COMP-TRIAGE-5 / S03 (see docs/features/COMP-TRIAGE-5/plan.md, blueprint.md C3).
 *
 * `escalate` is a PURE decision function: no file I/O, no imports of build.js
 * or the vision store. The caller (lib/build.js's escalation observer) reads
 * currentPhase from the vision store itself and performs all side effects
 * (un-skipping phases, re-entering, writing checkpoints, human handoff).
 */

/** Lane ladder, low → high. Exported so callers/tests (and S04) share one order. */
export const LANE_ORDER = ['trivial', 'standard', 'complex'];

/** Bound on escalation attempts before forcing a human handoff (STOP). */
const MAX_ESCALATIONS = 2;

/** Earliest phase to re-enter for each escalated-to lane. */
const RE_ENTRY_PHASE_BY_LANE = {
  standard: 'blueprint',
  complex: 'design',
};

/**
 * Decide whether/how to escalate the current build lane in response to a
 * normalized gate result.
 *
 * @param {{gate: 'review'|'test', passed: boolean}} normalizedGate - normalized gate signal.
 * @param {'trivial'|'standard'|'complex'} currentLane - current lane on the ladder.
 * @param {number} escalationCount - number of escalations already performed for this feature.
 * @param {string} [currentPhase] - caller-supplied current phase (from the vision store).
 *   Not read or fetched here — the caller owns all I/O. Reserved for future use to avoid
 *   re-entering a phase later than necessary than the lane's default reEntryPhase; ignored
 *   in this implementation (see Deviation note below).
 * @returns {null|'STOP'|{nextLane: string, reEntryPhase: string}}
 *   - `null` — gate passed, no escalation needed.
 *   - `'STOP'` — bounded out (escalationCount >= 2) or already at the top lane ('complex')
 *     and the gate failed; caller performs human handoff.
 *   - `{nextLane, reEntryPhase}` — escalate one rung up the ladder and re-enter at the
 *     earliest phase the new lane requires.
 */
export function escalate(normalizedGate, currentLane, escalationCount, currentPhase) {
  // currentPhase is intentionally unused: the design instructs "if unsure, ignore it and
  // document that" (docs/features/COMP-TRIAGE-5/plan.md S03). Accepted as a parameter so
  // the caller's signature is stable for S04, but the reEntryPhase returned here is always
  // the ladder default for the target lane, not narrowed by currentPhase.
  void currentPhase;

  if (normalizedGate.passed === true) {
    return null;
  }

  if (escalationCount >= MAX_ESCALATIONS) {
    return 'STOP';
  }

  const currentIndex = LANE_ORDER.indexOf(currentLane);
  const nextIndex = currentIndex + 1;

  if (currentIndex === -1 || nextIndex >= LANE_ORDER.length) {
    // Unknown lane or already at the top rung ('complex') — cannot escalate further.
    return 'STOP';
  }

  const nextLane = LANE_ORDER[nextIndex];
  const reEntryPhase = RE_ENTRY_PHASE_BY_LANE[nextLane];

  return { nextLane, reEntryPhase };
}
