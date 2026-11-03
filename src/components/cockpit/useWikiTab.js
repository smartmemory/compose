import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext.jsx';
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
  // COMP-SUBAPP-HOST-WORKSPACE-1: the server answers per workspace root, so the answer is re-read when the Compose workspace id
  // changes. `forWs` ties an answer to the id it was read for: for any other id the tab is `unknown` ("checking"), never the old workspace's.
  const { loading, workspace: composeWs } = useWorkspace() ?? {};
  const wsId = composeWs?.id ?? null;
  const [tab, setTab] = useState(UNKNOWN);
  const answered = useRef(false);
  useEffect(() => {
    if (!built || loading) return undefined;
    let live = true;
    checkAvailability({ name: 'wiki', url: '/api/wiki/available', decide: (j) => (j?.available === true ? 'yes' : 'no'), isLive: () => live })
      .then(({ state, json: j }) => {
        if (!live) return;
        if (state === 'unknown') {
          // A failed RE-check must not leave the old workspace's wiki showing: the room says it is unavailable. First check: unchanged.
          if (answered.current) setTab({ ...UNKNOWN, recheckFailed: true, forWs: wsId });
          return;
        }
        answered.current = true;
        if (state === 'yes') setTab({ available: true, workspace: j.workspace, frameBase: j.frameBase, availability: 'yes', forWs: wsId });
        else setTab({ ...NO, forWs: wsId });
      });
    return () => { live = false; };
  }, [built, loading, wsId]);
  if (!built) return NO;
  return !answered.current || tab.forWs === wsId ? tab : UNKNOWN;
}

export default function useWikiTab() {
  return useWikiTabState();
}
