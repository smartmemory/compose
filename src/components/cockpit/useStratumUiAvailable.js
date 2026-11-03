import { useEffect, useState } from 'react';
import { checkUntilSettled } from './availabilityCheck.js';

/**
 * COMP-SUBAPP-ATTENTION-FU-2 (F3): the recheck interval while the check stays `unknown`. 30 s: a dev-server restart is
 * usually over in seconds, and while unknown the inbox says "Alerts unknown", so a short wait matters more than the one
 * small GET per 30 s it costs (only while unknown; a settled check never reruns).
 */
export const STRATUM_RECHECK_MS = 30_000;

/** True when this build linked `@smartmemory/stratum-ui` (`__STRATUM_UI__`). */
export const stratumUiBuilt = () => typeof __STRATUM_UI__ !== 'undefined' && !!__STRATUM_UI__;

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
  const built = stratumUiBuilt();
  const [state, setState] = useState('unknown');
  useEffect(() => {
    if (!built) return undefined;
    // FU-2: a check that failed twice is rechecked slowly, never left `unknown` for the session.
    return checkUntilSettled({
      name: 'stratum', url: '/api/stratum-ui/available', decide: (j) => (j?.available === true ? 'yes' : 'no'),
      recheckMs: STRATUM_RECHECK_MS, onSettled: setState,
    });
  }, [built]);
  return built ? state : 'no';
}

export default function useStratumUiAvailable() {
  return useStratumUiAvailability() === 'yes';
}
