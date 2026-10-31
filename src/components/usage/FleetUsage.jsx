/**
 * FleetUsage — the Usage view's "Seats and fleet" scope (COMP-COCKPIT-PROCESS-DATA-1).
 *
 * Spend the Compose ledger never sees: the fleet's day $ against the ceiling and the last hour by session (the
 * sm_status `ceiling` and `spend` panels, read from the shared /api/fleet poll, no fetch of its own), plus one
 * quota row per seat from `client.getSeats()` (GET /api/usage/seats, usage_watch). Neither source records
 * dollars per seat, so a seat row shows quota used, never $. Mounted only while the fleet scope is picked, so the
 * Compose-dispatched scope starts no fleet poll.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { useFleet } from '../../lib/fleetPoller.js';
import { smPanel } from '../cockpit/fleetLogic.js';

const pctText = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : '—');

function resetText(iso, now) {
  if (!iso) return '—';
  const mins = Math.round((Date.parse(iso) - now) / 60_000);
  if (!Number.isFinite(mins)) return '—';
  if (mins <= 0) return 'reset';
  return mins < 60 ? `${mins}m` : mins < 2880 ? `${(mins / 60).toFixed(1)}h` : `${Math.round(mins / 1440)}d`;
}

/** Pure: the fleet's two spend panels, each `{text, rows}` or `{down: reason}`. Exported for the tests. */
export function fleetSpend(data) {
  const ceiling = smPanel(data, 'ceiling');
  const spend = smPanel(data, 'spend');
  const down = (p, what) => (p === null ? 'fleet status unavailable' : p.error ? `${what} unavailable: ${p.error}` : null);
  return {
    ceiling: down(ceiling, 'ceiling') ? { down: down(ceiling, 'ceiling') } : { text: ceiling.value?.line ?? '—', warn: Boolean(ceiling.value?.warn) },
    spend: down(spend, 'spend') ? { down: down(spend, 'spend') } : { text: spend.value?.head ?? '—', rows: Array.isArray(spend.value?.rows) ? spend.value.rows : [] },
  };
}

function Panel({ title, testId, children }) {
  return (
    <section className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1" data-testid={testId}>
      <h3 className="text-[12px] font-medium text-card-foreground">{title}</h3>
      {children}
    </section>
  );
}

export default function FleetUsage({ client, now }) {
  const fleet = useFleet();
  const { ceiling, spend } = fleetSpend(fleet.data);
  const [seats, setSeats] = useState({ loading: true, body: null, error: null });
  const load = useCallback(() => {
    let live = true;
    setSeats((s) => ({ ...s, loading: true }));
    client.getSeats()
      .then((body) => { if (live) setSeats({ loading: false, body, error: null }); })
      .catch((err) => { if (live) setSeats({ loading: false, body: null, error: err.message || String(err) }); });
    return () => { live = false; };
  }, [client]);
  useEffect(() => load(), [load]);

  const src = seats.body?.seats;
  const rows = Array.isArray(src?.value?.seats) ? src.value.seats : [];
  const seatError = seats.error || src?.error || null;
  const at = now ? Date.parse(now) : Date.now();
  return (
    <div className="flex flex-col gap-4" data-testid="usage-fleet">
      <div className="grid gap-2 md:grid-cols-2">
        <Panel title="Fleet spend today" testId="usage-fleet-ceiling">
          {ceiling.down
            ? <span className="text-[12px] text-muted-foreground">{fleet.loading ? 'loading…' : ceiling.down}</span>
            : <span className={cn('text-[12px]', ceiling.warn && 'text-[hsl(var(--warning))]')}>{ceiling.text}</span>}
        </Panel>
        <Panel title="Last hour by session" testId="usage-fleet-spend">
          {spend.down
            ? <span className="text-[12px] text-muted-foreground">{fleet.loading ? 'loading…' : spend.down}</span>
            : (
              <>
                <span className="text-[12px]">{spend.text}</span>
                {spend.rows.map((r) => <span key={r} className="font-mono text-[11px] text-muted-foreground whitespace-pre">{r}</span>)}
              </>
            )}
        </Panel>
      </div>

      <section className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[12px] font-medium text-card-foreground mr-auto">Seats</h3>
          {src?.stale && <span className="text-[11px] text-muted-foreground">refreshing…</span>}
          <button type="button" onClick={load} aria-label="Refresh seats" className="p-1 rounded hover:bg-muted">
            <RefreshCw className={cn('w-3.5 h-3.5', seats.loading && 'animate-spin')} />
          </button>
        </div>
        {seatError && <div className="text-[12px] text-destructive" data-testid="usage-seats-error">Could not read seat quotas: {seatError}</div>}
        {rows.length > 0 && (
          <table className="w-full text-[12px]" data-testid="usage-seats-table">
            <thead className="text-[11px] text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left font-normal py-1.5">Seat</th>
                <th className="text-left font-normal">Reading</th>
                <th className="text-right font-normal">5h used</th>
                <th className="text-right font-normal">5h resets in</th>
                <th className="text-right font-normal">7d used</th>
                <th className="text-right font-normal">7d resets in</th>
                <th className="text-right font-normal">Today pts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/50" data-testid={`usage-seat-${r.id}`}>
                  <td className="py-1.5">{r.label}</td>
                  <td className={cn(r.status !== 'ok' && 'text-muted-foreground')}>{r.status ?? '—'}</td>
                  <td className="text-right font-mono">{pctText(r.five_h?.used_pct)}</td>
                  <td className="text-right font-mono text-muted-foreground">{resetText(r.five_h?.resets_at, at)}</td>
                  <td className="text-right font-mono">{pctText(r.seven_d?.used_pct)}</td>
                  <td className="text-right font-mono text-muted-foreground">{resetText(r.seven_d?.resets_at, at)}</td>
                  <td className="text-right font-mono">{typeof r.today_pts === 'number' ? r.today_pts : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-[11px] text-muted-foreground" data-testid="usage-seats-note">
          Quota used per seat, from the usage watcher. Dollars are recorded for the whole fleet (above), not per seat.
        </p>
      </section>
    </div>
  );
}
