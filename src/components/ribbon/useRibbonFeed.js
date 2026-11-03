/**
 * useRibbonFeed.js — GET /api/ribbon for the current window (COMP-COCKPIT-RIBBON-RANGE-1).
 *
 * `loading` stays true until the first response for THIS window, so a consumer draws a skeleton, never an empty ribbon.
 * A change of window aborts the request in flight; the last 5 windows are kept in memory (a cached window shows at once);
 * the poll runs every 120 s, and only while the window contains now and the document is visible. A window with
 * `from >= to` never reaches the feed.
 *
 * COMP-DAYVIEW-DESIGN-FIX-1 U2: the hook returns the cockpit's one source shape (`lib/sourceState.js`: `fetchedAt`,
 * `errorSince`, `stale` beside `data` and `error`), so a failed refresh over kept data reads "unreadable since HH:MM" (TOP M1).
 * `last` is the newest body from ANY window, for the loading skeleton's lane names (M15). `sourceGood` is, per
 * `sourceErrors` key, the last time a body read that source cleanly (M4: "not read since HH:MM"), or null when never.
 *
 * U3: a cached window keeps the time its body was fetched, so a failed refresh over it still says "last good read from
 * HH:MM". `retrying` is the poll rule above as a flag (the window holds now): a failed past window is never read again, and
 * the page must not say it is (review U2 F4).
 */
import { useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

export const RIBBON_POLL_MS = 120_000;
export const RIBBON_CACHE_WINDOWS = 5;

const keyOf = (w) => `${w.from}|${w.to}`;
const usable = (w) => w && Date.parse(w.from) < Date.parse(w.to);
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const holdsNow = (from, to, n = Date.now()) => Date.parse(from) <= n && n <= Date.parse(to);

export function useRibbonFeed(win, { enabled = true } = {}) {
  const cache = useRef(new Map());
  const key = usable(win) ? keyOf(win) : null;
  const [snap, setSnap] = useState({ key: null, data: null, error: null, fetchedAt: null, errorSince: null });
  const [last, setLast] = useState(null);
  const good = useRef({});
  const [sourceGood, setSourceGood] = useState({});

  useEffect(() => {
    if (!enabled || !key) return undefined;
    const [from, to] = key.split('|');
    const ctl = { current: null };
    let dead = false;

    const remember = (data, at) => {
      cache.current.delete(key);
      cache.current.set(key, { data, at });
      while (cache.current.size > RIBBON_CACHE_WINDOWS) cache.current.delete(cache.current.keys().next().value);
    };
    const load = async () => {
      ctl.current?.abort();
      const ac = new AbortController();
      ctl.current = ac;
      try {
        const res = await wsFetch(`/api/ribbon?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal: ac.signal });
        if (!res.ok) throw new Error(`ribbon route ${res.status}`);
        const data = await res.json();
        if (dead || ac.signal.aborted) return;
        const at = Date.now();
        remember(data, at);
        const errs = data?.sourceErrors || {};
        const known = ['stamps', 'quota', 'ownerQueue', 'holds', 'ledger', 'outage', 'seats', 'eta', ...Object.keys(errs)];
        known.forEach((k) => { if (!errs[k]) good.current[k] = at; });
        setSourceGood({ ...good.current });
        setLast(data);
        setSnap({ key, data, error: null, fetchedAt: at, errorSince: null });
      } catch (e) {
        if (dead || ac.signal.aborted) return;
        const at = Date.now();
        setSnap((s) => {
          const same = s.key === key;
          return { key, data: same ? s.data : null, error: String(e?.message ?? e), fetchedAt: same ? s.fetchedAt : null, errorSince: same && s.error && s.errorSince ? s.errorSince : at };
        });
      }
    };

    const hit = cache.current.get(key);
    if (hit) setSnap({ key, data: hit.data, error: null, fetchedAt: hit.at, errorSince: null });
    else setSnap({ key, data: null, error: null, fetchedAt: null, errorSince: null });
    const cachedPast = !!hit && !holdsNow(from, to);
    if (!cachedPast) load();

    const timer = setInterval(() => {
      const n = Date.now();
      if (hidden() || !holdsNow(from, to, n)) return;
      load();
    }, RIBBON_POLL_MS);
    return () => { dead = true; clearInterval(timer); ctl.current?.abort(); };
  }, [key, enabled]);

  const mine = snap.key === key;
  const data = mine ? snap.data : null;
  const error = mine ? snap.error : null;
  return {
    data,
    error,
    loading: enabled && !!key && !data && !error,
    stale: !!(error && data),
    fetchedAt: mine ? snap.fetchedAt : null,
    errorSince: mine ? snap.errorSince : null,
    last,
    sourceGood,
    retrying: !!key && holdsNow(win.from, win.to),
  };
}
