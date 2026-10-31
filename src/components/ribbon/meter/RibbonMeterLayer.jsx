import React, { useCallback, useEffect, useRef, useState } from 'react';
import CostMeter from '../../cockpit/cost/CostMeter.jsx';
import { meterRows } from '../../cockpit/cost/costLogic.js';
import MeterPopover from './MeterPopover.jsx';
import useHourlySpend from './useHourlySpend.js';
import { seatCard, moneyCard } from './meterCards.js';

/**
 * RibbonMeterLayer — the Day page's cost meter plus its two cards (COMP-COCKPIT-RIBBON-METER-1). It is the SAME `CostMeter`
 * with the optional open props, never a second meter. `meter` is `useCostMeterProps()`; `flashSeat` outlines a seat row
 * (the tray's "Show s2 ▸"). Both card links open Usage, whose default pane is Seats and fleet.
 */
export default function RibbonMeterLayer({ meter, flashSeat = null, onNavigate, now }) {
  const [open, setOpen] = useState(null); // {kind: 'seat', id, rect} | {kind: 'money', rect}
  const hourly = useHourlySpend();
  const trigger = useRef(null);
  const at = now ? Date.parse(now) : Date.now();

  const show = useCallback((next) => { trigger.current = document.activeElement; setOpen(next); }, []);
  const close = useCallback((why) => {
    setOpen(null);
    const el = trigger.current;
    trigger.current = null;
    if (why !== 'nav' && el && el.isConnected && typeof el.focus === 'function') el.focus();
  }, []);

  // A flashed seat may sit below the meter box's fold: bring its row into view.
  useEffect(() => {
    if (!flashSeat) return;
    document.querySelector(`[data-testid="cost-meter-seat-${flashSeat}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [flashSeat]);

  let card = null;
  if (open?.kind === 'seat') {
    const seat = (meter.seats || []).find((s) => s.id === open.id);
    if (seat) card = seatCard(seat, at);
  } else if (open?.kind === 'money') {
    card = moneyCard({ spend: meter.spend, codex: meterRows(meter.seats, meter.spend, at).codex, hourly, credit: meter.credit });
  }

  return (
    <>
      <CostMeter
        compact
        {...meter}
        now={now}
        flashSeat={flashSeat}
        onSeatOpen={(seat, rect) => show({ kind: 'seat', id: seat.id, rect })}
        onMoneyOpen={(rect) => show({ kind: 'money', rect })}
      />
      {card && (
        <MeterPopover card={card} rect={open.rect} onClose={close} onLink={() => { onNavigate?.(card.link.to); close('nav'); }} />
      )}
    </>
  );
}
