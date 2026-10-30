import React, { useState } from 'react';
import { useProcess } from '../../lib/processPoller.js';
import { useFleet } from '../../lib/fleetPoller.js';
import { OwnerQueueCard } from './FleetPanels.jsx';
import {
  BUCKETS, NOT_RECORDED, PANELS, bucketText, pageMarker, splitSummary,
} from './processLogic.js';

/**
 * ProcessView — the read-only Process tab (COMP-COCKPIT-13 U2): how unit work has been flowing, per lane.
 * P8 the builder's master process table (cells verbatim from `process.json`), P1-P5 one page's figures
 * (verbatim from its `summary.json`), P6 the stamps-derived time split, P7 the owner queue (the Fleet card).
 * Every figure comes from GET /api/process or GET /api/fleet; nothing here computes a builder figure and no
 * unknown is rendered as 0. Colours come from the index.css tokens.
 */

const dim = { color: 'hsl(var(--muted-foreground))' };
const warn = { color: 'hsl(var(--warning))' };
const bad = { color: 'hsl(var(--destructive))' };
const CARD = 'rounded-md border border-border bg-card p-3 flex flex-col gap-1.5 min-w-0';
const TITLE = 'text-[10px] font-semibold uppercase tracking-wider text-muted-foreground';
const NOTE = 'text-[11px] text-muted-foreground';
const NOT_REPORTED = 'not reported';

function Card({ id, title, children }) {
  return (
    <section className={CARD} data-testid={`process-${id}`}>
      <h3 className={TITLE}>{title}</h3>
      {children}
    </section>
  );
}

function Unavailable({ id, title, reason }) {
  return (
    <Card id={id} title={title}>
      <div className={NOTE} style={warn} data-testid={`process-unavailable-${id}`}>unavailable: {reason}</div>
    </Card>
  );
}

/** One figure: the value verbatim in its own element (the agreement test reads it), a missing key says so. */
function Fig({ id, label, value, suffix }) {
  const missing = value === undefined || value === null;
  return (
    <div className="flex items-baseline gap-2 text-xs" data-testid={`fig-${id}`}>
      <span style={dim}>{label}</span>
      <span className="font-mono" data-testid={`val-${id}`}>{missing ? NOT_REPORTED : String(value)}</span>
      {!missing && suffix ? <span style={dim}>{suffix}</span> : null}
    </div>
  );
}

function Basis({ id, text }) {
  return text ? <div className={NOTE} data-testid={`basis-${id}`}>{text}</div> : null;
}

/** The empty text for a panel: the builder's `no_data.<key>` verbatim, else "not reported". */
function Empty({ id, text }) {
  return <div className={NOTE} style={text ? undefined : warn} data-testid={`empty-${id}`}>{text ?? NOT_REPORTED}</div>;
}

function StaleLine({ id, text }) {
  // The builder writes the reason as text, or `true` when the config carries none (real 2.0 summary.json today).
  if (!text) return null;
  return <div className={NOTE} style={warn} data-testid={`stale-${id}`}>stale: {typeof text === 'string' ? text : 'the builder marks this figure stale'}</div>;
}

