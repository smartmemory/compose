/**
 * FleetProjectsSection.jsx — the Fleet room's left-bar PROJECTS list (COMP-COCKPIT-FLEET-PROJECTS-1).
 *
 * Replaces GROUPS in the Fleet room only. Rows are the lanes GET /api/process knows (`fleet.known`), in the owner's
 * saved order (`fleet.projects`; every lane in builder order when none is saved), each with move up, move down and
 * remove; Add lists the hidden lanes. Every change POSTs the whole list (fleetProjects.js), shows at once, and rolls
 * back with a visible error line when the save fails. Clicking a name selects that lane for the Process KPI tiles
 * (the same state as the comparison column header) and opens the Process tab.
 *
 * COMP-COCKPIT-FLEET-PROJECTS-2: shown in every room. `mode="lane"` (Fleet, Library) is the behaviour above.
 * `mode="project"` (Home, Ideas, Roadmap, Build, Review): a click opens that lane's Compose project through
 * `onSelectProject(lane, root|null)` (null: the lane has none, so the room says so), and the highlighted row is the
 * lane whose root is the cockpit's `projectRoot`, or the project-less lane the room is showing (`noProjectLane`).
 */
import React from 'react';
import { ChevronUp, ChevronDown, X, Plus } from 'lucide-react';
import { useProcess } from '../../lib/processPoller.js';
import {
  effectiveOrder, orderLanes, pickLane, saveFleetProjects, selectProjectLane, setPickedLane, useFleetProjects, useFleetRoots,
} from '../../lib/fleetProjects.js';

const HEAD = 'text-[10px] font-medium uppercase tracking-wider px-2';
const MUTED = { color: 'hsl(var(--muted-foreground))' };
const ICON_BTN = 'shrink-0 rounded p-0.5 hover:bg-sidebar-accent disabled:opacity-30 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** The project rooms' one-line state for a lane with no Compose project behind it. */
export function NoComposeProject({ lane }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <p className="text-sm" style={MUTED} data-testid="no-compose-project">No Compose project for {lane}</p>
    </div>
  );
}

