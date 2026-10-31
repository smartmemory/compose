import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const W = 300;
const GAP = 8;

/**
 * MeterPopover — one small card anchored at `rect` (the clicked seat row or money block). The same rules as
 * RIBBON-MARKS-1's MarkPopover: Esc, a press outside, a scroll elsewhere and a resize close it, focus moves in on open and
 * the layer puts it back on the trigger on close, no animation (so reduced motion needs no case). It renders a meterCards
 * card (`rows`, `bars`, `link`); `onLink()` runs the link.
 */
export default function MeterPopover({ card, rect, onClose, onLink }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const h = ref.current ? ref.current.offsetHeight : 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(GAP, Math.min((rect?.left ?? 0) + (rect?.width ?? 0) / 2 - W / 2, vw - W - GAP));
    const below = (rect?.bottom ?? 0) + GAP;
    // The meter sits at the bottom of the page, so the card opens upward when there is no room below.
    const top = below + h > vh - GAP ? Math.max(GAP, (rect?.top ?? 0) - h - GAP) : below;
    setPos({ left, top });
  }, [rect, card]);

  useEffect(() => { ref.current?.querySelector('button')?.focus(); }, [card.kind, card.id]);

  useEffect(() => {
    const inside = (t) => ref.current && ref.current.contains(t);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose('esc'); } };
    const onDown = (e) => { if (!inside(e.target)) onClose('outside'); };
    const onScroll = (e) => { if (!inside(e.target)) onClose('scroll'); };
    const onResize = () => onClose('resize');
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  return (
    <div ref={ref} role="dialog" aria-label={card.title} tabIndex={-1} data-testid="meter-popover" data-kind={card.kind}
      className="fixed z-50 rounded-lg border border-border bg-card p-3 text-[12px] shadow-lg outline-none"
      style={{ left: pos.left, top: pos.top, width: W }}>
      <div className="font-bold text-foreground" data-testid="meter-popover-title">{card.title}</div>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5" data-testid="meter-popover-rows">
        {card.rows.map((r) => (
          <React.Fragment key={r.label}>
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className={`m-0 ${r.missing ? 'text-muted-foreground' : 'text-foreground'}`} data-testid={`meter-row-${r.label}`} data-missing={r.missing ? 'true' : undefined}>{r.value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {card.bars && (
        <div className="mt-2 flex h-10 items-end gap-px" role="img" aria-label="Spend by closed hour today" data-testid="meter-popover-bars">
          {card.bars.hours.map((b, i) => (
            <div key={i} title={`${b.label}:00 $${Math.round(b.usd)}`} className="flex-1 rounded-sm bg-primary" style={{ height: `${card.bars.max > 0 ? Math.max(4, (b.usd / card.bars.max) * 100) : 4}%` }} />
          ))}
        </div>
      )}
      <div className="mt-2">
        <button type="button" data-testid="meter-popover-link" className="text-[12px] text-muted-foreground hover:text-foreground hover:underline focus-visible:underline outline-none" onClick={onLink}>
          {card.link.label}
        </button>
      </div>
    </div>
  );
}
