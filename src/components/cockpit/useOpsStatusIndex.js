import { useEffect, useState } from 'react';
import { checkAvailability } from './availabilityCheck.js';

/**
 * Page names served at /ops-status (COMPOSE-OPS-TAB-1) plus a three-valued
 * availability (COMP-AUDIT-17): `unknown` until the index fetch settles, then
 * `yes` (pages listed) or `no` (route absent or empty). A failed fetch stays `unknown` (availabilityCheck.js).
 */
export function useOpsStatusIndexState() {
  const [state, setState] = useState({ pages: [], availability: 'unknown' });
  useEffect(() => {
    let live = true;
    checkAvailability({
      name: 'ops',
      url: '/api/ops-status/index',
      decide: (j) => (Array.isArray(j?.pages) && j.pages.length ? 'yes' : 'no'),
      isLive: () => live,
    }).then(({ state: s, json: j }) => {
      if (!live || s === 'unknown') return;
      setState({ pages: s === 'yes' ? j.pages : [], availability: s });
    });
    return () => { live = false; };
  }, []);
  return state;
}

/** Page names served at /ops-status (COMPOSE-OPS-TAB-1). [] when the route is absent or empty. */
export default function useOpsStatusIndex() {
  return useOpsStatusIndexState().pages;
}
