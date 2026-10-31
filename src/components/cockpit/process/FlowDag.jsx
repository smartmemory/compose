import React from 'react';
import { ROW_SPECS, cellInfo } from './processTones.js';

/**
 * FlowDag — "Flow of work" for the selected lane (COMP-COCKPIT-13-POLISH U5, the mockup's section 5), plain SVG.
 * Units stamped -> round-1 review -> clean first pass / needed fix (fix loop) -> gate runs -> gate passed -> landed
 * per day. Every count is a field GET /api/process already carries for the lane (its summary.json, and the
 * "Measured pace" rollup cell for landed/day); "needed fix" is reviewed minus clean and says so in its tooltip.
 * An edge whose count the builder does not record is dashed and carries no number. Edge width scales with units.
 */

const W = 1220;
const H = 160;
const NW = 130;
const NH = 44;
const MID = 70;
const TOP = 28;
const LOW = 114;
const hsl = (v, a) => (a == null ? `hsl(var(${v}))` : `hsl(var(${v}) / ${a})`);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const PACE = ROW_SPECS.find((s) => s.id === 'pace');

/** Pure: the nodes and edges for one lane, with each count's source. Exported for the tests. */
export function flowModel(summary, paceText) {
  const fp = summary?.first_pass_clean ?? null;
  const st = summary?.standard ?? null;
  const rr = summary?.review_rounds ?? null;
  const reviewed = num(fp?.total);
  const clean = num(fp?.clean);
  const fix = reviewed !== null && clean !== null && reviewed >= clean ? reviewed - clean : null;
  const pace = typeof paceText === 'string' ? cellInfo(PACE, paceText) : null;
  const perDay = pace && pace.state !== 'missing' ? pace.key : null;
  const nodes = [
    { id: 'stamped', title: 'Units stamped', value: num(st?.stamps?.with), x: 0, y: MID, src: 'standard.stamps.with: units with unit stamps' },
    { id: 'review', title: 'Round-1 review', value: reviewed, x: 210, y: MID, src: 'first_pass_clean.total: units with a first-round verdict' },
    { id: 'clean', title: 'Clean first pass', value: clean, x: 450, y: TOP, src: 'first_pass_clean.clean: first-round verdicts that came back clean' },
    { id: 'fix', title: 'Needed fix', value: fix, x: 450, y: LOW, derived: true,
      src: fix === null ? 'derived: reviewed minus clean (not computable, a count is missing)' : `derived: reviewed minus clean (${reviewed} - ${clean}), not a recorded count` },
    { id: 'gate', title: 'Gate runs', value: num(st?.gate_runs), x: 690, y: MID, src: 'standard.gate_runs: landing gate runs in the gate log' },
    { id: 'passed', title: 'Gate passed', value: num(st?.gate_passes), x: 900, y: MID, src: 'standard.gate_passes: gate runs whose result is landed' },
    { id: 'landed', title: 'Landed / day', value: perDay, x: 1090, y: MID,
      src: `Measured pace rollup cell: ${paceText ?? 'not reported'}${pace?.state === 'stale' ? ' (stale)' : ''}` },
  ];
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = [
    { id: 'stamped-review', from: 'stamped', to: 'review', count: reviewed, kind: 'recorded', src: 'units that reached round-1 review (first_pass_clean.total)' },
    { id: 'review-clean', from: 'review', to: 'clean', count: clean, kind: 'recorded', src: 'clean on the first round (first_pass_clean.clean)' },
    { id: 'review-fix', from: 'review', to: 'fix', count: fix, kind: 'derived', src: 'needed a fix: reviewed minus clean (derived, not a recorded count)' },
    { id: 'fix-loop', from: 'fix', to: 'review', count: null, kind: 'not-in-data',
      src: `fix loop: rounds per unit are recorded (median ${rr?.median ?? 'not reported'}, worst ${rr?.max ?? 'not reported'}), the units per loop are not` },
    { id: 'clean-gate', from: 'clean', to: 'gate', count: null, kind: 'not-in-data', src: 'how many clean units reached the gate is not in the data' },
    { id: 'fix-gate', from: 'fix', to: 'gate', count: null, kind: 'not-in-data', src: 'how many fixed units reached the gate is not in the data' },
    { id: 'gate-passed', from: 'gate', to: 'passed', count: num(st?.gate_passes), kind: 'recorded', src: 'gate runs that passed (standard.gate_passes)' },
    { id: 'passed-landed', from: 'passed', to: 'landed', count: null, kind: 'not-in-data', src: 'gate-to-land counts are not in the data (only a landed/day rate is reported)' },
  ].map((e) => (e.count === null && e.kind !== 'not-in-data' ? { ...e, kind: 'not-in-data', src: `${e.src}: not reported for this lane` } : e));
  return { nodes, edges, at, rounds: rr };
}

