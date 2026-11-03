import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WhatLine from '../cockpit/what/WhatLine.jsx';
import { useNotifySources } from '../cockpit/notify/useNotifySources.js';
import { ribbonAlerts } from '../cockpit/notify/notifyState.js';
import { publishSeats } from '../cockpit/notify/useNotifyState.js';
import { useCostMeterProps } from '../vision/HomeFleetGlance.jsx';
import DayRibbon from './DayRibbon.jsx';
import { alertTip, isLive, orphanAlerts, sourceErrorLines, withOwnerOpen } from './ribbonLayout.js';
import { PRESETS } from './rangeLogic.js';
import { daySources } from './daySources.js';
import { DayMissingSources, DaySourceNotes } from './DaySourceNotes.jsx';
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
import { SplitHandle, useUpperHeight } from './DaySplit.jsx';

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

/** Dispatch a cancelable window event; true when a listener took it (called `preventDefault()`). */
export function dispatchRibbon(type, detail) {
  return !window.dispatchEvent(new CustomEvent(type, { detail, cancelable: true }));
}

const readResetsHidden = () => { try { return localStorage.getItem(RESETS_HIDDEN_KEY) === '1'; } catch { return false; } };
const readIdleOpen = () => { try { return sessionStorage.getItem(IDLE_OPEN_KEY) === '1'; } catch { return false; } };

/** U2 M4: the missing-source lines live in ribbonLayout.js now (the phone shows them too); re-exported for old callers. */
export { sourceErrorLines };

/**
 * U2 M15: what the ribbon draws while a window loads. The last body any window returned gives the lanes their names, group
 * and seat; nothing that belongs to a time is kept (no spans, marks, pins or bands), so the old window's bars never sit on
 * the new window's axis. Before any body has arrived there are no lanes, and the ribbon draws its axis alone.
 */
