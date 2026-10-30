import React from 'react';
import { StateBadge } from './ProcessBadge.jsx';
import { TONES } from './processTones.js';

/**
 * KpiTiles — one tile per summary.json panel (P1-P5) for the selected page. Each figure is the builder's value
 * verbatim in its own `val-*` element (the agreement test reads it); nothing is computed. Stale and no-data states
 * are badges with the builder's text in the tooltip; basis, last 5 and the feed breakdown live in the drawer.
 */

const NOT_REPORTED = 'not reported';
const warn = { color: 'hsl(var(--warning))' };
const present = (v) => v !== undefined && v !== null;

/** One figure: `fig-<id>` wraps it, `val-<id>` holds the value verbatim, a missing value says "not reported". */
export function Fig({ id, label, value, suffix, big = false, className = '' }) {
  const missing = !present(value);
  return (
    <span className={`inline-flex items-baseline gap-1 ${className}`} data-testid={`fig-${id}`}>
      {label ? <span className="text-muted-foreground">{label}</span> : null}
      <span className={`font-mono ${big ? 'text-[26px] font-semibold leading-none text-foreground' : 'text-foreground'}`} data-testid={`val-${id}`}>
        {missing ? NOT_REPORTED : String(value)}
      </span>
      {!missing && suffix ? <span className="font-mono text-[11px] text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}

/** The builder writes a stale reason as text, or `true` when the config carries none. */
const staleText = (s) => `stale: ${typeof s === 'string' ? s : 'the builder marks this figure stale'}`;

function Tile({ id, title, tone, stale, staleId, empty, emptyId, onDetails, children, sub, align }) {
  const t = TONES[tone] ?? TONES.neutral;
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3" data-testid={`process-${id}`}>
      <div className="flex min-h-[20px] items-center justify-between gap-2">
        <h3 className="truncate text-[11px] font-medium text-muted-foreground">{title}</h3>
        {stale ? <StateBadge state="stale" tip={staleText(stale)} tipTestId={staleId} tipStyle={warn} align={align} /> : null}
        {empty !== undefined ? (
          <StateBadge state="missing" tip={empty ?? NOT_REPORTED} tipTestId={emptyId} tipStyle={empty ? undefined : warn} align={align} />
        ) : null}
      </div>
      <div className="flex min-h-[30px] flex-wrap items-baseline gap-x-1.5 gap-y-1">
        {empty !== undefined ? <span className="font-mono text-[26px] font-semibold leading-none text-muted-foreground" aria-label="no figure">—</span> : children}
      </div>
      <div className="h-1 w-full rounded" style={empty !== undefined ? TONES.missing.bar : t.bar} aria-hidden="true" />
      <div className="flex min-h-[16px] items-center justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 truncate">{empty !== undefined ? null : sub}</span>
        <button type="button" onClick={onDetails} className="shrink-0 text-[11px] text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
          aria-label={`${title} details`}>details</button>
      </div>
    </section>
  );
}

/** `tones` maps a panel id to its rollup tone for this page; `onDetails(panelId)` opens the drawer there. */
export default function KpiTiles({ name, summary, tones, onDetails }) {
  const nd = summary.no_data ?? {};
  const f = (k) => `${name}-${k}`;
  const has = (k) => present(summary[k]);
  const ws = summary.waiting_share, fp = summary.first_pass_clean, rr = summary.review_rounds;
  const gm = summary.gate_minutes, st = summary.standard;
  // Tips on the two right-hand tiles open leftwards so they stay inside the view.
  const tile = (k, title, align = 'left') => ({
    id: f(k), align, title, tone: tones?.[k] ?? 'neutral', onDetails: () => onDetails(k),
    empty: has(k) ? undefined : (nd[k] ?? null), emptyId: `empty-${f(k)}`,
  });
  return (
    <div className="grid grid-cols-5 gap-2" data-testid="process-kpis">
      <Tile {...tile('waiting_share', 'Waiting share')} stale={ws?.stale} staleId={`stale-${f('waiting_share')}`}
        sub={has('waiting_share') ? <Fig id={f('waiting_units_stamped')} label="units stamped" value={summary.waiting_units_stamped} /> : null}>
        {has('waiting_share') ? <Fig id={f('waiting_share-pct')} value={ws.pct} suffix="%" big /> : null}
      </Tile>
      <Tile {...tile('first_pass_clean', 'First-pass CLEAN')}
        sub={has('first_pass_clean') ? <span className="text-muted-foreground">clean of reviewed</span> : null}>
        {has('first_pass_clean') ? (<>
          <Fig id={f('first_pass_clean-clean')} value={fp.clean} big />
          <Fig id={f('first_pass_clean-total')} label="of" value={fp.total} />
        </>) : null}
      </Tile>
      <Tile {...tile('review_rounds', 'Review rounds / unit')}
        sub={has('review_rounds') ? (<>
          <Fig id={f('review_rounds-max')} label="worst" value={rr.max} />
          <Fig id={f('review_rounds-n')} label="units" value={rr.n} />
        </>) : null}>
        {has('review_rounds') ? <Fig id={f('review_rounds-median')} value={rr.median} suffix="median" big /> : null}
      </Tile>
      <Tile {...tile('gate_minutes', 'Gate min / land', 'right')} stale={gm?.stale} staleId={`stale-${f('gate_minutes')}`}
        sub={has('gate_minutes') ? (<>
          <Fig id={f('gate_minutes-max')} label="longest" value={gm.max} />
          <Fig id={f('gate_minutes-lands')} label="lands" value={gm.lands} />
          <Fig id={f('gate_minutes-day')} label="on" value={gm.day} />
        </>) : null}>
        {has('gate_minutes') ? <Fig id={f('gate_minutes-median')} value={gm.median} suffix="min median" big /> : null}
      </Tile>
      <Tile {...tile('standard', 'Std-process feeds', 'right')}
        sub={has('standard') ? <span className="text-muted-foreground">units stamped</span> : null}>
        {has('standard') ? (<>
          <Fig id={f('standard-with')} value={st.stamps?.with} big />
          <Fig id={f('standard-of')} label="of" value={st.stamps?.of} />
        </>) : null}
      </Tile>
    </div>
  );
}
