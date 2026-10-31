/**
 * NotifyActions.jsx — COMP-COCKPIT-NOTIFY-ACTIONS-1: the ONE inline-actions block for a tray row and an inbox-drawer row.
 * The row's class (`actionClassOf`) decides the controls, all on the same screen:
 *   ask       one button per option (`optionsOf`), a reply box with Send, Open in chat. Answers go to the owner queue.
 *   security  Acknowledge (Compose list only), Resolved… (a required "What did you do?" field, then Confirm), Open in chat.
 *   alert     Acknowledge, Snooze (1 hour, until reset, until tomorrow 09:00), Dismiss; the parent adds its jump / Open.
 *   info      Acknowledge, Snooze, Dismiss (the decided row keeps its reverse line and Copy id, drawn by the parent).
 * A cleared row shows what cleared it and Restore. Labels are plain text, never HTML. Nothing submits from the keyboard
 * except Enter on a focused button: `rowKeys` moves focus (`a`), it never answers.
 */
import React from 'react';
import { optionsOf, choiceText } from '../../../../lib/ask-options.js';
import {
  actionClassOf, keyOf, clearMeta, snoozePresets, isCleared, securityAck, answeredOf, CLEARED_WORD, hhmm,
} from './notifyState.js';
import { writeState, answerOwner } from './useNotifyState.js';

export const OWNER_CHAT_URL = import.meta.env?.VITE_OWNER_CHAT_URL || '';
const btn = 'shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] leading-4 hover:bg-muted focus-visible:bg-muted outline-none disabled:cursor-default disabled:text-muted-foreground';
const note = 'text-[11px] text-muted-foreground';

function OpenInChat({ id }) {
  const [copied, setCopied] = React.useState(false);
  const open = () => {
    navigator.clipboard?.writeText(`Re ${id}: `).then(() => setCopied(true), () => setCopied(false));
    setCopied(true);
    if (OWNER_CHAT_URL) window.open(OWNER_CHAT_URL, '_blank', 'noopener,noreferrer');
  };
  return (
    <>
      <button type="button" className={btn} data-action="chat" data-testid="notify-open-chat" onClick={open}>Open in chat</button>
      {copied && <span className={note} data-testid="notify-chat-copied" role="status">Copied. Paste in s1-chat</span>}
    </>
  );
}

