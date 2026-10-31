/**
 * PaneSwitcher (COMP-COCKPIT-TAB-DEPTH-1): the third navigation level. It is never a tab row: it is one small segmented
 * pill group at the top of a room's content, cycled with `[` (previous) and `]` (next, wraps). The two tab rows above the
 * content (the room row and the views row) stay the only underline rows.
 *
 * Props:
 *   panes     {Array<{key, label, testId?}>}
 *   active    {string}   the active pane key
 *   onChange  {fn}       called with a pane key
 *   label     {string}   aria-label of the group
 *   trailing  {node?}    controls that sit beside the pills (Wiki's feature-code input, Ops' builder link)
 */
import React, { useEffect, useRef, useState } from 'react';

const TEXT_TARGET = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** The pane `[`/`]` lands on from `active`: a step of -1 or +1, wrapping. Null when there is nothing to cycle. */
export function stepPane(panes, active, step) {
  if (!panes || panes.length < 2) return null;
  const i = panes.findIndex((p) => p.key === active);
  return panes[(i + step + panes.length) % panes.length].key;
}

/** Room key -> last pane. Module scope so it outlives the view that unmounts when a room is left (the `lastByRoom` pattern). */
const paneMemory = new Map();
export const resetPaneMemory = () => paneMemory.clear();

/**
 * `[pane, setPane]` remembered per room: leaving the room and coming back reopens the last pane. A stored pane no longer
 * offered falls back to `initial`; `force` (a deep link) skips the memory for this mount.
 */
export function usePaneMemory(roomKey, initial, valid, force = false) {
  const [pane, setPaneState] = useState(() => {
    const kept = paneMemory.get(roomKey);
    return !force && kept && (!valid || valid.includes(kept)) ? kept : initial;
  });
  const setPane = (next) => { paneMemory.set(roomKey, next); setPaneState(next); };
  return [pane, setPane];
}

export default function PaneSwitcher({ panes, active, onChange, label, trailing = null }) {
  // The listener reads the latest props from a ref so one `keydown` handler stays attached for the mount.
  const live = useRef({ panes, active, onChange });
  live.current = { panes, active, onChange };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '[' && e.key !== ']') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof Element && (t.closest(TEXT_TARGET) || t.isContentEditable)) return;
      const { panes: ps, active: cur, onChange: change } = live.current;
      const next = stepPane(ps, cur, e.key === '[' ? -1 : 1);
      if (next != null) { e.preventDefault(); change?.(next); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!panes || panes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 shrink-0" data-testid="pane-switcher-bar">
      <div
        role="tablist"
        aria-label={label}
        data-testid="pane-switcher"
        title="[ and ] switch panes"
        className="inline-flex flex-wrap items-center gap-0.5 rounded-full border border-border bg-muted/40 p-0.5 max-w-full"
      >
        {panes.map((p) => {
          const on = p.key === active;
          return (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={p.testId || `pane-${p.key}`}
              onClick={() => onChange?.(p.key)}
              className={[
                'px-2.5 h-6 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors',
                on ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >{p.label}</button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
