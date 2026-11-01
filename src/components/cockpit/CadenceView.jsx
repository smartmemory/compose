import { useMemo, useState } from 'react';
import { DataClientProvider, SeatStrip, UnitBelt, ChainDags, DiaryFeed, LiveLanes } from '@cadence/ui';
import '@cadence/ui/styles.css';
import { createCadenceDataClient } from '../../lib/clients/cadence.js';
import PaneSwitcher, { usePaneMemory } from './PaneSwitcher.jsx';

// COMP-COCKPIT-TAB-DEPTH-1 (M1): Attention is no screen here, the same rows are typed rows in the inbox (`attentionAdapter`, notify/notifyLogic.js).
const SCREENS = [
  { key: 'belt', label: 'Board' },
  { key: 'chains', label: 'Chains' },
  { key: 'diary', label: 'Diary' },
  { key: 'live', label: 'Live' }, // COMP-CADENCE-LIVE-MOUNT-1: CADENCE-UI-LIVE-1's lane view, refreshes itself every 10 s
];

/**
 * Cadence tab (COMPOSE-CADENCE-TAB-1): the Cadence Board screens from `@cadence/ui` (seat strip on top,
 * then the belt, chain DAGs or diary behind a pane switcher), fed by Compose's read-only DataClient. The
 * screens never fetch and never route: navigation is this component's state, the same seam the
 * standalone shell fills. Opening a unit from the diary focuses it on the belt.
 * `client` is injectable for tests.
 */
export default function CadenceView({ client }) {
  const dataClient = useMemo(() => client ?? createCadenceDataClient(), [client]);
  const [view, setView] = usePaneMemory('cadence', 'belt', SCREENS.map((s) => s.key));
  const [focusUnit, setFocusUnit] = useState(null);
  const openUnit = ({ id }) => { setFocusUnit(id); setView('belt'); };

  return (
    <DataClientProvider client={dataClient}>
      <div className="h-full flex flex-col min-h-0" data-testid="cadence-view">
        <PaneSwitcher panes={SCREENS} active={view} onChange={setView} label="Cadence panes" />
        <div className="flex-1 min-h-0 overflow-auto">
          <SeatStrip />
          {view === 'belt' && <UnitBelt focusUnit={focusUnit} />}
          {view === 'chains' && <ChainDags />}
          {view === 'diary' && <DiaryFeed onOpenUnit={openUnit} />}
          {view === 'live' && <LiveLanes onOpenUnit={openUnit} />}
        </div>
      </div>
    </DataClientProvider>
  );
}
