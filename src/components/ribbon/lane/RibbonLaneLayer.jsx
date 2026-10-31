import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFleet } from '../../../lib/fleetPoller.js';
import { smPanel } from '../../cockpit/fleetLogic.js';
import LaneDrawer from './LaneDrawer.jsx';
import LanePage from './LanePage.jsx';
import { sessionsForLane } from './laneLogic.js';

const OPEN_LANE = 'compose:ribbon-open-lane'; // same string as DayView's EVT.openLane (not imported: DayView mounts this file)
const NO_SESSIONS = [];

/**
 * RibbonLaneLayer — listens for `compose:ribbon-open-lane`, takes it (`preventDefault()`) and holds `{lane, mode}`. It reads
 * the feed DayView already loaded for the current window, so the drawer and the page show the same window as the ribbon and
 * fetch nothing. Esc closes (page → ribbon, drawer → row), and focus returns to the row that opened it.
 */
export default function RibbonLaneLayer({ data, from, to, now }) {
  const [open, setOpen] = useState(null); // {lane, mode: 'drawer' | 'page'}
  const dataRef = useRef(data);
  dataRef.current = data;
  const fleet = useFleet();
  const lane = open && (data?.lanes || []).find((l) => l.lane === open.lane);

  const returnTo = useRef(null);
  const close = useCallback(() => {
    setOpen((cur) => { if (cur) returnTo.current = cur.lane; return null; });
  }, []);
  // Focus goes back to the row that opened the drawer or page once it has unmounted.
  useEffect(() => {
    if (open || !returnTo.current) return;
    const name = returnTo.current;
    returnTo.current = null;
    [...document.querySelectorAll('[data-lane]')].find((el) => el.getAttribute('data-lane') === name)?.focus();
  }, [open]);

  useEffect(() => {
    const onOpen = (e) => {
      const name = e.detail?.lane;
      if (!name || !(dataRef.current?.lanes || []).some((l) => l.lane === name)) return; // unknown lane: leave the fallback to run
      e.preventDefault();
      setOpen({ lane: name, mode: 'drawer' });
    };
    window.addEventListener(OPEN_LANE, onOpen);
    return () => window.removeEventListener(OPEN_LANE, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!open || !lane) return null;
  const sessions = open.mode === 'drawer' ? sessionsForLane(smPanel(fleet.data, 'sessions')?.value, lane.lane) : NO_SESSIONS;
  const live = data?.live !== false;
  const at = data?.now || now;
  return open.mode === 'page'
    ? <LanePage lane={lane} from={from} to={to} now={at} onBack={close} />
    : <LaneDrawer lane={lane} live={live} now={at} sessions={sessions} onClose={close} onOpenPage={() => setOpen({ lane: open.lane, mode: 'page' })} />;
}
