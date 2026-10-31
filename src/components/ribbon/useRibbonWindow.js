/**
 * useRibbonWindow.js — the ribbon's window state and its URL hash (COMP-COCKPIT-RIBBON-RANGE-1).
 *
 * `{window, following}`. No hash on load: following, the window is the day default re-resolved each minute (it is anchored
 * to local midnight, so its value only changes at the day boundary and the feed is not refetched every minute). A valid
 * `#ribbon.` hash on load or on `hashchange`: that window, not following. Every committed user change writes the hash with
 * `history.replaceState`; the hash is written only while `active` is true. "Now" clears the hash and follows again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyPreset, clampWindow, formatHash, isoAt, isRibbonHash, parseHash, PRESETS, step as stepWindow, zoneOf,
} from './rangeLogic.js';

const TICK_MS = 60_000;
/** `clock()` returns ms (read in the browser's zone) or an ISO string with an offset (a test's fixed clock). */
const nowIso = (clock) => { const v = clock(); return typeof v === 'string' ? v : isoAt(v, zoneOf(v)); };
const same = (a, b) => a.from === b.from && a.to === b.to;

function readHash() {
  if (typeof window === 'undefined') return null;
  const parsed = parseHash(window.location.hash);
  return parsed ? clampWindow(parsed, { anchor: 'to' }).window : null;
}

export function useRibbonWindow({ active = true, clock = Date.now } = {}) {
  const [now, setNow] = useState(() => nowIso(clock));
  const [state, setState] = useState(() => {
    const fromHash = readHash();
    return fromHash ? { window: fromHash, following: false } : { window: PRESETS.day(nowIso(clock)), following: true };
  });
  const [clampedBecause, setClampedBecause] = useState(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;

  // One minute tick: moves the NOW line, and re-resolves the day default while following (same value = same object).
  useEffect(() => {
    const id = setInterval(() => {
      const n = nowIso(clockRef.current);
      setNow(n);
      setState((s) => {
        if (!s.following) return s;
        const w = PRESETS.day(n);
        return same(w, s.window) ? s : { window: w, following: true };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  // A hash that arrives later (back/forward, a pasted link) moves the window and stops following.
  useEffect(() => {
    const onHash = () => {
      const w = readHash();
      if (w) { setClampedBecause(null); setState({ window: w, following: false }); }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The one hash writer: only while active and not following, and only when the hash would change.
  useEffect(() => {
    if (!active || state.following) return;
    const hash = formatHash(state.window);
    if (window.location.hash === hash) return;
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
  }, [active, state]);

  const commit = useCallback((w, anchor) => {
    const { window: legal, clampedBecause: why } = clampWindow(w, { anchor });
    setClampedBecause(why);
    if (legal) setState({ window: legal, following: false });
    return legal;
  }, []);

  const setRange = useCallback((from, to, anchor = 'from') => commit({ from, to }, anchor), [commit]);
  const preset = useCallback((key) => commit(applyPreset(key, state.window, nowIso(clockRef.current)), 'from'), [commit, state.window]);
  const stepBy = useCallback((dir) => commit(stepWindow(state.window, dir), 'from'), [commit, state.window]);
  const zoom = useCallback((fromMs, toMs) => {
    const off = zoneOf(state.window.from);
    return commit({ from: isoAt(fromMs, off), to: isoAt(toMs, off) }, 'from');
  }, [commit, state.window]);
  const goNow = useCallback(() => {
    const n = nowIso(clockRef.current);
    setClampedBecause(null);
    setNow(n);
    setState({ window: PRESETS.day(n), following: true });
    if (active && isRibbonHash(window.location.hash)) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    }
  }, [active]);

  return { window: state.window, following: state.following, now, clampedBecause, setRange, preset, step: stepBy, zoom, goNow };
}
