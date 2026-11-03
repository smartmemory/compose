import { useCallback, useMemo, useState } from 'react';
import { DataClientProvider, NavProvider, SeatStrip, UnitBelt, ChainDags, DiaryFeed, LiveLanes } from '@cadence/ui';
import '@cadence/ui/styles.css';
import { createCadenceDataClient } from '../../lib/clients/cadence.js';
import { useNavigation } from '@/lib/navigation.jsx';
import PaneSwitcher, { usePaneMemory } from './PaneSwitcher.jsx';
import { useHostScope } from './HostScopeChip.jsx';
import { useRoomFocus } from './roomFocus.js';

// COMP-COCKPIT-TAB-DEPTH-1 (M1): Attention is no screen here, the same rows are typed rows in the inbox (`attentionAdapter`, notify/notifyLogic.js).
const SCREENS = [
  { key: 'belt', label: 'Board' },
  { key: 'chains', label: 'Chains' },
  { key: 'diary', label: 'Diary' },
  { key: 'live', label: 'Live' }, // [masked:line]: [masked:line]'s lane view, refreshes itself every 10 s
];
// Targets the Fleet pane shows (session, job, seat, ask, attention): this room has no screen for them.
const FLEET_TARGETS = new Set(['session', 'job', 'seat', 'ask', 'attention']);

/**
 * The room state a Cadence nav target asks for (the same mapping as Cadence's shell `routeFor`), or null for a Fleet target.
 * `prev` keeps the lane filter when a unit opens on the Board.
 */
export function cadenceRouteFor(target, prev = {}) {
  switch (target?.kind) {
    case 'unit': return { view: 'belt', unit: target.id, lane: prev.view === 'belt' ? prev.lane : null };
    case 'lane': return { view: 'belt', unit: null, lane: target.lane };
    case 'chain': return { view: 'chains', chain: target.id };
    case 'diary': return { view: 'diary', unit: target.unit ?? null, family: null };
    case 'live': return { view: 'live', unit: target.unit ?? null };
    default: return null;
  }
}

/**
 * Cadence tab (COMPOSE-CADENCE-TAB-1): the Cadence Board screens from `@cadence/ui` (seat strip on top,
 * then the belt, chain DAGs or diary behind a pane switcher), fed by Compose's read-only DataClient. The
 * screens never fetch and never route: navigation is this component's state, the same seam the
 * standalone shell fills. `client` is injectable for tests. COMP-SUBAPP-HOST-1: `host` (contracts/subapp-host.schema.json) goes into
 * the provider, so the Board narrows to the selected unit, feature or lane; the chip clears that for this tab.
 * COMP-UI-LINKS-1: every screen gets its callbacks and a NavProvider, so a unit, chain, lane or diary link inside any screen opens it
 * here (blockers, depends-on, chain steps); a session, job, seat or question opens the Fleet pane on it; a jump from another room
 * (Fleet's ready units) lands through roomFocus.js.
 */
function CadenceRoom({ client, host }) {
  const dataClient = useMemo(() => client ?? createCadenceDataClient(), [client]);
  const navigation = useNavigation();
  const scoped = useHostScope(host, 'cadence');
  const [view, setView] = usePaneMemory('cadence', 'belt', SCREENS.map((s) => s.key));
  const [route, setRoute] = useState({ unit: null, lane: null, chain: null, family: null });

  const go = useCallback((next) => {
    if (next.view) setView(next.view);
    setRoute((r) => ({ ...r, ...next }));
  }, [setView]);
  const open = useCallback((target) => {
    const next = cadenceRouteFor(target, { view, ...route });
    if (next) go(next);
    else if (FLEET_TARGETS.has(target?.kind)) navigation?.openRoom?.('fleet', target);
  }, [go, view, route, navigation]);
  const openUnit = useCallback(({ id, lane }) => open({ kind: 'unit', id, lane }), [open]);
  const nav = useMemo(() => ({ open }), [open]);
  useRoomFocus('cadence', open);

  return (
    <DataClientProvider client={dataClient} host={scoped.host}>
      <NavProvider nav={nav}>
        <div className="h-full flex flex-col min-h-0" data-testid="cadence-view">
          <PaneSwitcher panes={SCREENS} active={view} onChange={(v) => go({ view: v, unit: null })} label="Cadence panes" trailing={view === 'belt' ? scoped.chip : null} />
          <div className="flex-1 min-h-0 overflow-auto">
            <SeatStrip />
            {view === 'belt' && (
              <UnitBelt
                focusUnit={route.unit}
                onOpenUnit={openUnit}
                onCloseUnit={() => go({ unit: null })}
                lane={route.lane ?? 'all'}
                onLaneChange={(lane) => go({ lane: lane === 'all' ? null : lane })}
              />
            )}
            {view === 'chains' && <ChainDags chain={route.chain} onOpenChain={(chain) => go({ view: 'chains', chain })} onOpenUnit={openUnit} />}
            {view === 'diary' && (
              <DiaryFeed onOpenUnit={openUnit} family={route.family ?? 'all'} unit={route.unit} onFamilyChange={(family) => go({ family: family === 'all' ? null : family })} />
            )}
            {view === 'live' && <LiveLanes onOpenUnit={openUnit} focusUnit={route.unit} />}
          </div>
        </div>
      </NavProvider>
    </DataClientProvider>
  );
}

// COMP-SUBAPP-HOST-WORKSPACE-1: ONE re-scope mechanism for all three rooms: the whole room is keyed on the host's workspace id, so a
// switch remounts it (its data provider, client and panes start fresh and the first read goes to the new workspace; nothing of the old
// one survives in state). No package change. Cadence: the server reads are fleet-wide (server/cadence-ui-routes.js reads no workspace), so the room re-reads and claims no workspace filter.
export default function CadenceView(props) {
  return <CadenceRoom key={props.host?.workspace?.id ?? ''} {...props} />;
}
