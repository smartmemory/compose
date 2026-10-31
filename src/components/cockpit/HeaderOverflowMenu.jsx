import React, { useCallback, useRef, useState } from 'react';
import useDismissable from './useDismissable.js';
import { usePhoneLayout } from '../ribbon/now/usePhoneLayout.js';
import EnvironmentHealthPanel from './EnvironmentHealthPanel.jsx';
import BuildAllGsdControl from './BuildAllGsdControl.jsx';
import LaunchPopover from './LaunchPopover.jsx';
import NewMenu from './NewMenu.jsx';
import DisplayMenu from './DisplayMenu.jsx';

/**
 * COMP-COCKPIT-PHONE-HEADER-1: the shell header's controls. At desktop width they are the inline cluster they always were
 * (same elements, same order). Below the phone breakpoint the cluster is ~307 px wide, which pushed the header to 412 px on a
 * 390 px screen, so Batch build, Launch, New and Display fold into one ⋯ menu. Each item is the existing component with its
 * popover in flow (`inline`), so nothing here re-implements what they do and no popover can reach past the viewport.
 */

/** ⋯ button plus a panel fixed 8 px inside both screen edges. `children` is `(close) => nodes`. */
export default function HeaderOverflowMenu({ children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, rootRef, close);

  return (
    <div ref={rootRef} className="relative shrink-0" data-testid="header-overflow-menu">
      <button
        type="button"
        className="compose-btn-icon"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More controls"
        title="Run, Launch, New and Display"
        data-testid="header-overflow-trigger"
      >
        <span aria-hidden="true" className="text-[15px] leading-none">⋯</span>
      </button>
      {open && (
        <div
          role="menu"
          className="fixed left-2 right-2 top-10 z-50 max-h-[calc(100vh-3rem)] overflow-y-auto rounded-md border border-border bg-popover shadow-lg p-1 space-y-1"
          data-testid="header-overflow-panel"
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

function LaunchControl({ activeBuild, open, onOpenChange, inline = false, onDone }) {
  return (
    <div className={inline ? 'relative w-full' : 'relative'}>
      <button
        className={inline ? 'compose-btn-icon w-full justify-start' : 'compose-btn-icon'}
        onClick={() => onOpenChange(!open)}
        title="Launch a fix, new feature, or resume"
        aria-label="Launch lifecycle"
        aria-expanded={open}
        data-testid="launch-popover-toggle"
      >
        {'\u{1F680}'}<span className="ml-1 text-[11px]">Launch</span>
      </button>
      {open && (
        <LaunchPopover
          activeBuild={activeBuild}
          inline={inline}
          onClose={() => { onOpenChange(false); onDone?.(); }}
        />
      )}
    </div>
  );
}

export function HeaderControls({ connected, activeBuild, launchOpen, onLaunchOpenChange, onNewFeature, onNewItem, display }) {
  const phone = usePhoneLayout();

  if (phone) {
    return (
      <div className="flex items-center gap-1 shrink-0" data-testid="header-controls-phone">
        {!connected && (
          <span
            className="w-2 h-2 rounded-full bg-destructive animate-pulse shrink-0"
            role="img"
            aria-label="disconnected"
            title="disconnected"
            data-testid="header-disconnected-dot"
          />
        )}
        <EnvironmentHealthPanel />
        <HeaderOverflowMenu>
          {(close) => (
            <>
              <BuildAllGsdControl inline />
              <LaunchControl inline activeBuild={activeBuild} open={launchOpen} onOpenChange={onLaunchOpenChange} onDone={close} />
              <NewMenu
                inline
                onNewFeature={() => { close(); onNewFeature?.(); }}
                onNewItem={() => { close(); onNewItem?.(); }}
              />
              <DisplayMenu inline {...display} onPairDevice={() => { close(); display.onPairDevice?.(); }} />
            </>
          )}
        </HeaderOverflowMenu>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 min-[1440px]:gap-2 shrink-0" data-testid="header-controls-inline">
      {/* Connection indicator */}
      {!connected && (
        <span className="text-[9px] uppercase tracking-wider text-destructive animate-pulse">
          disconnected
        </span>
      )}

      {/* Environment health (COMP-PARITY-3) — passive drift signal */}
      <EnvironmentHealthPanel />

      {/* COMP-AUDIT-17: labelled clusters. Run: both buttons spawn agents. */}
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground" data-testid="header-run-label">Run</span>

      {/* Build-all / GSD launchers (PARITY-8) */}
      <BuildAllGsdControl />

      {/* Launch fix / new / resume lifecycle (PARITY-2) */}
      <LaunchControl activeBuild={activeBuild} open={launchOpen} onOpenChange={onLaunchOpenChange} />

      {/* New: feature scaffold (PARITY-9) or a board item */}
      <NewMenu onNewFeature={onNewFeature} onNewItem={onNewItem} />

      {/* Display: theme, font size, pair phone */}
      <DisplayMenu {...display} />
    </div>
  );
}
