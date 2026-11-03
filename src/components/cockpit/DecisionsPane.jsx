/**
 * DecisionsPane — Projects › Review › Decisions (COMP-COCKPIT-DECISIONS-1).
 *
 * The decision records the ops ledger and the owner queue hold, newest first, from GET /api/decisions. Scoped by the
 * project chip (the project whose root or module is the cockpit's root, from the project model); a segmented filter
 * row picks this project, Fleet-wide (rows naming no project) or All, the deciders, and standing-only. Read-only, plain
 * `fetch` (the route is loopback and global, never workspace-scoped). A failing source shows as a line, never a blank.
 *
 * COMP-WIKI-DOC-PATH-LINKS-1: every ledger reference in a row (its source `ledger.md#L<n>` or commit, `Refs: ledger :<n>`, echoes,
 * "maybe changed by", the line that superseded it) opens the ledger in the wiki at `<ledgerDoc>#L<n>`, and an owner-queue row's id
 * opens the queue file. `ledgerDoc`/`queueDoc` are the paths /api/decisions reports inside the ops repo; with no path, or no
 * `onOpenFile`, the reference stays text.
 *
 * Props:
 *   projectRoot {string}  the cockpit's bound root (App's `projectRoot`)
 *   onOpenFile  {(path: string) => void}  opens a repo doc path in the wiki (App's `navigateToWiki`); optional
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectModel } from '../../lib/fleetProjects.js';
import EntityLink from '../shared/EntityLink.jsx';
import {
  DECIDER_KEYS, DECIDER_LABELS, STANDING_LEGEND, decisionsUrl, projectOfRoot, rowSource, rowTags, rowWhen, statusLabel, toggleDecider,
} from './decisionsPaneLogic.js';

const PILL_GROUP = 'inline-flex flex-wrap items-center gap-0.5 rounded-full border border-border bg-muted/40 p-0.5';
const pill = (on) => [
  'px-2.5 h-6 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors',
  on ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
].join(' ');
const CHIP = 'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium border';
const DECIDER_CHIP = {
  owner: 'border-sky-500/40 text-sky-600 dark:text-sky-300',
  absent: 'border-amber-500/40 text-amber-600 dark:text-amber-300',
  lane: 'border-violet-500/40 text-violet-600 dark:text-violet-300',
  queue: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-300',
};

function Segmented({ label, testid, options, isOn, onPick }) {
  return (
    <div role="group" aria-label={label} data-testid={testid} className={PILL_GROUP}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={isOn(o.key)} data-testid={`${testid}-${o.key}`} onClick={() => onPick(o.key)} className={pill(isOn(o.key))}>
          {o.label}{o.count != null ? <span className="ml-1 opacity-60 tabular-nums">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

const DOC_LINK = 'font-mono underline decoration-dotted underline-offset-2 hover:text-foreground';

/** A ledger line reference: a button opening the ledger at `line` when `openLine` is given, else plain text in `className`. */
function LineRef({ line, openLine, children, testid, className = 'font-mono', linkClass = DOC_LINK, title }) {
  if (!openLine || !Number.isInteger(line)) return <span className={className} data-testid={testid} title={title}>{children}</span>;
  return (
    <button type="button" className={linkClass} data-testid={testid ?? 'decision-line-link'} data-line={line} title={title ?? `open the ledger at line ${line} in the wiki`}
      onClick={(e) => { e.stopPropagation(); openLine(line); }}>{children}</button>
  );
}

/** COMP-UI-LINKS-2: a chip that narrows the list to rows mentioning its text (fills the search box: a view filter, nothing is written). */
function FilterChip({ text, onFilter, className, testid, children }) {
  if (!onFilter) return <span className={className} data-testid={testid}>{children ?? text}</span>;
  return (
    <button type="button" className={`${className} cursor-pointer hover:underline focus-visible:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent`}
      title={`show decisions mentioning "${text}"`} data-testid={testid} onClick={() => onFilter(text)}>{children ?? text}</button>
  );
}

