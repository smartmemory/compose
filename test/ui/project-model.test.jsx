/**
 * COMP-COCKPIT-PROJECT-MODEL-1: the project model in the UI. ProjectTree nests each project's lanes and modules and
 * shows the unassigned lanes; a lane click opens the merged graph (`?project=&lane=`) through plain GETs, never
 * /api/project/switch and never an X-Compose-Workspace-Id header; the shared forge ops row focuses both of its
 * modules; a module with no store says so; the Day ribbon and Process lane chips open the graph. One row table.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

vi.mock('../../src/components/vision/GraphView.jsx', () => ({
  default: ({ items, readOnly, onSelect, onOpenDoc }) => (
    <>
      <div data-testid="graph-stub" data-readonly={String(readOnly)}>{items.map((i) => i.id).join(',')}</div>
      {items.map((i) => (
        <button key={i.id} type="button" data-testid={`tap-${i.id}`} onClick={() => onSelect(i.id)} onDoubleClick={() => onOpenDoc(i.id)} />
      ))}
    </>
  ),
}));

const { ProjectTree } = await import('../../src/components/vision/ProjectsHome.jsx');
const { default: ProjectGraphView, focusGraph } = await import('../../src/components/vision/ProjectGraphView.jsx');
const { default: DayRibbon } = await import('../../src/components/ribbon/DayRibbon.jsx');
const { default: ProcessView } = await import('../../src/components/cockpit/ProcessView.jsx');
const { laneChips, resetFleetProjects } = await import('../../src/lib/fleetProjects.js');
const { resetProcessPoller } = await import('../../src/lib/processPoller.js');
const { resetFleetPoller } = await import('../../src/lib/fleetPoller.js');

const lane = (id, opsLane, module = null) => ({ id, label: id, opsLane, module });
const MODEL = {
  configured: true,
  projects: [
    { name: 'smartmemory', label: 'SmartMemory', root: '/r/sm', hasStore: true, lanes: [lane('main', 'main')], modules: [], errors: [] },
    {
      name: 'forge', label: 'Forge', root: '/r/forge', hasStore: true,
      lanes: [lane('compose', 'forge', 'compose'), lane('stratum', 'forge', 'stratum'), lane('choir', 'choir', 'choir')],
      modules: [
        { name: 'compose', realpath: '/r/forge/compose', hasStore: true },
        { name: 'stratum', realpath: '/r/forge/stratum', hasStore: true },
        { name: 'choir', realpath: '/r/forge/choir', hasStore: false },
      ],
      errors: [],
    },
  ],
  laneIndex: {
    main: { project: 'smartmemory', label: 'SmartMemory', laneIds: ['main'], modules: [] },
    forge: { project: 'forge', label: 'Forge', laneIds: ['compose', 'stratum'], modules: ['compose', 'stratum'] },
    choir: { project: 'forge', label: 'Forge', laneIds: ['choir'], modules: ['choir'] },
  },
  unassigned: ['hub'],
  errors: [],
};
const item = (id, module) => ({ id, module, type: 'feature', title: id });
const GRAPH = {
  items: [item('forge:r1', 'forge'), item('compose:c1', 'compose'), item('stratum:s1', 'stratum')],
  connections: [{ fromId: 'forge:r1', toId: 'compose:c1', type: 'informs' }, { fromId: 'compose:c1', toId: 'stratum:s1', type: 'blocks' }],
  focus: { lane: null, modules: [] },
};

/** Stubs fetch; every call is recorded as [url, headers] so a row can assert no switch and no workspace header. */
function stubFetch(extra = {}) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    calls.push([u, opts.headers ?? null]);
    const hit = Object.keys(extra).find((k) => u.startsWith(k));
    const body = hit ? extra[hit] : u.startsWith('/api/projects/') ? GRAPH : u === '/api/projects' ? MODEL : {};
    return { ok: true, status: 200, json: async () => body };
  }));
  return calls;
}
const clean = (calls) => {
  expect(calls.filter(([u]) => u.includes('/api/project/switch'))).toEqual([]);
  expect(calls.filter(([, h]) => h && Object.keys(h).some((k) => k.toLowerCase() === 'x-compose-workspace-id'))).toEqual([]);
};
const search = () => new URLSearchParams(window.location.search);

