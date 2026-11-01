/**
 * projects-tab.test.jsx — COMP-COCKPIT-PROJECTS-TAB-1: the Projects tab, its sub-row, the breadcrumb and the selector.
 * One row table per behaviour. App rows render the whole shell; selector rows render the real popover with the roots mocked.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import ProjectSwitchPopover from '../../src/components/ProjectSwitchPopover.jsx';
import { resetFleetProjects } from '../../src/lib/fleetProjects.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const ROOTS = { forge: { root: '/p/forge', hasCompose: true }, cadence: { root: '/p/cadence', hasCompose: true }, trader: { root: null, hasCompose: false } };

function stubFetch() {
  wsFetch.mockImplementation(async (url) => {
    if (String(url).startsWith('/api/fleet/roots')) return ok({ roots: ROOTS });
    if (String(url) === '/api/project') return ok({ name: 'compose', targetRoot: '/p/forge' });
    return ok({});
  });
  global.fetch = vi.fn(async () => ok({}));
}

describe('Projects tab (COMP-COCKPIT-PROJECTS-TAB-1)', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
    wsFetch.mockReset(); resetFleetProjects();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

  it('each project room: Projects stays active, its sub-tab is selected, the breadcrumb reads Day > Projects > project > room (> view)', async () => {
    stubFetch(); // the vision store fetches on import
    const { default: App } = await import('../../src/App.jsx');
    const rows = [
      { view: 'dashboard', room: 'home', crumb: ['Day', 'Projects', 'compose', 'Project home'] },
      { view: 'ideabox', room: 'ideas', crumb: ['Day', 'Projects', 'compose', 'Ideas'] },
      { view: 'tree', room: 'roadmap', crumb: ['Day', 'Projects', 'compose', 'Roadmap', 'List'], views: ['graph', 'tree'] },
      { view: 'pipeline', room: 'build', crumb: ['Day', 'Projects', 'compose', 'Build', 'Live build'], views: ['design', 'pipeline', 'pipeline-editor', 'build-history'] },
      { view: 'validate', room: 'review', crumb: ['Day', 'Projects', 'compose', 'Review', 'Validate'], views: ['gates', 'validate', 'qa-scope', 'decisions'] },
    ];
    for (const r of rows) {
      cleanup(); localStorage.clear(); sessionStorage.clear(); resetFleetProjects();
      window.history.pushState({}, '', `/?view=${r.view}`);
      stubFetch();
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('crumb-project').textContent, r.view).toBe('compose'));
      const crumb = screen.getByTestId('room-breadcrumb');
      expect(crumb.textContent.replace(/›/g, '|').split('|').map((x) => x.trim()), r.view).toEqual(r.crumb);
      const topSelected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true' && t.dataset.testid.startsWith('room-tab-')).map((t) => t.dataset.testid);
      expect(topSelected, r.view).toEqual(['room-tab-projects']);
      const roomRow = screen.getByTestId('project-sub-tabs');
      expect([...roomRow.querySelectorAll('[aria-selected="true"]')].map((t) => t.dataset.testid), r.view).toEqual([`sub-tab-${r.room}`]);
      // TAB-DEPTH-1: no views tab row under Projects, the room's views are the in-page pane switcher
      expect(screen.queryByTestId('sub-tabs'), r.view).toBeNull();
      const switcher = screen.queryByTestId('pane-switcher');
      expect(switcher ? [...switcher.querySelectorAll('[role="tab"]')].map((t) => t.dataset.testid.replace('sub-tab-', '')) : undefined, r.view).toEqual(r.views);
      expect(roomRow.querySelector('[data-testid="project-selector"]').textContent, r.view).toMatch(/compose/);
    }
  }, 120000);

  it('Day, Fleet and Library show no Projects sub-row and no chip', async () => {
    stubFetch(); // the vision store fetches on import
    const { default: App } = await import('../../src/App.jsx');
    for (const view of ['day', 'process', 'wiki']) {
      cleanup(); localStorage.clear(); sessionStorage.clear();
      window.history.pushState({}, '', `/?view=${view}`);
      stubFetch();
      render(<App />);
      await screen.findByTestId('room-tab-projects');
      expect(screen.queryByTestId('project-sub-tabs'), view).toBeNull();
      expect(screen.queryByTestId('project-chip'), view).toBeNull();
      expect(screen.queryByTestId('room-breadcrumb'), view).toBeNull();
    }
  }, 60000);

  it('selector rows: shows the current project, lists the known ones, a pick calls the switch (mocked) with that root', async () => {
    stubFetch();
    const rows = [
      { name: 'pick another project', pick: 'cadence', want: ['/p/cadence'] },
      { name: 'pick the current project: no switch', pick: 'forge', want: [] },
    ];
    for (const r of rows) {
      cleanup();
      const onSwitch = vi.fn(async () => true);
      render(<ProjectSwitchPopover brand={false} projectName="compose" projectRoot="/p/forge" onSwitch={onSwitch} />);
      expect(screen.getByTestId('project-btn').textContent, r.name).toBe('compose');
      expect(screen.queryByText('Compose'), r.name).toBeNull();
      fireEvent.click(screen.getByTestId('project-btn'));
      await waitFor(() => expect(screen.getAllByTestId(/^project-row-/).map((b) => b.dataset.testid), r.name).toEqual(['project-row-forge', 'project-row-cadence']));
      fireEvent.click(screen.getByTestId(`project-row-${r.pick}`));
      await waitFor(() => expect(screen.queryByTestId('project-popover'), r.name).toBeNull());
      expect(onSwitch.mock.calls.map((c) => c[0]), r.name).toEqual(r.want);
    }
  });

  it('the branded popover (default) lists nothing and fetches no roots', () => {
    stubFetch();
    render(<ProjectSwitchPopover projectName="compose" projectRoot="/p/forge" onSwitch={vi.fn()} />);
    expect(screen.getByText('Compose')).toBeTruthy();
    fireEvent.click(screen.getByTestId('project-btn'));
    expect(screen.queryByTestId('project-list')).toBeNull();
    expect(wsFetch.mock.calls.filter((c) => String(c[0]).startsWith('/api/fleet/roots')).length).toBe(0);
  });
});
