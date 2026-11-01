/**
 * DecisionsPane — Projects › Review › Decisions (COMP-COCKPIT-DECISIONS-1).
 *
 * The decision records the ops ledger and the owner queue hold, newest first, from GET /api/decisions. Scoped by the
 * project chip (the project whose root or module is the cockpit's root, from the project model); a segmented filter
 * row picks this project, Fleet-wide (rows naming no project) or All, the deciders, and standing-only. Read-only, plain
 * `fetch` (the route is loopback and global, never workspace-scoped). A failing source shows as a line, never a blank.
 *
 * Props:
 *   projectRoot {string}  the cockpit's bound root (App's `projectRoot`)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectModel } from '../../lib/fleetProjects.js';
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

function DecisionRow({ row }) {
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
        <span className={`${CHIP} ${status === 'standing' ? 'border-border text-muted-foreground' : 'border-destructive/50 text-destructive'}`} data-testid="decision-status">{status}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[7.5rem] text-[10px] text-muted-foreground">
        {row.by ? <span className="font-mono">{row.by}{row.via ? ` via ${row.via}` : ''}</span> : null}
        {rowTags(row).map((t) => <span key={t} className={`${CHIP} border-border`} data-testid="decision-tag">{t}</span>)}
        {(row.projects ?? []).map((p) => <span key={p} className={`${CHIP} border-border`}>{p}</span>)}
        <span className="font-mono" title={src.title} data-testid="decision-source">{src.kind === 'pending' ? `commit pending · ${src.label}` : src.label}</span>
      </div>
      {open && (
        <div className="mt-1.5 pl-[7.5rem] text-[11px] text-muted-foreground space-y-1" data-testid="decision-premises">
          <div className="whitespace-pre-wrap break-words text-foreground/80">{row.text}</div>
          {row.reverse ? <div>To reverse: {row.reverse}</div> : null}
          {row.units?.length ? <div>Units: <span className="font-mono">{row.units.join(', ')}</span></div> : null}
          {row.refs?.length ? <div>Refs: <span className="font-mono">{row.refs.map((r) => (r.kind === 'line' ? `ledger :${r.value}` : `${r.kind} ${r.value}`)).join(', ')}</span></div> : null}
          {row.echoes?.length ? <div>Echoes: <span className="font-mono">{row.echoes.map((e) => `L${e.line}${e.by ? ` ${e.by}` : ''}`).join(', ')}</span></div> : null}
          {row.maybe?.length ? <div>Maybe changed by: <span className="font-mono">{row.maybe.map((l) => `L${l}`).join(', ')}</span></div> : null}
        </div>
      )}
    </li>
  );
}

export default function DecisionsPane({ projectRoot }) {
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

      <ul data-testid="decisions-list">{rows.map((r) => <DecisionRow key={r.id} row={r} />)}</ul>

      {data?.nextCursor ? (
        <button type="button" className={`mt-2 ${pill(false)} border border-border`} disabled={loading} onClick={() => load(data.nextCursor)} data-testid="decisions-more">
          {loading ? 'Loading…' : `More (${rows.length} of ${data.total})`}
        </button>
      ) : data ? <div className="mt-2 text-[10px] text-muted-foreground" data-testid="decisions-total">{data.total} decisions</div> : null}
    </div>
  );
}
