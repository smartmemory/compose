/**
 * NotifyChip.jsx — COMP-COCKPIT-NOTIFY-CHIP-1: the header's sticky alert chip ("All clear" / "3 alerts" / "Alerts unknown")
 * and its tray. Rows come from notifyLogic.js (existing sources, existing thresholds). Nothing auto-dismisses and there is
 * no dismiss in phase 1: a row stays until its source clears it. Read-only: the only actions open the place to act.
 * The chip mounts the inbox drawer (NOTIFY-INBOX-1), so `compose:open-inbox` always has a handler while the header is up.
 */
import React from 'react';
import { fmtAge } from '../fleetLogic.js';
import useDismissable from '../useDismissable.js';
import { useNotifySources } from './useNotifySources.js';
import { chipLabel, unknownLine, defaultsLine } from './notifyLogic.js';
import InboxDrawer from './InboxDrawer.jsx';

/** Owner-queue rows ask the inbox to open; when nothing handles the event the Fleet pane lists them. */
export function openInbox(onOpenFleet) {
  const ev = new CustomEvent('compose:open-inbox', { cancelable: true });
  if (window.dispatchEvent(ev)) onOpenFleet?.();
}

const TONE = {
  'all-clear': 'hsl(var(--muted-foreground))',
  unknown: 'hsl(var(--muted-foreground))',
  alerts: 'hsl(var(--warning, 32 95% 52%))',
  critical: 'hsl(var(--destructive))',
};

export default function NotifyChip({ onOpenFleet, onNavigate }) {
  const { loading, collected, chip } = useNotifySources();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const close = React.useCallback(() => setOpen(false), []);
  useDismissable(open, rootRef, close);

  const act = (row) => {
    setOpen(false);
    if (row.action === 'inbox') openInbox(onOpenFleet);
    else if (row.action === 'cadence') onNavigate?.('cadence');
    else onOpenFleet?.();
  };

  const label = loading ? 'Checking alerts' : chipLabel(chip);
  const color = loading ? TONE.unknown : chip.state === 'alerts' && chip.critical > 0 ? TONE.critical : TONE[chip.state];
  const note = unknownLine(collected);
  const defaults = defaultsLine(collected);

  return (
    <div ref={rootRef} className="relative shrink-0" data-testid="notify-chip-root">
      <button
        type="button"
        data-testid="notify-chip"
        data-state={loading ? 'loading' : chip.state}
        aria-haspopup="true"
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] whitespace-nowrap rounded px-1.5 hover:bg-muted focus-visible:bg-muted outline-none"
        style={{ color }}
        title={note || label}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">●</span> {label}
      </button>
      {open && (
        <div
          data-testid="notify-tray"
          role="dialog"
          aria-label="Alerts"
          className="absolute right-0 top-full z-50 mt-1 w-96 max-h-96 overflow-auto rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
        >
          {collected.rows.length === 0 && !note && !defaults && <div className="p-1 text-muted-foreground">Nothing open. Every source answered.</div>}
          {collected.rows.map((r) => (
            <div key={r.key} data-testid="notify-row" data-kind={r.kind} data-severity={r.severity} className="flex items-start gap-2 p-1">
              <span aria-hidden="true" style={{ color: r.severity === 'critical' ? TONE.critical : TONE.alerts }}>●</span>
              <div className="min-w-0 flex-1">
                <div
                  className="font-semibold break-words"
                  title={r.title}
                  style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                >
                  {r.title}
                </div>
                <div className="text-muted-foreground">
                  {r.sourceLabel}{r.since != null ? ` · ${fmtAge(r.since)}` : ''}{r.detail ? ` · ${r.detail}` : ''}
                </div>
              </div>
              <button
                type="button"
                data-testid="notify-row-action"
                className="shrink-0 underline underline-offset-2 hover:no-underline"
                onClick={() => act(r)}
              >
                Open
              </button>
            </div>
          ))}
          {defaults && (
            <div data-testid="notify-defaults" className="mt-1 p-1 text-muted-foreground">{defaults}</div>
          )}
          {note && (
            <div data-testid="notify-unknown" className="mt-1 border-t border-border p-1 text-muted-foreground">
              {note}: {collected.unknown.join(', ')}
            </div>
          )}
        </div>
      )}
      <InboxDrawer />
    </div>
  );
}
