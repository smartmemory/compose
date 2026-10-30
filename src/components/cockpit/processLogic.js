/**
 * processLogic.js — pure labels and formatters for the Process view (COMP-COCKPIT-13). No React imports.
 * Input is the GET /api/process body (`server/process-routes.js`); nothing here recomputes a builder figure.
 */

/** P6 buckets in display order; `escalation` and `other` are never recorded by stamps. */
export const BUCKETS = [
  ['authoring', 'Authoring'],
  ['review', 'Review'],
  ['fix_rounds', 'Fix rounds'],
  ['gate', 'Gate'],
  ['waiting_owner', 'Waiting on owner'],
  ['waiting', 'Waiting'],
];

export const NOT_RECORDED = 'not recorded (stamps carry no such interval)';

/** Short plain label per P6 unknown rule (U1's rules, `lib/process-metrics.js`). */
export const RULE_LABELS = {
  'U-a': 'end without start',
  'U-b': 'start without end',
  'U-c': 'legacy fixes[] without fix_runs[]',
  'U-d': 'no author_done_at',
  'U-e': 'unreadable or reversed stamp',
};

/** "U-a: end without start x3, U-d: no author_done_at x1"; unknown rules with a zero count are left out. */
export function unknownRules(byRule) {
  return Object.entries(byRule ?? {})
    .filter(([, n]) => n > 0)
    .map(([rule, n]) => `${rule}: ${RULE_LABELS[rule] ?? 'unlabelled rule'} x${n}`)
    .join(', ');
}

/** "M known, N unknown (rules), K not in split" for one stamps lane's `timeSplit`. */
export function splitSummary(ts) {
  if (!ts) return 'unknown';
  const rules = unknownRules(ts.byRule);
  return `${ts.known} known, ${ts.unknown} unknown${rules ? ` (${rules})` : ''}, ${ts.outside} not in split`;
}

/** Minutes shown rounded at display only. A lane with no known unit has no figure: never rendered as 0. */
export function bucketText(ts, key) {
  if (!ts || !(ts.known > 0)) return 'no known units';
  const v = ts.minutes?.[key];
  return Number.isFinite(v) ? `${Math.round(v)} min` : 'not reported';
}

/** A page's freshness marker text, or null when it is fresh and not failed. */
export function pageMarker(page) {
  if (!page) return 'no summary';
  if (page.error) return 'unavailable';
  if (page.failed) return 'build failed';
  if (page.stale) return 'stale';
  return null;
}

/** The P1-P5 panels of one summary.json: `[id, title]`. `no_data.<id>` carries the builder's own empty text. */
export const PANELS = [
  ['waiting_share', 'Waiting share'],
  ['first_pass_clean', 'First-pass CLEAN rate'],
  ['review_rounds', 'Review rounds per unit'],
  ['gate_minutes', 'Gate minutes per land'],
  ['standard', 'Standard-process feeds'],
];
