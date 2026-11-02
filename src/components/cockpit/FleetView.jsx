import React, { useCallback, useMemo, useState } from 'react';
import {
  DataClientProvider, NavProvider, SeatStrip, OwnerAsks, SessionsPanel, JobsPanel, GatePanel, ReadyUnits, VitalsPanel, LedgerTail,
} from '@cadence/ui';
import '@cadence/ui/styles.css';
import { createCadenceDataClient } from '../../lib/clients/cadence.js';
import { useNavigation } from '@/lib/navigation.jsx';
import FleetPanels, { FleetSkeleton } from './FleetPanels.jsx';
import { readerUp } from './fleetLogic.js';
import { useCadenceUiAvailability } from './useCadenceUiAvailable.js';
import { useRoomFocus } from './roomFocus.js';

/**
 * FleetView — the Sessions tab Fleet pane. COMP-UI-LINKS-1 (compose row 311's Fleet slice, D-0019): built from `@cadence/ui` parts
 * (seat strip, owner questions, sessions, jobs, the launch gates with the fleet cap, ready units, disk and spend, the ledger tail),
 * fed by Compose's read-only Cadence DataClient. Every row opens something: a session, job, seat or ask selects it here (the
 * session's jobs, the job highlighted, the ask expanded); a unit, lane or chain opens the Cadence room on it (roomFocus.js).
 * Read-only: nothing here answers, resolves or starts anything.
 *
 * Without the Cadence package (published npm build, CI) the parts are stubs, so the pane keeps its own cards (`FleetPanels`, fed by
 * GET /api/fleet), which the mobile Status tab and the Process view also render.
 */
const READERS = [['stratum', 'Stratum'], ['sm_status', 'sm_status'], ['cadence', 'Cadence']];
const CADENCE_TARGETS = new Set(['unit', 'lane', 'chain', 'diary', 'live']);

/** The Fleet selection a nav target sets, or null when the target belongs to another room. */
export function fleetSelectionFor(target) {
  switch (target?.kind) {
    case 'session': return { session: target.name };
    case 'job': return { job: target.id };
    case 'seat': return { seat: target.id };
    case 'ask': return { ask: target.id };
    case 'attention': return {};
    default: return null;
  }
}

function LegacyFleet({ fleet }) {
  const { data, error, loading } = fleet ?? {};
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
      <div className="[&>section]:mb-2 [&>section]:break-inside-avoid" style={{ columnWidth: '320px', columnGap: '0.5rem' }} data-testid="fleet-cards">
        <FleetPanels data={data} variant="desktop" />
      </div>
    </div>
  );
}

/** The Cadence-fed Fleet. `client` is injectable for tests. */
export function CadenceFleet({ client }) {
  const dataClient = useMemo(() => client ?? createCadenceDataClient(), [client]);
  const navigation = useNavigation();
  const [sel, setSel] = useState({});
  const openRoom = navigation?.openRoom;
  const toCadence = useCallback((target) => openRoom?.('cadence', target), [openRoom]);
  const onOpenUnit = useCallback(({ lane, id }) => toCadence({ kind: 'unit', id, lane }), [toCadence]);
  const nav = useMemo(() => ({
    open: (target) => {
      const next = fleetSelectionFor(target);
      if (next) setSel(next);
      else if (CADENCE_TARGETS.has(target?.kind)) toCadence(target);
    },
  }), [toCadence]);
  useRoomFocus('fleet', (focus) => setSel(fleetSelectionFor(focus) ?? {}));
  const scope = sel.session ? `session ${sel.session}` : sel.job ? `job ${sel.job}` : sel.seat ? `seat ${sel.seat}` : sel.ask ? `question ${sel.ask}` : null;

  return (
    <DataClientProvider client={dataClient}>
      <NavProvider nav={nav}>
        <div className="flex-1 min-h-0 overflow-auto cb-root" data-testid="fleet-view" data-fleet-source="cadence">
          <div className="flex items-center gap-3 px-3 pt-2 text-[10px] text-muted-foreground">
            <span>Read-only. Act in chat.</span>
            {scope && (
              <span data-testid="fleet-scope">
                showing {scope} ·{' '}
                <button type="button" className="underline hover:text-foreground focus-visible:outline focus-visible:outline-1" onClick={() => setSel({})}>clear</button>
              </span>
            )}
          </div>
          <SeatStrip selected={sel.seat ?? null} />
          <div className="px-3 pb-3 [&>*]:mb-2 [&>*]:break-inside-avoid" style={{ columnWidth: '360px', columnGap: '0.5rem' }} data-testid="fleet-cards">
            <OwnerAsks selected={sel.ask ?? null} onOpenUnit={onOpenUnit} />
            <SessionsPanel selected={sel.session ?? null} seat={sel.seat ?? null} />
            <JobsPanel selected={sel.job ?? null} session={sel.session ?? null} onOpenUnit={onOpenUnit} />
            <GatePanel />
            <ReadyUnits onOpenUnit={onOpenUnit} />
            <VitalsPanel onOpenUnit={onOpenUnit} />
            <LedgerTail onOpenUnit={onOpenUnit} />
          </div>
        </div>
      </NavProvider>
    </DataClientProvider>
  );
}

export default function FleetView({ fleet, client }) {
  const cadence = useCadenceUiAvailability();
  // Until the availability answer arrives (one cached check per page) the cards from GET /api/fleet show, so the pane is never blank.
  if (client || cadence === 'yes') return <CadenceFleet client={client} />;
  return <LegacyFleet fleet={fleet} />;
}
