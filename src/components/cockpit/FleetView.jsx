import React from 'react';
import FleetPanels, { FleetSkeleton } from './FleetPanels.jsx';
import { readerUp } from './fleetLogic.js';

/**
 * FleetView — the Sessions tab Fleet pane (COMP-COCKPIT-12): every Claude session, open jobs, the owner
 * queue, disk and spend, Cadence's ready units and the ledger tail, read-only. Data comes from the shared
 * GET /api/fleet poll (src/lib/fleetPoller.js), passed in by SessionsView.
 */
const READERS = [['stratum', 'Stratum'], ['sm_status', 'sm_status'], ['cadence', 'Cadence']];

export default function FleetView({ fleet }) {
  const { data, error, loading } = fleet;
  if (loading && !data) {
    return (
      <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2" data-testid="fleet-loading">
        <span className="text-xs text-muted-foreground">Loading fleet…</span>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', alignItems: 'start' }}>
          <FleetSkeleton variant="desktop" />
        </div>
      </div>
    );
  }
  const up = READERS.filter(([n]) => readerUp(data, n));
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2" data-testid="fleet-view">
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span>Read-only. Act in chat.</span>
        <span data-testid="fleet-readers">readers up: {up.map(([, l]) => l).join(', ') || 'none'}</span>
        {data?.generated && <span>as of {new Date(data.generated).toLocaleTimeString()}</span>}
        {error && <span style={{ color: 'hsl(var(--warning))' }}>last poll failed: {error}</span>}
      </div>
      {/* Columns, not grid rows: a row-aligned grid left ~1300 px of blank space under the short cards at 1440. Each card stays whole. */}
      <div className="[&>section]:mb-2 [&>section]:break-inside-avoid" style={{ columnWidth: '320px', columnGap: '0.5rem' }} data-testid="fleet-cards">
        <FleetPanels data={data} variant="desktop" />
      </div>
    </div>
  );
}
