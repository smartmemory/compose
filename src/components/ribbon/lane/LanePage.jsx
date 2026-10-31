import React, { useEffect, useState } from 'react';
import { ChainGraph } from '@cadence/ui';
import '@cadence/ui/styles.css';
import useCadenceUiAvailable from '../../cockpit/useCadenceUiAvailable.js';
import { createCadenceDataClient } from '../../../lib/clients/cadence.js';
import { tipText, toMs, windowTitle } from '../ribbonLayout.js';
import { SEGMENT_WORD, chainForLane, unitSegments } from './laneLogic.js';

const SEG_CLASS = {
  authoring: 'bg-blue-500', review: 'bg-violet-500', fix_rounds: 'bg-amber-500', gate: 'bg-teal-500',
  waitReview: 'bg-violet-300', waitOwner: 'bg-orange-400', waitGate: 'bg-teal-300', waitQuota: 'bg-rose-300', waitUnknown: 'bg-zinc-400',
  notRecorded: 'bg-transparent border border-dashed border-muted-foreground',
};

/** Legend rows `[segment key, word]`: the page draws these colours and nothing else explains them. */
const LEGEND = [['authoring', 'author'], ['review', 'review'], ['fix_rounds', 'fix'], ['gate', 'gate'], ['waitReview', 'waiting on review'], ['waitOwner', 'waiting on you'], ['notRecorded', 'not recorded']];

function Legend() {
  return (
    <ul className="m-0 mb-2 p-0 list-none flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground" data-testid="lane-legend">
      {LEGEND.map(([k, word]) => <li key={k} className="flex items-center gap-1"><span className={`inline-block h-2.5 w-4 rounded-sm ${SEG_CLASS[k]}`} />{word}</li>)}
      <li className="flex items-center gap-1"><span className="inline-block h-3 w-[3px] bg-foreground" />landed</li>
    </ul>
  );
}
const H = 'm-0 mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground';

const pct = (t, from, to) => Math.min(100, Math.max(0, ((toMs(t) - toMs(from)) / (toMs(to) - toMs(from))) * 100));

function UnitRow({ row, lane, from, to, now }) {
  return (
    <div className="grid grid-cols-[220px_1fr] items-center gap-3 py-1" data-testid="lane-unit-row" data-unit={row.unit || ''}>
      <div className="min-w-0">
        <p className="m-0 text-[13px] text-foreground truncate">{row.title || row.unit || 'not recorded'}</p>
        <p className="m-0 text-[12px] text-muted-foreground truncate">{row.unit || 'no unit'}</p>
      </div>
      <div className="relative h-4 rounded bg-muted" data-testid="lane-unit-track">
        {row.segments.map((s, i) => {
          const left = pct(s.start, from, to);
          const width = Math.max(0.6, pct(s.end, from, to) - left);
          const tip = tipText({ ...s, title: row.title, unit: row.unit, lane: lane.lane, now });
          return <div key={i} className={`absolute top-0 h-4 rounded-sm ${SEG_CLASS[s.key]}`} style={{ left: `${left}%`, width: `${width}%` }}
            title={tip} data-testid={`lane-seg-${s.key}`} aria-label={`${SEGMENT_WORD[s.key]}: ${tip.replace(/\n/g, ', ')}`} />;
        })}
        {[['land', row.landedAt, 'landed'], ['deploy', row.deployedAt, 'deployed'], ['deployFail', row.deployFailedAt, 'deploy failed']].map(([k, at, word]) => at && (
          <div key={k} className={`absolute -top-0.5 h-5 w-[3px] ${k === 'deployFail' ? 'bg-red-600' : 'bg-foreground'}`} style={{ left: `${pct(at, from, to)}%` }}
            title={`${word} · ${row.title || row.unit}`} data-testid={`lane-mark-${k}`} />
        ))}
      </div>
    </div>
  );
}

