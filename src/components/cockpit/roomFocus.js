/**
 * roomFocus.js — COMP-UI-LINKS-1: what a cross-room jump asks the target room to show (a Cadence unit, a Stratum run and step, a
 * Fleet session). Rooms mount only while open, so a jump cannot hand the target a prop: the caller files the focus here, then
 * switches the view, and the room reads it when it mounts (or at once when it is already open). Same module-level idiom as
 * PaneSwitcher's `paneMemory`.
 *
 * A focus is `{ room, focus, at }`; `at` is new on every request, so asking for the same unit twice still lands. A room calls
 * `useRoomFocus(room, apply)`: `apply(focus)` runs once per request for that room, then the request is consumed.
 */
import { useEffect, useSyncExternalStore } from 'react';

let current = null;
let seq = 0;
const listeners = new Set();

export function requestRoomFocus(room, focus) {
  current = { room, focus: focus ?? {}, at: ++seq };
  for (const l of listeners) l();
}

export const resetRoomFocus = () => { current = null; };

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const snapshot = () => current;

/** Runs `apply(focus)` once for every request filed for `room`, including one filed before the room mounted. */
export function useRoomFocus(room, apply) {
  const req = useSyncExternalStore(subscribe, snapshot, snapshot);
  const mine = req && req.room === room ? req : null;
  useEffect(() => {
    if (!mine) return;
    current = null; // consumed: a later remount of the room must not replay it
    apply(mine.focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine?.at]);
}
