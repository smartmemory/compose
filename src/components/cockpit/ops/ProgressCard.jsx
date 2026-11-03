import React from 'react';
import Freshness from '@/components/shared/Freshness.jsx';
import SourceNote from '../SourceNote.jsx';
import { etaText, OPS_STALE_AFTER_S } from './opsLogic.js';

/**
 * "<landed> of <planned> landed", a bar, the not-recorded and builder-only counts, the ETA, and freshness.
 * `source` is useOpsData's source state: a failed refresh over retained data shows the shared fault note
 * (COMP-COCKPIT-SOURCE-FAULTS-1), as do the route's progress warnings and the estimator's warnings.
 */
export default function ProgressCard({ data, fetchedAt, source = null }) {
  const p = data?.progress;
  const note = <SourceNote source="Ops data" state={source} />;
  if (!p) {
    return (
      <section className="rounded-md border p-4 text-sm space-y-1" aria-label="Progress">
        <div>Progress is unavailable: {data?.progressError ?? 'the stamps could not be read'}.</div>
        {note}
      </section>
    );
  }
  const warnings = [...(data.progressWarnings ?? []), ...(data.eta?.warnings ?? []).map((w) => `ETA: ${w}`)];
  const pct = p.planned ? Math.round((p.landed / p.planned) * 100) : 0;
  const eta = etaText(data.eta);
  return (
    <section className="rounded-md border p-4 space-y-2" aria-label="Progress">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-lg font-semibold" data-testid="ops-progress-text">{p.landed} of {p.planned} landed</div>
        <Freshness ts={fetchedAt - (data.ageS ?? 0) * 1000} staleAfterS={OPS_STALE_AFTER_S} />
      </div>
      {note}
      <div className="h-2 rounded bg-muted overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={p.planned} aria-valuenow={p.landed}>
        <div className="h-full" style={{ width: `${pct}%`, background: 'hsl(var(--success))' }} />
      </div>
      <div className="text-xs text-muted-foreground space-y-0.5">
        <div>{p.notRecorded} not recorded in stamps</div>
        {p.builderOnly > 0 && <div>{p.builderOnly} the builder calls landed with no stamp</div>}
        {eta && <div data-testid="ops-eta">{eta}</div>}
        {warnings.map((w) => <div key={w} data-testid="ops-warning" style={{ color: 'hsl(var(--warning))' }}>{w}</div>)}
      </div>
    </section>
  );
}
