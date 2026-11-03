/**
 * InboxDrawer.jsx — COMP-COCKPIT-NOTIFY-INBOX-1: a right-side drawer over the owner queue, grouped by inboxLogic.js
 * (Security, Asks, Decided for you, FYI). Opened by `compose:open-inbox` (it calls preventDefault so the Fleet-pane
 * fallback does not also fire). Rows expand in place to their full text. It reads the shared fleet poll.
 * COMP-COCKPIT-NOTIFY-ACTIONS-1 (supersedes COMP-NOTIFY-ASKS-1): every row carries its class's inline actions
 * (NotifyActions.jsx). An answered ask stays as "answered HH:MM: <answer>" until the queue drops it, then moves to a
 * folded "Answered (n)" list (last 24 h). Cleared info rows move to a folded "Cleared (n)" list with Restore.
 * Keys: j/k select, Enter expands, a focuses an answer control (never submits), d/s on info rows, r on security, Esc.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useFleet } from '../../../lib/fleetPoller.js';
import { fmtAge, smPanel } from '../fleetLogic.js';
import { groupInbox, entityLinkParts, reverseText } from './inboxLogic.js';
import EntityLink from '../../shared/EntityLink.jsx';
import { useNavigation } from '@/lib/navigation.jsx';
import { canOpenEntity } from '../../shared/EntityLink.jsx';
import NotifyActions, { useRowKeys } from './NotifyActions.jsx';
import { useNotifyState } from './useNotifyState.js';
import SourceNote from '../SourceNote.jsx';
import { isCleared, securityAck, answeredOf, answerHolds, answeredFold, fnv1a, keyOf, hhmm } from './notifyState.js';

const asOf = (fleet) => {
  const t = Date.parse(fleet?.generated ?? '');
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : null;
};

// COMP-UI-LINKS-2: a feature code opens its feature when Compose holds it, else (the queue is Cadence-fed) the Cadence unit of that
// name; a repo path opens in the wiki. An entity with no way to open stays plain text.
function entityTarget(nav, p) {
  if (p.entity === 'file') return canOpenEntity(nav, 'file', p.text) ? 'file' : null;
  if (canOpenEntity(nav, 'feature', p.text)) return 'feature';
  return canOpenEntity(nav, 'unit', p.text) ? 'unit' : null;
}

function FullText({ text, tone }) {
  const nav = useNavigation();
  return (
    <div data-testid="inbox-full" data-tone={tone ? 'critical' : undefined} className="mt-1 whitespace-pre-wrap break-words" style={{ color: tone ? 'hsl(var(--destructive))' : undefined }}>
      {entityLinkParts(text).map((p, i) => {
        if (p.href) return <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{p.text}</a>;
        const kind = p.entity ? entityTarget(nav, p) : null;
        return kind
          ? <EntityLink key={i} kind={kind} id={p.text} className="text-[length:inherit]" />
          : <React.Fragment key={i}>{p.text}</React.Fragment>;
      })}
    </div>
  );
}

function Row({ row, groupId, open, onToggle, notify, index, selected }) {
  const [copied, setCopied] = React.useState(false);
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(row.id).then(() => setCopied(true), () => {});
  };
  const state = notify?.state ?? null;
  const actRow = { ...row, group: groupId, ...(groupId === 'security' ? { textHash: fnv1a(row.text) } : {}) };
  const key = keyOf(actRow);
  const acked = groupId === 'security' && securityAck(state, key, actRow);
  const answered = groupId === 'asks' && (answeredOf(state, key, { age: row.since }) || (notify?.answers?.get(row.id)?.phase === 'accepted' && answerHolds(notify.answers.get(row.id), { age: row.since })));
  return (
    <div
      data-testid="inbox-row"
      data-id={row.id}
      data-group={groupId}
      data-red={row.red ? 'true' : 'false'}
      data-acked={acked ? 'true' : 'false'}
      data-answered={answered ? 'true' : 'false'}
      data-row-index={index}
      aria-selected={selected}
      className={`border-b border-border/60 py-1.5 ${selected ? 'bg-muted' : ''} ${answered ? 'text-muted-foreground' : ''}`}
    >
      <button
        type="button"
        data-testid="inbox-row-toggle"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 text-left outline-none focus-visible:bg-muted"
      >
        <span className="w-10 shrink-0 text-muted-foreground">{row.age != null ? fmtAge(row.age) : '?'}</span>
        <span className="w-24 shrink-0 truncate text-muted-foreground" title={row.by ?? ''}>{row.by ?? 'unknown'}</span>
        {/* Open: the full text below is the row, so the first line is not printed twice. */}
        <span
          className="min-w-0 flex-1 truncate"
          data-tone={row.red ? 'critical' : undefined}
          style={{ color: row.red ? 'hsl(var(--destructive))' : undefined }}
        >
          {open ? '' : row.first}
        </span>
        {row.untyped && (
          <span data-testid="inbox-untyped" className="shrink-0 rounded bg-muted px-1 text-[11px] text-muted-foreground" title="No type recorded; shown as an ask so nothing is missed">
            untyped
          </span>
        )}
      </button>
      {open && <FullText text={row.text} tone={row.red} />}
      <NotifyActions row={actRow} notify={notify} />
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

