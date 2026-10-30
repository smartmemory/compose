import { useEffect, useState } from 'react';

/**
 * True when the Stratum tab can work (COMPOSE-STRAT-TAB-1): this build linked
 * `@smartmemory/stratum-ui` (`__STRATUM_UI__`, Mac sibling or installed package) AND the server mounted `/api/stratum-ui` (it does
 * not in remote mode or without the package). Otherwise the tab is hidden.
 */
export default function useStratumUiAvailable() {
  const built = typeof __STRATUM_UI__ !== 'undefined' && __STRATUM_UI__;
  const [served, setServed] = useState(false);
  useEffect(() => {
    if (!built) return undefined;
    let live = true;
    fetch('/api/stratum-ui/available')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.available === true) setServed(true); })
      .catch(() => {});
    return () => { live = false; };
  }, [built]);
  return built && served;
}
