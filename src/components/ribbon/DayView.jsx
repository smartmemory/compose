import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WhatLine from '../cockpit/what/WhatLine.jsx';
import CostMeter from '../cockpit/cost/CostMeter.jsx';
import { useNotifySources } from '../cockpit/notify/useNotifySources.js';
import { useCostMeterProps } from '../vision/HomeFleetGlance.jsx';
import DayRibbon from './DayRibbon.jsx';
import RangeBar from './RangeBar.jsx';
import { useRibbonWindow } from './useRibbonWindow.js';
import { useRibbonFeed } from './useRibbonFeed.js';

/**
 * DayView — the front page (COMP-COCKPIT-RIBBON-TOP-1): the WHAT line, the range bar, the ribbon and the cost meter on one
 * screen, with two links into the layer below. It owns no drawing and no data rule: it mounts the shared parts and wires
 * them. A click on a lane, mark, pin or band goes out as a cancelable window event; a later unit's listener calls
 * `preventDefault()` to take it, and when nobody does the fallback here runs (the lane opens Fleet > Process, the others
 * leave the tooltip alone).
 */
export const EVT = {
  openLane: 'compose:ribbon-open-lane',
  openMark: 'compose:ribbon-open-mark',
  openPin: 'compose:ribbon-open-pin',
  openBand: 'compose:ribbon-open-band',
  focus: 'compose:ribbon-focus',
};
export const IDLE_OPEN_KEY = 'compose:ribbonIdleOpen';
const FLASH_CLEAR_MS = 1700;
const NO_ALERTS = [];

/** Plain-word names for `sourceErrors` keys (`server/ribbon-routes.js`). */
const SOURCE_WORDS = {
  stamps: 'unit stamps', quota: 'seat quota', ownerQueue: 'the owner queue', holds: 'launch holds', ledger: 'the ledger', outage: 'outage notices',
};

/** Dispatch a cancelable window event; true when a listener took it (called `preventDefault()`). */
export function dispatchRibbon(type, detail) {
  return !window.dispatchEvent(new CustomEvent(type, { detail, cancelable: true }));
}

const readIdleOpen = () => { try { return sessionStorage.getItem(IDLE_OPEN_KEY) === '1'; } catch { return false; } };

export function sourceErrorLines(sourceErrors) {
  return Object.entries(sourceErrors || {}).map(([k, v]) => `${SOURCE_WORDS[k] || k} is missing (${String(v).slice(0, 120)})`);
}

/** `[{label, pct}]` for DayRibbon's "(seatN has room for them)": five-hour used percent of each active seat. */
export function seatPcts(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((s) => s && s.retired !== true && !s.codex_daily)
    .map((s) => ({ label: s.label, pct: typeof s.five_h?.used_pct === 'number' ? s.five_h.used_pct : null }));
}

export default function DayView({ onOpenFleet, onNavigate, active = true }) {
  const win = useRibbonWindow({ active });
  const feed = useRibbonFeed(win.window);
  const notify = useNotifySources();
  const meter = useCostMeterProps();
  // `useNotifySources` already ran `collect` over the shared fleet and cadence reads; its rows are the ribbon's alerts.
  const alerts = notify.collected?.rows || NO_ALERTS;
  const seats = useMemo(() => seatPcts(meter.seats), [meter.seats]);

  const [idleOpen, setIdleOpen] = useState(readIdleOpen);
  const setIdle = useCallback((open) => {
    setIdleOpen(open);
    try { sessionStorage.setItem(IDLE_OPEN_KEY, open ? '1' : '0'); } catch { /* storage denied */ }
  }, []);
  const [flashLane, setFlashLane] = useState(null);
  const lanesRef = useRef([]);
  lanesRef.current = feed.data?.lanes || [];
  const flashTimer = useRef(null);

  // The tray's "jump to lane": flash the row, and open the idle fold first when that lane is folded away inside it.
  useEffect(() => {
    const onFocus = (e) => {
      const lane = e.detail?.lane;
      if (!lane) return;
      if (lanesRef.current.some((l) => l.lane === lane && l.idle)) setIdle(true);
      setFlashLane(lane);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashLane(null), FLASH_CLEAR_MS);
    };
    window.addEventListener(EVT.focus, onFocus);
    return () => { window.removeEventListener(EVT.focus, onFocus); clearTimeout(flashTimer.current); };
  }, [setIdle]);

  const openLane = useCallback((lane) => {
    const name = typeof lane === 'string' ? lane : lane?.lane;
    if (!dispatchRibbon(EVT.openLane, { lane: name })) onNavigate?.('process'); // fallback until RIBBON-LANE-1 listens
  }, [onNavigate]);
  const openMark = useCallback((mark, rect) => { dispatchRibbon(EVT.openMark, { mark, rect }); }, []);
  const openPin = useCallback((pin, rect) => { dispatchRibbon(EVT.openPin, { pin, rect }); }, []);
  const openBand = useCallback((band) => { dispatchRibbon(EVT.openBand, { band }); }, []);

  const missing = sourceErrorLines(feed.data?.sourceErrors);
  const link = 'text-[12px] text-muted-foreground hover:text-foreground hover:underline focus-visible:underline outline-none';

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 p-3 overflow-hidden" data-testid="day-view">
      <div className="sticky top-0 z-10 bg-background" data-testid="day-what">
        <WhatLine onOpenFleet={onOpenFleet} onNavigate={onNavigate} />
      </div>
      <RangeBar
        window={win.window}
        following={win.following}
        clampedBecause={win.clampedBecause}
        onRange={win.setRange}
        onPreset={win.preset}
        onStep={win.step}
        onNow={win.goNow}
      />
      <div className="flex-1 min-h-0 flex flex-col gap-1">
        {feed.loading && (
          <div className="flex-1 rounded-xl border border-border bg-card animate-pulse" data-testid="day-skeleton" aria-label="Loading the ribbon" />
        )}
        {feed.error && !feed.data && (
          <p className="m-0 text-[12px] text-destructive" role="status" data-testid="day-feed-error">The ribbon could not be loaded: {feed.error}</p>
        )}
        {feed.data && (
          <div className="flex-1 min-h-0">
            <DayRibbon
              data={feed.data}
              from={win.window.from}
              to={win.window.to}
              now={win.now}
              seats={seats}
              alerts={alerts}
              idleOpen={idleOpen}
              onIdleToggle={() => setIdle(!idleOpen)}
              onLaneOpen={openLane}
              onMarkOpen={openMark}
              onPinOpen={openPin}
              onBandOpen={openBand}
              flashLane={flashLane}
              onAxisSelect={win.zoom}
            />
          </div>
        )}
        {missing.length > 0 && (
          <ul className="m-0 pl-4 text-[12px] text-muted-foreground" data-testid="day-source-errors">
            {missing.map((m) => <li key={m}>Not drawn: {m}</li>)}
          </ul>
        )}
      </div>
      <CostMeter compact {...meter} />
      <div className="flex items-center gap-4 shrink-0" data-testid="day-footer">
        <button type="button" className={link} data-testid="day-link-process" onClick={() => onNavigate?.('process')}>Is the process improving? ▸</button>
        <button type="button" className={link} data-testid="day-link-ops" onClick={() => onNavigate?.('ops')}>How far is 2.0 from flipping? ▸</button>
      </div>
    </div>
  );
}
