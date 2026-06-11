import React, { useCallback, useEffect, useState } from 'react';
import { setSensitiveToken } from '../lib/compose-api';
import { isGatePending } from '../lib/pipeline-steps.js';
import BottomNav from './components/BottomNav';
import AgentsTab from './tabs/AgentsTab';
import RoadmapTab from './tabs/RoadmapTab';
import IdeasTab from './tabs/IdeasTab';
import BuildsTab from './tabs/BuildsTab';
import MobileAlertBar from './components/MobileAlertBar';
import { usePendingGates } from './hooks/usePendingGates.js';
import { useActiveBuild } from './hooks/useActiveBuild.js';
import { useRoadmapItems } from './hooks/useRoadmapItems.js';
import useMonitorEvents from './hooks/useMonitorEvents.js';
import './mobile.css';

const TABS = ['agents', 'roadmap', 'builds', 'ideas'];
const DEFAULT_TAB = 'agents';
const TOKEN_STORAGE_KEY = 'compose:mobile:sensitiveToken';

function readTabFromPathname(pathname) {
  // /m, /m/, /m/agents, /m/roadmap, ...
  const m = pathname.match(/^\/m(?:\/([^/?#]+))?\/?$/);
  if (!m) return DEFAULT_TAB;
  const seg = m[1];
  if (seg && TABS.includes(seg)) return seg;
  return DEFAULT_TAB;
}

export default function MobileApp() {
  const [tab, setTab] = useState(() => readTabFromPathname(window.location.pathname));

  // Token pairing: ?token=... → localStorage → setSensitiveToken; strip from URL.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const fromQs = u.searchParams.get('token');
      if (fromQs) {
        try { localStorage.setItem(TOKEN_STORAGE_KEY, fromQs); } catch {}
        setSensitiveToken(fromQs);
        u.searchParams.delete('token');
        window.history.replaceState(
          {},
          '',
          u.pathname + (u.search ? u.search : '') + u.hash
        );
      } else {
        let stored = null;
        try { stored = localStorage.getItem(TOKEN_STORAGE_KEY); } catch {}
        if (stored) setSensitiveToken(stored);
      }
    } catch {
      // best-effort; absence of localStorage / URL parse failures must not crash the shell
    }
  }, []);

  // Service worker registration (deferred / best-effort).
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.register('/m-sw.js').catch(err => {
        console.warn('[compose-mobile] SW registration failed:', err);
      });
    } catch (err) {
      console.warn('[compose-mobile] SW registration threw:', err);
    }
  }, []);

  // URL sync: /m/<tab> via replaceState whenever the tab changes.
  const setTabAndUrl = useCallback((next) => {
    if (!TABS.includes(next)) return;
    setTab(next);
    try {
      const u = new URL(window.location.href);
      u.pathname = `/m/${next}`;
      window.history.replaceState({}, '', u.pathname + u.search + u.hash);
    } catch {}
  }, []);

  // ── Lifted monitoring hooks ───────────────────────────────────────────────
  // Single source of truth for shell-level badge/alert state.
  // Each tab receives hook values as props so it doesn't open duplicate WS connections.
  const { gates, loading: gatesLoading, resolve: resolveGate } = usePendingGates();
  const { active, loading: buildLoading, error: buildError, startBuild, abortBuild } = useActiveBuild();
  const {
    items,
    loading: itemsLoading,
    error: itemsError,
    applyOptimisticEdit,
    createItem,
    deleteItem,
    addConnection,
    removeConnection,
    fetchItemDetail,
  } = useRoadmapItems();

  // Monitor build + gate transitions → compose:notify alerts (uses lifted data, no extra WS)
  useMonitorEvents({ active, gates, items });

  // ── Badge computation ─────────────────────────────────────────────────────
  const badges = {};
  if (gates.length > 0) {
    badges.agents = { count: gates.length, level: 'warn' };
  }
  if (active?.status === 'failed') {
    badges.builds = { level: 'error' };
  } else if (isGatePending(active, gates, items)) {
    badges.builds = { level: 'warn' };
  }

  // ── Tab content ───────────────────────────────────────────────────────────
  let content = null;
  if (tab === 'agents') {
    content = (
      <AgentsTab
        gates={gates}
        gatesLoading={gatesLoading}
        resolveGate={resolveGate}
      />
    );
  } else if (tab === 'roadmap') {
    content = (
      <RoadmapTab
        items={items}
        loading={itemsLoading}
        error={itemsError}
        applyOptimisticEdit={applyOptimisticEdit}
        createItem={createItem}
        deleteItem={deleteItem}
        addConnection={addConnection}
        removeConnection={removeConnection}
        fetchItemDetail={fetchItemDetail}
      />
    );
  } else if (tab === 'ideas') {
    content = <IdeasTab />;
  } else if (tab === 'builds') {
    content = (
      <BuildsTab
        active={active}
        loading={buildLoading}
        error={buildError}
        startBuild={startBuild}
        abortBuild={abortBuild}
      />
    );
  }

  return (
    <div className="m-root" data-testid="mobile-root">
      <header className="m-header">
        <div className="m-header-title">Compose</div>
      </header>
      <MobileAlertBar onNavigate={setTabAndUrl} />
      <main className="m-main" data-testid="mobile-main" data-tab={tab}>
        {content}
      </main>
      <BottomNav active={tab} onSelect={setTabAndUrl} badges={badges} />
    </div>
  );
}
