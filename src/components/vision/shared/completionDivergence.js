/**
 * completionDivergence.js — pure divergence rule for COMP-PARITY-5.
 *
 * No React/DOM imports — pure so it can be unit-tested without jsdom
 * (mirrors driftRibbonLogic.js). Compares the vision-state status (lowercase)
 * with the latest recorded completion and decides whether they diverge.
 */

/**
 * @typedef {Object} DivergenceResult
 * @property {'none'|'aligned'|'aligned-terminal'|'diverged'} kind
 * @property {boolean} diverged
 * @property {string|null} message
 */

/**
 * Compute divergence between the vision-state status and the latest completion.
 *
 * @param {string|null} status   item.status (lowercase: 'complete'|'in_progress'|…)
 * @param {object|null} latest   latest completion record (getCompletions sort desc), or null
 * @returns {DivergenceResult}
 */
export function computeDivergence(status, latest) {
  const s = (status || '').toLowerCase();

  if (!latest) {
    if (s === 'complete') {
      return {
        kind: 'diverged',
        diverged: true,
        message: 'Status complete but no recorded completion (no commit-bound evidence).',
      };
    }
    return { kind: 'none', diverged: false, message: null };
  }

  // latest completion exists
  if (s === 'complete') {
    return { kind: 'aligned', diverged: false, message: null };
  }
  if (s === 'killed') {
    // deliberate terminal action after a completion — not drift
    return { kind: 'aligned-terminal', diverged: false, message: null };
  }
  const sha = latest.commit_sha_short || (latest.commit_sha || '').slice(0, 8) || '—';
  return {
    kind: 'diverged',
    diverged: true,
    message: `Recorded complete (${sha}) but status is "${s || 'unknown'}".`,
  };
}
