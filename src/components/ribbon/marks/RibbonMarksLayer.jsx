import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cardFor } from './markCards.js';
import MarkPopover from './MarkPopover.jsx';

/** Same names as `EVT` in `../DayView.jsx` (not imported: DayView mounts this layer, so importing it back is a cycle). */
const OPEN = ['compose:ribbon-open-mark', 'compose:ribbon-open-pin', 'compose:ribbon-open-band'];
const INBOX = 'compose:open-inbox';
/** Where a unit's records live, shown and copied by "unit page ▸" (no native unit page, and `/api/file` serves the project only). */
export const unitPath = (id) => `smart-memory-ops/units/${id}/`;

/**
 * RibbonMarksLayer — listens for the ribbon's three cancelable open events, takes each (`preventDefault()`), and shows a
 * `MarkPopover`. It never writes anywhere: "unit page ▸" copies a path, "reverse ▸" and the initiative link only open
 * another view.
 */
export default function RibbonMarksLayer({ lanes, seats, now, onNavigate }) {
  const [open, setOpen] = useState(null); // {card, rect, note}
  const ctx = useRef({});
  ctx.current = { lanes, seats, now };
  const trigger = useRef(null);

  const show = useCallback((item, rect) => {
    trigger.current = document.activeElement;
    setOpen({ card: cardFor(item, ctx.current), rect, note: '' });
  }, []);

  useEffect(() => {
    const take = (pick) => (e) => {
      const item = pick(e.detail || {});
      if (!item) return;
      e.preventDefault();
      show(item, e.detail.rect || { left: 0, top: 0, bottom: 0, width: 0 });
    };
    const handlers = [take((d) => d.mark), take((d) => d.pin), take((d) => d.band)];
    OPEN.forEach((t, i) => window.addEventListener(t, handlers[i]));
    return () => OPEN.forEach((t, i) => window.removeEventListener(t, handlers[i]));
  }, [show]);

  const close = useCallback((why) => {
    setOpen(null);
    const el = trigger.current;
    trigger.current = null;
    const back = () => { if (el && el.isConnected && typeof el.focus === 'function') el.focus(); };
    if (why === 'outside') {
      // The press that closed the card is still landing; give focus back only if it left focus on nothing, so a click on
      // another control keeps its own focus.
      setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) back(); }, 0);
    } else if (why !== 'nav') back();
  }, []);

  const act = useCallback((a) => {
    if (a.type === 'card') {
      setOpen((o) => o && { ...o, card: cardFor(a.item, ctx.current), note: '' });
    } else if (a.type === 'unit') {
      const path = unitPath(a.id);
      const done = (note) => setOpen((o) => o && { ...o, note });
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(path).then(() => done(`Path copied: ${path}`), () => done(`Copy failed. Path: ${path}`));
      else done(`Path: ${path}`);
    } else if (a.type === 'reverse') {
      const taken = !window.dispatchEvent(new CustomEvent(INBOX, { detail: { focus: a.id }, cancelable: true }));
      if (!taken && onNavigate) onNavigate('fleet');
      close('nav');
    } else if (a.type === 'initiative') {
      if (onNavigate) onNavigate('ops');
      close('nav');
    }
  }, [close, onNavigate]);

  if (!open) return null;
  return <MarkPopover card={open.card} rect={open.rect} note={open.note} onClose={close} onAction={act} />;
}
