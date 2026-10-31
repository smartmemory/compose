/**
 * InboxDrawer.jsx — COMP-COCKPIT-NOTIFY-INBOX-1 (phase 1, read-only): a right-side drawer over the owner queue, grouped by
 * inboxLogic.js (Security, Asks, Decided for you, FYI). Opened by `compose:open-inbox` (it calls preventDefault so the
 * Fleet-pane fallback does not also fire). Rows expand in place to their full text. It reads the shared fleet poll and
 * writes nothing: no answer, no dismiss (phase 2 is COMP-NOTIFY-ASKS-1).
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useFleet } from '../../../lib/fleetPoller.js';
import { fmtAge, smPanel } from '../fleetLogic.js';
import { groupInbox, linkParts, reverseText } from './inboxLogic.js';

const asOf = (fleet) => {
  const t = Date.parse(fleet?.generated ?? '');
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : null;
};

function FullText({ text }) {
  return (
    <div data-testid="inbox-full" className="mt-1 whitespace-pre-wrap break-words">
      {linkParts(text).map((p, i) => (p.href
        ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{p.text}</a>
        : <React.Fragment key={i}>{p.text}</React.Fragment>))}
    </div>
  );
}

function Row({ row, groupId, open, onToggle }) {
  const [copied, setCopied] = React.useState(false);
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(row.id).then(() => setCopied(true), () => {});
  };
  return (
    <div data-testid="inbox-row" data-id={row.id} data-group={groupId} data-red={row.red ? 'true' : 'false'} className="border-b border-border/60 py-1.5">
      <button
        type="button"
        data-testid="inbox-row-toggle"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 text-left outline-none focus-visible:bg-muted"
      >
        <span className="w-10 shrink-0 text-muted-foreground">{row.age != null ? fmtAge(row.age) : '?'}</span>
        <span className="w-24 shrink-0 truncate text-muted-foreground" title={row.by ?? ''}>{row.by ?? 'unknown'}</span>
        <span
          className={`min-w-0 flex-1 ${open ? 'break-words font-semibold' : 'truncate'}`}
          style={{ color: row.red && groupId === 'security' ? 'hsl(var(--destructive))' : undefined }}
        >
          {row.first}
        </span>
        {row.untyped && (
          <span data-testid="inbox-untyped" className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground" title="No type recorded; shown as an ask so nothing is missed">
            untyped
          </span>
        )}
      </button>
      {open && <FullText text={row.text} />}
      {groupId === 'decided' && (
        <div className="mt-1 flex items-center gap-2 text-muted-foreground">
          <span data-testid="inbox-reverse" className="min-w-0 flex-1 break-words">{reverseText(row)}</span>
          <button type="button" data-testid="inbox-copy-id" className="shrink-0 underline underline-offset-2 hover:no-underline" onClick={copy}>
            {copied ? 'Copied' : 'Copy id'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function InboxDrawer() {
  const { data: fleet } = useFleet();
  const [open, setOpen] = React.useState(false);
  const [unfolded, setUnfolded] = React.useState({});
  const [expanded, setExpanded] = React.useState({});

  React.useEffect(() => {
    const onOpen = (e) => { e.preventDefault(); setOpen(true); };
    window.addEventListener('compose:open-inbox', onOpen);
    return () => window.removeEventListener('compose:open-inbox', onOpen);
  }, []);
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const panel = smPanel(fleet, 'queue');
  const groups = React.useMemo(() => groupInbox(panel?.value), [panel?.value]);
  if (!open) return null;

  const time = asOf(fleet);
  const unavailable = !panel || panel.value == null;
  const toggle = (setter, key) => setter((m) => ({ ...m, [key]: !m[key] }));

  return createPortal(
    <aside
      data-testid="inbox-drawer"
      role="dialog"
      aria-label="Owner inbox"
      className="fixed right-0 top-0 z-50 flex h-full w-[28rem] max-w-full flex-col border-l border-border bg-popover text-xs text-popover-foreground shadow-lg"
    >
      <header className="flex items-start gap-2 border-b border-border p-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Waiting on you</div>
          <div data-testid="inbox-counts" className="text-muted-foreground">
            {groups.map((g) => `${g.rows.length} ${g.label.toLowerCase()}`).join(' · ')}
            {time ? ` · as of ${time}` : ''}
          </div>
        </div>
        <button type="button" data-testid="inbox-close" aria-label="Close inbox" className="shrink-0 rounded px-1.5 hover:bg-muted" onClick={() => setOpen(false)}>
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {unavailable && <div data-testid="inbox-unavailable" className="text-muted-foreground">The owner queue is unavailable (sm_status). Nothing is shown rather than a false zero.</div>}
        {!unavailable && groups.every((g) => g.rows.length === 0) && <div className="text-muted-foreground">Nothing open.</div>}
        {groups.filter((g) => g.rows.length > 0).map((g) => {
          const folded = g.folded && !unfolded[g.id];
          return (
            <section key={g.id} data-testid="inbox-group" data-group={g.id} data-folded={folded ? 'true' : 'false'} className="mb-3">
              <button
                type="button"
                data-testid="inbox-group-toggle"
                aria-expanded={!folded}
                disabled={!g.folded}
                onClick={() => toggle(setUnfolded, g.id)}
                className="mb-1 flex w-full items-center gap-1 text-left font-semibold disabled:cursor-default"
              >
                {g.folded && <span aria-hidden="true">{folded ? '▸' : '▾'}</span>}
                {g.folded ? `${g.rows.length} ${g.label.toLowerCase()}` : `${g.label} (${g.rows.length})`}
              </button>
              {!folded && g.rows.map((r) => (
                <Row key={r.id} row={r} groupId={g.id} open={Boolean(expanded[r.id])} onToggle={() => toggle(setExpanded, r.id)} />
              ))}
            </section>
          );
        })}
      </div>
    </aside>,
    document.body,
  );
}
