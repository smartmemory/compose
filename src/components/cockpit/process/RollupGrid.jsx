import React, { useState } from 'react';
import { StateBadge, Tip } from './ProcessBadge.jsx';
import { TONES, rowCells } from './processTones.js';
import { pageMarker } from '../processLogic.js';

/**
 * RollupGrid — P8, the builder's master process table as a heat grid (POLISH). Each cell shows a headline taken
 * from its own text plus a mini bar, coloured by rank within its row; the verbatim cell text is the tooltip
 * (`rollup-cell-*`). "Expand to table" swaps in the verbatim table with the same ids. A column header selects that
 * page for the tiles above.
 * COMP-COCKPIT-FLEET-PROJECTS-1: `order` (the Fleet PROJECTS list) picks and orders the columns shown; each column
 * still reads its own builder column (`names` index), and the row colours rank across every lane the builder wrote.
 */

const NOT_REPORTED = 'not reported';
const NOTE = 'text-[11px] text-muted-foreground';
const bad = { color: 'hsl(var(--destructive))' };

/** "2026-10-30 22:53 local" -> "22:53 local": a substring for the narrow header; the full text is the title. */
const shortTime = (s) => String(s).match(/\d{1,2}:\d{2}(?::\d{2})?(?:\s*local)?/)?.[0] ?? String(s);

const MARKER_STATE = { stale: 'stale', 'build failed': 'failed', unavailable: 'failed', 'no summary': 'missing' };
const MARKER_TIP = {
  stale: 'this page has not been rebuilt for two builder ticks: showing its last output',
  unavailable: 'this page could not be read',
  'no summary': 'no summary.json for this page',
};

function ColHeader({ n, label, page, proj, selected, onSelect, align }) {
  const m = pageMarker(page);
  const asOf = page?.asOf ?? proj?.as_of ?? 'unknown';
  const failedTip = page?.failed ? `failed ${page.failed.time}: ${page.failed.reason}` : null;
  return (
    <th scope="col" className="min-w-0 p-0 text-left align-top font-normal" data-testid={`process-col-${n}`}>
      <div className={`flex h-full flex-col gap-0.5 rounded-md px-2 py-1.5 ${selected ? 'ring-1 ring-inset ring-primary' : ''}`}
        style={selected ? { background: 'hsl(var(--primary) / 0.1)' } : undefined}>
        <button type="button" onClick={() => onSelect(n)} aria-pressed={selected}
          className="truncate text-left text-[12px] font-medium hover:underline focus:outline-none focus-visible:underline">{label}</button>
        <span className="truncate font-mono text-[10px] text-muted-foreground" title={`as of ${asOf}`}>as of {shortTime(asOf)}</span>
        {m ? (
          <span className="mt-0.5">
            <StateBadge state={MARKER_STATE[m] ?? 'missing'} label={m} labelTestId="process-col-marker"
              tip={failedTip ?? page?.error ?? MARKER_TIP[m]} tipStyle={failedTip ? bad : undefined} align={align} />
          </span>
        ) : null}
      </div>
    </th>
  );
}

function HeatCell({ text, info, testId, selected, align }) {
  const t = TONES[info.tone] ?? TONES.neutral;
  return (
    <td className="p-0 align-top">
      <Tip tip={text ?? NOT_REPORTED} tipTestId={testId} as="div" align={align}
        className={`flex h-full min-h-[44px] cursor-default flex-col justify-center gap-1 rounded px-2 py-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${selected ? 'ring-1 ring-inset ring-primary/40' : ''}`}>
        <span className="absolute inset-0 rounded" style={info.state === 'missing' ? { boxShadow: 'inset 0 0 0 1px hsl(var(--border))' } : t.cell} aria-hidden="true" />
        <span className={`relative flex items-center gap-1 truncate font-mono text-[12px] ${info.state === 'missing' ? 'text-muted-foreground' : 'text-foreground'}`} aria-hidden="true">
          <span className="truncate">{info.head}</span>
          {info.state === 'stale' ? <span className="text-[9px] font-sans font-semibold uppercase" style={TONES.stale.badge}>&nbsp;stale&nbsp;</span> : null}
        </span>
        {info.width != null ? (
          <span className="relative h-1 w-full rounded" style={{ background: 'hsl(var(--muted))' }} aria-hidden="true">
            <span className="absolute inset-y-0 left-0 rounded" style={{ ...t.bar, width: `${info.width}%` }} />
          </span>
        ) : null}
      </Tip>
    </td>
  );
}

export default function RollupGrid({ table, names, order, pages, selected, onSelect, onBasis }) {
  const [expanded, setExpanded] = useState(false);
  const projects = Array.isArray(table?.projects) ? table.projects : [];
  const rows = table.rows ?? [];
  const cols = order ?? names;
  const at = (n) => names.indexOf(n);
  // Tips on the right half open leftwards so a hidden tip never widens the page.
  const side = (ci) => (ci >= Math.floor(cols.length / 2) ? 'right' : 'left');
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3" data-testid="process-rollup">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Lane comparison</h3>
        <span className={NOTE}>{expanded ? "the builder's master process table, verbatim" : 'colour = rank within the row, best to worst; hover a cell for the exact text; click a lane to select it'}</span>
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} data-testid="process-rollup-expand"
          className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {expanded ? 'Back to grid' : 'Expand to table'}
        </button>
      </div>
      <div className={expanded ? 'max-h-[60vh] overflow-auto' : undefined}>
        <table className="w-full table-fixed border-separate text-xs" style={{ borderSpacing: 2 }} data-testid="process-rollup-table">
          <colgroup>
            <col style={{ width: 168 }} />
            {cols.map((n) => <col key={n} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="p-1 text-left align-bottom text-[10px] font-normal uppercase tracking-wider text-muted-foreground">measure</th>
              {cols.map((n, ci) => {
                const proj = projects.find((p) => p.name === n);
                return <ColHeader key={n} n={n} label={proj?.label ?? n} page={pages?.[n]} proj={proj} selected={n === selected} onSelect={onSelect} align={side(ci)} />;
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const infos = rowCells(r.measure, r.cells);
              return (
                <tr key={`${r.measure}-${ri}`} className="align-top">
                  <th scope="row" className="px-1 py-1.5 text-left text-[12px] font-normal leading-snug" data-testid={`rollup-measure-${ri}`}>
                    {r.measure}
                    {(r.basis ?? []).length > 0 ? (
                      <button type="button" onClick={() => onBasis(ri)} className="ml-1 rounded text-[10px] text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        aria-label={`basis for ${r.measure}`}>basis</button>
                    ) : null}
                  </th>
                  {cols.map((n, ci) => (expanded ? (
                    <td key={n} className="break-words border-t border-border p-1.5 font-mono text-[11px] leading-snug" data-testid={`rollup-cell-${ri}-${ci}`}>{r.cells?.[at(n)] ?? NOT_REPORTED}</td>
                  ) : (
                    <HeatCell key={n} text={r.cells?.[at(n)]} info={infos[at(n)] ?? { head: NOT_REPORTED, tone: 'missing', state: 'missing', width: null }}
                      testId={`rollup-cell-${ri}-${ci}`} selected={n === selected} align={side(ci)} />
                  )))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {table.note ? <div className={NOTE} data-testid="rollup-note">{table.note}</div> : null}
    </section>
  );
}
