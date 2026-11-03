import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WhatLine from '../cockpit/what/WhatLine.jsx';
import { useNotifySources } from '../cockpit/notify/useNotifySources.js';
import { ribbonAlerts } from '../cockpit/notify/notifyState.js';
import { publishSeats } from '../cockpit/notify/useNotifyState.js';
import { useCostMeterProps } from '../vision/HomeFleetGlance.jsx';
import DayRibbon from './DayRibbon.jsx';
import { alertTip, orphanAlerts, withOwnerOpen } from './ribbonLayout.js';
import { ownerAsks } from '../cockpit/notify/notifyLogic.js';
import RangeBar from './RangeBar.jsx';
import { useRibbonWindow } from './useRibbonWindow.js';
import { useRibbonFeed } from './useRibbonFeed.js';
import RibbonLaneLayer from './lane/RibbonLaneLayer.jsx';
import RibbonMarksLayer from './marks/RibbonMarksLayer.jsx';
import { useFleet } from '../../lib/fleetPoller.js';
import { laneChips, openProjectGraph, useProjectModel } from '../../lib/fleetProjects.js';
import { useUnitIndex } from '../../lib/useUnitIndex.js';
import { useAgentState } from '../cockpit/what/useAgentState.js';
import { readLastVisit } from '../cockpit/what/whatRules.js';
import NowDrawer from './now/NowDrawer.jsx';
import DayPhone from './now/DayPhone.jsx';
import { usePhoneLayout } from './now/usePhoneLayout.js';
import RibbonMeterLayer from './meter/RibbonMeterLayer.jsx';

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
/** RESETS-COMPACT-1: the viewer's choice to hide the AHEAD resets row, kept per browser. */
export const RESETS_HIDDEN_KEY = 'compose:ribbonResetsHidden';
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

