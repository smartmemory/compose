import React from 'react';
import UnitName from '@/components/shared/UnitName.jsx';
import Freshness from '@/components/shared/Freshness.jsx';
import { Skeleton } from '@/components/ui/skeleton.jsx';
import {
  blockerReasons, ctxLevel, fmtAge, fmtK, proposedLine, readerUp, smPanel, sortJobs, sortReady, DISK_RED_GB,
} from './fleetLogic.js';

/**
 * FleetPanels — the read-only Fleet cards (COMP-COCKPIT-12), shared by the Sessions tab Fleet view
 * (`variant="desktop"`) and the mobile Status tab (`variant="mobile"`). Takes the GET /api/fleet body.
 *
 * Order: owner questions, sessions, open jobs, detached fleet (Stratum), disk and spend, Cadence, ledger tail.
 * A reader that is down renders none of its cards. A failing source inside a reader renders its own
 * `unavailable: <reason>` card. No actions in v1: watch here, act in chat.
 * Colours come from the index.css tokens (--destructive, --warning, --success, --muted-foreground).
 */

const TONE = {
  red: { color: 'hsl(var(--destructive))' },
  yellow: { color: 'hsl(var(--warning))' },
  ok: { color: 'hsl(var(--success))' },
  dim: { color: 'hsl(var(--muted-foreground))' },
};

const FRESH_STALE_S = 180;

const CLS = {
  desktop: {
    card: 'rounded-md border border-border bg-card p-3 flex flex-col gap-1.5 min-w-0',
    title: 'text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2',
    row: 'flex items-baseline gap-2 text-xs min-w-0',
    // Fixed tracks, so the age/lane/kind/note columns start at one x on every row and a long cell clips (full text in its title) instead of wrapping.
    rowJob: 'grid grid-cols-[1rem_3.25rem_minmax(0,1fr)_5rem] items-baseline gap-2 text-xs min-w-0 [&>*]:min-w-0 [&>*]:truncate',
    rowReady: 'grid grid-cols-[1rem_minmax(0,3fr)_3.5rem_minmax(0,2fr)] items-baseline gap-2 text-xs min-w-0 [&>*]:min-w-0 [&>*]:truncate',
    text: 'truncate',
    mono: 'font-mono text-[11px]',
    note: 'text-[11px] text-muted-foreground',
    list: 'flex flex-col gap-1.5 max-h-[26rem] overflow-auto',
  },
  mobile: {
    card: 'm-fleet-card',
    title: 'm-section-title',
    row: 'm-fleet-row',
    rowJob: 'm-fleet-row',
    rowReady: 'm-fleet-row',
    text: 'm-fleet-text',
    mono: 'm-fleet-mono',
    note: 'm-fleet-note',
    list: 'm-fleet-list',
  },
};

function Card({ id, title, extra, fresh, cls, children }) {
  return (
    <section className={cls.card} data-testid={`fleet-${id}`}>
      <h3 className={cls.title}>{title}{extra ? <span style={TONE.dim}>{extra}</span> : null}{fresh ? <Freshness ts={fresh} staleAfterS={FRESH_STALE_S} className="ml-auto normal-case font-normal tracking-normal" /> : null}</h3>
      {children}
    </section>
  );
}

/** A failing inner source: its own card, its own reason. */
function Unavailable({ id, title, reason, cls }) {
  return (
    <Card id={id} title={title} cls={cls}>
      <div className={cls.note} data-testid={`fleet-unavailable-${id}`} style={TONE.yellow}>unavailable: {reason}</div>
    </Card>
  );
}

/**
 * An sm_status panel (`fresh` is the SOURCE's ms `ts`; the panel's own `ts` is epoch seconds and is not used): rows, an unavailable card, or (sm_status's partial read: error AND value, sm_status.py
 * Source.refresh UncertainSource) the readable rows under an "unknown" note, as a lower bound, like its TUI.
 */
function panelOr(panel, id, title, cls, render, fresh) {
  if (!panel) return null;
  if (panel.error != null && panel.value != null) {
    const card = React.cloneElement(render(panel.value), { fresh });
    return React.cloneElement(card, {}, (
      <div className={cls.note} data-testid={`fleet-partial-${id}`} style={TONE.yellow}>
        unknown: {panel.error} (rows shown are a lower bound)
      </div>
    ), card.props.children);
  }
  if (panel.value == null) {
    return <Unavailable key={id} id={id} title={title} reason={panel.error ?? 'no data'} cls={cls} />;
  }
  return React.cloneElement(render(panel.value), { fresh });
}

