import { useMemo, useState } from 'react';
import { DataClientProvider, RunsList, RunDetail, GatesInbox } from '@stratum/ui';
import '@stratum/ui/styles.css';
import { createStratumDataClient } from '../../lib/clients/stratum.js';

/**
 * Stratum tab (COMPOSE-STRAT-TAB-1): runs list, a run's DAG, and the gates inbox from `@stratum/ui`,
 * fed by Compose's DataClient. The screens never fetch and never route: navigation is this
 * component's state, the same seam the standalone shell fills with hash routes.
 * `client` is injectable for tests.
 */
export default function StratumView({ client }) {
  const dataClient = useMemo(() => client ?? createStratumDataClient(), [client]);
  const [view, setView] = useState({ name: 'runs' });
  const tab = view.name === 'run' ? 'runs' : view.name;
  const openRun = (runId) => setView({ name: 'run', runId });
  const tabClass = (name) => `px-3 py-1 text-sm rounded ${tab === name ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`;

  return (
    <DataClientProvider client={dataClient}>
      <div className="h-full flex flex-col min-h-0" data-testid="stratum-view">
        <nav className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0" aria-label="stratum">
          <button type="button" className={tabClass('runs')} onClick={() => setView({ name: 'runs' })}>Runs</button>
          <button type="button" className={tabClass('gates')} onClick={() => setView({ name: 'gates' })}>Gates</button>
        </nav>
        <div className="flex-1 min-h-0 overflow-auto">
          {view.name === 'runs' && <RunsList onOpenRun={openRun} />}
          {view.name === 'run' && (
            <RunDetail runId={view.runId} onBack={() => setView({ name: 'runs' })} onOpenGates={() => setView({ name: 'gates' })} />
          )}
          {view.name === 'gates' && <GatesInbox onOpenRun={openRun} />}
        </div>
      </div>
    </DataClientProvider>
  );
}
