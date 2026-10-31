import React from 'react';
import { fmtAge } from '@/components/cockpit/fleetLogic.js';

/**
 * Freshness (COMP-COCKPIT-RULE-FRESH-1): "as of HH:MM (Nm ago)", or "stale: N min old" past `staleAfterS`.
 * Give it `ts` (ms epoch or ISO string) or `ageS`. Renders nothing when neither is a usable time.
 */
export function ageSeconds({ ts, ageS, now = Date.now() }) {
  if (Number.isFinite(ageS)) return ageS;
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
}

export default function Freshness({ ts, ageS, staleAfterS = 300, label = 'as of', className = '' }) {
  const age = ageSeconds({ ts, ageS });
  if (age === null) return null;
  if (age > staleAfterS) {
    return (
      <span className={`text-[11px] ${className}`} style={{ color: 'hsl(var(--warning))' }} data-testid="freshness" data-stale="true">
        stale: {Math.round(age / 60)} min old
      </span>
    );
  }
  const at = Number.isFinite(ageS) ? new Date(Date.now() - ageS * 1000) : new Date(typeof ts === 'string' ? Date.parse(ts) : ts);
  return (
    <span className={`text-[11px] text-muted-foreground ${className}`} data-testid="freshness" data-stale="false">
      {label} {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({fmtAge(age)} ago)
    </span>
  );
}
