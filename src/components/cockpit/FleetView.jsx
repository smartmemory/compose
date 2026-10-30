import React from 'react';
import FleetPanels from './FleetPanels.jsx';
import { readerUp } from './fleetLogic.js';

/**
 * FleetView — the Sessions tab Fleet pane (COMP-COCKPIT-12): every Claude session, open jobs, the owner
 * queue, disk and spend, Cadence's ready units and the ledger tail, read-only. Data comes from the shared
 * GET /api/fleet poll (src/lib/fleetPoller.js), passed in by SessionsView.
 */
const READERS = [['stratum', 'Stratum'], ['sm_status', 'sm_status'], ['cadence', 'Cadence']];

export default function FleetView({ fleet }) {
  const { data, error, loading } = fleet;
  if (loading && !data) return <div className="p-4 text-xs text-muted-foreground" data-testid="fleet-loading">Loading fleet…</div>;
  const up = READERS.filter(([n]) => readerUp(data, n));
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2" data-testid="fleet-view">
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span>Read-only. Act in chat.</span>
        <span data-testid="fleet-readers">readers up: {up.map(([, l]) => l).join(', ') || 'none'}</span>
        {data?.generated && <span>as of {new Date(data.generated).toLocaleTimeString()}</span>}
        {error && <span style={{ color: 'hsl(var(--warning))' }}>last poll failed: {error}</span>}
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', alignItems: 'start' }}>
        <FleetPanels data={data} variant="desktop" />
      </div>
    </div>
  );
}
