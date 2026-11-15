/**
 * ProjectGraphView.jsx — COMP-COCKPIT-PROJECT-MODEL-1: one project's merged roadmap graph in the Roadmap room.
 *
 * Reads GET /api/projects/:name/graph (plain fetch: no workspace header, no project switch, no store write) and hands
 * the `{items, connections}` to GraphView with `readOnly` (no layout save, no group change, no Save HTML). A lane with
 * a module focuses that module: only its items show, and "Whole project" clears the focus. A module with no store
 * shows one plain line instead of nodes, never another store's items. A double-click opens the item's doc from its
 * owning module (GET /api/projects/:name/doc). COMP-PROJECT-GRAPH-DOC-PANEL-1 r2: there is no pane of its own. A click
 * hands the item to the app's right panel through `onSelectItem({item, items, connections, doc})` (App turns it into the
 * List view's selection, or a read-only one for an item outside the bound workspace); a double-click hands the doc too.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import GraphView from './GraphView.jsx';
import { OPS_PREFIX, closeProjectGraph, fetchProjectDoc, fetchProjectGraph, openProjectGraph } from '../../lib/fleetProjects.js';

const MUTED = { color: 'hsl(var(--muted-foreground))' };

/** The items and edges a focus shows: the focused modules' items, or everything when nothing is focused. */
export function focusGraph(graph, modules) {
  if (!graph) return { items: [], connections: [] };
  if (!modules?.length) return { items: graph.items, connections: graph.connections };
  const items = graph.items.filter((i) => modules.includes(i.module));
  const ids = new Set(items.map((i) => i.id));
  return { items, connections: graph.connections.filter((c) => ids.has(c.fromId) && ids.has(c.toId)) };
}

export default function ProjectGraphView({ project, lane = null, model = null, onSelectItem = null }) {
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  // The latest doc request: a reply for an item the user has since left is dropped.
  const docFor = useRef(null);

  useEffect(() => {
    let live = true;
    setError(null);
    fetchProjectGraph(project, lane)
      .then((g) => { if (live) setGraph(g); })
      .catch((e) => { if (live) { setGraph(null); setError(String(e?.message ?? e)); } });
    return () => { live = false; };
  }, [project, lane]);

  const info = model?.projects?.find((p) => p.name === project) ?? null;
  const laneEntry = info?.lanes?.find((l) => l.id === lane) ?? null;
  // `?lane=ops:<opsLane>` (the Day/Process chip) is the shared ops row: every module of that ops lane. A plain lane id
  // focuses its own module only, as the server answers (`focus.modules`).
  const focusModules = useMemo(() => {
    if (lane?.startsWith(OPS_PREFIX)) {
      const ops = lane.slice(OPS_PREFIX.length);
      return [...new Set((info?.lanes ?? []).filter((l) => l.opsLane === ops && l.module).map((l) => l.module))];
    }
    if (laneEntry) return laneEntry.module ? [laneEntry.module] : [];
    return graph?.focus?.modules ?? [];
  }, [graph, info, laneEntry, lane]);
  const shown = useMemo(() => focusGraph(graph, focusModules), [graph, focusModules]);
  const emptyModule = focusModules.length > 0 && shown.items.length === 0
    ? (info?.modules ?? []).find((m) => focusModules.includes(m.name) && !m.hasStore) : null;

  const hand = (id, doc) => {
    const it = graph?.items?.find((i) => i.id === id);
    if (it && onSelectItem) onSelectItem({ item: it, items: graph.items, connections: graph.connections, doc });
  };
  // Clicks before a double-click arrive too: a click never toggles, it just selects (and drops any open doc request).
  const select = (id) => { setSelected(id); docFor.current = null; hand(id, null); };
  const openDoc = (id) => {
    setSelected(id);
    const requestedAt = Date.now();
    docFor.current = requestedAt;
    hand(id, { loading: true, requestedAt });
    const settle = (d) => { if (docFor.current === requestedAt) hand(id, { ...d, requestedAt }); };
    fetchProjectDoc(project, id)
      .then((d) => settle({ text: d?.text ?? '', path: d?.path ?? null }))
      .catch((e) => settle({ error: String(e?.message ?? e) }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-graph">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs" style={{ borderColor: 'hsl(var(--border))' }}>
        <span className="font-semibold" data-testid="project-graph-name">{info?.label ?? project}</span>
        {(info?.lanes ?? []).map((l) => (
          <button key={l.id} type="button" onClick={() => openProjectGraph(project, l.id)} data-testid={`project-graph-lane-${l.id}`}
            aria-pressed={lane === l.id}
            className={`rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent/40 ${lane === l.id ? 'bg-accent/50' : ''}`}
            style={{ borderColor: 'hsl(var(--border))' }}>{l.label}</button>
        ))}
        {lane ? <button type="button" onClick={() => openProjectGraph(project)} className="text-[11px] underline" style={MUTED} data-testid="project-graph-whole">Whole project</button> : null}
        <span className="ml-auto text-[10px]" style={MUTED} data-testid="project-graph-counts">
          {graph ? `${shown.items.length} items · ${shown.connections.length} edges${focusModules.length ? ` · focus ${focusModules.join(' + ')}` : ''}` : ''}
        </span>
        <button type="button" onClick={closeProjectGraph} className="text-[11px] underline" style={MUTED} data-testid="project-graph-close"
          title="Back to the bound workspace's graph">Workspace graph</button>
      </div>
      {error ? <p className="p-4 text-sm" style={{ color: 'hsl(var(--warning))' }} data-testid="project-graph-error">Project graph unavailable: {error}</p> : null}
      {!error && !graph ? <p className="p-4 text-sm" style={MUTED}>Loading {project}…</p> : null}
      {emptyModule ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm" style={MUTED} data-testid="project-graph-no-store">{emptyModule.name} has no Compose store</p>
        </div>
      ) : null}
      {graph && !emptyModule ? (
        <div className="flex min-h-0 flex-1">
          {/* GraphView's root is `flex-1 flex flex-col min-h-0`: it needs a flex-column parent, or its canvas collapses to 0 px. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <GraphView items={shown.items} connections={shown.connections} selectedItemId={selected} onSelect={select}
              onOpenDoc={openDoc} readOnly />
          </div>
        </div>
      ) : null}
    </div>
  );
}