export function skeletonOf(last) {
  if (!Array.isArray(last?.lanes)) return { lanes: [] };
  return { lanes: last.lanes.map((l) => ({ lane: l.lane, group: l.group, seat: l.seat, idle: l.idle, spans: [], marks: [] })) };
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
  // U2 F1 + NOW M3: the Now lists (phone, drawer) read the window that holds now. When the ribbon shows a past window, a
  // second read of the day window stands in, so a look back never makes the Now list describe the past.
  const live = isLive(win.window.from, win.window.to, win.now);
  const dayWin = useMemo(() => PRESETS.day(win.now), [win.now]);
  const nowFeed = useRibbonFeed(dayWin, { enabled: !live });
  const nowSrc = live ? feed : nowFeed;
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
  const openIds = (body) => {
    const open = body?.owner?.open;
    return Array.isArray(open) ? (ownerAsks(open, notify.notify?.state ?? null, Date.now())?.rows ?? []).map((r) => r.id) : null;
  };
  const ribbonData = useMemo(() => withOwnerOpen(feed.data, openIds(feed.data), win.now), [feed.data, notify.notify?.state, win.now]); // eslint-disable-line react-hooks/exhaustive-deps
  // One filtered Now feed, through the same owner-ask rule as the ribbon, so the phone's Now line, the drawer and the ribbon's
  // NOW words cannot disagree after an ask is answered from the cockpit (F1).
  const nowData = useMemo(() => (live ? ribbonData : withOwnerOpen(nowFeed.data, openIds(nowFeed.data), win.now)), [live, ribbonData, nowFeed.data, notify.notify?.state, win.now]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // COMP-DAYVIEW-SPLIT-1: the upper panel's height is the viewer's (dragged, remembered); the page scrolls past the meter.
  const rootRef = useRef(null);
  const upperRef = useRef(null);
  const split = useUpperHeight(upperRef, rootRef);
  // RIBBON-NOW-1: the WHAT counts open "now" lists here; the phone layout drops the ribbon.
  const phone = usePhoneLayout();
  const fleet = useFleet().data;
  const unitSrc = useUnitIndex();
  const unitIndex = unitSrc.data;
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
  const phoneRef = useRef(false);
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
    // U2 (METER M1): take the event only for a target this page draws right now. The phone draws no ribbon and a seat the
    // meter does not render has no row to flash; taking those would swallow the tray's own fallback for nothing.
    const onFocus = (e) => {
      const { lane, seat } = e.detail || {};
      if (phoneRef.current) return;
      const seatShown = seat && seatsRef.current.some((s) => s.id === seat)
        && [...document.querySelectorAll('[data-testid^="cost-meter-seat-"]')].some((n) => n.getAttribute('data-testid') === `cost-meter-seat-${seat}`);
      if (seatShown) {
        e.preventDefault();
        setMeterOpen(true);
        flash(setFlashSeat, seat);
      } else if (lane && lanesRef.current.some((l) => l.lane === lane) && document.querySelector('[data-testid="day-ribbon"]')) {
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

  // U3 (review U2 F2 + SOURCE-ENVELOPE-1): the source state of every feed this page renders, computed once; the desktop,
  // the phone and the Now drawer each draw all of it.
  const sources = useMemo(
    () => daySources({ feed, nowFeed, live, index: unitSrc }),
    [feed, nowFeed, live, unitSrc],
  );
  const [pickersOpen, setPickersOpen] = useState(false);
  phoneRef.current = phone;
  // U3 (AD#18): the two questions down read as links: the accent ink at the body size, underlined on hover and focus.
  const footLink = 'text-[length:var(--type-body)] text-[color:var(--rb-accent)] hover:underline focus-visible:underline underline-offset-2 outline-none';

  const drawer = nowKind && <NowDrawer kind={nowKind} onClose={closeNow} fleet={fleet} index={unitIndex} feed={nowData} feedLoading={nowSrc.loading} agent={agent} lastVisitAt={lastVisitAt} sources={sources} />;
  if (phone) {
    return (
      <div className="h-full min-h-0 overflow-hidden" data-testid="day-view">
        <DayPhone feed={nowData} sources={sources} index={unitIndex} meter={meter} lastVisitAt={lastVisitAt} onOpenFleet={onOpenFleet} onNavigate={onNavigate} onCountOpen={setNowKind} />
        {drawer}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="h-full min-h-0 flex flex-col gap-2 p-3 overflow-y-auto" data-testid="day-view">
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
        pickersOpen={pickersOpen}
        alertChip={alertChip}
        onAlertChip={openAlertTray}
      />
      {/* COMP-DAYVIEW-SPLIT-1: a fixed, dragged height (never flex-1), so a tall meter below pushes the page, not the ribbon. */}
      <div ref={upperRef} className="shrink-0 min-h-0 flex flex-col gap-1 relative" style={{ height: split.height }} data-testid="day-upper">
        {/* TOP M1 + U3: a failed read says whether it is read again; a failed refresh over kept data says so (the ribbon
            stays, marked old); the Now feed and the unit index say the same here as on the phone and in the drawer. */}
        <DaySourceNotes sources={sources} />
        {(feed.data || feed.loading) && (
          // M15: while a window loads, the axis and the lane names stay on screen with "updating…", never a blank panel.
          <div className="flex-1 min-h-0" data-testid={feed.loading ? 'day-skeleton' : undefined} aria-busy={feed.loading || undefined}>
            <DayRibbon
              data={feed.loading ? skeletonOf(feed.last) : ribbonData}
              updating={feed.loading}
              onTitleClick={() => setPickersOpen((v) => !v)}
              onResetsToggle={toggleResets}
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
        <RibbonLaneLayer data={ribbonData} from={win.window.from} to={win.window.to} now={win.now} />
        <DayMissingSources sources={sources} />
      </div>
      <SplitHandle {...split} />
      {/* COMP-DAYVIEW-SPLIT-1 (owner 2026-11-03): the meter at its full height, every seat and dollar row, no scroll inside it.
          When the upper panel and the meter do not fit, the page (this root) scrolls. */}
      <div className="shrink-0 flex flex-col gap-1" data-testid="day-meter">
        <div data-testid="day-meter-box">
          <RibbonMeterLayer meter={meter} flashSeat={flashSeat} onNavigate={onNavigate} />
        </div>
      </div>
      <RibbonMarksLayer lanes={feed.data?.lanes} seats={seats} now={win.now} onNavigate={onNavigate} />
      <div className="flex items-center gap-4 shrink-0" data-testid="day-footer">
        <button type="button" className={footLink} data-testid="day-link-process" onClick={() => onNavigate?.('process')}>Is the process improving? ▸</button>
        <button type="button" className={footLink} data-testid="day-link-ops" onClick={() => onNavigate?.('ops')}>How far is 2.0 from flipping? ▸</button>
      </div>
      {drawer}
    </div>
  );
}
