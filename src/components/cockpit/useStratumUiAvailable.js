import { useEffect, useState } from 'react';

/**
 * True when the Stratum tab can work (COMPOSE-STRAT-TAB-1): this build linked
 * `@smartmemory/stratum-ui` (`__STRATUM_UI__`, Mac sibling or installed package) AND the server mounted `/api/stratum-ui` (it does
 * not in remote mode or without the package). Otherwise the tab is hidden.
 */
/**
 * Three-valued form (COMP-AUDIT-17): `unknown` while the availability fetch is
 * in flight, then `yes` or `no`. `no` at once when this build did not link the package.
 */
export function useStratumUiAvailability() {
  const built = typeof __STRATUM_UI__ !== 'undefined' && __STRATUM_UI__;
  const [state, setState] = useState('unknown');
  useEffect(() => {
    if (!built) return undefined;
    let live = true;
    fetch('/api/stratum-ui/available')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setState(j?.available === true ? 'yes' : 'no'); })
      .catch(() => { if (live) setState('no'); });
    return () => { live = false; };
  }, [built]);
  return built ? state : 'no';
}

export default function useStratumUiAvailable() {
  return useStratumUiAvailability() === 'yes';
}