function PagePanels({ name, summary }) {
  const nd = summary.no_data ?? {};
  const f = (k) => `${name}-${k}`;
  const present = (k) => summary[k] !== undefined && summary[k] !== null;
  const ws = summary.waiting_share, fp = summary.first_pass_clean, rr = summary.review_rounds;
  const gm = summary.gate_minutes, st = summary.standard;
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', alignItems: 'start' }}>
      <Card id={f('waiting_share')} title="Waiting share">
        {present('waiting_share') ? (<>
          <Fig id={f('waiting_share-pct')} label="share" value={ws.pct} suffix="%" />
          <StaleLine id={f('waiting_share')} text={ws.stale} />
          <Basis id={f('waiting_share')} text={ws.basis} />
          <Fig id={f('waiting_units_stamped')} label="units stamped" value={summary.waiting_units_stamped} />
        </>) : <Empty id={f('waiting_share')} text={nd.waiting_share} />}
      </Card>
      <Card id={f('first_pass_clean')} title="First-pass CLEAN rate">
        {present('first_pass_clean') ? (<>
          <Fig id={f('first_pass_clean-clean')} label="clean" value={fp.clean} />
          <Fig id={f('first_pass_clean-total')} label="reviewed" value={fp.total} />
          <Basis id={f('first_pass_clean')} text={fp.basis} />
        </>) : <Empty id={f('first_pass_clean')} text={nd.first_pass_clean} />}
      </Card>
      <Card id={f('review_rounds')} title="Review rounds per unit">
        {present('review_rounds') ? (<>
          <Fig id={f('review_rounds-median')} label="median" value={rr.median} />
          <Fig id={f('review_rounds-max')} label="max" value={rr.max} />
          <Fig id={f('review_rounds-n')} label="units" value={rr.n} />
          <Basis id={f('review_rounds')} text={rr.basis} />
        </>) : <Empty id={f('review_rounds')} text={nd.review_rounds} />}
      </Card>
      <Card id={f('gate_minutes')} title="Gate minutes per land">
        {present('gate_minutes') ? (<>
          <Fig id={f('gate_minutes-day')} label="day" value={gm.day} />
          <Fig id={f('gate_minutes-lands')} label="lands" value={gm.lands} />
          <Fig id={f('gate_minutes-median')} label="median" value={gm.median} suffix="min" />
          <Fig id={f('gate_minutes-max')} label="max" value={gm.max} suffix="min" />
          <div className="flex flex-col gap-0.5" data-testid={`fig-${f('gate_minutes-last5')}`}>
            <span className={NOTE}>last 5</span>
            {(Array.isArray(gm.last5) ? gm.last5 : []).map(([unit, min], i) => (
              <div key={`${unit}-${i}`} className="flex gap-2 text-xs font-mono">
                <span data-testid={`val-${f('gate_minutes-last5')}-${i}-unit`}>{String(unit)}</span>
                <span data-testid={`val-${f('gate_minutes-last5')}-${i}-min`}>{String(min)}</span>
              </div>
            ))}
          </div>
          <StaleLine id={f('gate_minutes')} text={gm.stale} />
          <Basis id={f('gate_minutes')} text={gm.basis} />
        </>) : <Empty id={f('gate_minutes')} text={nd.gate_minutes} />}
      </Card>
      <Card id={f('standard')} title="Standard-process feeds">
        {present('standard') ? (<>
          <Fig id={f('standard-with')} label="units stamped, with" value={st.stamps?.with} />
          <Fig id={f('standard-of')} label="of" value={st.stamps?.of} />
          <Fig id={f('standard-review_files')} label="units with a first-round verdict" value={st.review_files} />
          <Fig id={f('standard-gate_runs')} label="gate runs" value={st.gate_runs} />
          <Fig id={f('standard-gate_passes')} label="gate passes" value={st.gate_passes} />
        </>) : <Empty id={f('standard')} text={nd.standard} />}
      </Card>
    </div>
  );
}

function Marker({ page }) {
  const m = pageMarker(page);
  if (!m) return null;
  return <span style={m === 'stale' ? warn : bad} data-testid="process-col-marker">{m}</span>;
}

