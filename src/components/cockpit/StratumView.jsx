import { useMemo, useState } from 'react';
import { DataClientProvider, RunsList, RunDetail, GatesInbox } from '@smartmemory/stratum-ui';
import '@smartmemory/stratum-ui/styles.css';
import { createStratumDataClient } from '../../lib/clients/stratum.js';
import PaneSwitcher, { usePaneMemory } from './PaneSwitcher.jsx';

// COMP-COCKPIT-TAB-DEPTH-1 (M2 fallback): `RunsList` takes no filter prop (stratum-ui RunsListProps: onOpenRun, pollMs), so Gates stays its own pane.
const PANES = [{ key: 'runs', label: 'Runs' }, { key: 'gates', label: 'Gates' }];

/**
 * Stratum tab (COMPOSE-STRAT-TAB-1): runs list, a run's DAG, and the gates inbox from `@smartmemory/stratum-ui`,
 * fed by Compose's DataClient. The screens never fetch and never route: navigation is this
 * component's state, the same seam the standalone shell fills with hash routes.
 * `client` is injectable for tests.
 */
export default function StratumView({ client }) {
  const dataClient = useMemo(() => client ?? createStratumDataClient(), [client]);
  const [tab, setTab] = usePaneMemory('stratum', 'runs', PANES.map((p) => p.key));
  const [runId, setRunId] = useState(null);
  const openRun = (id) => { setTab('runs'); setRunId(id); };
  const openPane = (name) => { setRunId(null); setTab(name); };

  return (
    <DataClientProvider client={dataClient}>
      <div className="h-full flex flex-col min-h-0" data-testid="stratum-view">
        <PaneSwitcher panes={PANES} active={tab} onChange={openPane} label="Stratum panes" />
        <div className="flex-1 min-h-0 overflow-auto">
          {!runId && tab === 'runs' && <RunsList onOpenRun={openRun} />}
          {runId && (
            <RunDetail runId={runId} onBack={() => openPane('runs')} onOpenGates={() => openPane('gates')} />
          )}
          {!runId && tab === 'gates' && <GatesInbox onOpenRun={openRun} />}
        </div>
      </div>
    </DataClientProvider>
  );
}