/** A reference that is a repo path opens in the wiki; any other kind (a commit hash, a queue id) has no doc to open. */
const looksLikePath = (v) => typeof v === 'string' && /^[\w.-]+(\/[\w.#-]+)+$/.test(v);

function DecisionRow({ row, openLine, openQueue, onOpenFile, onFilter }) {
  const [open, setOpen] = useState(false);
  const src = rowSource(row);
  const status = statusLabel(row);
  return (
    <li data-testid="decision-row" data-id={row.id} className="border-b border-border/60 py-2">
      <div className="flex items-start gap-2 text-[12px]">
        <span className="font-mono text-[11px] text-muted-foreground whitespace-nowrap pt-px">{rowWhen(row)}</span>
        <span className={`${CHIP} ${DECIDER_CHIP[row.decider] ?? ''}`} data-testid="decision-decider">{DECIDER_LABELS[row.decider] ?? row.decider}</span>
        <button type="button" className="flex-1 min-w-0 text-left hover:underline decoration-dotted" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="decision-summary">
          {row.summary}
        </button>
        {(() => {
          const chip = `${CHIP} ${status === 'standing' ? 'border-border text-muted-foreground' : 'border-destructive/50 text-destructive'}`;
          return <LineRef line={row.statusBy?.line} openLine={openLine} testid="decision-status" className={chip} linkClass={`${chip} hover:underline`}>{status}</LineRef>;
        })()}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[7.5rem] text-[10px] text-muted-foreground">
        {row.by ? <FilterChip text={row.by} onFilter={onFilter} className="font-mono" testid="decision-by">{row.by}{row.via ? ` via ${row.via}` : ''}</FilterChip> : null}
        {rowTags(row).map((t) => <FilterChip key={t} text={t} onFilter={onFilter} className={`${CHIP} border-border`} testid="decision-tag" />)}
        {(row.projects ?? []).map((p) => <FilterChip key={p} text={p} onFilter={onFilter} className={`${CHIP} border-border`} testid="decision-project" />)}
        {src.kind === 'queue'
          ? (openQueue
            ? <button type="button" className={DOC_LINK} title="open the owner queue in the wiki" data-testid="decision-source" onClick={openQueue}>{src.label}</button>
            : <span className="font-mono" data-testid="decision-source">{src.label}</span>)
          : <LineRef line={row.line} openLine={openLine} testid="decision-source" title={src.title}>{src.kind === 'pending' ? `commit pending · ${src.label}` : src.label}</LineRef>}
      </div>
      {open && (
        <div className="mt-1.5 pl-[7.5rem] text-[11px] text-muted-foreground space-y-1" data-testid="decision-premises">
          <div className="whitespace-pre-wrap break-words text-foreground/80">{row.text}</div>
          {row.reverse ? <div>To reverse: {row.reverse}</div> : null}
          {row.units?.length ? <div data-testid="decision-units">Units: {joined(row.units.map((u) => <EntityLink key={u} kind="unit" id={u} className="text-[11px]" />))}</div> : null}
          {row.refs?.length ? <div>Refs: {joined(row.refs.map((r, i) => (r.kind === 'line'
            ? <LineRef key={i} line={Number(r.value)} openLine={openLine}>{`ledger :${r.value}`}</LineRef>
            : (onOpenFile && looksLikePath(r.value)
              ? <EntityLink key={i} kind="file" id={r.value} label={`${r.kind} ${r.value}`} className="text-[11px]" />
              : <span key={i} className="font-mono" title="No target: this reference is not a repo path">{`${r.kind} ${r.value}`}</span>))))}</div> : null}
          {row.echoes?.length ? <div>Echoes: {joined(row.echoes.map((e, i) => <LineRef key={i} line={e.line} openLine={openLine}>{`L${e.line}${e.by ? ` ${e.by}` : ''}`}</LineRef>))}</div> : null}
          {row.maybe?.length ? <div>Maybe changed by: {joined(row.maybe.map((l, i) => <LineRef key={i} line={l} openLine={openLine}>{`L${l}`}</LineRef>))}</div> : null}
        </div>
      )}
    </li>
  );
}

/** Items separated by ", ". */
const joined = (items) => items.flatMap((el, i) => (i ? [', ', el] : [el]));

export default function DecisionsPane({ projectRoot, onOpenFile }) {
  const { model } = useProjectModel();
  const project = projectOfRoot(model?.projects, projectRoot);
  const [scope, setScope] = useState('this');
  const [deciders, setDeciders] = useState(DECIDER_KEYS);
  const [standing, setStanding] = useState(false);
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  // COMP-WIKI-DOC-PATH-LINKS-1: ledger lines and the owner queue open in the wiki at the paths the route reports.
  const ledgerDoc = data?.ledgerDoc;
  const openLine = onOpenFile && ledgerDoc ? (line) => onOpenFile(`${ledgerDoc}#L${line}`) : null;
  const openQueue = onOpenFile && data?.queueDoc ? () => onOpenFile(data.queueDoc) : null;

  const load = useCallback(async (cursor = null) => {
    const my = ++reqId.current;
    setLoading(true);
    try {
      const res = await fetch(decisionsUrl({ scope, project, deciders, standing, q, cursor }), { headers: { accept: 'application/json' } });
      let body = null;
      try { body = await res.json(); } catch { /* no body */ }
      if (!res.ok) throw new Error(body?.error ?? `decisions ${res.status}`);
      if (my !== reqId.current) return;
      setData(body);
      setRows((prev) => (cursor ? [...prev, ...body.rows] : body.rows));
      setError(null);
    } catch (e) {
      if (my !== reqId.current) return;
      setError(String(e?.message ?? e));
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [scope, project?.name, deciders, standing, q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(null); }, [load]);

  const counts = data?.counts ?? { projects: {}, decider: {} };
  const scopeOptions = [
    { key: 'this', label: project ? (project.label ?? project.name) : 'This project', count: project ? counts.projects[project.name] ?? 0 : null },
    { key: 'fleet', label: 'Fleet-wide', count: counts.projects.fleet },
    { key: 'all', label: 'All', count: counts.projects.all },
  ];
  const sourceErrors = Object.entries(data?.sourceErrors ?? {});

  return (
    <div data-testid="decisions-pane" className="flex-1 overflow-auto px-4 pb-4 text-foreground">
      <div className="flex flex-wrap items-center gap-2 py-2">
        <Segmented label="Project" testid="decisions-scope" options={scopeOptions} isOn={(k) => k === scope} onPick={setScope} />
        <Segmented
          label="Decider" testid="decisions-decider"
          options={DECIDER_KEYS.map((k) => ({ key: k, label: DECIDER_LABELS[k], count: counts.decider[k] }))}
          isOn={(k) => deciders.includes(k)} onPick={(k) => setDeciders((d) => toggleDecider(d, k))}
        />
        <Segmented
          label="Status" testid="decisions-status"
          options={[{ key: 'all', label: 'All' }, { key: 'standing', label: 'Standing only' }]}
          isOn={(k) => (k === 'standing') === standing} onPick={(k) => setStanding(k === 'standing')}
        />
        <input
          type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search decisions" data-testid="decisions-search"
          className="h-6 w-40 rounded-full border border-border bg-transparent px-2.5 text-[11px] outline-none focus:border-accent"
        />
        <span className="ml-auto text-[10px] text-muted-foreground" data-testid="decisions-legend">{STANDING_LEGEND}</span>
      </div>

      {scope === 'this' && !project && model ? (
        <div className="text-[11px] text-muted-foreground mb-2" data-testid="decisions-no-project">This root belongs to no project in the model: showing Fleet-wide rows.</div>
      ) : null}
      {data?.blame && data.blame.state !== 'warm' && data.blame.state !== 'off' ? (
        <div className="text-[11px] text-muted-foreground mb-2" data-testid="decisions-blame">Commit links are building ({data.blame.state}); rows show the ledger line until then.</div>
      ) : null}
      {sourceErrors.map(([k, v]) => <div key={k} className="text-[11px] text-destructive mb-1" data-testid="decisions-source-error">{k} unavailable: {v}</div>)}
      {error ? <div className="text-[12px] text-destructive" data-testid="decisions-error">Unavailable: {error}</div> : null}

      {data && !rows.length && !error ? <div className="text-[12px] text-muted-foreground italic" data-testid="decisions-empty">No decisions match these filters.</div> : null}
      {!data && !error ? <div className="text-[12px] text-muted-foreground">Loading…</div> : null}

      <ul data-testid="decisions-list">{rows.map((r) => <DecisionRow key={r.id} row={r} openLine={openLine} openQueue={openQueue} onOpenFile={onOpenFile} onFilter={setQ} />)}</ul>

      {data?.nextCursor ? (
        <button type="button" className={`mt-2 ${pill(false)} border border-border`} disabled={loading} onClick={() => load(data.nextCursor)} data-testid="decisions-more">
          {loading ? 'Loading…' : `More (${rows.length} of ${data.total})`}
        </button>
      ) : data ? <div className="mt-2 text-[10px] text-muted-foreground" data-testid="decisions-total">{data.total} decisions</div> : null}
    </div>
  );
}
