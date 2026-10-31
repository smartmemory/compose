/**
 * SecurityBanner.jsx — COMP-COCKPIT-NOTIFY-CHIP-1: a full-width red strip under the header while any security row
 * (owner-queue tag SECURITY or CREDENTIAL) is open.
 * COMP-COCKPIT-NOTIFY-ACTIONS-1 (OWNER addendum 2026-10-31): Acknowledge collapses it (Compose's own list; the row stays
 * open in the inbox and the chip stays red); it returns for a new security row or when the same row's text changes, never
 * for an age change. Resolved… (OWNER 21:3x) asks "What did you do?" and, on Confirm, closes the owner-queue row through
 * the answer route; it does not rotate or scrub anything.
 */
import React from 'react';
import { useNotifySources } from './useNotifySources.js';
import { bannerText } from './notifyLogic.js';
import { openInbox } from './NotifyChip.jsx';
import { clearMeta } from './notifyState.js';
import { writeState, answerOwner } from './useNotifyState.js';

const bbtn = 'underline underline-offset-2 whitespace-nowrap hover:no-underline disabled:no-underline disabled:cursor-default';

export default function SecurityBanner({ onOpenFleet }) {
  const { collected, notify } = useNotifySources();
  const [resolving, setResolving] = React.useState(false);
  const [text, setText] = React.useState('');
  const banner = bannerText(collected, notify?.state ?? null);
  const row = banner?.row;
  const phase = row ? notify?.answers?.get(row.id) : null;
  React.useEffect(() => { setResolving(false); setText(''); }, [row?.key]);
  if (!banner) return null;
  const sending = phase?.phase === 'sending';
  const failed = phase && (phase.phase === 'rejected' || phase.phase === 'error' || phase.phase === 'conflict');
  return (
    <div
      data-testid="security-banner"
      role="alert"
      className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 text-xs font-semibold"
      style={{ background: 'hsl(var(--destructive))', color: 'white' }}
    >
      <span className="min-w-0 flex-1 truncate" title={banner.text}>{banner.text}</span>
      {banner.more > 0 && <span data-testid="security-banner-more" className="whitespace-nowrap">+{banner.more} more</span>}
      <button type="button" data-testid="security-banner-ack" className={bbtn} onClick={() => writeState(row.key, 'ack', { meta: clearMeta(row) })}>
        Acknowledge
      </button>
      <button type="button" data-testid="security-resolve" className={bbtn} aria-expanded={resolving} onClick={() => setResolving((v) => !v)}>
        Resolved…
      </button>
      <button type="button" data-testid="security-banner-open" className={bbtn} onClick={() => openInbox(onOpenFleet)}>
        Open inbox
      </button>
      {resolving && (
        <div data-testid="security-resolve-form" className="flex w-full flex-wrap items-center gap-2 pb-1 font-normal">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0">What did you do?</span>
            <input
              type="text"
              data-testid="security-resolve-text"
              required
              maxLength={300}
              value={text}
              disabled={sending}
              placeholder="rotated the Slack token"
              onChange={(e) => setText(e.target.value)}
              className="min-w-0 flex-1 rounded border border-white/60 bg-white px-1.5 py-0.5 text-[12px] text-black"
            />
          </label>
          <button
            type="button"
            data-testid="security-resolve-confirm"
            className={bbtn}
            disabled={sending || !text.trim()}
            onClick={() => answerOwner(row.id, { resolve: true, text: text.trim() }, { answerText: `OWNER (via cockpit): resolved: ${text.trim()}` })}
          >
            Confirm
          </button>
          <button type="button" data-testid="security-resolve-cancel" className={bbtn} onClick={() => { setResolving(false); setText(''); }}>Cancel</button>
          <span className="w-full">This closes the alert. It does not rotate anything for you.</span>
          {sending && <span role="status">Sending…</span>}
          {failed && (
            <span role="alert" data-testid="security-resolve-error">
              {phase.phase === 'conflict' ? `Already closed${phase.channel ? ` (via ${phase.channel})` : ''}: ${phase.winning}` : `Not sent: ${phase.reason}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