function ChainBlock({ lane }) {
  const available = useCadenceUiAvailable();
  const [state, setState] = useState({ chains: null, error: null });
  useEffect(() => {
    if (!available) return undefined;
    let live = true;
    createCadenceDataClient().getChains()
      .then((r) => { if (live) setState({ chains: r?.chains || [], error: null }); })
      .catch((e) => { if (live) setState({ chains: null, error: String(e?.message ?? e) }); });
    return () => { live = false; };
  }, [available]);
  let body;
  if (!available) body = <p className="m-0 text-[13px] text-muted-foreground" data-testid="lane-chain-unavailable">Cadence not available</p>;
  else if (state.error) body = <p className="m-0 text-[13px] text-muted-foreground" data-testid="lane-chain-error">Chains could not be read: {state.error}</p>;
  else if (!state.chains) body = <p className="m-0 text-[13px] text-muted-foreground">Reading chains…</p>;
  else {
    const chain = chainForLane(lane, state.chains);
    body = chain
      ? <div className={`cb-root${document.documentElement.classList.contains('dark') ? ' dark' : ''}`} data-testid="lane-chain-graph"><p className="m-0 mb-1 text-[12px] text-muted-foreground">{chain.title || chain.unit}</p><ChainGraph chain={chain} /></div>
      : <p className="m-0 text-[13px] text-muted-foreground" data-testid="lane-chain-none">Chains: not linked to lanes yet. See Fleet › Cadence.</p>;
  }
  return <section className="py-3" data-testid="lane-chain"><h3 className={H}>CHAIN AT THE FRONTIER</h3>{body}</section>;
}

/**
 * LanePage — the full page for one lane (COMP-COCKPIT-RIBBON-LANE-1), laid over the ribbon area of the Day page: the question
 * as the title, one row per unit (author → review → fix → gate, then the land and deploy marks) over the window, the chain at
 * the frontier, and the landed vs live strip. Esc and the breadcrumb are handled by the layer / `onBack`.
 */
export default function LanePage({ lane, from, to, now, onBack }) {
  const rows = unitSegments(lane);
  const landed = rows.filter((r) => r.landedAt || r.deployedAt);
  useEffect(() => { document.querySelector('[data-testid="lane-page-back"]')?.focus(); }, []);
  return (
    <div className="absolute inset-0 z-20 bg-background overflow-y-auto p-3" data-testid="lane-page">
      <nav aria-label="breadcrumb" className="text-[12px] text-muted-foreground mb-2">
        <button type="button" data-testid="lane-page-back" onClick={onBack} className="hover:underline focus-visible:underline outline-none">Day</button>
        <span> › {lane.lane} lane</span>
      </nav>
      <h2 className="m-0 text-[18px] font-semibold text-foreground">Who is on what in {lane.lane}?</h2>
      <p className="m-0 mb-3 text-[12px] text-muted-foreground">{windowTitle(from, to, now)}</p>
      <section className="py-2 border-t border-border" data-testid="lane-units">
        <h3 className={H}>UNITS · AUTHOR → REVIEW → FIX → GATE → LAND → DEPLOY</h3>
        {rows.length > 0 && <Legend />}
        {rows.length === 0 && <p className="m-0 text-[13px] text-muted-foreground" data-testid="lane-units-empty">nothing ran in this window</p>}
        {rows.map((r, i) => <UnitRow key={`${r.unit}${i}`} row={r} lane={lane} from={from} to={to} now={now} />)}
      </section>
      <ChainBlock lane={lane} />
      <section className="py-2 border-t border-border" data-testid="lane-live">
        <h3 className={H}>LANDED VS LIVE</h3>
        {landed.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">nothing landed in this window</p>}
        {landed.map((r) => <p key={r.unit} className="m-0 text-[13px] text-foreground" data-testid="lane-live-row">{r.title || r.unit} <span className="text-[12px] text-muted-foreground">· {r.live}</span></p>)}
      </section>
    </div>
  );
}
