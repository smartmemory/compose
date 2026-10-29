import { useEffect, useState } from 'react';

const HIDDEN = { available: false, workspace: null, frameBase: null };

/**
 * The Wiki tab's availability (COMPOSE-WIKI-TAB-1): shown only when this build linked the wiki's
 * `@wiki/components` package (`__WIKI_COMPONENTS__`) AND the server's `/api/wiki` proxy is configured
 * (the project's `.compose/compose.json` `wiki` block; never in remote mode). Returns the served
 * workspace and the wiki's base URL for the "open full wiki" frame.
 */
export default function useWikiTab() {
  const built = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
  const [tab, setTab] = useState(HIDDEN);
  useEffect(() => {
    if (!built) return undefined;
    let live = true;
    fetch('/api/wiki/available')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live && j?.available === true) setTab({ available: true, workspace: j.workspace, frameBase: j.frameBase });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [built]);
  return built ? tab : HIDDEN;
}
