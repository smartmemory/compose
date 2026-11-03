import React, { useEffect, useState } from 'react';
import { activePreset, fromLocalInput, PRESET_KEYS, PRESET_LABEL, toLocalInput } from './rangeLogic.js';

/**
 * RangeBar — the ribbon's time-window controls (COMP-COCKPIT-RIBBON-RANGE-1): the 6h / day / 3d / week presets, back/forward
 * one window, "Live", the start and end pickers, and the clamp note. It owns only the picker drafts; every committed change
 * goes out through a callback. A picker commits on blur, so spinning a field never refetches.
 *
 * COMP-DAYVIEW-DESIGN-FIX-1 U2 M8: the presets come first (the common act), then the steps, then "Live" (pressed while the
 * window follows now, and never disabled: pressing it again is a harmless "yes, now"). The pickers are hidden until the
 * ribbon's title is clicked (`pickersOpen`), because the title already says the window once. The resets switch moved to
 * the resets row it controls.
 */
const BTN = 'rounded-md border border-border bg-card px-2 py-1 text-[12px] text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-card';
const INPUT = 'rounded-md border border-border bg-card px-1.5 py-1 text-[12px] text-foreground';

export default function RangeBar({ window: w, following, clampedBecause, onRange, onPreset, onStep, onNow, pickersOpen = false, alertChip = null, onAlertChip }) {
  const [start, setStart] = useState(toLocalInput(w.from));
  const [end, setEnd] = useState(toLocalInput(w.to));
  useEffect(() => { setStart(toLocalInput(w.from)); setEnd(toLocalInput(w.to)); }, [w.from, w.to]);

  const active = activePreset(w);
  const commitStart = () => {
    const iso = fromLocalInput(start, w.from);
    if (iso && iso !== w.from) onRange(iso, w.to, 'to');
    else setStart(toLocalInput(w.from));
  };
  const commitEnd = () => {
    const iso = fromLocalInput(end, w.to);
    if (iso && iso !== w.to) onRange(w.from, iso, 'from');
    else setEnd(toLocalInput(w.to));
  };

  return (
    <div className="flex flex-col gap-1" data-testid="range-bar">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Ribbon time window">
        <div className="flex items-center gap-1" role="group" aria-label="Window size">
          {PRESET_KEYS.map((k) => (
            <button key={k} type="button" className={`${BTN}${active === k ? ' border-primary font-semibold' : ''}`} aria-pressed={active === k}
              data-testid={`range-preset-${k}`} onClick={() => onPreset(k)}>{PRESET_LABEL[k]}</button>
          ))}
        </div>
        <button type="button" className={BTN} aria-label="Back one window" data-testid="range-back" onClick={() => onStep(-1)}>◀</button>
        <button type="button" className={BTN} aria-label="Forward one window" data-testid="range-forward" onClick={() => onStep(1)}>▶</button>
        <button type="button" className={`${BTN}${following ? ' border-primary font-semibold' : ''}`} data-testid="range-now" aria-pressed={!!following}
          title={following ? 'Following now' : 'Back to now'} onClick={onNow}>Live</button>
        {pickersOpen && (
          <>
            <label className="flex items-center gap-1 text-[length:var(--type-label)] text-muted-foreground">
              Start
              <input type="datetime-local" className={INPUT} data-testid="range-start" value={start}
                onChange={(e) => setStart(e.target.value)} onBlur={commitStart} />
            </label>
            <label className="flex items-center gap-1 text-[length:var(--type-label)] text-muted-foreground">
              End
              <input type="datetime-local" className={INPUT} data-testid="range-end" value={end}
                onChange={(e) => setEnd(e.target.value)} onBlur={commitEnd} />
            </label>
          </>
        )}
        {alertChip && (
          // U2 M12: the open count in the warning's text tone (4.5:1 on the card), never the bar fill color.
          <button type="button" className={`${BTN}${alertChip.open ? ' text-[hsl(var(--warning-ink))]' : ' text-muted-foreground'}`} data-testid="ribbon-alert-chip" title={alertChip.tip} aria-label={alertChip.tip.replace(/\n/g, '. ')} onClick={onAlertChip}>
            {alertChip.open ? `⚠ ${alertChip.open}${alertChip.cleared ? ` (+${alertChip.cleared} cleared)` : ''}` : `✓ ${alertChip.cleared} cleared`}
          </button>
        )}
      </div>
      {clampedBecause && <p className="m-0 text-[length:var(--type-label)] text-muted-foreground" role="status" data-testid="range-clamp">{clampedBecause}</p>}
    </div>
  );
}
