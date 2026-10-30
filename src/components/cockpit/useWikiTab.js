import { useEffect, useState } from 'react';

const HIDDEN = { available: false, workspace: null, frameBase: null };
const UNKNOWN = { ...HIDDEN, availability: 'unknown' };
const NO = { ...HIDDEN, availability: 'no' };

/**
 * The Wiki tab's availability (COMPOSE-WIKI-TAB-1): shown only when this build linked the wiki's
 * `@wiki/components` package (`__WIKI_COMPONENTS__`) AND the server's `/api/wiki` proxy is configured
 * (the project's `.compose/compose.json` `wiki` block; never in remote mode). Returns the served
 * workspace and the wiki's base URL for the "open full wiki" frame.
 */
/**
 * Three-valued form (COMP-AUDIT-17): the tab plus `availability`, `unknown`
 * while the fetch is in flight, then `yes` or `no`.
 */
export function useWikiTabState() {
  const built = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
  const [tab, setTab] = useState(UNKNOWN);
  useEffect(() => {
    if (!built) return undefined;
    let live = true;
    fetch('/api/wiki/available')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live) return;
        if (j?.available === true) setTab({ available: true, workspace: j.workspace, frameBase: j.frameBase, availability: 'yes' });
        else setTab(NO);
      })
      .catch(() => { if (live) setTab(NO); });
    return () => { live = false; };
  }, [built]);
  return built ? tab : NO;
}

export default function useWikiTab() {
  return useWikiTabState();
}
