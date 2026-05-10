import React, { useEffect, useState, useCallback } from 'react';
import { setSensitiveToken } from '../lib/compose-api';
import BottomNav from './components/BottomNav';
import AgentsTab from './tabs/AgentsTab';
import RoadmapTab from './tabs/RoadmapTab';
import IdeasTab from './tabs/IdeasTab';
import BuildsTab from './tabs/BuildsTab';
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

  let content = null;
  if (tab === 'agents') content = <AgentsTab />;
  else if (tab === 'roadmap') content = <RoadmapTab />;
  else if (tab === 'ideas') content = <IdeasTab />;
  else if (tab === 'builds') content = <BuildsTab />;

  return (
    <div className="m-root" data-testid="mobile-root">
      <header className="m-header">
        <div className="m-header-title">Compose</div>
      </header>
      <main className="m-main" data-testid="mobile-main" data-tab={tab}>
        {content}
      </main>
      <BottomNav active={tab} onSelect={setTabAndUrl} />
    </div>
  );
}