const MAX_ROWS = { desktop: 400, mobile: 40 };

function More({ total, shown, cls }) {
  return total > shown ? <div className={cls.note}>+{total - shown} more</div> : null;
}

/** The "Waiting on the owner" card: rows, an unavailable card, or the partial-read note. Shared with the Process view (COMP-COCKPIT-13). */
export function OwnerQueueCard({ data, variant = 'desktop' }) {
  const cls = CLS[variant] ?? CLS.desktop;
  return panelOr(smPanel(data, 'queue'), 'owner', 'Waiting on the owner', cls, (rows) => (
    <Card key="owner" id="owner" title="Waiting on the owner" extra={rows.length ? String(rows.length) : null} cls={cls}>
      {rows.length === 0 && <div className={cls.note}>No open questions</div>}
      {rows.map((q) => (
        <div key={q.id} className={cls.row}>
          <span className={cls.mono} style={TONE.yellow}>{fmtAge(q.age)}</span>
          <span className={cls.mono} style={TONE.dim}>{q.by}</span>
          <span className={cls.text} title={q.text}>{q.text}</span>
        </div>
      ))}
    </Card>
  ), data?.sources?.sm_status?.ts);
}

/** Skeleton cards for the first /api/fleet answer: a loading card is never a zero. */
export function FleetSkeleton({ variant = 'desktop', count = 6 }) {
  const cls = CLS[variant] ?? CLS.desktop;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <section key={i} className={cls.card} data-testid="fleet-skeleton-card" aria-busy="true">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </section>
      ))}
    </>
  );
}

