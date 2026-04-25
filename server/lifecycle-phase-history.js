/**
 * lifecycle-phase-history.js — Populate lifecycle.phaseHistory[].
 *
 * COMP-OBS-TIMELINE: plugs project_lifecycle_phasehistory_gap (memory note).
 * This module is the SOLE WRITER for lifecycle.phaseHistory[].
 *
 * Entries carry BOTH the legacy shape (`phase`, `step`, `enteredAt`, `exitedAt`,
 * `outcome`) consumed by `ItemDetailPanel.jsx`, `ContextPipelineDots.jsx`, and
 * `session-routes.js`, AND the new shape (`from`, `to`, `outcome`, `timestamp`)
 * consumed by `decision-events-snapshot.js`. Legacy `enteredAt` is the same
 * instant as the new `timestamp`. The previous entry's `exitedAt` is closed out
 * to the new entry's `enteredAt` (legacy semantic: a phase exits when its
 * successor begins).
 */

/**
 * Append one phase transition entry to item.lifecycle.phaseHistory and close
 * out the prior entry's `exitedAt`.
 *
 * @param {object} item — vision store item (mutated in place)
 * @param {{ from: string|null, to: string, outcome: string|null, timestamp: string }} params
 */
export function appendPhaseHistory(item, { from, to, outcome, timestamp }) {
  if (!Array.isArray(item.lifecycle.phaseHistory)) {
    item.lifecycle.phaseHistory = [];
  }
  const history = item.lifecycle.phaseHistory;
  const prior = history[history.length - 1];
  if (prior && prior.exitedAt == null) {
    prior.exitedAt = timestamp;
  }
  history.push({
    // Legacy shape (preserves existing readers in ItemDetailPanel, ContextPipelineDots, session-routes)
    phase: to,
    step: to,
    enteredAt: timestamp,
    exitedAt: null,
    // New shape (consumed by decision-events-snapshot.js)
    from: from ?? null,
    to,
    outcome: outcome ?? null,
    timestamp,
  });
}
