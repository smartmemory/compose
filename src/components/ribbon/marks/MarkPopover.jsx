import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const W = 300;
const GAP = 8;
const TONE = { bad: 'text-destructive', warn: 'text-foreground', plain: 'text-foreground' };

/**
 * MarkPopover — one small card anchored at `rect` (a mark's bounding box). Esc, a press outside, a scroll elsewhere and a
 * resize close it; focus moves in on open and the layer puts it back on the mark on close. No animation, so reduced motion
 * needs no special case. `card` is `cardFor`'s output; `onAction(action)` runs a link; `note` is a one-line status
 * ("copied") shown under the links.
 */
export default function MarkPopover({ card, rect, note, onClose, onAction }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    const h = el ? el.offsetHeight : 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(GAP, Math.min((rect?.left ?? 0) + (rect?.width ?? 0) / 2 - W / 2, vw - W - GAP));
    const below = (rect?.bottom ?? 0) + GAP;
    const top = below + h > vh - GAP ? Math.max(GAP, (rect?.top ?? 0) - h - GAP) : below;
    setPos({ left, top });
  }, [rect, card]);

  useEffect(() => {
    const el = ref.current;
    if (el) (el.querySelector('button') || el).focus();
  }, [card]);

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

  const head = `${card.icon ? `${card.icon} ` : ''}${card.title}`;
  return (
    <div ref={ref} role="dialog" aria-label={head} tabIndex={-1} data-testid="mark-popover" data-kind={card.kind}
      className="fixed z-50 rounded-lg border border-border bg-card p-3 text-[12px] shadow-lg outline-none"
      style={{ left: pos.left, top: pos.top, width: W }}>
      <div className={`font-bold ${card.tone === 'bad' ? 'text-destructive' : TONE.plain}`} data-testid="mark-popover-title">{head}</div>
      {card.name && <div className="mt-0.5 font-semibold text-foreground" data-testid="mark-popover-name">{card.name}</div>}
      {card.sub && <div className="text-muted-foreground" data-testid="mark-popover-sub">{card.sub}</div>}
      {card.body && <p className="m-0 mt-2 text-foreground" data-testid="mark-popover-body">{card.body}</p>}
      {card.list && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" data-testid="mark-popover-list">
          {card.list.map((it, i) => (
            <li key={i}>
              <button type="button" className="w-full text-left text-[12px] text-foreground hover:underline focus-visible:underline outline-none" onClick={() => onAction(it.action)}>
                {it.glyph} {it.text} <span className="text-muted-foreground">{it.at}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(card.id || card.links.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground" data-testid="mark-popover-links">
          {card.id && <span>{card.id}</span>}
          {card.links.map((l) => (
            <button key={l.label} type="button" className="text-[12px] text-muted-foreground hover:text-foreground hover:underline focus-visible:underline outline-none" onClick={() => onAction(l.action)}>
              {l.label}
            </button>
          ))}
        </div>
      )}
      {note && <div className="mt-1 text-muted-foreground" role="status" data-testid="mark-popover-note">{note}</div>}
    </div>
  );
}
