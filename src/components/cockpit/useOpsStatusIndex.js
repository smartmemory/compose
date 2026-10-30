import { useEffect, useState } from 'react';

/**
 * Page names served at /ops-status (COMPOSE-OPS-TAB-1) plus a three-valued
 * availability (COMP-AUDIT-17): `unknown` until the index fetch settles, then
 * `yes` (pages listed) or `no` (route absent, failed or empty).
 */
export function useOpsStatusIndexState() {
  const [state, setState] = useState({ pages: [], availability: 'unknown' });
  useEffect(() => {
    let live = true;
    fetch('/api/ops-status/index')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live) return;
        const pages = Array.isArray(j?.pages) ? j.pages : [];
        setState({ pages, availability: pages.length ? 'yes' : 'no' });
      })
      .catch(() => { if (live) setState({ pages: [], availability: 'no' }); });
    return () => { live = false; };
  }, []);
  return state;
}

/** Page names served at /ops-status (COMPOSE-OPS-TAB-1). [] when the route is absent or empty. */
export default function useOpsStatusIndex() {
  return useOpsStatusIndexState().pages;
}