export default function FleetProjectsSection({ onViewChange, mode = 'lane', projectRoot = null, noProjectLane = null, onSelectProject }) {
  const projectMode = mode === 'project';
  const { data, error, loading } = useProcess();
  const lanes = useFleetProjects();
  const { roots, error: rootsError } = useFleetRoots(projectMode);
  // Roots not loaded (or the route missing, e.g. a server not yet restarted): a click must not claim "no project".
  const rootsReady = roots !== null && !rootsError;
  const [adding, setAdding] = React.useState(false);

  const fleet = data?.fleet ?? null;
  const known = Array.isArray(fleet?.known) ? fleet.known : [];
  const list = orderLanes(known, effectiveOrder(fleet, lanes));
  const hidden = known.filter((n) => !list.includes(n));
  const projects = data?.sources?.builder?.value?.table?.projects ?? [];
  const builderNames = Object.keys(data?.sources?.builder?.value?.pages ?? {});
  const selected = projectMode
    ? (noProjectLane ?? list.find((n) => roots?.[n]?.hasCompose && roots[n].root === projectRoot) ?? null)
    : pickLane(list.filter((n) => builderNames.includes(n)), lanes.picked);
  const hasProject = (n) => !!(roots?.[n]?.root && roots[n].hasCompose);
  const labelOf = (n) => projects.find((p) => p?.name === n)?.label ?? n;

  const move = (i, d) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    saveFleetProjects(next);
  };
  const remove = (n) => saveFleetProjects(list.filter((x) => x !== n));
  const add = (n) => { saveFleetProjects([...list, n]); setAdding(false); };
  const select = projectMode
    ? (n) => { if (rootsReady) onSelectProject?.(n, selectProjectLane(n, roots).switchTo); }
    : (n) => { setPickedLane(n); onViewChange?.('process'); };
  const titleOf = (n) => {
    if (projectMode) return hasProject(n) ? `Open ${labelOf(n)} (${roots[n].root})` : `${labelOf(n)}: no Compose project`;
    return !builderNames.includes(n) ? `${labelOf(n)}: time split only (the builder writes no page for this lane)` : `Show ${labelOf(n)} in Process`;
  };

  let body;
  if (!fleet) {
    body = (
      <p className="px-2 text-[11px]" style={MUTED} data-testid="fleet-projects-status">
        {loading && !data ? 'Loading lanes…' : `Lanes unavailable${error ? `: ${error}` : ''}`}
      </p>
    );
  } else {
    body = (
      <>
        {list.length === 0 ? <p className="px-2 text-[11px]" style={MUTED} data-testid="fleet-projects-empty">No projects listed. Add one below.</p> : null}
        {list.map((n, i) => {
          const isSel = n === selected;
          const tilesless = projectMode ? (rootsReady && !hasProject(n)) : !builderNames.includes(n);
          return (
            <div key={n} data-testid={`fleet-project-${n}`}
              className={`group flex w-full items-center gap-0.5 rounded-md px-1 py-0.5 text-xs ${isSel ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent/50'}`}>
              <button type="button" onClick={() => select(n)} aria-pressed={isSel} data-testid={`fleet-project-select-${n}`}
                title={titleOf(n)}
                className="min-w-0 flex-1 truncate px-1 text-left font-mono focus:outline-none focus-visible:underline"
                style={tilesless ? MUTED : undefined}>
                {labelOf(n)}
              </button>
              <button type="button" className={ICON_BTN} onClick={() => move(i, -1)} disabled={i === 0}
                aria-label={`Move ${n} up`} title="Move up" data-testid={`fleet-project-up-${n}`}>
                <ChevronUp className="h-3 w-3" />
              </button>
              <button type="button" className={ICON_BTN} onClick={() => move(i, 1)} disabled={i === list.length - 1}
                aria-label={`Move ${n} down`} title="Move down" data-testid={`fleet-project-down-${n}`}>
                <ChevronDown className="h-3 w-3" />
              </button>
              <button type="button" className={ICON_BTN} onClick={() => remove(n)}
                aria-label={`Remove ${n}`} title="Remove from the list (Add brings it back)" data-testid={`fleet-project-remove-${n}`}>
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <button type="button" onClick={() => setAdding((v) => !v)} disabled={hidden.length === 0} aria-expanded={adding}
          data-testid="fleet-projects-add" title={hidden.length === 0 ? 'Every lane is listed' : 'Add a hidden lane'}
          className="mt-1 flex w-full items-center gap-1 rounded-md px-2 py-0.5 text-[11px] hover:bg-sidebar-accent/50 disabled:opacity-40 disabled:hover:bg-transparent"
          style={MUTED}>
          <Plus className="h-3 w-3" /> Add{hidden.length ? ` (${hidden.length} hidden)` : ''}
        </button>
        {adding && hidden.length > 0 ? (
          <div className="ml-2 mt-0.5 flex flex-col border-l border-sidebar-border pl-1" data-testid="fleet-projects-add-picker">
            {hidden.map((n) => (
              <button key={n} type="button" onClick={() => add(n)} data-testid={`fleet-projects-add-${n}`}
                className="truncate rounded-md px-2 py-0.5 text-left font-mono text-xs hover:bg-sidebar-accent/50">
                {labelOf(n)}
              </button>
            ))}
          </div>
        ) : null}
        {projectMode && rootsError ? <p className="px-2 text-[11px]" style={{ color: 'hsl(var(--warning))' }} data-testid="fleet-roots-error">Project switching unavailable: {rootsError}</p> : null}
        {fleet.error ? <p className="px-2 text-[11px]" style={{ color: 'hsl(var(--warning))' }} data-testid="fleet-projects-config-error">{fleet.error}</p> : null}
      </>
    );
  }

  return (
    <div data-testid="fleet-projects">
      <p className={`${HEAD} mb-1`} style={MUTED}>Projects</p>
      {body}
      {lanes.saveError ? (
        <p className="mt-1 px-2 text-[11px]" role="alert" style={{ color: 'hsl(var(--destructive))' }} data-testid="fleet-projects-error">{lanes.saveError}</p>
      ) : null}
    </div>
  );
}