/** The "Answered (n)" fold: asks answered from the cockpit in the last 24 h that the queue no longer holds. */
function AnsweredFold({ rows }) {
  const [open, setOpen] = React.useState(false);
  if (!rows.length) return null;
  return (
    <section data-testid="inbox-answered" className="mb-3">
      <button type="button" data-testid="inbox-answered-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="mb-1 flex w-full items-center gap-1 text-left font-semibold">
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Answered ({rows.length})
      </button>
      {open && rows.map((r) => (
        <div key={r.key} data-testid="inbox-answered-row" className="border-b border-border/60 py-1.5 text-muted-foreground">
          <div className="truncate">{r.first || r.id}</div>
          <div className="break-words">answered {hhmm(r.at)}: {r.answer}</div>
        </div>
      ))}
    </section>
  );
}

export default function InboxDrawer() {
  const fleetSrc = useFleet();
  const { data: fleet } = fleetSrc;
  const notify = useNotifyState();
  const listRef = React.useRef(null);
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
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const panel = smPanel(fleet, 'queue');
  const allGroups = React.useMemo(() => groupInbox(panel?.value), [panel?.value]);
  const now = Date.now();
  // Info rows (decided, FYI) that Compose's list clears leave their group for the "Cleared (n)" fold.
  const { groups, clearedInfo } = React.useMemo(() => {
    const st = notify.state;
    const out = [];
    const gone = [];
    for (const g of allGroups) {
      const info = g.id === 'decided' || g.id === 'fyi';
      const keep = [];
      for (const r of g.rows) {
        if (info && st && isCleared(`queue:${r.id}`, r, st, now)) gone.push({ ...r, groupId: g.id });
        else keep.push(r);
      }
      out.push({ ...g, rows: keep });
    }
    return { groups: out, clearedInfo: gone };
  // `now` moves with each fleet poll (`fleet` changes), which is when a snooze can expire.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allGroups, notify.state, fleet]);
  const answeredRows = React.useMemo(() => answeredFold(notify.state, panel?.value, now), [notify.state, panel?.value, fleet]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showCleared, setShowCleared] = React.useState(false);
  const visible = [];
  for (const g of groups) {
    if (g.rows.length && !(g.folded && !unfolded[g.id])) for (const r of g.rows) visible.push({ r, gid: g.id });
  }
  if (showCleared) for (const r of clearedInfo) visible.push({ r, gid: r.groupId });
  const indexOf = new Map(visible.map((v, i) => [v.r.id, i]));
  const keys = useRowKeys({
    active: open,
    root: listRef,
    count: visible.length,
    onExpand: (i) => { const id = visible[i]?.r.id; if (id) setExpanded((m) => ({ ...m, [id]: !m[id] })); },
  });
  if (!open) return null;

  const time = asOf(fleet);
  const unavailable = !panel || panel.value == null;
  // SOURCE-FAULTS-1 (NOTIFY-INBOX M1): a failed refresh (retained rows) or a queue panel read with an error is not a
  // complete read, so the drawer says so and never prints "Nothing open." over it.
  const partial = !unavailable && panel.error ? { error: panel.error } : null;
  const faulted = Boolean(fleetSrc.error || partial);
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
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-3">
        {unavailable && <div data-testid="inbox-unavailable" className="text-muted-foreground">The owner queue is unavailable (sm_status). Nothing is shown rather than a false zero.</div>}
        {faulted && (
          <div data-testid="inbox-fault" className="mb-2">
            <SourceNote source="Fleet" state={fleetSrc} />
            <SourceNote source="Owner queue" state={partial} />
          </div>
        )}
        {!unavailable && !faulted && groups.every((g) => g.rows.length === 0) && <div className="text-muted-foreground">Nothing open.</div>}
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
                <Row
                  key={r.id}
                  row={r}
                  groupId={g.id}
                  open={Boolean(expanded[r.id])}
                  onToggle={() => toggle(setExpanded, r.id)}
                  notify={notify}
                  index={indexOf.get(r.id)}
                  selected={keys.selected === indexOf.get(r.id)}
                />
              ))}
            </section>
          );
        })}
        <AnsweredFold rows={answeredRows} />
        {clearedInfo.length > 0 && (
          <section data-testid="inbox-cleared" className="mb-3">
            <button type="button" data-testid="inbox-cleared-toggle" aria-expanded={showCleared} onClick={() => setShowCleared((v) => !v)} className="mb-1 flex w-full items-center gap-1 text-left font-semibold">
              <span aria-hidden="true">{showCleared ? '▾' : '▸'}</span> Cleared ({clearedInfo.length})
            </button>
            {showCleared && clearedInfo.map((r) => (
              <Row
                key={r.id}
                row={r}
                groupId={r.groupId}
                open={Boolean(expanded[r.id])}
                onToggle={() => toggle(setExpanded, r.id)}
                notify={notify}
                index={indexOf.get(r.id)}
                selected={keys.selected === indexOf.get(r.id)}
              />
            ))}
          </section>
        )}
        {keys.hint && <div data-testid="inbox-key-hint" role="status" className="text-muted-foreground">{keys.hint}</div>}
        {notify.unavailable && <div data-testid="inbox-state-unavailable" className="text-muted-foreground">Cleared states unavailable: showing everything</div>}
      </div>
    </aside>,
    document.body,
  );
}
