/**
 * status-snapshot.js — COMP-OBS-STATUS producer (A1).
 *
 * Pure function: computeStatusSnapshot(state, featureCode, now) → StatusSnapshot
 *
 * Decision 2 (design.md): 8 rule branches, first-match wins.
 *   1. No feature selected  → "Select a feature to see status."
 *   2. Killed               → "{fc} killed. No further action."
 *   3. Complete             → "{fc} complete."
 *   4. Pending gate         → "Holding {phase}. Next: approve {gateId}."
 *   5. Drift breach         → "{phase} — N drift alert(s)."
 *   6. Stale open loops     → "{phase}. N loop(s) past TTL."
 *   7. Iteration in flight  → "Iterating {loopType} (attempt {count})."
 *   8. Idle baseline        → "Building {phase}. Open loops: {count}."
 *
 * Null/unknown phase fallbacks (Decision 2 note):
 *   - null phase + feature selected → "{fc}: phase pending."
 *   - unknown phase string          → "{fc}: {phase} (unrecognized phase)."
 *   Both short-circuit branches 4–7.
 */

// Known lifecycle phases — must match LIFECYCLE_PHASE_LABELS in constants.js
const KNOWN_PHASES = new Set([
  'explore_design', 'prd', 'architecture', 'blueprint',
  'verification', 'plan', 'execute', 'report', 'docs', 'ship',
  'complete', 'killed',
]);

const TERMINAL_PHASES = new Set(['complete', 'killed']);
const MAX_SENTENCE = 280;

/**
 * Truncate a string to fit within `headroom` chars, appending '…' if cut.
 * If the string already fits, it is returned unchanged.
 */
export function truncateForSentence(s, headroom) {
  if (s.length <= headroom) return s;
  if (headroom <= 1) return '…';
  return s.slice(0, headroom - 1) + '…';
}

/**
 * Build the sentence string from Decision 2 branches.
 *
 * @param {object} params
 * @param {string|null} featureCode
 * @param {string|null} activePhase
 * @param {Array}  pendingGates  — gate objects with .id
 * @param {Array}  driftAlerts   — breached DriftAxis objects
 * @param {number} staleLoopCount
 * @param {object|null} iterationState — lifecycle.iterationState
 * @param {boolean} featureExists — whether the feature was found in the store
 */
function buildStatusSentence({
  featureCode,
  activePhase,
  pendingGates,
  driftAlerts,
  staleLoopCount,
  iterationState,
  openLoopsCount,
  featureExists,
}) {
  // Branch 1: no feature selected
  if (!featureCode || !featureExists) {
    return 'Select a feature to see status.';
  }

  // Null phase guard (Decision 2 note) — short-circuits 4–7
  if (activePhase === null || activePhase === undefined) {
    return `${featureCode}: phase pending.`;
  }

  // Unknown phase guard — short-circuits 4–7
  if (!KNOWN_PHASES.has(activePhase)) {
    return truncateForSentence(`${featureCode}: ${activePhase} (unrecognized phase).`, MAX_SENTENCE);
  }

  // Branch 2: killed (terminal, checked BEFORE non-terminal branches)
  if (activePhase === 'killed') {
    return `${featureCode} killed. No further action.`;
  }

  // Branch 3: complete (terminal)
  if (activePhase === 'complete') {
    return `${featureCode} complete.`;
  }

  // Branch 4: pending gate
  if (pendingGates.length > 0) {
    const gateId = pendingGates[0].id;
    const prefix = `Holding ${activePhase}. Next: approve `;
    const suffix = '.';
    const headroom = MAX_SENTENCE - prefix.length - suffix.length;
    const gateIdShort = truncateForSentence(gateId, headroom);
    return `${prefix}${gateIdShort}${suffix}`;
  }

  // Branch 5: drift breach
  if (driftAlerts.length > 0) {
    const n = driftAlerts.length;
    const s = n === 1 ? '' : 's';
    return truncateForSentence(`${activePhase} — ${n} drift alert${s}.`, MAX_SENTENCE);
  }

  // Branch 6: stale open loops
  if (staleLoopCount > 0) {
    const n = staleLoopCount;
    const s = n === 1 ? '' : 's';
    return truncateForSentence(`${activePhase}. ${n} loop${s} past TTL.`, MAX_SENTENCE);
  }

  // Branch 7: iteration in flight
  if (iterationState?.status === 'running') {
    const { loopType, count } = iterationState;
    return truncateForSentence(`Iterating ${loopType} (attempt ${count}).`, MAX_SENTENCE);
  }

  // Branch 8: idle baseline
  return truncateForSentence(`Building ${activePhase}. Open loops: ${openLoopsCount}.`, MAX_SENTENCE);
}