/** Path from the right edge of `a` to the left edge of `b`; a straight line when level, else an S-curve. */
function link(a, b) {
  const x1 = a.x + NW;
  const x2 = b.x;
  if (a.y === b.y) return { d: `M${x1} ${a.y} L${x2} ${b.y}`, lx: (x1 + x2) / 2, ly: a.y - 7 };
  const mx = (x1 + x2) / 2;
  return { d: `M${x1} ${a.y} C${mx} ${a.y}, ${mx} ${b.y}, ${x2} ${b.y}`, lx: mx - 14, ly: (a.y + b.y) / 2 + (b.y < a.y ? -6 : 14) };
}

export default function FlowDag({ name, label, summary, pace }) {
  const { nodes, edges, at, rounds } = flowModel(summary, pace);
  const max = Math.max(1, ...edges.map((e) => e.count ?? 0));
  const width = (e) => (e.kind === 'not-in-data' ? 1.5 : 2 + (10 * (e.count ?? 0)) / max);
  const id = (k) => `flow-${name}-${k}`;
  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-3" data-testid={`process-flow-${name}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[13px] font-semibold">Flow of work · {label}</h3>
        <span className="text-[11px] text-muted-foreground">edge width = units · dashed = split not recorded · hover a box or line for its source</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Flow of work for ${label}`}>
        {edges.map((e) => {
          if (e.id === 'fix-loop') {
            const f = at.fix;
            const r = at.review;
            return (
              <path key={e.id} data-testid={id(`edge-${e.id}`)} data-kind={e.kind} d={`M${r.x + NW / 2} ${r.y + NH / 2} C${r.x + NW / 2} ${H - 6}, ${f.x - 60} ${H - 6}, ${f.x} ${f.y + 8}`}
                fill="none" stroke={hsl('--warning', 0.8)} strokeWidth={1.5} strokeDasharray="4 4">
                <title>{e.src}</title>
              </path>
            );
          }
          const { d, lx, ly } = link(at[e.from], at[e.to]);
          return (
            <g key={e.id}>
              <path data-testid={id(`edge-${e.id}`)} data-kind={e.kind} d={d} fill="none" strokeWidth={width(e)}
                stroke={e.kind === 'not-in-data' ? hsl('--muted-foreground', 0.55) : hsl('--muted-foreground', 0.7)}
                strokeDasharray={e.kind === 'not-in-data' ? '4 4' : undefined}>
                <title>{e.src}</title>
              </path>
              {e.count !== null ? (
                <text x={lx} y={ly} textAnchor="middle" fontSize="11" className="font-mono" style={{ fill: hsl('--muted-foreground') }}
                  data-testid={id(`edge-val-${e.id}`)}>{e.count}</text>
              ) : null}
            </g>
          );
        })}
        {nodes.map((n) => (
          <g key={n.id} data-testid={id(n.id)} data-derived={n.derived ? 'true' : undefined}>
            <title>{`${n.title}: ${n.value ?? 'not reported'}. Source: ${n.src}`}</title>
            <rect x={n.x} y={n.y - NH / 2} width={NW} height={NH} rx={6} style={{ fill: hsl('--background'), stroke: hsl('--border') }}
              strokeDasharray={n.derived ? '3 2' : undefined} />
            <text x={n.x + 10} y={n.y - 6} fontSize="11" style={{ fill: hsl('--muted-foreground') }}>{n.title}{n.derived ? ' (derived)' : ''}</text>
            <text x={n.x + 10} y={n.y + 14} fontSize={n.value === null ? 12 : 17} fontWeight={n.value === null ? 400 : 600} className="font-mono"
              style={{ fill: n.value === null ? hsl('--muted-foreground') : hsl('--foreground') }} data-testid={id(`val-${n.id}`)}>
              {n.value === null ? 'not reported' : String(n.value)}
            </text>
          </g>
        ))}
        {rounds ? (
          <text x={at.fix.x + 10} y={at.fix.y + NH / 2 + 13} fontSize="10.5" className="font-mono" style={{ fill: hsl('--muted-foreground') }}
            data-testid={id('rounds')}>median {rounds.median ?? 'not reported'}, worst {rounds.max ?? 'not reported'}</text>
        ) : null}
      </svg>
      <p className="text-[11px] text-muted-foreground" data-testid={id('note')}>
        Not in the data: how clean vs fixed units split into gate runs, per-stage time, and gate-to-land counts (only a landed/day rate is reported).
      </p>
    </section>
  );
}
