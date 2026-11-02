import { useMemo, useState } from 'react';
import { DataClientProvider, RunsList, RunDetail, GatesInbox } from '@smartmemory/stratum-ui';
import '@smartmemory/stratum-ui/styles.css';
import { createStratumDataClient } from '../../lib/clients/stratum.js';
import PaneSwitcher, { usePaneMemory } from './PaneSwitcher.jsx';
import StratumBuilderPane from './StratumBuilderPane.jsx';
import { useHostScope } from './HostScopeChip.jsx';

// COMP-COCKPIT-TAB-DEPTH-1 (M2 fallback): `RunsList` takes no filter prop (stratum-ui RunsListProps: onOpenRun, pollMs), so Gates stays its own pane.
// COMP-SUBAPP-STRAT-AUTHOR-1: "New pipeline" is the Stratum flow builder with Save / Open (StratumBuilderPane).
const PANES = [{ key: 'runs', label: 'Runs' }, { key: 'gates', label: 'Gates' }, { key: 'builder', label: 'New pipeline' }];

/**
 * Stratum tab (COMPOSE-STRAT-TAB-1): runs list, a run's DAG, the gates inbox and the flow builder from `@smartmemory/stratum-ui`,
 * fed by Compose's DataClient. The screens never fetch and never route: navigation is this
 * component's state, the same seam the standalone shell fills with hash routes.
 * `client` is injectable for tests. COMP-SUBAPP-HOST-1: `host` (contracts/subapp-host.schema.json) goes into the provider,
 * so the runs list narrows to the selected feature; the chip clears that for this tab.
 */
export default function StratumView({ client, host }) {
  const dataClient = useMemo(() => client ?? createStratumDataClient(), [client]);
  const scoped = useHostScope(host, 'stratum');
  const [tab, setTab] = usePaneMemory('stratum', 'runs', PANES.map((p) => p.key));
  const [runId, setRunId] = useState(null);
  const openRun = (id) => { setTab('runs'); setRunId(id); };
  const openPane = (name) => { setRunId(null); setTab(name); };

  return (
    <DataClientProvider client={dataClient} host={scoped.host}>
      <div className="h-full flex flex-col min-h-0" data-testid="stratum-view">
        <PaneSwitcher panes={PANES} active={tab} onChange={openPane} label="Stratum panes" trailing={tab === 'runs' && !runId ? scoped.chip : null} />
        <div className="flex-1 min-h-0 overflow-auto">
          {!runId && tab === 'runs' && <RunsList onOpenRun={openRun} />}
          {runId && (
            <RunDetail runId={runId} onBack={() => openPane('runs')} onOpenGates={() => openPane('gates')} />
          )}
          {!runId && tab === 'gates' && <GatesInbox onOpenRun={openRun} />}
          {!runId && tab === 'builder' && <StratumBuilderPane client={dataClient} />}
        </div>
      </div>
    </DataClientProvider>
  );
}
