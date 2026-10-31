import React, { useEffect, useRef } from 'react';
import { Fig } from './KpiTiles.jsx';
import UnitName from '@/components/shared/UnitName.jsx';

/**
 * DetailsDrawer — the right-side drawer behind the tiles' "details" and the rollup rows' "basis" (POLISH).
 * It stays mounted while closed (`hidden`), so every figure it carries keeps one element in the page. Opens on a
 * section (`focus`), closes on Escape or the close button, and hands focus back to the control that opened it.
 */

const NOTE = 'text-[11px] text-muted-foreground';
const SECTIONS = [
  ['waiting_share', 'Waiting share'],
  ['first_pass_clean', 'First-pass CLEAN rate'],
  ['review_rounds', 'Review rounds per unit'],
  ['gate_minutes', 'Gate minutes per land'],
  ['standard', 'Standard-process feeds'],
];

function Basis({ id, text }) {
  return text ? <p className={NOTE} data-testid={`basis-${id}`}>{text}</p> : null;
}

function Section({ id, title, children }) {
  return (
    <section id={`process-drawer-${id}`} className="flex flex-col gap-1.5 border-b border-border pb-3 scroll-mt-2" tabIndex={-1}>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

const staleText = (s) => `stale: ${typeof s === 'string' ? s : 'the builder marks this figure stale'}`;

/** Extra rows per section: the last 5 lands for gate minutes, the feed breakdown for the standard process. */
function Extra({ k, f, v }) {
  if (k === 'gate_minutes') {
    return (
      <div className="flex flex-col gap-0.5" data-testid={`fig-${f('gate_minutes-last5')}`}>
        <span className={NOTE}>last 5 lands (unit, gate minutes)</span>
        {(Array.isArray(v.last5) ? v.last5 : []).map(([unit, min], i) => (
          <div key={`${unit}-${i}`} className="flex justify-between gap-2 font-mono text-xs">
            <span data-testid={`val-${f('gate_minutes-last5')}-${i}-unit`}><UnitName id={String(unit)} /></span>
            <span><span data-testid={`val-${f('gate_minutes-last5')}-${i}-min`}>{String(min)}</span> <span className="text-muted-foreground">min</span></span>
          </div>
        ))}
      </div>
    );
  }
  if (k === 'standard') {
    return (
      <div className="flex flex-col gap-1 text-xs">
        <Fig id={f('standard-review_files')} label="units with a first-round verdict" value={v.review_files} />
        <Fig id={f('standard-gate_runs')} label="gate runs" value={v.gate_runs} />
        <Fig id={f('standard-gate_passes')} label="gate passes" value={v.gate_passes} />
      </div>
    );
  }
  return null;
}

function PageSections({ name, summary, pace }) {
  const f = (k) => `${name}-${k}`;
  const nd = summary.no_data ?? {};
  return (<>
    {SECTIONS.map(([k, title]) => {
      const v = summary[k];
      return (
        <Section key={k} id={k} title={title}>
          {v == null ? <p className={NOTE}>{nd[k] ?? 'not reported'}</p> : (<>
            {v.stale ? <p className={NOTE} style={{ color: 'hsl(var(--warning))' }}>{staleText(v.stale)}</p> : null}
            <Extra k={k} f={f} v={v} />
            <Basis id={f(k)} text={v.basis} />
          </>)}
        </Section>
      );
    })}
    {pace != null ? (
      <Section id="pace" title="Measured pace">
        <p className="font-mono text-xs">{pace}</p>
      </Section>
    ) : null}
  </>);
}

function RollupBasis({ table }) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  if (!rows.some((r) => (r.basis ?? []).length)) return null;
  return (
    <Section id="rollup-basis" title="How each rollup row is measured">
      {rows.map((r, ri) => ((r.basis ?? []).length > 0 ? (
        <div key={`${r.measure}-${ri}`} id={`process-drawer-rollup-${ri}`} className="flex flex-col gap-0.5 scroll-mt-2" data-testid={`rollup-basis-${ri}`} tabIndex={-1}>
          <span className="text-xs font-medium">{r.measure}</span>
          {r.basis.map((b, bi) => <span key={bi} className={NOTE}>{b}</span>)}
        </div>
      ) : null))}
    </Section>
  );
}

/** `open`, `focus` (a section id), `name`/`label`/`summary` for the selected page (summary may be null). */
export default function DetailsDrawer({ open, focus, onClose, name, label, summary, pace, table }) {
  const ref = useRef(null);
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const target = ref.current?.querySelector(`[id="process-drawer-${focus ?? ''}"]`) ?? ref.current?.querySelector('[data-drawer-close]');
    target?.scrollIntoView?.({ block: 'start' });
    target?.focus?.({ preventScroll: true });
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener.current?.isConnected) opener.current.focus?.();
    };
  }, [open, focus, onClose]);
  return (
    <aside ref={ref} hidden={!open} role="dialog" aria-modal="false" aria-label={`Details: ${label ?? name ?? 'process'}`}
      className={`fixed bottom-0 right-0 top-0 z-40 ${open ? 'flex' : 'hidden'} w-[420px] max-w-[90vw] flex-col border-l border-border bg-background shadow-2xl`}
      data-testid="process-drawer">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h3 className="truncate text-sm font-semibold">Details · {label ?? name ?? 'no page selected'}</h3>
        <button type="button" data-drawer-close onClick={onClose} aria-label="Close details"
          className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring">Close (Esc)</button>
      </header>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {summary ? <PageSections name={name} summary={summary} pace={pace} /> : <p className={NOTE}>No summary.json for this page.</p>}
        <RollupBasis table={table} />
      </div>
    </aside>
  );
}
