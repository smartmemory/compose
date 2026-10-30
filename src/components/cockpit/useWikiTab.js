import { useEffect, useState } from 'react';
import { checkAvailability } from './availabilityCheck.js';

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
    checkAvailability({ name: 'wiki', url: '/api/wiki/available', decide: (j) => (j?.available === true ? 'yes' : 'no'), isLive: () => live })
      .then(({ state, json: j }) => {
        if (!live || state === 'unknown') return;
        if (state === 'yes') setTab({ available: true, workspace: j.workspace, frameBase: j.frameBase, availability: 'yes' });
        else setTab(NO);
      });
    return () => { live = false; };
  }, [built]);
  return built ? tab : NO;
}

export default function useWikiTab() {
  return useWikiTabState();
}
