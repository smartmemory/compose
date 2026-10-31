import React, { useCallback, useRef, useState } from 'react';
import useDismissable from './useDismissable.js';

/**
 * New ▾ (COMP-AUDIT-17): the two kinds of "new", each named and explained in
 * one line. Replaces the lone ➕ icon and the sidebar "+ New" button.
 */
export default function NewMenu({ onNewFeature, onNewItem, inline = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, rootRef, close);

  const pick = (fn) => () => { setOpen(false); fn?.(); };

  return (
    <div ref={rootRef} className={inline ? 'relative w-full' : 'relative shrink-0'} data-testid="new-menu">
      <button
        type="button"
        className={inline ? 'compose-btn-icon w-full justify-start' : 'compose-btn-icon'}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Create something new"
        data-testid="new-menu-trigger"
      >
        New ▾
      </button>
      {open && (
        <div
          role="menu"
          className={`${inline ? 'static w-full' : 'absolute top-full right-0 w-64 z-50'} mt-1 rounded-md border border-border bg-popover shadow-lg p-1`}
          data-testid="new-menu-popover"
        >
          <button
            type="button"
            role="menuitem"
            onClick={pick(onNewFeature)}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-muted/50"
            data-testid="new-feature-toggle"
          >
            <span className="block text-[11px] text-foreground">Feature (scaffold)</span>
            <span className="block text-[10px] text-muted-foreground">Creates feature.json and a roadmap row.</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={pick(onNewItem)}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-muted/50"
            data-testid="new-item-toggle"
          >
            <span className="block text-[11px] text-foreground">Item <span className="text-muted-foreground">(⌘N)</span></span>
            <span className="block text-[10px] text-muted-foreground">Adds a card to the board: idea, task, decision or question.</span>
          </button>
        </div>
      )}
    </div>
  );
}
