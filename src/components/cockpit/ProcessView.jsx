import React, { useCallback, useState } from 'react';
import { useProcess } from '../../lib/processPoller.js';
import { useFleet } from '../../lib/fleetPoller.js';
import { effectiveOrder, orderLanes, pickLane, setPickedLane, useFleetProjects } from '../../lib/fleetProjects.js';
import { OwnerQueueCard } from './FleetPanels.jsx';
import { pageMarker } from './processLogic.js';
import { specFor, tileTone } from './process/processTones.js';
import ProcessHeader from './process/ProcessHeader.jsx';
import KpiTiles from './process/KpiTiles.jsx';
import RollupGrid from './process/RollupGrid.jsx';
import TimeSplitBars from './process/TimeSplitBars.jsx';
import DetailsDrawer from './process/DetailsDrawer.jsx';
import FlowDag from './process/FlowDag.jsx';

/**
 * ProcessView — the read-only Process tab (COMP-COCKPIT-13 U2, layout COMP-COCKPIT-13-POLISH): how unit work has
 * been flowing, per lane. Top to bottom: header (freshness badges, Publish), KPI tiles for the selected page
 * (P1-P5, verbatim from its `summary.json`), the heat-coded rollup grid (P8, cells verbatim from `process.json`,
 * expand to the verbatim table), then the P6 stamps time split beside P7 the owner queue (the Fleet card). Basis
 * notes, last 5 lands and the feed breakdown sit in a details drawer. Every figure comes from GET /api/process or
 * GET /api/fleet; nothing here computes a builder figure and no unknown is rendered as 0.
 * U5: the tiles carry a sparkline and delta from the recorded daily history (`sources.history`), and the Flow of
 * work DAG sits between the tiles and the comparison, as in the mockup.
 * COMP-COCKPIT-FLEET-PROJECTS-1: the Fleet left bar's PROJECTS list (`fleet.projects`, null = every lane) orders and
 * filters the comparison columns and the time-split rows; the selected lane is shared with that list.
 */

const NOTE = 'text-[11px] text-muted-foreground';
const warn = { color: 'hsl(var(--warning))' };
const bad = { color: 'hsl(var(--destructive))' };
const PANEL_IDS = ['waiting_share', 'first_pass_clean', 'review_rounds', 'gate_minutes', 'standard'];

function Card({ id, title, children }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-3" data-testid={`process-${id}`}>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
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

/** The selected page's verbatim "Measured pace" rollup cell, for the drawer; null when no such row. */
function paceCell(table, column) {
  const row = (table?.rows ?? []).find((r) => specFor(r.measure)?.id === 'pace');
  return row && column >= 0 ? (row.cells?.[column] ?? null) : null;
}

export default function ProcessView() {
  const { data, error, loading } = useProcess();
  const fleet = useFleet();
  const lanes = useFleetProjects();
  const picked = lanes.picked;
  const [drawer, setDrawer] = useState({ open: false, focus: null });
  const openDrawer = useCallback((focus) => setDrawer({ open: true, focus }), []);
  const closeDrawer = useCallback(() => setDrawer((d) => ({ ...d, open: false })), []);
  if (loading && !data) return <div className="p-4 text-xs text-muted-foreground" data-testid="process-loading">Loading process metrics…</div>;

  const builder = data?.sources?.builder;
  const stamps = data?.sources?.stamps;
  const bv = builder?.value ?? null;
  const pages = bv?.pages ?? {};
  const table = bv?.table ?? null;
  const names = table ? (table.projects ?? []).map((p) => p.name) : Object.keys(pages);
  const order = effectiveOrder(data?.fleet, lanes);
  const shown = orderLanes(names, order);
  const selected = pickLane(shown, picked);
  const page = selected ? pages[selected] : null;
  const column = names.indexOf(selected);
  const label = page?.value?.label ?? (table?.projects ?? []).find((p) => p.name === selected)?.label ?? selected;
  const tones = Object.fromEntries(PANEL_IDS.map((k) => [k, tileTone(table, k, column)?.tone ?? null]));
  const history = (selected && data?.sources?.history?.value?.lanes?.[selected]) || [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden p-3" data-testid="process-view">
      <ProcessHeader data={data} error={error} builder={builder} stamps={stamps} />
      {!bv ? (
        <Unavailable id="builder" title="Rollup and per-page figures" reason={builder?.error ?? (error ? 'process route not reachable' : 'no builder source')} />
      ) : (<>
        {selected && (
          page?.value ? (
            <section className="flex flex-col gap-2" data-testid={`process-page-${selected}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{label}</h3>
                <span className="font-mono text-[11px] text-muted-foreground">as of {page.asOf ?? 'unknown'}</span>
                {pageMarker(page) ? <span className="text-[11px]" style={page.failed ? bad : warn}>({pageMarker(page)})</span> : null}
                <span className={NOTE}>· pick another lane in the comparison below</span>
              </div>
              {page.failed ? <div className={NOTE} style={bad} data-testid="process-page-failed">build failed {page.failed.time}: {page.failed.reason} (figures are the last good build)</div> : null}
              <KpiTiles name={selected} summary={page.value} tones={tones} onDetails={openDrawer} history={history} />
              <FlowDag name={selected} label={label} summary={page.value} pace={paceCell(table, column)} />
            </section>
          ) : <Unavailable id={`page-${selected}`} title={selected} reason={page?.error ?? 'no summary.json for this page'} />
        )}
        {table ? (
          <RollupGrid table={table} names={names} order={order ? shown : null} pages={pages} selected={selected} onSelect={setPickedLane} onBasis={(ri) => openDrawer(`rollup-${ri}`)} />
        ) : (
          <Card id="rollup-missing" title="Rollup">
            <div className={NOTE} style={warn} data-testid="process-rollup-missing-text">
              Rollup unavailable: the builder has not written process.json (OPS-STATUS-PROCESS-JSON-1){bv.tableError ? `: ${bv.tableError}` : ''}
            </div>
          </Card>
        )}
      </>)}
      <div className="grid items-start gap-3" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 340px)' }}>
        {!stamps || stamps.value == null
          ? <Unavailable id="p6" title="Time split" reason={stamps?.error ?? 'no stamps source'} />
          : <TimeSplitBars stamps={stamps} order={order} />}
        <div className="flex min-w-0 flex-col gap-2" data-testid="process-owner">
          <OwnerQueueCard data={fleet.data} variant="desktop" />
        </div>
      </div>
      {bv ? (
        <DetailsDrawer open={drawer.open} focus={drawer.focus} onClose={closeDrawer} name={selected} label={label}
          summary={page?.value ?? null} pace={paceCell(table, column)} table={table} />
      ) : null}
    </div>
  );
}
