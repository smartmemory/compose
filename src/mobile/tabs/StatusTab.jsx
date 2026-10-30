import React from 'react';
import FleetPanels from '../../components/cockpit/FleetPanels.jsx';
import { anyReaderUp } from '../../components/cockpit/fleetLogic.js';
import { useFleet } from '../../lib/fleetPoller.js';

/**
 * StatusTab — read-only fleet status on the phone (COMP-COCKPIT-12). Stacked cards from GET /api/fleet:
 * owner questions first, then sessions, jobs, disk and spend, Cadence ready units, ledger tail.
 * No actions in v1. Polls only while this tab is mounted and the page is visible.
 */
export default function StatusTab() {
  const { data, error, loading } = useFleet();
  return (
    <section data-testid="mobile-tab-status" className="m-status-tab">
      {loading && !data && <div className="m-empty" data-testid="mobile-status-loading">Loading…</div>}
      {data && !anyReaderUp(data) && (
        <div className="m-empty" data-testid="mobile-status-empty">Fleet status is not available on this host.</div>
      )}
      {error && <div className="m-fleet-note" style={{ color: 'hsl(var(--warning))' }}>last poll failed: {error}</div>}
      {data && <FleetPanels data={data} variant="mobile" />}
    </section>
  );
}
