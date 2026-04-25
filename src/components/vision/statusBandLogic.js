/**
 * statusBandLogic.js — Pure helpers for StatusBand rendering.
 *
 * COMP-OBS-STATUS B3: client-side pure helpers that are unit-testable without React.
 *
 * - truncateForSentence(s, headroom) — truncate string with ellipsis
 * - formatExpansionPanel(snapshot)   — produce labelled rows for the detail panel
 */

/**
 * Truncate a string to fit within `headroom` chars, appending '…' if cut.
 * If the string already fits, it is returned unchanged.
 *
 * Mirrors the server implementation in status-snapshot.js for client-side
 * fall-through rendering cases.
 */
export function truncateForSentence(s, headroom) {
  if (!s) return s || '';
  if (headroom <= 0) return '';
  if (headroom === 1) return '…';
  if (s.length <= headroom) return s;
  return s.slice(0, headroom - 1) + '…';
}

/**
 * Format a StatusSnapshot into labelled rows for the expansion panel.
 *
 * @param {StatusSnapshot|null} snapshot
 * @returns {{ label: string, value: string|number }[]}
 */
export function formatExpansionPanel(snapshot) {
  if (!snapshot) return [];

  const rows = [];

  // Active phase
  if (snapshot.active_phase != null) {
    rows.push({ label: 'Phase', value: snapshot.active_phase });
  }

  // Pending gates
  const gateIds = snapshot.pending_gates ?? [];
  rows.push({
    label: 'Pending gates',
    value: gateIds.length === 0 ? 'none' : gateIds.join(', '),
  });

  // Open loops count
  rows.push({
    label: 'Open loops',
    value: snapshot.open_loops_count ?? 0,
  });

  // Gate load (24h)
  rows.push({
    label: 'Gate load (24h)',
    value: snapshot.gate_load_24h ?? 0,
  });

  // Drift alerts
  const driftAlerts = snapshot.drift_alerts ?? [];
  if (driftAlerts.length > 0) {
    rows.push({
      label: 'Drift alerts',
      value: driftAlerts.map(a => a.axis_id || a.name || 'unknown').join(', '),
    });
  } else {
    rows.push({ label: 'Drift alerts', value: 'none' });
  }

  // Computed at
  if (snapshot.computed_at) {
    rows.push({ label: 'Updated', value: snapshot.computed_at });
  }

  return rows;
}
