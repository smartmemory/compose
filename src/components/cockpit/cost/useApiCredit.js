/**
 * useApiCredit — the ONE client of `GET /api/usage/credit` (COMP-COCKPIT-RIBBON-METER-1). The Usage meter, Home's glance and
 * the Day page's money card all read it through here, so there is no second copy. Returns `{value, error}` for CostMeter's
 * `credit` prop, or null while the call is pending (and when the client has no `getCredit`, as in older test doubles).
 */
import { useEffect, useState } from 'react';

export const CREDIT_POLL_MS = 60_000;

export default function useApiCredit(client) {
  const [credit, setCredit] = useState(null);
  useEffect(() => {
    if (typeof client?.getCredit !== 'function') return undefined;
    let live = true;
    const load = () => client.getCredit()
      .then((body) => { if (live) setCredit({ value: body?.credit?.value ?? null, error: body?.credit?.error ?? null }); })
      .catch((err) => { if (live) setCredit({ value: null, error: err.message || String(err) }); });
    load();
    const timer = setInterval(load, CREDIT_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [client]);
  return credit;
}
