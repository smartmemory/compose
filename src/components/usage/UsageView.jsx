/**
 * UsageView — Usage statistics page (COMP-OBS-STATS-1, slice 1).
 *
 * Five bands (docs/features/COMP-OBS-STATS-1/design.md): header, controls, KPI
 * tiles, usage-over-time chart, by-model table. Data comes only from the
 * injected `client` (default: usageClient.js); the component never fetches.
 * Current workspace only, Compose-dispatched spend only (design Q1/Q2).
 * COMP-COCKPIT-PROCESS-DATA-1: a scope toggle adds "Seats and fleet" (FleetUsage.jsx): the fleet's day and
 * last-hour spend and per-seat quota, the spend this ledger never sees. The default scope is unchanged.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import EmptyState from '../vision/shared/EmptyState.jsx';
import UsageChart from './UsageChart.jsx';
import FleetUsage from './FleetUsage.jsx';
import { defaultUsageClient } from './usageClient.js';
import {
  RANGES, resolveRange, costDisplay, provenanceCounts, formatCount, formatRate, delta,
} from './usageViewState.js';
import { formatCost } from '../../lib/format-cost.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SCOPES = [['compose', 'Compose-dispatched'], ['fleet', 'Seats and fleet']];

function Toggle({ options, value, onChange, label }) {
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}
          className={cn('px-2.5 py-1 text-[11px]', value === key ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted')}>
          {text}
        </button>
      ))}
    </div>
  );
}

function DeltaLine({ d, money }) {
  if (!d) return null;
  const sign = d.diff > 0 ? '+' : d.diff < 0 ? '−' : '±';
  const abs = Math.abs(d.diff);
  const amount = money ? formatCost(abs, { digits: 2 }) : formatCount(abs);
  const pct = d.pct === null ? 'new' : `${sign}${Math.abs(d.pct * 100).toFixed(0)}%`;
  return <div className="text-[10px] text-muted-foreground">vs previous: {sign}{amount} ({pct})</div>;
}

function Tile({ label, info, value, marker, d, money }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1" data-testid="usage-tile">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span title={info} aria-label={`${label}: ${info}`}><Info className="w-3 h-3" /></span>
      </div>
      <div className="flex items-center gap-1.5 text-lg font-semibold text-card-foreground">
        <span>{value}</span>
        {marker}
      </div>
      <DeltaLine d={d} money={money} />
    </div>
  );
}

function UnknownMarker({ tip }) {
  return (
    <span title={tip} aria-label={`Unknown provenance: ${tip}`} data-testid="unknown-provenance"
      className="text-[10px] px-1 rounded border border-[hsl(var(--warning))] text-[hsl(var(--warning))]">?</span>
  );
}

function tilesFor(cur, prev) {
  const t = cur.tiles;
  const p = prev?.tiles;
  const cost = costDisplay(t.total_cost.usd, provenanceCounts(t.total_cost.provenance));
  const c = t.cache_hit_rate;
  return [
    { label: 'Total cost', info: 'Sum of usd over dispatches in range. Provenance per dispatch: reported, estimated, or no record.',
      value: cost.text, marker: cost.unknownProvenance ? <UnknownMarker tip={cost.tip} /> : null,
      d: p && delta(t.total_cost.usd, p.total_cost.usd), money: true },
    { label: 'Total tokens', info: `Sum of tokens_total. ${t.total_tokens.missing_count} dispatches without a token count.`,
      value: formatCount(t.total_tokens.value), d: p && delta(t.total_tokens.value, p.total_tokens.value) },
    { label: 'Output tokens', info: `Sum of tokens_out. ${t.output_tokens.missing_count} dispatches without an output count.`,
      value: formatCount(t.output_tokens.value), d: p && delta(t.output_tokens.value, p.output_tokens.value) },
    { label: 'Dispatches', info: 'Agent dispatches Compose recorded in the ledger.',
      value: formatCount(t.dispatches.value), d: p && delta(t.dispatches.value, p.dispatches.value) },
    { label: 'Active days', info: 'Distinct local calendar days with at least one dispatch.',
      value: formatCount(t.active_days.value), d: p && delta(t.active_days.value, p.active_days.value) },
    { label: 'Cache hit rate (build-level)',
      info: `cache_read / (cache_read + input) over ${c.builds_counted} builds; ${c.builds_excluded} builds without cache fields excluded. Build history has no model id, so this is not split by model.`,
      value: formatRate(c.rate), d: p && delta(c.rate, p.cache_hit_rate.rate) },
    { label: 'Retry cost', info: `Sum of usd on dispatches with attempt > 1 (${t.retry_cost.dispatch_count} dispatches).`,
      value: formatCost(t.retry_cost.usd, { digits: 2 }), d: p && delta(t.retry_cost.usd, p.retry_cost.usd), money: true },
    { label: 'Wasted spend',
      info: `Sum of usd on dispatches whose build ended ${t.wasted_spend.statuses.join('/')}. ${t.wasted_spend.unjoined_count} dispatches have no build record yet, ${t.wasted_spend.no_build_count} have no build.`,
      value: formatCost(t.wasted_spend.usd, { digits: 2 }), d: p && delta(t.wasted_spend.usd, p.wasted_spend.usd), money: true },
  ];
}

function ModelTable({ models }) {
  return (
    <table className="w-full text-[12px]" data-testid="usage-model-table">
      <thead className="text-[11px] text-muted-foreground">
        <tr className="border-b border-border">
          <th className="text-left font-normal py-1.5">Model</th>
          <th className="text-right font-normal">Cost</th>
          <th className="text-right font-normal">Tokens</th>
          <th className="text-left font-normal pl-4 w-1/4">Share of cost</th>
          <th className="text-right font-normal">Dispatches</th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => {
          const cost = costDisplay(m.usd, m.provenance_counts);
          return (
            <tr key={m.model ?? '__unknown__'} className="border-b border-border/50">
              <td className={cn('py-1.5', m.unknown && 'italic text-muted-foreground')}>{m.unknown ? 'Unknown' : m.model}</td>
              <td className="text-right" title={cost.tip}>
                {cost.text}{cost.unknownProvenance && <> <UnknownMarker tip={cost.tip} /></>}
              </td>
              <td className="text-right">{formatCount(m.tokens_total)}</td>
              <td className="pl-4">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded bg-muted overflow-hidden">
                    <div className="h-full bg-[hsl(var(--primary))]" style={{ width: `${(m.share ?? 0) * 100}%` }} />
                  </div>
                  <span className="w-10 text-right text-muted-foreground">{formatRate(m.share)}</span>
                </div>
              </td>
              <td className="text-right">{m.dispatch_count}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function UsageView({ client = defaultUsageClient, now }) {
  const [scope, setScope] = useState('compose');
  if (scope === 'fleet') {
    return (
      <div className="flex flex-col h-full min-h-0 overflow-auto p-4 gap-4" data-testid="usage-view">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Usage</h2>
            <p className="text-[11px] text-muted-foreground max-w-2xl">
              Every session and job on this machine: the fleet's spend today and in the last hour, and how much of each seat's quota is used.
            </p>
          </div>
          <Toggle label="Scope" value={scope} onChange={setScope} options={SCOPES} />
        </header>
        <FleetUsage client={client} now={now} />
      </div>
    );
  }
  return <ComposeUsage client={client} now={now} scopeToggle={<Toggle label="Scope" value={scope} onChange={setScope} options={SCOPES} />} />;
}

function ComposeUsage({ client, now, scopeToggle }) {
  const [range, setRange] = useState('30');
  const [offset, setOffset] = useState(0);
  const [compare, setCompare] = useState(false);
  const [metric, setMetric] = useState('cost');
  const [split, setSplit] = useState('model');
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const span = resolveRange(range, offset, now ? new Date(now) : new Date());
  const bounded = span.from !== null;

  const load = useCallback(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    client.getStats({ from: span.from, to: span.to, compare: compare && bounded })
      .then((data) => { if (live) setState({ loading: false, data, error: null }); })
      .catch((err) => { if (live) setState({ loading: false, data: null, error: err.message || String(err) }); });
    return () => { live = false; };
  }, [client, span.from, span.to, compare, bounded]);
  useEffect(() => load(), [load]);

  const cur = state.data?.current;
  const prev = state.data?.previous;
  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto p-4 gap-4" data-testid="usage-view">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Usage</h2>
          <p className="text-[11px] text-muted-foreground max-w-2xl">
            Counts only spend from agents Compose dispatched in this workspace. Sessions you drive by hand are not in the ledger, so real spend is higher.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {scopeToggle}
          {state.data?.generated_at && <span>Updated {new Date(state.data.generated_at).toLocaleTimeString()}</span>}
          <button type="button" onClick={load} aria-label="Refresh" className="p-1 rounded hover:bg-muted">
            <RefreshCw className={cn('w-3.5 h-3.5', state.loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Toggle label="Range" value={range} onChange={(k) => { setRange(k); setOffset(0); }}
          options={RANGES.map((r) => [r.key, r.label])} />
        <button type="button" aria-label="Previous window" disabled={!bounded} onClick={() => setOffset((o) => o + 1)}
          className="p-1 rounded hover:bg-muted disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button>
        <button type="button" aria-label="Next window" disabled={!bounded || offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 1))}
          className="p-1 rounded hover:bg-muted disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
        <span className="text-[11px] text-muted-foreground" data-testid="usage-span">{span.label}</span>
        <label className={cn('ml-auto flex items-center gap-1.5 text-[11px]', !bounded && 'opacity-40')}>
          <input type="checkbox" checked={compare && bounded} disabled={!bounded} onChange={(e) => setCompare(e.target.checked)} />
          Compare with previous period
        </label>
      </div>

      {state.error && <div className="text-[12px] text-destructive">Could not load usage: {state.error}</div>}

      {cur && cur.empty && (
        <EmptyState icon={BarChart3} title="No dispatches in this range"
          description="Compose has not dispatched any agents in this workspace for the selected period." />
      )}

      {cur && !cur.empty && (
        <>
          {cur.incomplete.marked && (
            <div className="flex items-center gap-2 text-[11px] text-[hsl(var(--warning))]" data-testid="usage-incomplete">
              <TriangleAlert className="w-3.5 h-3.5" />
              Cost incomplete: {plural(cur.incomplete.usd_unknown_count, 'call')} with unknown cost in this range's build records
              {cur.incomplete.dispatches_missing_usd ? `, ${plural(cur.incomplete.dispatches_missing_usd, 'dispatch', 'dispatches')} without a cost` : ''}.
            </div>
          )}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-2" aria-label="Usage summary">
            {tilesFor(cur, prev).map((tile) => <Tile key={tile.label} {...tile} />)}
          </section>

          <section className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[12px] font-medium text-card-foreground mr-auto">Usage over time</h3>
              <Toggle label="Metric" value={metric} onChange={setMetric} options={[['cost', 'Cost'], ['tokens', 'Tokens']]} />
              <Toggle label="Split" value={split} onChange={setSplit} options={[['model', 'By model'], ['site', 'By site']]} />
            </div>
            <UsageChart days={cur.days} metric={metric} split={split} />
          </section>

          <section className="rounded-lg border border-border bg-card p-3">
            <h3 className="text-[12px] font-medium text-card-foreground mb-2">By model</h3>
            <ModelTable models={cur.models} />
          </section>
        </>
      )}
    </div>
  );
}