function SnoozeMenu({ presets, onPick, onClose }) {
  React.useEffect(() => {
    // Esc closes the snooze menu first, before the drawer or the tray (capture phase, so their handlers never see it).
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div role="menu" data-testid="notify-snooze-menu" className="flex flex-wrap items-center gap-1">
      {presets.map((p) => (
        <button key={p.id} type="button" role="menuitem" className={btn} data-testid={`notify-snooze-${p.id}`} onClick={() => onPick(p)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

function ClearControls({ row, state, notify, now }) {
  const key = keyOf(row);
  const [menu, setMenu] = React.useState(false);
  const closeMenu = React.useCallback(() => setMenu(false), []);
  const err = notify.errors?.get(key);
  const entry = state?.entries?.[key];
  if (isCleared(key, row, state, now)) {
    const word = CLEARED_WORD[entry.action] ?? entry.action;
    return (
      <div className="flex flex-wrap items-center gap-1.5" data-testid="notify-cleared-line">
        <span className={note}>{word} {hhmm(entry.at)}{entry.action === 'snooze' ? ` until ${hhmm(entry.until)}` : ''}</span>
        <button type="button" className={btn} data-action="restore" data-testid="notify-restore" onClick={() => writeState(key, 'restore')}>Restore</button>
        {err && <span className={note} role="alert" data-testid="notify-write-error">Not saved: {err}</span>}
      </div>
    );
  }
  const meta = clearMeta(row, now);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className={btn} data-action="ack" data-testid="notify-ack" onClick={() => writeState(key, 'ack', { meta })}>Acknowledge</button>
      <button type="button" className={btn} data-action="snooze" data-testid="notify-snooze" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>Snooze ▾</button>
      <button type="button" className={btn} data-action="dismiss" data-testid="notify-dismiss" onClick={() => writeState(key, 'dismiss', { meta })}>Dismiss</button>
      {menu && (
        <SnoozeMenu
          presets={snoozePresets(row, notify.seats, now)}
          onClose={closeMenu}
          onPick={(p) => { setMenu(false); writeState(key, 'snooze', { until: p.until, meta }); }}
        />
      )}
      {err && <span className={note} role="alert" data-testid="notify-write-error">Not saved: {err}</span>}
    </div>
  );
}

function phaseLine(a) {
  if (!a) return null;
  if (a.phase === 'sending') return 'Sending…';
  if (a.phase === 'conflict') return `Already answered${a.channel ? ` (via ${a.channel})` : ''}: ${a.winning}`;
  if (a.phase === 'rejected' || a.phase === 'error') return `Not sent: ${a.reason}`;
  return null;
}

function AskControls({ row, notify, state }) {
  const id = row.id;
  const [text, setText] = React.useState('');
  const a = notify.answers?.get(id);
  const answered = answeredOf(state, `ask:${id}`);
  if (a?.phase === 'accepted' || answered) {
    const at = answered?.at ?? a?.at;
    const ans = answered?.answer || a?.answer || '';
    return <div className={note} data-testid="notify-answered">answered {hhmm(at)}: {ans}</div>;
  }
  const sending = a?.phase === 'sending';
  const options = optionsOf({ text: row.text, options: row.options });
  const line = phaseLine(a);
  return (
    <div className="flex flex-col gap-1" data-testid="notify-ask-controls">
      {options.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={btn}
              data-action="option"
              data-testid="notify-option"
              disabled={sending}
              onClick={() => answerOwner(id, { choice: o.value }, { answerText: `OWNER (via cockpit): ${choiceText(o)}` })}
            >
              ({o.value}) {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          type="text"
          data-action="reply"
          data-testid="notify-reply"
          aria-label={`Reply to ${id}`}
          placeholder="Reply…"
          maxLength={1000}
          value={text}
          disabled={sending}
          onChange={(e) => setText(e.target.value)}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-[12px]"
        />
        <button
          type="button"
          className={btn}
          data-testid="notify-send"
          disabled={sending || !text.trim()}
          onClick={() => answerOwner(id, { text: text.trim() }, { answerText: `OWNER (via cockpit): ${text.trim()}` })}
        >
          Send
        </button>
        <OpenInChat id={id} />
      </div>
      {line && <div className={note} role={a.phase === 'sending' ? 'status' : 'alert'} data-testid="notify-answer-line" data-phase={a.phase}>{line}</div>}
    </div>
  );
}

function SecurityControls({ row, notify, state, now, resolveOpen, setResolveOpen }) {
  const id = row.id;
  const key = keyOf(row);
  const [text, setText] = React.useState('');
  const a = notify.answers?.get(id);
  const resolved = answeredOf(state, key);
  const acked = securityAck(state, key, row);
  const err = notify.errors?.get(key);
  if (a?.phase === 'accepted' || resolved) {
    return <div className={note} data-testid="notify-resolved">resolved {hhmm(resolved?.at ?? a?.at)}</div>;
  }
  const sending = a?.phase === 'sending';
  const line = phaseLine(a);
  return (
    <div className="flex flex-col gap-1" data-testid="notify-security-controls" data-acked={acked ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-1.5">
        {acked
          ? <span className={note} data-testid="notify-acked">acknowledged {hhmm(acked.at)}</span>
          : <button type="button" className={btn} data-action="ack" data-testid="notify-ack" onClick={() => writeState(key, 'ack', { meta: clearMeta(row, now) })}>Acknowledge</button>}
        <button type="button" className={btn} data-action="resolve" data-testid="security-resolve" aria-expanded={resolveOpen} onClick={() => setResolveOpen(!resolveOpen)}>Resolved…</button>
        <OpenInChat id={id} />
      </div>
      {resolveOpen && (
        <div className="flex flex-col gap-1" data-testid="security-resolve-form">
          <label className="flex min-w-0 items-center gap-1.5 text-[12px]">
            <span className="shrink-0">What did you do?</span>
            <input
              type="text"
              data-action="resolve-text"
              data-testid="security-resolve-text"
              required
              maxLength={300}
              value={text}
              disabled={sending}
              placeholder="rotated the Slack token"
              onChange={(e) => setText(e.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-[12px]"
            />
          </label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={btn}
              data-testid="security-resolve-confirm"
              disabled={sending || !text.trim()}
              onClick={() => answerOwner(id, { resolve: true, text: text.trim() }, { answerText: `OWNER (via cockpit): resolved: ${text.trim()}` })}
            >
              Confirm
            </button>
            <button type="button" className={btn} data-testid="security-resolve-cancel" onClick={() => { setResolveOpen(false); setText(''); }}>Cancel</button>
          </div>
          <div className={note}>This closes the alert. It does not rotate anything for you.</div>
        </div>
      )}
      {line && <div className={note} role={a.phase === 'sending' ? 'status' : 'alert'} data-testid="notify-answer-line" data-phase={a.phase}>{line}</div>}
      {err && <span className={note} role="alert" data-testid="notify-write-error">Not saved: {err}</span>}
    </div>
  );
}

/** The actions block for one row. `children` are the parent's own trailing controls (jump, Open, Copy id). */
export default function NotifyActions({ row, notify, now = Date.now(), children }) {
  const [resolveOpen, setResolveOpen] = React.useState(false);
  const cls = actionClassOf(row);
  const state = notify?.state ?? null;
  const n = notify ?? { errors: new Map(), answers: new Map(), seats: null };
  let body;
  if (cls === 'ask') body = <AskControls row={row} notify={n} state={state} />;
  else if (cls === 'security') body = <SecurityControls row={row} notify={n} state={state} now={now} resolveOpen={resolveOpen} setResolveOpen={setResolveOpen} />;
  else body = <ClearControls row={row} state={state} notify={n} now={now} />;
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="notify-actions" data-class={cls}>
      {body}
      {children ? <div className="flex flex-wrap items-center gap-1.5">{children}</div> : null}
    </div>
  );
}

const typing = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

/**
 * Keyboard for an open drawer or tray: j/k move the selection, Enter expands (via `onExpand`), `a` focuses the selected
 * ask's first option or its reply box (never submits), `d` dismisses and `s` opens the snooze menu on alert and info rows,
 * `r` opens a security row's Resolved field. Ignored while focus is in an input or textarea. Rows are found by
 * `[data-row-index]` under `root`; their class is read from the actions block.
 */
export function useRowKeys({ active, root, count, onExpand }) {
  const [selected, setSelected] = React.useState(-1);
  const [hint, setHint] = React.useState('');
  React.useEffect(() => { if (selected >= count) setSelected(count - 1); }, [count, selected]);
  React.useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const el = root.current?.querySelector(`[data-row-index="${selected}"]`);
      const cls = el?.querySelector('[data-testid="notify-actions"]')?.getAttribute('data-class');
      const click = (sel) => el?.querySelector(sel)?.click();
      switch (e.key) {
        case 'j': e.preventDefault(); setHint(''); setSelected((i) => Math.min(count - 1, i + 1)); break;
        case 'k': e.preventDefault(); setHint(''); setSelected((i) => Math.max(0, i - 1)); break;
        case 'Enter':
          if (selected >= 0 && e.target === document.body) { e.preventDefault(); onExpand?.(selected); }
          break;
        case 'a': {
          if (cls !== 'ask') return;
          e.preventDefault();
          const target = el.querySelector('[data-action="option"]:not([disabled])') ?? el.querySelector('[data-action="reply"]');
          target?.focus();
          break;
        }
        case 'd':
        case 's':
          if (!el) return;
          e.preventDefault();
          if (cls === 'security') { setHint('security rows can be acknowledged or resolved'); return; }
          if (cls === 'alert' || cls === 'info') click(e.key === 'd' ? '[data-action="dismiss"]' : '[data-action="snooze"]');
          break;
        case 'r':
          if (cls !== 'security') return;
          e.preventDefault();
          click('[data-action="resolve"]');
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, root, count, selected, onExpand]);
  return { selected, setSelected, hint };
}
