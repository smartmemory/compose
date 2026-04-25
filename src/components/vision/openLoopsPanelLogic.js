/**
 * openLoopsPanelLogic.js — Pure helpers for OpenLoopsPanel.
 *
 * Mirrors the server's isStaleLoop predicate so the panel and STATUS
 * agree exactly on what "stale" means (COMP-OBS-LOOPS Decision 3).
 */

/**
 * Sort loops oldest-first by created_at.
 * @param {OpenLoop[]} loops
 * @returns {OpenLoop[]}
 */
export function sortByAge(loops) {
  return [...loops].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/**
 * Format age as a human-readable string (e.g. "3d", "2h", "45m").
 * @param {string} createdAt — ISO date string
 * @param {number} [nowMs]   — epoch ms (defaults to Date.now())
 * @returns {string}
 */
export function formatAge(createdAt, nowMs) {
  const elapsed = (nowMs ?? Date.now()) - Date.parse(createdAt);
  if (elapsed < 0) return '0m';
  const mins = Math.floor(elapsed / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(elapsed / 3600000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(elapsed / 86400000);
  return `${days}d`;
}

/**
 * Returns true if a loop is unresolved and past its TTL.
 * Mirrors server/open-loops-store.js#isStaleLoop exactly.
 * @param {OpenLoop} loop
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isStaleLoop(loop, nowMs) {
  if (loop.resolution) return false;
  const ttl = loop.ttl_days ?? 90;
  const elapsed = (nowMs ?? Date.now()) - Date.parse(loop.created_at);
  return elapsed > ttl * 24 * 60 * 60 * 1000;
}
