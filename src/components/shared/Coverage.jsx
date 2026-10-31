import React from 'react';
import { useUnitIndex } from '@/lib/useUnitIndex.js';

/**
 * Coverage (COMP-COCKPIT-RULE-FRESH-1): how much of a time chart's data was actually recorded, from
 * GET /api/units/index `coverage[lane]`. Missing stamps are never read as zero time.
 */
const LABEL = { ready: 'ready', dispatched: 'dispatched', authorDone: 'author done', review: 'review', gate: 'gate', landed: 'landed', deployed: 'deployed' };
const TIP = 'Share of units landed in the last 48 h that carry this stamp. Missing stamps are not counted as zero time.';

export default function Coverage({ lane, events = [], className = '' }) {
  const { data, loading } = useUnitIndex();
  const cls = `text-[11px] text-muted-foreground ${className}`;
  const c = data?.coverage?.[lane];
  let body;
  if (!c && loading) body = 'coverage unknown';
  else if (!c || c.error) body = 'coverage unknown';
  else if (c.n === 0) body = 'no landings in 48 h';
  else body = `stamps recorded: ${events.map((e) => `${LABEL[e] ?? e} ${c.pct?.[e] ?? '?'}%`).join(' · ')}`;
  return <div className={cls} title={TIP} data-testid={`coverage-${lane}`}>{body}</div>;
}
