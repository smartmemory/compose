/**
 * driftRibbonLogic.js — Pure helpers for DriftRibbon.jsx (COMP-OBS-DRIFT).
 *
 * No React/DOM imports — all functions are pure so they can be unit-tested
 * without jsdom.
 */

const AXIS_LABELS = {
  path_drift:         'Path drift',
  contract_drift:     'Contract drift',
  review_debt_drift:  'Review debt',
};

/**
 * Human-readable label for an axis_id.
 *
 * @param {string} axis_id
 * @returns {string}
 */
export function axisLabel(axis_id) {
  return AXIS_LABELS[axis_id] ?? axis_id;
}

/**
 * Format a 0-1 ratio as a percentage string (e.g. 0.42 → '42%').
 *
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatRatio(n) {
  if (n == null || typeof n !== 'number' || isNaN(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

/**
 * Given an item, return only the breached drift axes.
 *
 * @param {object} item — vision item
 * @returns {DriftAxis[]} breached axes only (may be empty)
 */
export function getBreachedAxes(item) {
  const axes = item?.lifecycle?.lifecycle_ext?.drift_axes ?? [];
  return axes.filter(a => a.breached === true);
}
