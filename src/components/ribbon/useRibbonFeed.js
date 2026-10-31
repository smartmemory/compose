/**
 * useRibbonFeed.js — GET /api/ribbon for the current window (COMP-COCKPIT-RIBBON-RANGE-1).
 *
 * `loading` stays true until the first response for THIS window, so a consumer draws a skeleton, never an empty ribbon.
 * A change of window aborts the request in flight; the last 5 windows are kept in memory (a cached window shows at once);
 * the poll runs every 120 s, and only while the window contains now and the document is visible. A window with
 * `from >= to` never reaches the feed.
 */
import { useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

export const RIBBON_POLL_MS = 120_000;
export const RIBBON_CACHE_WINDOWS = 5;

const keyOf = (w) => `${w.from}|${w.to}`;
const usable = (w) => w && Date.parse(w.from) < Date.parse(w.to);
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function useRibbonFeed(win, { enabled = true } = {}) {
  const cache = useRef(new Map());
  const key = usable(win) ? keyOf(win) : null;
  const [snap, setSnap] = useState({ key: null, data: null, error: null });

  useEffect(() => {
    if (!enabled || !key) return undefined;
    const [from, to] = key.split('|');
    const ctl = { current: null };
    let dead = false;

    const remember = (data) => {
      cache.current.delete(key);
      cache.current.set(key, data);
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
        remember(data);
        setSnap({ key, data, error: null });
      } catch (e) {
        if (dead || ac.signal.aborted) return;
        setSnap((s) => ({ key, data: s.key === key ? s.data : null, error: String(e?.message ?? e) }));
      }
    };

    if (cache.current.has(key)) setSnap({ key, data: cache.current.get(key), error: null });
    else setSnap({ key, data: null, error: null });
    const cachedPast = cache.current.has(key) && !(Date.parse(from) <= Date.now() && Date.now() <= Date.parse(to));
    if (!cachedPast) load();

    const timer = setInterval(() => {
      const n = Date.now();
      if (hidden() || !(Date.parse(from) <= n && n <= Date.parse(to))) return;
      load();
    }, RIBBON_POLL_MS);
    return () => { dead = true; clearInterval(timer); ctl.current?.abort(); };
  }, [key, enabled]);

  const mine = snap.key === key;
  const data = mine ? snap.data : null;
  const error = mine ? snap.error : null;
  return { data, error, loading: enabled && !!key && !data && !error };
}
