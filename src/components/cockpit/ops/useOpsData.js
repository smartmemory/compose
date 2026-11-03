import { useEffect, useState } from 'react';
import { wsFetch } from '@/lib/wsFetch.js';
import { sourceFail } from '@/lib/sourceState.js';
import { OPS_POLL_MS } from './opsLogic.js';

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

const fresh = (name) => ({ name, status: 'loading', data: null, message: null, error: null, stale: false, fetchedAt: null, errorSince: null, loading: true });

/**
 * One lane's `GET /api/ops-status/<name>/data`, polled every 60 s while the tab is visible (the same pause as
 * fleetPoller.js). `status` is loading | ok | missing (404: the builder has not written data.json yet) | error.
 * The rest is the cockpit source state (lib/sourceState.js): a failed poll keeps the last good `data` with
 * `status: 'ok'`, and sets `error`, `stale` and `errorSince` so the card says so (SourceNote), never as current.
 * COMP-COCKPIT-SOURCE-FAULTS-1 (INIT-VIEW M2): each read takes a sequence number and a reply older than the last one
 * applied is dropped, so an interval read and a visibility read in flight together never roll progress back.
 */
export default function useOpsData(name) {
  const [state, setState] = useState(() => fresh(name));
  useEffect(() => {
    if (!name) return undefined;
    let live = true;
    let timer = null;
    let seq = 0;
    let applied = 0;
    setState(fresh(name));
    const poll = async () => {
      const my = ++seq;
      const accept = () => {
        if (!live || my < applied) return false;
        applied = my;
        return true;
      };
      try {
        const res = await wsFetch(`/api/ops-status/${encodeURIComponent(name)}/data`);
        const body = await res.json().catch(() => ({}));
        if (res.status !== 404 && !res.ok) throw new Error(body.error ?? `data route ${res.status}`);
        if (!accept()) return;
        const at = Date.now();
        if (res.status === 404) setState({ ...fresh(name), status: 'missing', message: body.error ?? 'no data yet', loading: false, fetchedAt: at });
        else setState({ ...fresh(name), status: 'ok', data: body, loading: false, fetchedAt: at });
      } catch (e) {
        if (!accept()) return;
        setState((s) => {
          const next = sourceFail(s, e);
          return { ...s, ...next, name, status: next.data ? 'ok' : 'error', message: next.error };
        });
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
