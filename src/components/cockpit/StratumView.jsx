import { useCallback, useMemo, useState } from 'react';
import { DataClientProvider, NavProvider, RunsList, RunDetail, GatesInbox } from '@smartmemory/stratum-ui';
import '@smartmemory/stratum-ui/styles.css';
import { createStratumDataClient } from '../../lib/clients/stratum.js';
import { useNavigation } from '@/lib/navigation.jsx';
import PaneSwitcher, { usePaneMemory } from './PaneSwitcher.jsx';
import StratumBuilderPane from './StratumBuilderPane.jsx';
import { useHostScope } from './HostScopeChip.jsx';
import { useRoomFocus } from './roomFocus.js';

// COMP-COCKPIT-TAB-DEPTH-1 (M2 fallback): Gates stays its own pane. COMP-SUBAPP-STRAT-AUTHOR-1: "New pipeline" is the flow builder.
const PANES = [{ key: 'runs', label: 'Runs' }, { key: 'gates', label: 'Gates' }, { key: 'builder', label: 'New pipeline' }];
// SUBAPP-UI-LINKS-REVIEW-1 L1: the runs filter is always explicit, so Back to the default tab shows the default, not the last one.
export const DEFAULT_RUNS_FILTER = 'recent';

/**
 * Stratum tab (COMPOSE-STRAT-TAB-1): runs list, a run's DAG, the gates inbox and the flow builder from `@smartmemory/stratum-ui`,
 * fed by Compose's DataClient. The screens never fetch and never route: navigation is this component's state, the same seam the
 * standalone shell fills with hash routes. `client` is injectable for tests. COMP-SUBAPP-HOST-1: `host` goes into the provider,
 * so the runs list narrows to the selected feature; the chip clears that for this tab.
 *
 * COMP-UI-LINKS-1: every link the screens draw lands somewhere. A feature chip opens the Compose feature (Tree selection and item
 * detail) when Compose has it, else stays text (`has`). "Open gates" opens the Compose gate for that flow step when Compose holds
 * one, else Stratum's Gates pane filtered to the run. A flow name or the drawer's "builder" opens the run's own spec in the builder
 * at that step. The selected step lives here and `onSelectStep` sets it in the same call (RunDetail's stepId contract, review L2).
 */
function StratumRoom({ client, host }) {
  const dataClient = useMemo(() => client ?? createStratumDataClient(), [client]);
  const navigation = useNavigation();
  const scoped = useHostScope(host, 'stratum');
  const [tab, setTab] = usePaneMemory('stratum', 'runs', PANES.map((p) => p.key));
  const [run, setRun] = useState({ id: null, stepId: null });
  const [filter, setFilter] = useState(DEFAULT_RUNS_FILTER);
  const [gatesRun, setGatesRun] = useState(null);
  const [builderRun, setBuilderRun] = useState(null); // {runId, stepId, at}: a run spec the builder opens

  const openRun = useCallback((id, stepId) => { setTab('runs'); setRun({ id, stepId: stepId ?? null }); }, [setTab]);
  const openPane = useCallback((name) => { setRun({ id: null, stepId: null }); setGatesRun(null); setTab(name); }, [setTab]);
  const openGates = useCallback((runId, stepId) => {
    if (runId && stepId && navigation?.openFlowGate?.(runId, stepId)) return;
    setRun({ id: null, stepId: null });
    setGatesRun(runId ?? null);
    setTab('gates');
  }, [navigation, setTab]);
  const openFlow = useCallback((runId, stepId) => {
    setRun({ id: null, stepId: null });
    setBuilderRun({ runId, stepId: stepId ?? null, at: Date.now() });
    setTab('builder');
  }, [setTab]);
  const openRuns = useCallback((f) => { openPane('runs'); setFilter(f ?? DEFAULT_RUNS_FILTER); }, [openPane]);

  const open = useCallback((target) => {
    switch (target?.kind) {
      case 'run': return openRun(target.id, target.stepId);
      case 'step': return target.runId ? openRun(target.runId, target.stepId) : setRun((r) => ({ ...r, stepId: target.stepId }));
      case 'flow': return target.runId ? openFlow(target.runId, target.stepId) : openPane('builder');
      case 'feature': return navigation?.openFeature?.(target.code);
      case 'gates': return openGates(target.runId, target.stepId);
      case 'runs': return openRuns(target.filter);
      case 'builder': return openPane('builder');
      default: return undefined;
    }
  }, [openRun, openFlow, openPane, openGates, openRuns, navigation]);
  const has = useCallback((target) => (target?.kind === 'feature' ? !!navigation?.canNavigate?.('feature', target.code) : true), [navigation]);
  const nav = useMemo(() => ({ open, has }), [open, has]);
  useRoomFocus('stratum', open);

  return (
    <DataClientProvider client={dataClient} host={scoped.host}>
      <NavProvider nav={nav}>
        <div className="h-full flex flex-col min-h-0" data-testid="stratum-view">
          <PaneSwitcher panes={PANES} active={tab} onChange={openPane} label="Stratum panes" trailing={tab === 'runs' && !run.id ? scoped.chip : null} />
          <div className="flex-1 min-h-0 overflow-auto">
            {!run.id && tab === 'runs' && (
              <RunsList
                onOpenRun={openRun}
                onOpenFlow={(runId) => openFlow(runId)}
                onOpenGates={(runId) => openGates(runId)}
                onOpenBuilder={() => openPane('builder')}
                filter={filter}
                onFilterChange={setFilter}
              />
            )}
            {run.id && (
              <RunDetail
                runId={run.id}
                stepId={run.stepId}
                onSelectStep={(stepId) => setRun((r) => ({ ...r, stepId }))}
                onBack={() => openPane('runs')}
                onOpenRuns={() => openPane('runs')}
                onOpenGates={openGates}
                onOpenFlow={openFlow}
              />
            )}
            {!run.id && tab === 'gates' && (
              <GatesInbox runId={gatesRun ?? undefined} onOpenRun={openRun} onOpenFlow={(runId) => openFlow(runId)} onOpenRuns={() => openRuns()} onOpenGates={openGates} />
            )}
            {!run.id && tab === 'builder' && <StratumBuilderPane client={dataClient} openRun={builderRun} />}
          </div>
        </div>
      </NavProvider>
    </DataClientProvider>
  );
}

// COMP-SUBAPP-HOST-WORKSPACE-1: ONE re-scope mechanism for all three rooms: the whole room is keyed on the host's workspace id, so a
// switch remounts it (its data provider, client and panes start fresh and the first read goes to the new workspace; nothing of the old
// one survives in state). No package change. Stratum: the run reads are not shown to be workspace-scoped on the server (unverified), so the room re-reads without claiming a filter.
export default function StratumView(props) {
  return <StratumRoom key={props.host?.workspace?.id ?? ''} {...props} />;
}