/** P8: measures x pages, cells verbatim; a header click selects that page's detail. */
function Rollup({ table, names, pages, selected, onSelect }) {
  const projects = Array.isArray(table?.projects) ? table.projects : [];
  return (
    <Card id="rollup" title="Rollup (the builder's master process table)">
      <div className="overflow-auto">
        <table className="text-xs border-collapse w-full" data-testid="process-rollup-table">
          <thead>
            <tr>
              <th className="text-left p-1 font-normal" style={dim}>measure</th>
              {names.map((n) => {
                const page = pages?.[n];
                const proj = projects.find((p) => p.name === n);
                return (
                  <th key={n} className="text-left p-1 font-normal align-top" data-testid={`process-col-${n}`}>
                    <button type="button" onClick={() => onSelect(n)} className="underline-offset-2 hover:underline"
                      style={n === selected ? { fontWeight: 600 } : undefined} aria-pressed={n === selected}>{proj?.label ?? n}</button>
                    <div className={NOTE}>as of {page?.asOf ?? proj?.as_of ?? 'unknown'}</div>
                    {page?.failed ? <div className={NOTE} style={bad}>failed {page.failed.time}: {page.failed.reason}</div> : null}
                    <Marker page={page} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(table.rows ?? []).map((r, ri) => (
              <tr key={`${r.measure}-${ri}`} className="border-t border-border align-top">
                <td className="p-1" data-testid={`rollup-measure-${ri}`}>
                  {r.measure}
                  {(r.basis ?? []).length > 0 && (
                    <details className={NOTE} data-testid={`rollup-basis-${ri}`}>
                      <summary>basis</summary>
                      {r.basis.map((b, bi) => <div key={bi}>{b}</div>)}
                    </details>
                  )}
                </td>
                {names.map((n, ci) => (
                  <td key={n} className="p-1 font-mono text-[11px]" data-testid={`rollup-cell-${ri}-${ci}`}>{r.cells?.[ci] ?? NOT_REPORTED}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.note ? <div className={NOTE} data-testid="rollup-note">{table.note}</div> : null}
    </Card>
  );
}

function TimeSplit({ stamps }) {
  if (!stamps || stamps.value == null) {
    return <Unavailable id="p6" title="Time split" reason={stamps?.error ?? 'no stamps source'} />;
  }
  const lanes = Object.entries(stamps.value.lanes ?? {});
  return (
    <Card id="p6" title="Time split per lane (from unit stamps)">
      <div className="overflow-auto">
        <table className="text-xs border-collapse w-full" data-testid="process-p6-table">
          <thead>
            <tr>
              <th className="text-left p-1 font-normal" style={dim}>lane</th>
              {BUCKETS.map(([k, l]) => <th key={k} className="text-left p-1 font-normal" style={dim}>{l}</th>)}
              <th className="text-left p-1 font-normal" style={dim}>escalation, other</th>
              <th className="text-left p-1 font-normal" style={dim}>units</th>
            </tr>
          </thead>
          <tbody>
            {lanes.map(([lane, l]) => (
              <tr key={lane} className="border-t border-border align-top" data-testid={`p6-lane-${lane}`}>
                <td className="p-1 font-mono">{lane}</td>
                {l.error || !l.timeSplit ? (
                  <td className="p-1" colSpan={BUCKETS.length + 2} style={warn} data-testid={`p6-error-${lane}`}>unavailable: {l.error ?? 'no time split'}</td>
                ) : (<>
                  {BUCKETS.map(([k]) => <td key={k} className="p-1 font-mono text-[11px]" data-testid={`p6-${lane}-${k}`}>{bucketText(l.timeSplit, k)}</td>)}
                  <td className="p-1 text-[11px]" style={dim}>{NOT_RECORDED}</td>
                  <td className="p-1 text-[11px]" data-testid={`p6-units-${lane}`}>{splitSummary(l.timeSplit)}
                    {l.warnings?.length ? <span style={warn}> ({l.warnings.length} warning{l.warnings.length === 1 ? '' : 's'})</span> : null}</td>
                </>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={NOTE}>Job buckets can overlap; waiting cannot. Lane totals sum known units only. An unknown unit adds to no bucket.</div>
    </Card>
  );
}

export default function ProcessView() {
  const { data, error, loading } = useProcess();
  const fleet = useFleet();
  const [picked, setPicked] = useState(null);
  if (loading && !data) return <div className="p-4 text-xs text-muted-foreground" data-testid="process-loading">Loading process metrics…</div>;

  const builder = data?.sources?.builder;
  const stamps = data?.sources?.stamps;
  const bv = builder?.value ?? null;
  const pages = bv?.pages ?? {};
  const table = bv?.table ?? null;
  const names = table ? (table.projects ?? []).map((p) => p.name) : Object.keys(pages);
  const selected = names.includes(picked) ? picked : names[0] ?? null;
  const page = selected ? pages[selected] : null;

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2" data-testid="process-view">
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span>Read-only. How unit work has been flowing, per lane.</span>
        {data?.generated && <span>as of {new Date(data.generated).toLocaleTimeString()}</span>}
        {error && <span style={warn} data-testid="process-poll-error">last poll failed: {error}</span>}
        {builder?.stale && <span style={warn}>builder source: serving cached copy</span>}
        {stamps?.stale && <span style={warn}>stamps source: serving cached copy</span>}
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 340px)', alignItems: 'start' }}>
        <div className="flex flex-col gap-2 min-w-0">
          {!bv ? (
            <Unavailable id="builder" title="Rollup and per-page figures" reason={builder?.error ?? (error ? 'process route not reachable' : 'no builder source')} />
          ) : (<>
            {table ? (
              <Rollup table={table} names={names} pages={pages} selected={selected} onSelect={setPicked} />
            ) : (
              <Card id="rollup-missing" title="Rollup">
                <div className={NOTE} style={warn} data-testid="process-rollup-missing-text">
                  Rollup unavailable: the builder has not written process.json (OPS-STATUS-PROCESS-JSON-1){bv.tableError ? `: ${bv.tableError}` : ''}
                </div>
              </Card>
            )}
            {selected && (
              page?.value ? (
                <section className="flex flex-col gap-2" data-testid={`process-page-${selected}`}>
                  <h3 className={TITLE}>{page.value.label ?? selected}, as of {page.asOf ?? 'unknown'} {pageMarker(page) ? `(${pageMarker(page)})` : ''}</h3>
                  {page.failed ? <div className={NOTE} style={bad} data-testid="process-page-failed">build failed {page.failed.time}: {page.failed.reason} (figures are the last good build)</div> : null}
                  <PagePanels name={selected} summary={page.value} />
                </section>
              ) : <Unavailable id={`page-${selected}`} title={selected} reason={page?.error ?? 'no summary.json for this page'} />
            )}
          </>)}
          <TimeSplit stamps={stamps} />
        </div>
        <div className="flex flex-col gap-2 min-w-0" data-testid="process-owner">
          <OwnerQueueCard data={fleet.data} variant="desktop" />
        </div>
      </div>
    </div>
  );
}