/**
 * Compute a full StatusSnapshot for the given featureCode from current store state.
 *
 * @param {object} state — VisionStore (must expose getItemByFeatureCode, getPendingGates)
 * @param {string|null} featureCode
 * @param {string} now — ISO timestamp (injected for testability)
 * @returns {StatusSnapshot}
 */
export function computeStatusSnapshot(state, featureCode, now) {
  const nowStr = now || new Date().toISOString();

  // No feature selected → branch 1 baseline
  if (!featureCode) {
    return {
      sentence: 'Select a feature to see status.',
      active_goal: null,
      active_phase: null,
      pending_gates: [],
      drift_alerts: [],
      open_loops_count: 0,
      gate_load_24h: 0, // TODO: real value when COMP-OBS-GATELOG ships
      cta: null,
      computed_at: nowStr,
    };
  }

  const item = state.getItemByFeatureCode(featureCode);

  // Feature not found in store — return no-feature snapshot
  if (!item) {
    return {
      sentence: 'Select a feature to see status.',
      active_goal: null,
      active_phase: null,
      pending_gates: [],
      drift_alerts: [],
      open_loops_count: 0,
      gate_load_24h: 0,
      cta: null,
      computed_at: nowStr,
    };
  }

  const lc = item.lifecycle;
  const activePhase = lc?.currentPhase ?? null;
  const ext = lc?.lifecycle_ext ?? {};

  // Pending gates for this item
  const pendingGates = state.getPendingGates(item.id);
  const pendingGateIds = pendingGates.map(g => g.id);

  // Drift alerts: only axes with breached:true
  const driftAxes = ext.drift_axes ?? [];
  const driftAlerts = driftAxes.filter(a => a.breached === true);

  // Open loops
  const openLoops = ext.open_loops ?? [];
  const openLoopsCount = openLoops.length;

  // Stale open loops: unresolved and past TTL relative to now
  const nowMs = Date.parse(nowStr);
  const staleLoops = openLoops.filter(loop => {
    if (loop.resolution) return false; // resolved — not stale
    const ttl = loop.ttl_days ?? 90;
    const ageMs = nowMs - Date.parse(loop.created_at);
    return ageMs > ttl * 24 * 60 * 60 * 1000;
  });
  const staleLoopCount = staleLoops.length;

  const iterationState = lc?.iterationState ?? null;

  // Is active phase known? (for null/unknown guard)
  const phaseKnown = activePhase === null || KNOWN_PHASES.has(activePhase);

  // Build sentence — pass iterationState only when phase is non-terminal+known
  const sentence = buildStatusSentence({
    featureCode,
    activePhase,
    pendingGates,
    driftAlerts,
    staleLoopCount,
    iterationState: phaseKnown && !TERMINAL_PHASES.has(activePhase) ? iterationState : null,
    openLoopsCount,
    featureExists: true,
  });

  return {
    sentence,
    active_goal: item.title || null,
    active_phase: activePhase,
    pending_gates: pendingGateIds,
    drift_alerts: driftAlerts,
    open_loops_count: openLoopsCount,
    gate_load_24h: 0, // TODO: real value when COMP-OBS-GATELOG ships
    cta: null,
    computed_at: nowStr,
  };
}
