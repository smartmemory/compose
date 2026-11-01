/**
 * COMP-AUDIT-17 slice 2: labelled rooms, the sub-row, the focus chip, deep links, stored-state migration.
 * Components render with props only (no fetch); the App-level rows reuse the slice-1 harness.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
import ViewTabs, { ViewSubTabs, ProjectSubTabs, RoomPaneSwitcher } from '../../src/components/cockpit/ViewTabs.jsx';
import { ROOMS } from '../../lib/view-keys.js';

const ALL_YES = { ops: 'yes', stratum: 'yes', cadence: 'yes', wiki: 'yes' };

describe('<ViewTabs> top row', () => {
  it('shows Day, Projects, Fleet, Library and the gear, with Projects selected on a project room (PROJECTS-TAB-1)', () => {
    render(<ViewTabs activeView="gates" availability={ALL_YES} onViewChange={() => {}} />);
    const names = screen.getAllByRole('tab').map((t) => t.getAttribute('data-testid'));
    expect(names).toEqual(['room-tab-day', 'room-tab-projects', 'room-tab-fleet', 'room-tab-library', 'room-tab-settings']);
    expect(screen.queryByTestId('project-chip')).toBeNull();
    expect(ROOMS.map((r) => r.label)).toEqual(['Day', 'Project home', 'Ideas', 'Roadmap', 'Build', 'Review', 'Fleet', 'Library']);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.map((t) => t.getAttribute('data-testid'))).toEqual(['room-tab-projects']);
  });

  it('the gear is selected on settings and no room is', () => {
    render(<ViewTabs activeView="settings" availability={ALL_YES} onViewChange={() => {}} />);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.map((t) => t.getAttribute('data-testid'))).toEqual(['room-tab-settings']);
  });

  it('click rows: a room opens its last view, else its first shown view', () => {
    const rows = [
      { room: 'projects', props: {}, want: 'dashboard' },
      { room: 'projects', props: { activeView: 'ops', lastByRoom: { projects: 'gates' } }, want: 'gates' },
      { room: 'fleet', props: {}, want: 'sessions' },
      { room: 'fleet', props: { lastByRoom: { fleet: 'usage' } }, want: 'usage' },
      { room: 'fleet', props: { availability: { ...ALL_YES, cadence: 'no', stratum: 'no', ops: 'no' } }, want: 'sessions' },
      { room: 'library', props: { availability: { ...ALL_YES, wiki: 'no' } }, want: 'journal' },
      { room: 'settings', props: {}, want: 'settings' },
    ];
    for (const r of rows) {
      const onViewChange = vi.fn();
      const { unmount } = render(<ViewTabs activeView="day" availability={ALL_YES} onViewChange={onViewChange} {...r.props} />);
      fireEvent.click(screen.getByTestId(`room-tab-${r.room}`));
      expect(onViewChange, r.room).toHaveBeenCalledWith(r.want);
      unmount(); cleanup();
    }
  });

  it('the Projects tab and its Review room carry the pending-gates badge', () => {
    render(<ViewTabs activeView="dashboard" availability={ALL_YES} onViewChange={() => {}} badges={{ review: 3 }} />);
    expect(screen.getByTestId('room-tab-projects').textContent).toMatch(/3/);
    expect(screen.getByTestId('room-tab-fleet').textContent).not.toMatch(/\d/);
    cleanup();
    render(<ProjectSubTabs activeView="dashboard" availability={ALL_YES} onViewChange={() => {}} badges={{ review: 3 }} />);
    expect(screen.getByTestId('sub-tab-review').textContent).toMatch(/3/);
    expect(screen.getByTestId('sub-tab-home').textContent).not.toMatch(/\d/);
  });

  it('the Feature chip shows only while focused, and its x clears', () => {
    const onClearFocus = vi.fn();
    const { rerender } = render(<ViewTabs activeView="graph" availability={ALL_YES} onViewChange={() => {}} />);
    expect(screen.queryByTestId('focus-chip')).toBeNull();
    rerender(<ViewTabs activeView="graph" availability={ALL_YES} onViewChange={() => {}} focusedFeature="FEAT-1" onClearFocus={onClearFocus} />);
    expect(screen.getByTestId('focus-chip').textContent).toMatch(/Feature: FEAT-1/);
    fireEvent.click(screen.getByTestId('focus-chip-clear'));
    expect(onClearFocus).toHaveBeenCalledTimes(1);
  });
});

describe('<ProjectSubTabs> rooms row (COMP-COCKPIT-PROJECTS-TAB-1)', () => {
  it('rows: the five rooms in order inside a project room, the active one selected, none elsewhere, the selector first', () => {
    const rows = [
      { view: 'dashboard', active: 'home' }, { view: 'ideabox', active: 'ideas' }, { view: 'tree', active: 'roadmap' },
      { view: 'pipeline', active: 'build' }, { view: 'qa-scope', active: 'review' },
      { view: 'day', active: null }, { view: 'ops', active: null }, { view: 'settings', active: null },
    ];
    for (const r of rows) {
      const { container } = render(<ProjectSubTabs activeView={r.view} availability={ALL_YES} selector={<span data-testid="sel">proj</span>} />);
      if (!r.active) { expect(screen.queryByTestId('project-sub-tabs'), r.view).toBeNull(); cleanup(); continue; }
      const tabs = screen.getAllByRole('tab');
      expect(tabs.map((t) => t.getAttribute('data-testid')), r.view).toEqual(['sub-tab-home', 'sub-tab-ideas', 'sub-tab-roadmap', 'sub-tab-build', 'sub-tab-review']);
      expect(tabs.map((t) => t.textContent), r.view).toEqual(['Project home', 'Ideas', 'Roadmap', 'Build', 'Review']);
      expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-testid')), r.view).toEqual([`sub-tab-${r.active}`]);
      expect(container.querySelector('[role="tablist"]').firstElementChild.getAttribute('data-testid'), r.view).toBe('project-selector');
      cleanup();
    }
  });

  it('a room click opens that room on its last view; the active room keeps the current view; the row shares Fleet\'s tab classes', () => {
    const rows = [
      { room: 'review', from: 'dashboard', last: {}, want: 'gates' },
      { room: 'review', from: 'dashboard', last: { review: 'validate' }, want: 'validate' },
      { room: 'roadmap', from: 'gates', last: {}, want: 'graph' },
      { room: 'ideas', from: 'gates', last: {}, want: 'ideabox' },
      { room: 'home', from: 'graph', last: {}, want: 'dashboard' },
      { room: 'roadmap', from: 'tree', last: {}, want: 'tree' },
    ];
    for (const r of rows) {
      const onViewChange = vi.fn();
      render(<ProjectSubTabs activeView={r.from} availability={ALL_YES} lastByRoom={r.last} onViewChange={onViewChange} />);
      fireEvent.click(screen.getByTestId(`sub-tab-${r.room}`));
      expect(onViewChange, r.room).toHaveBeenCalledWith(r.want);
      cleanup();
    }
    render(<div><ProjectSubTabs activeView="graph" availability={ALL_YES} /><ViewSubTabs activeView="process" availability={ALL_YES} /></div>);
    const cls = (id) => screen.getByTestId(id).className.replace(/border-blue-600 text-blue-600 dark:border-accent dark:text-accent|border-transparent text-muted-foreground hover:text-foreground hover:border-border/, '');
    expect(cls('sub-tab-roadmap')).toBe(cls('sub-tab-process'));
  });
});

describe('<ViewSubTabs> second row (one row table)', () => {
  const rows = [
    { view: 'dashboard', subs: null }, { view: 'ideabox', subs: null }, { view: 'settings', subs: null },
    // TAB-DEPTH-1: a project room's views are a pane switcher, never a second tab row
    { view: 'graph', subs: null }, { view: 'tree', subs: null }, { view: 'qa-scope', subs: null }, { view: 'design', subs: null },
    { view: 'process', subs: ['process', 'cadence', 'ops', 'stratum', 'sessions', 'usage'], active: 'process' },
    { view: 'journal', subs: ['wiki', 'journal'], active: 'journal' },
    { view: 'journal', av: { ...ALL_YES, wiki: 'no' }, subs: null },
    { view: 'sessions', av: { ops: 'no', stratum: 'no', cadence: 'no', wiki: 'no' }, subs: ['process', 'sessions', 'usage'], active: 'sessions' },
  ];
  it('rows', () => {
    for (const r of rows) {
      const onViewChange = vi.fn();
      render(<ViewSubTabs activeView={r.view} availability={r.av || ALL_YES} onViewChange={onViewChange} />);
      if (!r.subs) {
        expect(screen.queryByTestId('sub-tabs'), r.view).toBeNull();
      } else {
        const tabs = screen.getAllByRole('tab');
        expect(tabs.map((t) => t.getAttribute('data-testid').replace('sub-tab-', '')), r.view).toEqual(r.subs);
        expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-testid')), r.view).toEqual([`sub-tab-${r.active}`]);
        fireEvent.click(tabs[tabs.length - 1]);
        expect(onViewChange).toHaveBeenCalledWith(r.subs[r.subs.length - 1]);
      }
      cleanup();
    }
  });

  it('Roadmap shows Graph and List; Build names its four screens in plain words', () => {
    render(<RoomPaneSwitcher activeView="graph" availability={ALL_YES} onViewChange={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Graph', 'List']);
    cleanup();
    render(<RoomPaneSwitcher activeView="pipeline" availability={ALL_YES} onViewChange={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Design', 'Live build', 'Flow editor', 'Builds']);
  });
});

describe('<RoomPaneSwitcher> project room views (one row table)', () => {
  const rows = [
    { view: 'dashboard', panes: null }, { view: 'ideabox', panes: null }, { view: 'process', panes: null },
    { view: 'graph', panes: ['graph', 'tree'] },
    { view: 'tree', panes: ['graph', 'tree'] },
    { view: 'qa-scope', panes: ['gates', 'validate', 'qa-scope', 'decisions'] },
    { view: 'decisions', panes: ['gates', 'validate', 'qa-scope', 'decisions'] },
    { view: 'design', panes: ['design', 'pipeline', 'pipeline-editor', 'build-history'] },
  ];
  it('rows', () => {
    for (const r of rows) {
      const onViewChange = vi.fn();
      render(<RoomPaneSwitcher activeView={r.view} availability={ALL_YES} onViewChange={onViewChange} />);
      if (!r.panes) {
        expect(screen.queryByTestId('pane-switcher'), r.view).toBeNull();
      } else {
        const tabs = screen.getAllByRole('tab');
        expect(tabs.map((t) => t.getAttribute('data-testid').replace('sub-tab-', '')), r.view).toEqual(r.panes);
        expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-testid')), r.view).toEqual([`sub-tab-${r.view}`]);
        fireEvent.click(tabs[tabs.length - 1]);
        expect(onViewChange).toHaveBeenCalledWith(r.panes[r.panes.length - 1]);
      }
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// App level (slice-1 harness): deep links, stored-state migration, focus, invalid commands.
// ---------------------------------------------------------------------------

function mockFetch({ opsPages = null } = {}) {
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('/api/ops-status/index')) {
      return { ok: true, status: 200, json: async () => ({ pages: opsPages || [] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
}

async function renderApp() {
  const { default: App } = await import('../../src/App.jsx');
  return render(<App />);
}

// room tabs only: sub-tabs are role=tab too
const selectedIds = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true' && t.getAttribute('data-testid').startsWith('room-tab-')).map((t) => t.getAttribute('data-testid'));

describe('App rooms (COMP-AUDIT-17 slice 2)', () => {
  beforeEach(async () => {
    localStorage.clear(); sessionStorage.clear();
    window.history.pushState({}, '', '/');
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    // RIBBON-TOP-1: settings reset too. A row below sets defaultView 'dashboard', which used to equal the default and now overrides Day.
    useVisionStore.setState({ items: [], uiCommand: null, settings: {} });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

  it('fresh load: Day is highlighted, no sub-row, the rooms and the gear', async () => {
    mockFetch();
    await renderApp();
    expect(await screen.findByTestId('day-view')).toBeTruthy();
    expect(selectedIds()).toEqual(['room-tab-day']);
    expect(screen.queryByTestId('sub-tabs')).toBeNull();
    expect(screen.getByTestId('room-tab-settings')).toBeTruthy();
  }, 30000);

  it('deep links: ?view=process opens Fleet > Process and ?view=design opens Build > Design (one row table)', async () => {
    const rows = [
      { q: '?view=process', top: 'room-tab-fleet', sub: 'sub-tab-process' },
      { q: '?view=design', top: 'room-tab-projects', sub: 'sub-tab-design' },
    ];
    for (const r of rows) {
      cleanup(); localStorage.clear();
      window.history.pushState({}, '', `/${r.q}`);
      mockFetch();
      await renderApp();
      await waitFor(() => expect(selectedIds(), r.q).toEqual([r.top]));
      const sub = await screen.findByTestId(r.sub);
      expect(sub.getAttribute('aria-selected'), r.q).toBe('true');
      expect(screen.queryByText(/View not found/i)).toBeNull();
    }
  }, 60000);

  it('an old flat-tab state migrates: tab key lands in its room, old keys are removed, no "View not found"', async () => {
    localStorage.setItem('compose:mainTabs', JSON.stringify(['tree', 'graph', 'bogus']));
    localStorage.setItem('compose:activeTab', 'gates');
    mockFetch();
    // a settings defaultView must not override the migrated stored view (the old tab key counts as a stored view)
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    useVisionStore.setState({ settings: { ui: { defaultView: 'dashboard' } } });
    await renderApp();
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-projects']));
    await new Promise((r) => setTimeout(r, 300));
    expect(selectedIds()).toEqual(['room-tab-projects']);
    expect(screen.getByTestId('sub-tab-review').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sub-tab-gates').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText(/View not found/i)).toBeNull();
    expect(localStorage.getItem('compose:mainTabs')).toBeNull();
    expect(localStorage.getItem('compose:activeTab')).toBeNull();
  }, 30000);

  it('a stored hidden key (tree) opens Roadmap > List', async () => {
    sessionStorage.setItem('compose:activeView', 'tree');
    mockFetch();
    await renderApp();
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-projects']));
    expect(screen.getByTestId('sub-tab-roadmap').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sub-tab-tree').getAttribute('aria-selected')).toBe('true');
  }, 30000);

  it('clicking a room and a sub-tab navigates and re-opens the room on its last view', async () => {
    mockFetch();
    await renderApp();
    await screen.findByTestId('day-view');
    fireEvent.click(screen.getByTestId('room-tab-projects'));
    await screen.findByTestId('home');
    fireEvent.click(screen.getByTestId('sub-tab-review'));
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-projects']));
    fireEvent.click(screen.getByTestId('sub-tab-validate'));
    await waitFor(() => expect(screen.getByTestId('sub-tab-validate').getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByTestId('sub-tab-home'));
    await screen.findByTestId('home');
    fireEvent.click(screen.getByTestId('sub-tab-review'));
    await waitFor(() => expect(screen.getByTestId('sub-tab-validate').getAttribute('aria-selected')).toBe('true'));
  }, 30000);

  it('a uiCommand with an unknown view is ignored with one warning (no jump to Home, no "not found")', async () => {
    sessionStorage.setItem('compose:activeView', 'usage');
    mockFetch();
    await renderApp();
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-fleet']));
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    await act(async () => { useVisionStore.setState({ uiCommand: { view: 'bogus-view' } }); });
    await waitFor(() => expect(useVisionStore.getState().uiCommand).toBeNull());
    expect(selectedIds()).toEqual(['room-tab-fleet']);
    const warns = console.warn.mock.calls.filter((c) => String(c[0]).includes('bogus-view'));
    expect(warns.length).toBe(1);
    expect(screen.queryByText(/View not found/i)).toBeNull();
  }, 30000);

  it('a uiCommand with a valid view navigates (Review > Gates)', async () => {
    mockFetch();
    await renderApp();
    await screen.findByTestId('day-view');
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    await act(async () => { useVisionStore.setState({ uiCommand: { view: 'gates' } }); });
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-projects']));
    expect(screen.getByTestId('sub-tab-review').getAttribute('aria-selected')).toBe('true');
  }, 30000);

  it('focus: a stored code that resolves shows the chip; x clears it and the storage key', async () => {
    localStorage.setItem('compose:focusedFeature', 'FEAT-1');
    mockFetch();
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    await renderApp();
    await act(async () => { useVisionStore.setState({ items: [{ id: 'f1', type: 'feature', title: 'One', status: 'planned', featureCode: 'FEAT-1' }] }); });
    expect((await screen.findByTestId('focus-chip')).textContent).toMatch(/Feature: FEAT-1/);
    fireEvent.click(screen.getByTestId('focus-chip-clear'));
    await waitFor(() => expect(screen.queryByTestId('focus-chip')).toBeNull());
    expect(localStorage.getItem('compose:focusedFeature')).toBeNull();
  }, 30000);

  it('focus: a stored code that no longer resolves is cleared once items load, with a warning', async () => {
    localStorage.setItem('compose:focusedFeature', 'GONE-9');
    mockFetch();
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    await renderApp();
    expect(screen.getByTestId('focus-chip').textContent).toMatch(/GONE-9/); // kept until items can be judged
    await act(async () => { useVisionStore.setState({ items: [{ id: 'f1', type: 'feature', title: 'One', status: 'planned', featureCode: 'FEAT-1' }] }); });
    await waitFor(() => expect(screen.queryByTestId('focus-chip')).toBeNull());
    expect(localStorage.getItem('compose:focusedFeature')).toBeNull();
    expect(console.warn.mock.calls.some((c) => String(c[0]).includes('GONE-9'))).toBe(true);
  }, 30000);
});
