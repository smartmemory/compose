import { useEffect, useState } from 'react';

/**
 * True when the Cadence tab can work (COMPOSE-CADENCE-TAB-1): this build linked the sibling
 * `@cadence/ui` package (`__CADENCE_UI__`) AND the server mounted `/api/cadence-ui` (it does
 * not in remote mode or without the sibling). Otherwise the tab is hidden.
 */
export default function useCadenceUiAvailable() {
  const built = typeof __CADENCE_UI__ !== 'undefined' && __CADENCE_UI__;
  const [served, setServed] = useState(false);
  useEffect(() => {
    if (!built) return undefined;
    let live = true;
    fetch('/api/cadence-ui/available')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.available === true) setServed(true); })
      .catch(() => {});
    return () => { live = false; };
  }, [built]);
  return built && served;
}
