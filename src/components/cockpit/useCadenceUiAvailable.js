import { useEffect, useState } from 'react';
import { checkAvailability } from './availabilityCheck.js';

/**
 * True when the Cadence tab can work (COMPOSE-CADENCE-TAB-1): this build linked the sibling
 * `@cadence/ui` package (`__CADENCE_UI__`) AND the server mounted `/api/cadence-ui` (it does
 * not in remote mode or without the sibling). Otherwise the tab is hidden.
 */
/**
 * Three-valued form (COMP-AUDIT-17): `unknown` while the availability fetch is
 * in flight, then `yes` or `no`. `no` at once when this build did not link the package.
 */
export function useCadenceUiAvailability() {
  const built = typeof __CADENCE_UI__ !== 'undefined' && __CADENCE_UI__;
  const [state, setState] = useState('unknown');
  useEffect(() => {
    if (!built) return undefined;
    let live = true;
    checkAvailability({ name: 'cadence', url: '/api/cadence-ui/available', decide: (j) => (j?.available === true ? 'yes' : 'no'), isLive: () => live })
      .then(({ state: s }) => { if (live && s !== 'unknown') setState(s); });
    return () => { live = false; };
  }, [built]);
  return built ? state : 'no';
}

export default function useCadenceUiAvailable() {
  return useCadenceUiAvailability() === 'yes';
}
