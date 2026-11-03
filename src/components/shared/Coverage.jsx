import React from 'react';
import { useUnitIndex } from '@/lib/useUnitIndex.js';
import SourceNote from '@/components/cockpit/SourceNote.jsx';

/**
 * Coverage (COMP-COCKPIT-RULE-FRESH-1): how much of a time chart's data was actually recorded, from
 * GET /api/units/index `coverage[lane]`. Missing stamps are never read as zero time.
 * COMP-COCKPIT-SOURCE-FAULTS-1 (RULE-FRESH M1): a failed index refresh keeps the last percentages, marked by the shared
 * SourceNote; a partial index (queue dir unlistable) or a lane warning is named under the line too.
 * COMP-SOURCE-ENVELOPE-1: also index-wide `warnings` and the lane's own `coverage[lane].error`.
 */
const LABEL = { ready: 'ready', dispatched: 'dispatched', authorDone: 'author done', review: 'review', gate: 'gate', landed: 'landed', deployed: 'deployed' };
const TIP = 'Share of units landed in the last 48 h that carry this stamp. Missing stamps are not counted as zero time.';

export default function Coverage({ lane, events = [], className = '' }) {
  const src = useUnitIndex();
  const { data, loading } = src;
  const cls = `text-[11px] text-muted-foreground ${className}`;
  const c = data?.coverage?.[lane];
  let body;
  if (!c && loading) body = 'coverage unknown';
  else if (!c || c.error) body = 'coverage unknown';
  else if (c.n === 0) body = 'no landings in 48 h';
  else body = `stamps recorded: ${events.map((e) => `${LABEL[e] ?? e} ${c.pct?.[e] ?? '?'}%`).join(' · ')}`;
  // COMP-SOURCE-ENVELOPE-1: a lane with its own row is its own whole count; a lane with none may be missing because of an
  // index-wide fault, so it names every one (`error` and `warnings`); the lane's own stamp error or warnings go on its note.
  const wide = [data?.error, ...(Array.isArray(data?.warnings) ? data.warnings : [])].filter(Boolean);
  const partial = !c && wide.length ? { error: wide.join('; ') } : null;
  const laneFaults = [c?.error, ...(c?.warnings ?? [])].filter(Boolean);
  const laneWarn = laneFaults.length ? { error: laneFaults.join('; ') } : null;
  return (
    <div className={cls} title={TIP} data-testid={`coverage-${lane}`}>
      {body}
      <SourceNote source="Unit index" state={src.error ? src : partial} />
      <SourceNote source={`${lane} stamps`} state={src.error ? null : laneWarn} />
    </div>
  );
}
