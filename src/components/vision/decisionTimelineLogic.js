/**
 * decisionTimelineLogic.js — Pure helpers for the DecisionTimelineStrip.
 *
 * COMP-OBS-TIMELINE B2: no React, no side effects, fully testable with node:test.
 */

import { DECISION_KINDS } from './constants.js';

// Fallback values when kind is unknown (e.g. gate/drift_threshold before those ship)
const FALLBACK_ICON = '●';
const FALLBACK_COLOR = 'text-zinc-400';

/**
 * Format an ISO timestamp relative to `now` (default: Date.now()).
 * Mirror of TimelineEvent.jsx's relativeTime helper.
 */
export function formatRelativeTime(iso, now) {
  if (!iso) return '';
  const nowMs = now != null ? now : Date.now();
  const diffMs = nowMs - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

/**
 * Return the unicode icon character for a given DecisionEvent kind.
 */
export function kindIcon(kind) {
  return DECISION_KINDS[kind]?.icon ?? FALLBACK_ICON;
}

/**
 * Return the Tailwind text class for a given DecisionEvent kind.
 */
export function kindColor(kind) {
  return DECISION_KINDS[kind]?.color ?? FALLBACK_COLOR;
}

// Role chip Tailwind classes per role name
const ROLE_CHIP_CLASSES = {
  IMPLEMENTER: 'bg-blue-500/15 text-blue-300 border border-blue-500/25',
  REVIEWER:    'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25',
  PRODUCER:    'bg-purple-500/15 text-purple-300 border border-purple-500/25',
};

/**
 * Return the Tailwind classes for a role chip.
 */
export function roleChipClass(role) {
  return ROLE_CHIP_CLASSES[role] ?? 'bg-zinc-500/15 text-zinc-300 border border-zinc-500/25';
}

/**
 * Filter events to the given featureCode and sort oldest-first.
 * Newest event is at the end → rendered rightmost per layout.md region ②.
 *
 * Does NOT mutate the input array.
 */
export function sortAndFilterEvents(events, featureCode) {
  return events
    .filter(e => e.feature_code === featureCode)
    .slice()
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
