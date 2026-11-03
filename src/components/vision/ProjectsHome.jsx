/**
 * ProjectsHome.jsx — COMP-COCKPIT-PROJECT-MODEL-1: the projects, each with its lanes and modules nested.
 *
 * `ProjectTree` is the compact list (the project rooms' left bar and the Projects-tab selector); `ProjectsHome` is the
 * card strip at the top of Project home. Both read GET /api/projects (`useProjectModel`, plain fetch). A lane or a
 * project name opens that project's merged graph (`openProjectGraph`): a read, never a project switch. A module row
 * binds that module through the existing switch only when the caller passes `onSwitchModule` (the selector), and only
 * on that explicit click. Every model error, a module with no store and the unassigned lanes are shown, never hidden.
 */
import React from 'react';
import { modelConfigured, openProjectGraph, useProjectModel } from '../../lib/fleetProjects.js';

const MUTED = { color: 'hsl(var(--muted-foreground))' };
const WARN = { color: 'hsl(var(--warning))' };

function moduleNote(m) {
  if (m.error) return m.error;
  if (!m.hasStore) return m.lifecycle === false ? 'store retired' : 'no roadmap store yet';
  return null;
}

export function ProjectTree({ model, focus = null, onSwitchModule = null, compact = true, testid = 'project-tree' }) {
  if (!modelConfigured(model)) return null;
  const row = compact ? 'text-xs' : 'text-sm';
  return (
    <div data-testid={testid} className="flex flex-col gap-1">
      {model.projects.map((p) => {
        const isOpen = focus?.project === p.name;
        return (
          <div key={p.name} data-testid={`${testid}-project-${p.name}`} className="flex flex-col">
            <button type="button" onClick={() => openProjectGraph(p.name)} aria-pressed={isOpen && !focus?.lane}
              title={`Open the ${p.label} graph (${p.root})`} data-testid={`${testid}-open-${p.name}`}
              className={`flex items-center justify-between rounded-md px-2 py-0.5 text-left font-medium ${row} hover:bg-sidebar-accent/50 ${isOpen ? 'bg-sidebar-accent' : ''}`}>
              <span className="truncate">{p.label}</span>
              <span className="ml-2 shrink-0 text-[10px]" style={MUTED}>{p.lanes.length} lanes{p.modules.length ? ` · ${p.modules.length} modules` : ''}</span>
            </button>
            <div className="ml-2 flex flex-col border-l border-sidebar-border pl-1">
              {p.lanes.map((l) => {
                const sel = isOpen && focus?.lane === l.id;
                return (
                  <button key={l.id} type="button" onClick={() => openProjectGraph(p.name, l.id)} aria-pressed={sel}
                    data-testid={`${testid}-lane-${p.name}-${l.id}`}
                    title={`${l.label}: ops lane ${l.opsLane}${l.module ? `, module ${l.module}` : ''}`}
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-sidebar-accent/50 ${sel ? 'bg-sidebar-accent' : ''}`}>
                    <span className="truncate">{l.label}</span>
                    {l.opsLane !== l.id ? <span className="text-[10px]" style={MUTED}>({l.opsLane})</span> : null}
                  </button>
                );
              })}
              {p.modules.map((m) => {
                const note = moduleNote(m);
                const canSwitch = onSwitchModule && m.realpath && m.hasStore && !m.error;
                const label = (
                  <>
                    <span className="truncate">▸ {m.name}</span>
                    {m.outsideRoot ? <span className="text-[10px]" style={MUTED}>outside root</span> : null}
                    {note ? <span className="truncate text-[10px]" style={m.error ? WARN : MUTED}>{note}</span> : null}
                  </>
                );
                return canSwitch ? (
                  <button key={m.name} type="button" onClick={() => onSwitchModule(m.realpath)} data-testid={`${testid}-module-${p.name}-${m.name}`}
                    title={`Bind the cockpit to ${m.realpath} (Build, Review)`}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-sidebar-accent/50" style={MUTED}>{label}</button>
                ) : (
                  <div key={m.name} data-testid={`${testid}-module-${p.name}-${m.name}`} className="flex items-center gap-1 px-1.5 py-0.5 text-[11px]" style={MUTED}>{label}</div>
                );
              })}
              {p.errors.map((e) => <p key={e} className="px-1.5 text-[10px]" style={WARN} data-testid={`${testid}-error`}>{e}</p>)}
            </div>
          </div>
        );
      })}
      {model.unassigned?.length ? (
        <div data-testid={`${testid}-unassigned`} className="mt-1 px-2 text-[10px]" style={WARN}>
          Unassigned lanes: {model.unassigned.join(', ')}
        </div>
      ) : null}
      {model.errors?.map((e) => <p key={e} className="px-2 text-[10px]" style={WARN}>{e}</p>)}
    </div>
  );
}

/** Project home's top strip: one card per project. Renders nothing while the model is absent or unconfigured. */
export default function ProjectsHome({ focus = null }) {
  const { model, error } = useProjectModel();
  if (error) return <p className="px-4 pt-3 text-xs" style={WARN} data-testid="projects-home-error">Projects unavailable: {error}</p>;
  if (!modelConfigured(model)) return null;
  return (
    <section data-testid="projects-home" className="px-4 pt-3">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider" style={MUTED}>Projects</h2>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
        {model.projects.map((p) => (
          <div key={p.name} data-testid={`projects-home-card-${p.name}`} className="rounded-lg border p-3"
            style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}>
            <div className="flex items-baseline justify-between gap-2">
              <button type="button" className="truncate text-sm font-semibold hover:underline" onClick={() => openProjectGraph(p.name)}
                data-testid={`projects-home-open-${p.name}`}>{p.label}</button>
              <span className="shrink-0 text-[10px]" style={MUTED}>{p.hasStore ? 'roadmap store' : 'no store'}</span>
            </div>
            <p className="mb-2 truncate text-[10px]" style={MUTED} title={p.root}>{p.root}</p>
            <div className="mb-2 flex flex-wrap gap-1">
              {p.lanes.map((l) => (
                <button key={l.id} type="button" onClick={() => openProjectGraph(p.name, l.id)} data-testid={`projects-home-lane-${p.name}-${l.id}`}
                  className={`rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent/40 ${focus?.project === p.name && focus?.lane === l.id ? 'bg-accent/40' : ''}`}
                  style={{ borderColor: 'hsl(var(--border))' }} title={`ops lane ${l.opsLane}${l.module ? `, module ${l.module}` : ''}`}>
                  {l.label}{l.opsLane !== l.id ? <span style={MUTED}> · {l.opsLane}</span> : null}
                </button>
              ))}
            </div>
            {p.modules.length ? (
              <ul className="flex flex-col gap-0.5">
                {p.modules.map((m) => {
                  const note = moduleNote(m);
                  return (
                    <li key={m.name} className="flex items-center gap-2 text-[11px]" data-testid={`projects-home-module-${p.name}-${m.name}`}
                        title="No target: a module opens only by binding the cockpit to it (the Projects selector), which this card never does">
                      <span>▸ {m.name}</span>
                      {m.outsideRoot ? <span className="text-[10px]" style={MUTED}>outside root</span> : null}
                      {note ? <span className="text-[10px]" style={m.error ? WARN : MUTED}>{note}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {p.errors.map((e) => <p key={e} className="mt-1 text-[10px]" style={WARN}>{e}</p>)}
          </div>
        ))}
      </div>
      {model.unassigned?.length ? (
        <p className="mt-2 text-[11px]" style={WARN} data-testid="projects-home-unassigned">Unassigned lanes: {model.unassigned.join(', ')}</p>
      ) : null}
    </section>
  );
}