const ROWS = [
  ['ProjectTree nests lanes and modules per project and lists the unassigned lanes', async () => {
    render(<ProjectTree model={MODEL} />);
    expect(screen.getByTestId('project-tree-lane-forge-compose').textContent).toContain('(forge)');
    expect(screen.getByTestId('project-tree-module-forge-choir').textContent).toContain('no roadmap store yet');
    expect(screen.getByTestId('project-tree-module-forge-choir').tagName).toBe('DIV');
    expect(screen.getByTestId('project-tree-unassigned').textContent).toBe('Unassigned lanes: hub');
    expect(screen.queryByTestId('project-tree-module-smartmemory-main')).toBeNull();
  }],
  ['unconfigured model renders nothing (legacy lists stay)', async () => {
    const { container } = render(<ProjectTree model={{ configured: false, projects: [] }} />);
    expect(container.innerHTML).toBe('');
    expect(laneChips({ configured: false, projects: [] })).toEqual({});
  }],
  ['a lane click opens the graph in the URL: no switch, no workspace header', async () => {
    const calls = stubFetch();
    render(<ProjectTree model={MODEL} />);
    fireEvent.click(screen.getByTestId('project-tree-lane-forge-stratum'));
    expect([search().get('project'), search().get('lane')]).toEqual(['forge', 'stratum']);
    clean(calls);
  }],
  ['the shared forge row focuses both modules; the graph is readOnly and read by a plain GET', async () => {
    const calls = stubFetch();
    render(<ProjectGraphView project="forge" lane="ops:forge" model={MODEL} />);
    expect((await screen.findByTestId('graph-stub')).textContent).toBe('compose:c1,stratum:s1');
    expect(screen.getByTestId('graph-stub').dataset.readonly).toBe('true');
    expect(screen.getByTestId('project-graph-counts').textContent).toBe('2 items · 1 edges · focus compose + stratum');
    expect(calls.map(([u]) => u)).toEqual(['/api/projects/forge/graph?lane=ops%3Aforge']);
    clean(calls);
  }],
  ['a single lane focuses its own module: stratum shows stratum only, compose shows compose only; the chip is the shared row', async () => {
    stubFetch();
    const { unmount } = render(<ProjectGraphView project="forge" lane="stratum" model={MODEL} />);
    expect((await screen.findByTestId('graph-stub')).textContent).toBe('stratum:s1');
    expect(screen.getByTestId('project-graph-counts').textContent).toBe('1 items · 0 edges · focus stratum');
    unmount();
    render(<ProjectGraphView project="forge" lane="compose" model={MODEL} />);
    await waitFor(() => expect(screen.getByTestId('project-graph-counts').textContent).toContain('focus compose'), { timeout: 5000 });
    expect(screen.getByTestId('graph-stub').textContent).toBe('compose:c1');
    expect(laneChips(MODEL).forge.lane).toBe('ops:forge');
    expect(laneChips(MODEL).choir.lane).toBe('choir');
  }],
  ['a module with no store shows one plain line, never another store\'s items', async () => {
    stubFetch();
    render(<ProjectGraphView project="forge" lane="choir" model={MODEL} />);
    expect((await screen.findByTestId('project-graph-no-store')).textContent).toBe('choir has no Compose store');
    expect(screen.queryByTestId('graph-stub')).toBeNull();
  }],
  ['single click hands the item to the app\'s right panel; no pane opens inside the graph (r2)', async () => {
    stubFetch();
    const onSelectItem = vi.fn();
    render(<ProjectGraphView project="forge" model={MODEL} onSelectItem={onSelectItem} />);
    await screen.findByTestId('graph-stub');
    fireEvent.click(screen.getByTestId('tap-compose:c1'));
    expect(onSelectItem).toHaveBeenCalledTimes(1);
    const pick = onSelectItem.mock.calls[0][0];
    expect([pick.item.id, pick.doc, pick.items.length, pick.connections.length]).toEqual(['compose:c1', null, 3, 2]);
    expect(screen.queryByTestId('project-graph-doc')).toBeNull();
  }],
  ['double-click hands the doc to the right panel: loading, then the text; no pane inside the graph (r2)', async () => {
    const md = '# Design\n\n- one\n';
    stubFetch({ '/api/projects/forge/doc?id=compose%3Ac1': { id: 'compose:c1', module: 'compose', path: '/r/d.md', text: md } });
    const onSelectItem = vi.fn();
    render(<ProjectGraphView project="forge" model={MODEL} onSelectItem={onSelectItem} />);
    await screen.findByTestId('graph-stub');
    fireEvent.doubleClick(screen.getByTestId('tap-compose:c1'));
    expect(onSelectItem.mock.calls[0][0].doc).toMatchObject({ loading: true });
    await waitFor(() => expect(onSelectItem).toHaveBeenCalledTimes(2));
    const { doc } = onSelectItem.mock.calls[1][0];
    expect(doc).toMatchObject({ text: md, path: '/r/d.md' });
    expect(doc.requestedAt).toBe(onSelectItem.mock.calls[0][0].doc.requestedAt);
    expect(screen.queryByTestId('project-graph-doc')).toBeNull();
  }],
  ['no doc and a failed fetch reach the panel as errors; a late reply for an item the user left is dropped (r2)', async () => {
    let release;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/doc?id=forge%3Ar1')) return { ok: false, status: 404, json: async () => ({ error: 'forge: no doc on disk for X' }) };
      if (u.includes('/doc?id=stratum')) { await new Promise((r) => { release = r; }); throw new Error('late'); }
      if (u.includes('/doc?id=')) throw new Error('network down');
      return { ok: true, status: 200, json: async () => (u === '/api/projects' ? MODEL : GRAPH) };
    }));
    const onSelectItem = vi.fn();
    render(<ProjectGraphView project="forge" model={MODEL} onSelectItem={onSelectItem} />);
    await screen.findByTestId('graph-stub');
    fireEvent.doubleClick(screen.getByTestId('tap-forge:r1'));
    await waitFor(() => expect(onSelectItem.mock.calls.at(-1)[0].doc.error).toBe('forge: no doc on disk for X'));
    fireEvent.doubleClick(screen.getByTestId('tap-compose:c1'));
    await waitFor(() => expect(onSelectItem.mock.calls.at(-1)[0].doc.error).toBe('network down'));
    fireEvent.doubleClick(screen.getByTestId('tap-stratum:s1'));
    fireEvent.click(screen.getByTestId('tap-compose:c1'));
    const n = onSelectItem.mock.calls.length;
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(onSelectItem.mock.calls.length).toBe(n);
    expect(onSelectItem.mock.calls.at(-1)[0]).toMatchObject({ item: { id: 'compose:c1' }, doc: null });
  }],
  ['focusGraph keeps only edges between focused items; no focus is the whole graph', async () => {
    expect(focusGraph(GRAPH, ['forge', 'compose']).connections).toEqual([GRAPH.connections[0]]);
    expect(focusGraph(GRAPH, []).items.length).toBe(3);
    expect(focusGraph(null, ['x'])).toEqual({ items: [], connections: [] });
  }],
  ['Day ribbon: the chip opens the project graph, not the lane drawer; unindexed lanes carry no chip', async () => {
    const data = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
    const onLaneOpen = vi.fn();
    const onProjectOpen = vi.fn();
    render(<DayRibbon data={data} from={data.from} to={data.to} now="2026-10-31T16:40:00-07:00" onLaneOpen={onLaneOpen}
      laneProjects={laneChips(MODEL)} onProjectOpen={onProjectOpen} />);
    // U2 M6: a lane chip that repeats its group's project is dropped; the group header carries it once.
    expect(screen.queryByTestId('lane-project-main')).toBeNull();
    const groupChips = [...document.querySelectorAll('[data-testid^="group-project-"]')];
    expect(groupChips.map((c) => c.textContent)).toEqual(['SmartMemory']);
    fireEvent.click(groupChips[0]);
    expect(onProjectOpen).toHaveBeenCalledWith({ project: 'smartmemory', lane: null, label: 'SmartMemory' });
    expect(onLaneOpen).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lane-project-web')).toBeNull();
  }],
  ['Process: the selected lane\'s chip comes from fleet.laneIndex and opens the graph; no extra read', async () => {
    resetProcessPoller();
    resetFleetPoller();
    const env = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'process', 'api-process.json'), 'utf8'));
    env.fleet = { known: ['hub', 'main'], projects: ['main'], error: null, laneIndex: { main: MODEL.laneIndex.main } };
    const calls = stubFetch({ '/api/process': env });
    render(<ProcessView />);
    fireEvent.click(await screen.findByTestId('process-project-chip-main'));
    expect([search().get('project'), search().get('lane')]).toEqual(['smartmemory', 'main']);
    expect(calls.some(([u]) => u.startsWith('/api/projects'))).toBe(false);
    clean(calls);
  }],
];

describe('project model UI (COMP-COCKPIT-PROJECT-MODEL-1)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetFleetProjects();
    window.history.replaceState(null, '', '/');
  });
  for (const [name, run] of ROWS) it(name, run);
});
