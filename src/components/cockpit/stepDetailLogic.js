/**
 * stepDetailLogic.js — Pure helpers for ContextStepDetail sections.
 *
 * All functions are side-effect-free for easy testing (no React, no fetch).
 *
 * COMP-OBS-STEPDETAIL
 */

/**
 * Extract retries summary from a build step.
 *
 * Supports two shapes shipped by build.js:
 *   - step.retries as a scalar int (most common today)
 *   - step.retries as an array of attempt objects (Stratum future shape)
 *
 * Returns null when retries are zero / absent — callers should hide the section.
 *
 * @param {object|null} step
 * @returns {{ count: number, isArray: boolean, items: object[] } | null}
 */
export function selectRetriesSummary(step) {
  if (!step) return null;
  const { retries } = step;
  if (retries == null) return null;

  if (Array.isArray(retries)) {
    if (retries.length === 0) return null;
    return { count: retries.length, isArray: true, items: retries };
  }

  if (typeof retries === 'number' && retries > 0) {
    return { count: retries, isArray: false, items: [] };
  }

  return null;
}

/**
 * Extract violations array from a build step.
 * Returns empty array when absent/empty — callers should hide the section.
 *
 * @param {object|null} step
 * @returns {Array}
 */
export function selectViolations(step) {
  if (!step?.violations?.length) return [];
  return step.violations;
}

/**
 * Walk iterationStates (Map<loopId, iterState>) and return the first entry
 * whose stepId matches. Returns null if no match or iterationStates is falsy.
 *
 * Graceful degradation: if shipped iteration entries don't carry stepId, the
 * Map#values() walk simply finds nothing and returns null — no error thrown.
 *
 * @param {Map|null} iterationStates
 * @param {string} stepId
 * @returns {object|null}
 */
export function findLoopForStep(iterationStates, stepId) {
  if (!iterationStates) return null;
  for (const iter of iterationStates.values()) {
    if (iter.stepId === stepId) return iter;
  }
  return null;
}

/**
 * Build live-counter data from a running loop state + optional budget snapshot.
 *
 * Returns null when loopState is null or its status is not 'running'.
 * The component uses this to gate the Live Counters section.
 *
 * @param {object|null} loopState — one iterationStates entry
 * @param {object|null} budget — response shape from GET /api/lifecycle/budget
 * @param {number} now — current timestamp in ms (Date.now())
 * @returns {{
 *   count: number,
 *   maxIterations: number,
 *   loopType: string,
 *   elapsedMs: number,
 *   timeoutMs: number|null,
 *   usedIterations: number|null,
 *   maxTotal: number|null,
 * } | null}
 */
export function selectLiveCounters(loopState, budget, now) {
  if (!loopState || loopState.status !== 'running') return null;

  const startedMs = loopState.startedAt ? Date.parse(loopState.startedAt) : now;
  const elapsedMs = now - startedMs;

  const timeoutMs = loopState.wallClockTimeout != null
    ? loopState.wallClockTimeout * 60 * 1000
    : null;

  const loopBudget = budget?.per_loop_type?.[loopState.loopType];
  const usedIterations = loopBudget?.maxTotal != null ? loopBudget.usedIterations : null;
  const maxTotal = loopBudget?.maxTotal ?? null;

  return {
    count: loopState.count ?? 0,
    maxIterations: loopState.maxIterations ?? null,
    loopType: loopState.loopType,
    elapsedMs,
    timeoutMs,
    usedIterations,
    maxTotal,
  };
}

/**
 * Format a budget snapshot into a compact pill string for OpsStrip.
 * E.g. "r 5/20 · c 8/50"
 *
 * Returns empty string when budget is null or no loopType has a maxTotal.
 *
 * @param {object|null} budget — GET /api/lifecycle/budget response
 * @returns {string}
 */
export function formatBudgetCompact(budget) {
  if (!budget?.per_loop_type) return '';

  const ABBREV = { review: 'r', coverage: 'c' };
  const parts = [];

  for (const [lt, abbrev] of Object.entries(ABBREV)) {
    const entry = budget.per_loop_type[lt];
    if (!entry || entry.maxTotal == null) continue;
    parts.push(`${abbrev} ${entry.usedIterations}/${entry.maxTotal}`);
  }

  return parts.join(' · ');
}
