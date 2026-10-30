import { useMemo, useState } from 'react';
import { DataClientProvider, SeatStrip, UnitBelt, ChainDags, AttentionList, DiaryFeed } from '@cadence/ui';
import '@cadence/ui/styles.css';
import { createCadenceDataClient } from '../../lib/clients/cadence.js';

const SCREENS = [
  { key: 'belt', label: 'Board' },
  { key: 'chains', label: 'Chains' },
  { key: 'attention', label: 'Attention' },
  { key: 'diary', label: 'Diary' },
];

/**
 * Cadence tab (COMPOSE-CADENCE-TAB-1): the Cadence Board screens from `@cadence/ui` (seat strip on top,
 * then the belt, chain DAGs, attention list or diary), fed by Compose's read-only DataClient. The
 * screens never fetch and never route: navigation is this component's state, the same seam the
 * standalone shell fills. Opening a unit from attention or diary focuses it on the belt.
 * `client` is injectable for tests.
 */
export default function CadenceView({ client }) {
  const dataClient = useMemo(() => client ?? createCadenceDataClient(), [client]);
  const [view, setView] = useState('belt');
  const [focusUnit, setFocusUnit] = useState(null);
  const openUnit = ({ id }) => { setFocusUnit(id); setView('belt'); };
  const tabClass = (key) => `px-3 py-1 text-sm rounded ${view === key ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`;

  return (
    <DataClientProvider client={dataClient}>
      <div className="h-full flex flex-col min-h-0" data-testid="cadence-view">
        <nav className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0" aria-label="cadence">
          {SCREENS.map((s) => (
            <button key={s.key} type="button" className={tabClass(s.key)} onClick={() => setView(s.key)}>{s.label}</button>
          ))}
        </nav>
        <div className="flex-1 min-h-0 overflow-auto">
          <SeatStrip />
          {view === 'belt' && <UnitBelt focusUnit={focusUnit} />}
          {view === 'chains' && <ChainDags />}
          {view === 'attention' && <AttentionList onOpenUnit={openUnit} />}
          {view === 'diary' && <DiaryFeed onOpenUnit={openUnit} />}
        </div>
      </div>
    </DataClientProvider>
  );
}
