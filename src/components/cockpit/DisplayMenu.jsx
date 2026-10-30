import React, { useCallback, useRef, useState } from 'react';
import useDismissable from './useDismissable.js';

/**
 * Display ▾ (COMP-AUDIT-17): theme, font size and device pairing in one
 * labelled popover, so the header carries words instead of a row of glyphs.
 */
export default function DisplayMenu({
  isDark, onToggleTheme,
  fontSize, minFontSize, maxFontSize, defaultFontSize, onChangeFont, onResetFont,
  onPairDevice,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, rootRef, close);

  return (
    <div ref={rootRef} className="relative shrink-0" data-testid="display-menu">
      <button
        type="button"
        className="compose-btn-icon"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme, font size and phone pairing"
        data-testid="display-menu-trigger"
      >
        Display ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-1 w-56 rounded-md border border-border bg-popover shadow-lg z-50 p-2 space-y-2"
          data-testid="display-menu-popover"
        >
          <button
            type="button"
            role="menuitem"
            onClick={onToggleTheme}
            className="w-full text-left px-1 py-1 rounded text-[11px] text-foreground hover:bg-muted/50"
            data-testid="display-theme"
          >
            {isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
          <div className="flex items-center gap-1 px-1">
            <span className="text-[11px] text-foreground mr-auto">Font size</span>
            <button
              type="button"
              className="compose-btn-icon"
              onClick={() => onChangeFont(-1)}
              disabled={fontSize <= minFontSize}
              title="Decrease font size"
            >
              A&#x2212;
            </button>
            <span className="text-[10px] tabular-nums min-w-[20px] text-center text-muted-foreground">{fontSize}</span>
            <button
              type="button"
              className="compose-btn-icon"
              onClick={() => onChangeFont(1)}
              disabled={fontSize >= maxFontSize}
              title="Increase font size"
            >
              A+
            </button>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={onResetFont}
            disabled={fontSize === defaultFontSize}
            className="w-full text-left px-1 py-1 rounded text-[11px] text-foreground hover:bg-muted/50 disabled:opacity-40"
            title="Reset to default size"
          >
            Reset font size
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onPairDevice?.(); }}
            className="w-full text-left px-1 py-1 rounded text-[11px] text-foreground hover:bg-muted/50"
            data-testid="display-pair"
          >
            Pair phone
          </button>
        </div>
      )}
    </div>
  );
}