export default function FleetPanels({ data, variant = 'desktop' }) {
  const cls = CLS[variant] ?? CLS.desktop;
  const cap = MAX_ROWS[variant] ?? 400;
  const out = [];
  const smTs = data?.sources?.sm_status?.ts;

  out.push(<OwnerQueueCard key="owner-queue" data={data} variant={variant} />);

  out.push(panelOr(smPanel(data, 'sessions'), 'sessions', 'Sessions', cls, (rows) => (
    <Card key="sessions" id="sessions" title="Sessions" extra={String(rows.length)} cls={cls}>
      {rows.map((s, i) => {
        const level = ctxLevel(s.ctx);
        return (
          <div key={s.session_id ?? `${s.name}-${i}`} className={cls.row} data-testid="fleet-session-row">
            <span style={s.busy ? TONE.ok : TONE.dim} title={s.busy ? 'busy' : s.busy === false ? 'idle' : 'unknown'}>
              {s.busy ? '●' : '○'}
            </span>
            <span className={cls.text}>{s.name}</span>
            <span className={cls.mono} data-ctx={level ?? 'ok'} style={level ? TONE[level] : TONE.dim}>{fmtK(s.ctx)}</span>
            {s.error && <span className={cls.note} style={TONE.yellow}>{s.error}</span>}
          </div>
        );
      })}
    </Card>
  ), smTs));

  out.push(panelOr(smPanel(data, 'jobs'), 'jobs', 'Open jobs', cls, (rows) => {
    const sorted = sortJobs(rows).slice(0, cap);
    return (
      <Card key="jobs" id="jobs" title="Open jobs" extra={String(rows.length)} cls={cls}>
        <div className={cls.list}>
        {sorted.map((j) => (
          <div key={`${j.session}/${j.id}`} className={cls.rowJob} data-testid="fleet-job-row">
            <span
              style={j.alive === true ? TONE.ok : j.alive === false ? TONE.red : TONE.dim}
              title={`alive: ${j.alive ?? 'unknown'} (from ${j.aliveFrom ?? 'sm_status'})`}
              data-alive-from={j.aliveFrom}
            >{j.alive === true ? '●' : j.alive === false ? '✕' : '·'}</span>
            <span className={cls.mono}>{fmtAge(j.age)}</span>
            <span className={cls.text}>{j.session} / <UnitName id={j.id} compact /></span>
            <span className={cls.mono} style={TONE.dim} title={j.kind}>{j.kind}</span>
          </div>
        ))}
        </div>
        <More total={rows.length} shown={sorted.length} cls={cls} />
      </Card>
    );
  }, smTs));

  if (readerUp(data, 'stratum')) {
    const f = data.sources.stratum.value;
    out.push(
      <Card key="stratum" id="stratum" title="Detached fleet (Stratum)" extra={`${f.count ?? '?'} / ${f.max ?? '?'}`} fresh={data.sources.stratum.ts} cls={cls}>
        {f.jobs.length === 0 && <div className={cls.note}>No alive detached jobs</div>}
        {f.jobs.map((j, i) => (
          <div key={`${j.pid ?? 'nopid'}-${i}`} className={cls.row}>
            <span style={TONE.ok}>●</span>
            <span className={cls.text}>{j.session}</span>
            <span className={cls.mono} style={TONE.dim}>{j.label}</span>
          </div>
        ))}
      </Card>,
    );
  }

  const df = smPanel(data, 'df');
  const spend = smPanel(data, 'spend');
  const ceiling = smPanel(data, 'ceiling');
  if (df) {
    out.push(panelOr(df, 'disk', 'Disk', cls, (v) => (
      <Card key="disk" id="disk" title="Disk" cls={cls}>
        <div className={cls.row}>
          <span className={cls.mono} style={v.free_gb < DISK_RED_GB ? TONE.red : TONE.ok}>{Math.floor(v.free_gb)} GB free</span>
          <span className={cls.note}>{v.pct} used</span>
        </div>
      </Card>
    ), smTs));
    out.push(panelOr(spend, 'spend', 'Hourly spend', cls, (v) => (
      <Card key="spend" id="spend" title="Hourly spend" cls={cls}>
        <div className={cls.row}><span className={cls.text}>{v.head}</span></div>
        {(v.rows ?? []).map((r) => <div key={r} className={cls.note}>{r}</div>)}
      </Card>
    ), smTs));
    out.push(panelOr(ceiling, 'ceiling', 'Spend today', cls, (v) => (
      <Card key="ceiling" id="ceiling" title="Spend today" cls={cls}>
        <div className={cls.row}><span className={cls.text} style={v.warn ? TONE.yellow : undefined}>{v.line}</span></div>
      </Card>
    ), smTs));
  }

  if (readerUp(data, 'cadence')) {
    const c = data.sources.cadence.value;
    const ready = sortReady(c.ready);
    const shown = ready.slice(0, cap);
    out.push(
      <Card key="cadence" id="cadence" title="Ready units (Cadence)" extra={String(ready.length)} fresh={data.sources.cadence.ts} cls={cls}>
        <div className={cls.note} data-testid="fleet-proposed">{proposedLine(c)}</div>
        {c.wouldLaunch?.error && <div className={cls.note} style={TONE.yellow}>unavailable: {c.wouldLaunch.error}</div>}
        {c.errors?.length > 0 && <div className={cls.note} style={TONE.yellow}>unavailable: {c.errors[0]}</div>}
        <div className={cls.list}>
        {shown.map((u) => (
          <div key={`${u.lane}/${u.id}`} className={cls.rowReady} data-testid="fleet-ready-row">
            <span style={u.decision === 'launchable' ? TONE.ok : TONE.dim}>{u.decision === 'launchable' ? '▶' : '·'}</span>
            <span className={cls.text}><UnitName id={u.id} lane={u.lane} compact /></span>
            <span className={cls.mono} style={TONE.dim}>{u.lane}</span>
            <span className={cls.note} title={blockerReasons(u)}>{blockerReasons(u)}</span>
          </div>
        ))}
        </div>
        <More total={ready.length} shown={shown.length} cls={cls} />
      </Card>,
    );
  }

  out.push(panelOr(smPanel(data, 'ledger'), 'ledger', 'Ledger tail', cls, (lines) => (
    <Card key="ledger" id="ledger" title="Ledger tail" cls={cls}>
      <div className={cls.list}>
      {(Array.isArray(lines) ? lines : []).map((l, i) => <div key={i} className={`${cls.note} ${cls.mono}`} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l}</div>)}
      </div>
    </Card>
  ), smTs));

  return <>{out.filter(Boolean)}</>;
}