const readResetsHidden = () => { try { return localStorage.getItem(RESETS_HIDDEN_KEY) === '1'; } catch { return false; } };
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
  // COMP-COCKPIT-PROJECT-MODEL-1: each ops-lane row's project chip; `{}` (no chips) when projects.roots is unset.
  const projectModel = useProjectModel(active);
  const chips = useMemo(() => laneChips(projectModel.model), [projectModel.model]);
  const notify = useNotifySources();
  const meter = useCostMeterProps();
  // `useNotifySources` already ran `collect` over the shared fleet and cadence reads; its rows are the ribbon's alerts.
  // NOTIFY-ACTIONS-1: a row's `since` is its AGE IN SECONDS, so it becomes a time here (it never landed before); cleared
  // rows and stored entries whose source is gone are drawn too, muted, so a cleared alert keeps its mark.
  const alerts = useMemo(
    () => (notify.collected ? ribbonAlerts(notify.collected, notify.notify?.state ?? null, Date.now()) : NO_ALERTS),
    [notify.collected, notify.notify?.state],
  );
  const seats = useMemo(() => seatPcts(meter.seats), [meter.seats]);
  // C3: the ribbon draws an owner wait at now only for an ask the WHAT line still counts: the same `ownerAsks` rule over the
  // feed's open asks, with the same notify state (an ask answered from the cockpit stops counting in both at once).
  const ribbonData = useMemo(() => {
    const open = feed.data?.owner?.open;
    const ids = Array.isArray(open) ? (ownerAsks(open, notify.notify?.state ?? null, Date.now())?.rows ?? []).map((r) => r.id) : null;
    return withOwnerOpen(feed.data, ids, win.now);
  }, [feed.data, notify.notify?.state, win.now]);
  const openOwner = useCallback(() => {
    if (window.dispatchEvent(new CustomEvent('compose:open-inbox', { cancelable: true }))) onOpenFleet?.(); // same fallback as the WHAT line
  }, [onOpenFleet]);
  // "Until reset" on a seat wall reads the seat rows this page already polls (never a second read).
  useEffect(() => { publishSeats(meter.seats); }, [meter.seats]);

  const [idleOpen, setIdleOpen] = useState(readIdleOpen);
  const setIdle = useCallback((open) => {
    setIdleOpen(open);
    try { sessionStorage.setItem(IDLE_OPEN_KEY, open ? '1' : '0'); } catch { /* storage denied */ }
  }, []);
  const [resetsHidden, setResetsHidden] = useState(readResetsHidden);
  const toggleResets = useCallback(() => {
    setResetsHidden((hidden) => {
      try { localStorage.setItem(RESETS_HIDDEN_KEY, hidden ? '0' : '1'); } catch { /* storage denied */ }
      return !hidden;
    });
  }, []);
  // The AHEAD row's lane-less alert triangles live on this chip now; a click opens the header chip's tray (the full list).
  const alertChip = useMemo(() => {
    const rows = orphanAlerts(alerts, win.window.from, win.window.to);
    if (!rows.length) return null;
    const open = rows.filter((a) => !a.cleared);
    return {
      open: open.length,
      cleared: rows.length - open.length,
      tip: rows.map((a) => alertTip(a, win.now).replace('\n', ' ')).join('\n'),
    };
  }, [alerts, win.window.from, win.window.to, win.now]);
  const openAlertTray = useCallback(() => { document.querySelector('[data-testid="notify-chip"]')?.click(); }, []);
  const [meterOpen, setMeterOpen] = useState(false);
  // RIBBON-NOW-1: the WHAT counts open "now" lists here; the phone layout drops the ribbon.
  const phone = usePhoneLayout();
  const fleet = useFleet().data;
  const unitIndex = useUnitIndex().data;
  const agent = useAgentState();
  const [lastVisitAt] = useState(readLastVisit);
  const [nowKind, setNowKind] = useState(null);
  const nowKindRef = useRef(null);
  nowKindRef.current = nowKind;
  const closeNow = useCallback(() => {
    const id = { working: 'working', waiting: 'review', landed: 'landed' }[nowKindRef.current];
    setNowKind(null);
    setTimeout(() => document.querySelector(`[data-testid="what-count-${id}"]`)?.focus(), 0); // focus returns to the count
  }, []);
  const [flashLane, setFlashLane] = useState(null);
  const [flashSeat, setFlashSeat] = useState(null);
  const seatsRef = useRef([]);
  seatsRef.current = Array.isArray(meter.seats) ? meter.seats : [];
  const lanesRef = useRef([]);
  lanesRef.current = feed.data?.lanes || [];
  const flashTimer = useRef(null);

  // The tray's "Show <lane> / <seat>": flash the row (opening the idle fold first when that lane is folded away inside it) or
  // the seat in the meter (opening the meter box so the row is on screen). A target Day does not draw is left alone, so the
  // tray falls back to the row's own action.
  useEffect(() => {
    const flash = (set, id) => {
      set(id);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => { setFlashLane(null); setFlashSeat(null); }, FLASH_CLEAR_MS);
    };
    const onFocus = (e) => {
      const { lane, seat } = e.detail || {};
      if (seat && seatsRef.current.some((s) => s.id === seat)) {
        e.preventDefault();
        setMeterOpen(true);
        flash(setFlashSeat, seat);
      } else if (lane && lanesRef.current.some((l) => l.lane === lane)) {
        e.preventDefault();
        if (lanesRef.current.some((l) => l.lane === lane && l.idle)) setIdle(true);
        flash(setFlashLane, lane);
      }
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

  const drawer = nowKind && <NowDrawer kind={nowKind} onClose={closeNow} fleet={fleet} index={unitIndex} feed={feed.data} feedLoading={feed.loading} agent={agent} lastVisitAt={lastVisitAt} />;
  if (phone) {
    return (
      <div className="h-full min-h-0 overflow-hidden" data-testid="day-view">
        <DayPhone feed={feed.data} index={unitIndex} meter={meter} lastVisitAt={lastVisitAt} onOpenFleet={onOpenFleet} onNavigate={onNavigate} onCountOpen={setNowKind} />
        {drawer}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 p-3 overflow-hidden" data-testid="day-view">
      <div className="sticky top-0 z-10 bg-background" data-testid="day-what">
        <WhatLine onOpenFleet={onOpenFleet} onNavigate={onNavigate} onCountOpen={setNowKind} />
      </div>
      <RangeBar
        window={win.window}
        following={win.following}
        clampedBecause={win.clampedBecause}
        onRange={win.setRange}
        onPreset={win.preset}
        onStep={win.step}
        onNow={win.goNow}
        resetsHidden={resetsHidden}
        onResetsToggle={toggleResets}
        alertChip={alertChip}
        onAlertChip={openAlertTray}
      />
      <div className="flex-1 min-h-0 flex flex-col gap-1 relative">
        {feed.loading && (
          <div className="flex-1 rounded-xl border border-border bg-card animate-pulse" data-testid="day-skeleton" aria-label="Loading the ribbon" />
        )}
        {feed.error && !feed.data && (
          <p className="m-0 text-[12px] text-destructive" role="status" data-testid="day-feed-error">The ribbon could not be loaded: {feed.error}</p>
        )}
        {feed.data && (
          <div className="flex-1 min-h-0">
            <DayRibbon
              data={ribbonData}
              onOwnerOpen={openOwner}
              from={win.window.from}
              to={win.window.to}
              now={win.now}
              seats={seats}
              alerts={alerts}
              showResets={!resetsHidden}
              idleOpen={idleOpen}
              onIdleToggle={() => setIdle(!idleOpen)}
              onLaneOpen={openLane}
              laneProjects={chips}
              onProjectOpen={(c) => openProjectGraph(c.project, c.lane)}
              onMarkOpen={openMark}
              onPinOpen={openPin}
              onBandOpen={openBand}
              flashLane={flashLane}
              onAxisSelect={win.zoom}
            />
          </div>
        )}
        <RibbonLaneLayer data={feed.data} from={win.window.from} to={win.window.to} now={win.now} />
        {missing.length > 0 && (
          <ul className="m-0 pl-4 text-[12px] text-muted-foreground" data-testid="day-source-errors">
            {missing.map((m) => <li key={m}>Not drawn: {m}</li>)}
          </ul>
        )}
      </div>
      {/* The shared meter's full form is ~470 px tall and would squeeze the ribbon to a thumbnail at 1440x900, so it sits in a
          capped, scrollable box that opens fully on request. Nothing is dropped; the ribbon keeps the height. */}
      <div className="shrink-0 flex flex-col gap-1" data-testid="day-meter">
        <div className={meterOpen ? 'max-h-[40vh] overflow-y-auto' : 'max-h-[176px] overflow-y-auto'} data-testid="day-meter-box">
          <RibbonMeterLayer meter={meter} flashSeat={flashSeat} onNavigate={onNavigate} />
        </div>
        <button type="button" className={`${link} self-start`} aria-expanded={meterOpen} data-testid="day-meter-toggle" onClick={() => setMeterOpen((v) => !v)}>
          {meterOpen ? 'Show less ▴' : 'Show all seats and dollars ▾'}
        </button>
      </div>
      <RibbonMarksLayer lanes={feed.data?.lanes} seats={seats} now={win.now} onNavigate={onNavigate} />
      <div className="flex items-center gap-4 shrink-0" data-testid="day-footer">
        <button type="button" className={link} data-testid="day-link-process" onClick={() => onNavigate?.('process')}>Is the process improving? ▸</button>
        <button type="button" className={link} data-testid="day-link-ops" onClick={() => onNavigate?.('ops')}>How far is 2.0 from flipping? ▸</button>
      </div>
      {drawer}
    </div>
  );
}
