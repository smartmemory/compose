/**
 * NotifyChip.jsx — COMP-COCKPIT-NOTIFY-CHIP-1: the header's sticky alert chip ("All clear" / "3 alerts" / "Alerts unknown")
 * and its tray. Rows come from notifyLogic.js (existing sources, existing thresholds). Nothing auto-dismisses.
 * COMP-COCKPIT-NOTIFY-ACTIONS-1: every tray row carries its class's inline actions (NotifyActions.jsx): asks are answered
 * through the owner queue, alerts are acknowledged, snoozed or dismissed in Compose's own list, security rows are
 * acknowledged or resolved. Cleared rows leave the count and sit in a folded "Cleared (n)" list with Restore.
 * Keys while the tray is open: j/k select, a focuses an answer control, d dismiss, s snooze, r resolve, Esc closes.
 * The chip mounts the inbox drawer (NOTIFY-INBOX-1), so `compose:open-inbox` always has a handler while the header is up.
 */
import React from 'react';
import { fmtAge } from '../fleetLogic.js';
import useDismissable from '../useDismissable.js';
import { useNotifySources } from './useNotifySources.js';
import { chipLabel, unknownLine, defaultsLine, jumpOf, tryJump, rowTarget } from './notifyLogic.js';
import { useNavigation } from '../../../lib/navigation.jsx';
import InboxDrawer from './InboxDrawer.jsx';
import NotifyActions, { useRowKeys } from './NotifyActions.jsx';
import { CLEARED_WORD } from './notifyState.js';

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

/**
 * COMP-SUBAPP-ATTENTION-1: run a row's click (notifyLogic.js `rowTarget`, one rule for the tray and the sidebar list). A gate
 * row only opens a room or a gate, never resolves anything; without a navigation provider it falls back to the old routing.
 */
export function openRow(row, { nav, onNavigate, onOpenFleet }) {
  const t = rowTarget(row);
  if (t.to === 'room' && nav?.openRoom) nav.openRoom(t.room, t.focus);
  else if (t.to === 'room') onNavigate?.(t.room);
  else if (t.to === 'gate' && nav?.openGate) nav.openGate(t.id);
  else if (t.to === 'inbox') openInbox(onOpenFleet);
  else if (t.to === 'view') onNavigate?.(t.view);
  else onOpenFleet?.();
}

export default function NotifyChip({ onOpenFleet, onNavigate, dayActive = false }) {
  const nav = useNavigation();
  const { loading, collected, chip, notify } = useNotifySources();
  const [open, setOpen] = React.useState(false);
  const [showCleared, setShowCleared] = React.useState(false);
  const rootRef = React.useRef(null);
  const trayRef = React.useRef(null);
  const close = React.useCallback(() => setOpen(false), []);
  useDismissable(open, rootRef, close);
  const cleared = collected.cleared ?? [];
  const listed = showCleared ? [...collected.rows, ...cleared] : collected.rows;
  const keys = useRowKeys({ active: open, root: trayRef, count: listed.length });
  React.useEffect(() => {
    if (!open) return undefined;
    const onEsc = (e) => { if (e.key === 'Escape') e.preventDefault(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open]);

  const act = (row) => {
    setOpen(false);
    openRow(row, { nav, onNavigate, onOpenFleet });
  };

  // COMP-COCKPIT-RIBBON-METER-1: on Day, a row about a seat or a lane flashes it; if Day does not take it the row's own action runs.
  const jump = (row) => {
    if (tryJump(row)) setOpen(false);
    else act(row);
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
          ref={trayRef}
          className="absolute right-0 top-full z-50 mt-1 w-96 max-w-[calc(100vw-1rem)] max-h-[70vh] overflow-auto rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
        >
          {collected.rows.length === 0 && !note && !defaults && <div className="p-1 text-muted-foreground">{cleared.length ? 'Nothing open.' : 'Nothing open. Every source answered.'}</div>}
          {listed.map((r, i) => (
            <div
              key={r.key}
              data-testid={r.cleared ? 'notify-row-cleared' : 'notify-row'}
              data-row-index={i}
              aria-selected={keys.selected === i}
              data-kind={r.kind}
              data-severity={r.severity}
              className={`flex items-start gap-2 rounded p-1 ${keys.selected === i ? 'bg-muted' : ''}`}
            >
              <span aria-hidden="true" style={{ color: r.cleared ? 'hsl(var(--muted-foreground))' : r.severity === 'critical' ? TONE.critical : TONE.alerts }}>{r.cleared ? '✓' : '●'}</span>
              <div className="min-w-0 flex-1">
                <div
                  className={`font-semibold break-words ${r.cleared ? 'text-muted-foreground' : ''}`}
                  title={r.title}
                  style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                >
                  {r.title}
                </div>
                <div className="text-muted-foreground">
                  {r.sourceLabel}{r.since != null ? ` · ${fmtAge(r.since)}` : ''}{r.detail ? ` · ${r.detail}` : ''}
                </div>
                <NotifyActions row={r} notify={notify}>
                  {dayActive && jumpOf(r) && (
                    <button
                      type="button"
                      data-testid="notify-row-jump"
                      className="shrink-0 underline underline-offset-2 hover:no-underline"
                      onClick={() => jump(r)}
                    >
                      {jumpOf(r).label}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="notify-row-action"
                    className="shrink-0 underline underline-offset-2 hover:no-underline"
                    onClick={() => act(r)}
                  >
                    Open
                  </button>
                </NotifyActions>
              </div>
            </div>
          ))}
          {cleared.length > 0 && (
            <button
              type="button"
              data-testid="notify-cleared-toggle"
              aria-expanded={showCleared}
              className="mt-1 flex w-full items-center gap-1 p-1 text-left text-muted-foreground hover:underline"
              onClick={() => setShowCleared((v) => !v)}
              title={cleared.map((r) => `${r.title}: ${CLEARED_WORD[r.cleared?.action] ?? ''}`).join('\n')}
            >
              <span aria-hidden="true">{showCleared ? '▾' : '▸'}</span> Cleared ({cleared.length})
            </button>
          )}
          {keys.hint && <div data-testid="notify-key-hint" role="status" className="mt-1 p-1 text-muted-foreground">{keys.hint}</div>}
          {collected.stateUnavailable && (
            <div data-testid="notify-state-unavailable" className="mt-1 p-1 text-muted-foreground">Cleared states unavailable: showing everything</div>
          )}
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
