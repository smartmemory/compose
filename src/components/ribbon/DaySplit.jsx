/**
 * DaySplit.jsx — COMP-DAYVIEW-SPLIT-1: the Day view's upper panel (notes, ribbon, missing sources) takes a height the viewer
 * drags, and the meter below it renders at its full height. When the two do not fit, the page scrolls, never the meter.
 *
 * `useUpperHeight` owns the height (read once from storage, clamped to the window), `SplitHandle` is the separator between
 * the two panels: pointer drag, ArrowUp/ArrowDown, Home/End, double-click back to the default.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const UPPER_HEIGHT_KEY = 'compose:day-upper-height';
/** The ribbon's title row (~28 px with the border) plus its own geometry at two lanes (DayRibbon.jsx GEOM: axis AX 46, +6,
 *  one group header GH 22, two lane rows RH 2 x 30, +8 bottom = 142): 170 px still shows the axis and two lanes. */
export const UPPER_MIN_PX = 170;
/** Today's ribbon at a 1440x900 viewport, read from the layout (rough, by hand): 900 - header 36 = 864 for the view; minus
 *  padding 24, WHAT line ~20, range bar ~30, the old capped meter 176 + 4 + toggle ~18, footer ~24 and four 8 px gaps = 536. */
export const UPPER_DEFAULT_PX = 536;
/** A stored height above this is not a height any screen gives: it reads as corrupt and the default stands. */
export const UPPER_STORED_MAX_PX = 4000;
export const UPPER_STEP_PX = 16;
export const HANDLE_PX = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The stored height, or the default for a missing, unreadable or out-of-range value. Never throws. */
export function readUpperHeight() {
  try {
    const raw = localStorage.getItem(UPPER_HEIGHT_KEY);
    if (raw == null || raw.trim() === '') return UPPER_DEFAULT_PX;
    const n = Number(raw);
    return Number.isFinite(n) && n >= UPPER_MIN_PX && n <= UPPER_STORED_MAX_PX ? Math.round(n) : UPPER_DEFAULT_PX;
  } catch { return UPPER_DEFAULT_PX; }
}
const writeUpperHeight = (px) => { try { localStorage.setItem(UPPER_HEIGHT_KEY, String(px)); } catch { /* storage denied */ } };
const clearUpperHeight = () => { try { localStorage.removeItem(UPPER_HEIGHT_KEY); } catch { /* storage denied */ } };

/** The tallest upper panel whose handle still sits on screen with the page scrolled to its top. jsdom has no layout: the
 *  panel's top reads 0 there, so the max is the window height less the handle. */
function maxFor(upper, scroller) {
  const top = upper ? upper.getBoundingClientRect().top + (scroller?.scrollTop || 0) : 0;
  return Math.max(UPPER_MIN_PX, Math.floor((window.innerHeight || 0) - top - HANDLE_PX));
}

export function useUpperHeight(upperRef, scrollerRef) {
  const [want, setWant] = useState(readUpperHeight);
  const [max, setMax] = useState(() => maxFor(null, null));
  const measure = useCallback(() => {
    const m = maxFor(upperRef.current, scrollerRef.current);
    setMax((old) => (old === m ? old : m));
    return m;
  }, [upperRef, scrollerRef]);
  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);
  // `persist: false` while a drag moves, so storage is written once, on release.
  const set = useCallback((px, persist = true) => {
    const v = clamp(Math.round(px), UPPER_MIN_PX, measure());
    setWant(v);
    if (persist) writeUpperHeight(v);
    return v;
  }, [measure]);
  const reset = useCallback(() => { setWant(UPPER_DEFAULT_PX); clearUpperHeight(); }, []);
  return { height: clamp(want, UPPER_MIN_PX, max), min: UPPER_MIN_PX, max, set, reset };
}

export function SplitHandle({ height, min, max, set, reset }) {
  const [drag, setDrag] = useState(null); // {y, h, last}
  const dragRef = useRef(null);
  dragRef.current = drag;
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => { const d = dragRef.current; if (d) d.last = set(d.h + (e.clientY - d.y), false); };
    const up = () => { const d = dragRef.current; if (d) set(d.last, true); setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [!drag, set]); // eslint-disable-line react-hooks/exhaustive-deps
  const onKeyDown = (e) => {
    const to = { ArrowUp: height - UPPER_STEP_PX, ArrowDown: height + UPPER_STEP_PX, Home: min, End: max }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    set(to);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the ribbon panel"
      aria-valuenow={height}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid="day-split-handle"
      className="group shrink-0 flex items-center justify-center cursor-row-resize touch-none outline-none select-none"
      style={{ height: HANDLE_PX }}
      onPointerDown={(e) => { if (e.button > 0) return; e.preventDefault(); setDrag({ y: e.clientY, h: height, last: height }); }}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    >
      <span className={`h-1 w-12 rounded-full ${drag ? 'bg-foreground/50' : 'bg-border group-hover:bg-foreground/40 group-focus-visible:bg-foreground/60'}`} />
    </div>
  );
}
