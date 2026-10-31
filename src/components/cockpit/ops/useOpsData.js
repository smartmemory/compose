import { useEffect, useState } from 'react';
import { wsFetch } from '@/lib/wsFetch.js';
import { OPS_POLL_MS } from './opsLogic.js';

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * One lane's `GET /api/ops-status/<name>/data`, polled every 60 s while the tab is visible (the same pause as
 * fleetPoller.js). `status` is loading | ok | missing (404: the builder has not written data.json yet) | error.
 * A failed poll keeps the last good `data` and stamps `fetchedAt`, so the card shows it as stale, never as zero.
 */
export default function useOpsData(name) {
  const [state, setState] = useState({ name, status: 'loading', data: null, message: null, fetchedAt: null });
  useEffect(() => {
    if (!name) return undefined;
    let live = true;
    let timer = null;
    setState({ name, status: 'loading', data: null, message: null, fetchedAt: null });
    const poll = async () => {
      try {
        const res = await wsFetch(`/api/ops-status/${encodeURIComponent(name)}/data`);
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.status === 404) setState({ name, status: 'missing', data: null, message: body.error ?? 'no data yet', fetchedAt: Date.now() });
        else if (!res.ok) throw new Error(body.error ?? `data route ${res.status}`);
        else setState({ name, status: 'ok', data: body, message: null, fetchedAt: Date.now() });
      } catch (e) {
        if (live) setState((s) => ({ ...s, name, status: s.data ? 'ok' : 'error', message: String(e?.message ?? e) }));
      }
    };
    const schedule = () => {
      clearInterval(timer);
      timer = hidden() ? null : setInterval(poll, OPS_POLL_MS);
    };
    const onVisibility = () => { if (!hidden()) poll(); schedule(); };
    document.addEventListener('visibilitychange', onVisibility);
    if (!hidden()) poll();
    schedule();
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [name]);
  return state;
}
