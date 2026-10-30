/**
 * COMP-AUDIT-17 slice 2: labelled rooms, the sub-row, the focus chip, deep links, stored-state migration.
 * Components render with props only (no fetch); the App-level rows reuse the slice-1 harness.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
import ViewTabs, { ViewSubTabs } from '../../src/components/cockpit/ViewTabs.jsx';
import { ROOMS } from '../../lib/view-keys.js';

const ALL_YES = { ops: 'yes', stratum: 'yes', cadence: 'yes', wiki: 'yes' };

describe('<ViewTabs> top row', () => {
  it('shows the seven rooms in order plus the gear, with the right one selected', () => {
    render(<ViewTabs activeView="gates" availability={ALL_YES} onViewChange={() => {}} />);
    const names = screen.getAllByRole('tab').map((t) => t.getAttribute('data-testid'));
    expect(names).toEqual([...ROOMS.map((r) => `room-tab-${r.key}`), 'room-tab-settings']);
    expect(ROOMS.map((r) => r.label)).toEqual(['Home', 'Roadmap', 'Ideas', 'Review', 'Build', 'Fleet', 'Library']);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.map((t) => t.getAttribute('data-testid'))).toEqual(['room-tab-review']);
  });

  it('the gear is selected on settings and no room is', () => {
    render(<ViewTabs activeView="settings" availability={ALL_YES} onViewChange={() => {}} />);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.map((t) => t.getAttribute('data-testid'))).toEqual(['room-tab-settings']);
  });

  it('click rows: a room opens its last view, else its first shown view', () => {
    const rows = [
      { room: 'home', props: {}, want: 'dashboard' },
      { room: 'fleet', props: {}, want: 'cadence' },
      { room: 'fleet', props: { lastByRoom: { fleet: 'usage' } }, want: 'usage' },
      { room: 'fleet', props: { availability: { ...ALL_YES, cadence: 'no', stratum: 'no', ops: 'no' } }, want: 'sessions' },
      { room: 'review', props: {}, want: 'gates' },
      { room: 'library', props: { availability: { ...ALL_YES, wiki: 'no' } }, want: 'docs' },
      { room: 'ideas', props: {}, want: 'ideabox' },
      { room: 'settings', props: {}, want: 'settings' },
    ];
    for (const r of rows) {
      const onViewChange = vi.fn();
      const { unmount } = render(<ViewTabs activeView="dashboard" availability={ALL_YES} onViewChange={onViewChange} {...r.props} />);
      if (r.room !== 'home') fireEvent.click(screen.getByTestId(`room-tab-${r.room}`));
      else { cleanup(); render(<ViewTabs activeView="graph" availability={ALL_YES} onViewChange={onViewChange} />); fireEvent.click(screen.getByTestId('room-tab-home')); }
      expect(onViewChange, r.room).toHaveBeenCalledWith(r.want);
      unmount(); cleanup();
    }
  });

  it('the Review room carries the pending-gates badge', () => {
    render(<ViewTabs activeView="dashboard" availability={ALL_YES} onViewChange={() => {}} badges={{ review: 3 }} />);
    expect(screen.getByTestId('room-tab-review').textContent).toMatch(/3/);
    expect(screen.getByTestId('room-tab-fleet').textContent).not.toMatch(/\d/);
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

describe('<ViewSubTabs> second row (one row table)', () => {
  const rows = [
    { view: 'dashboard', subs: null }, { view: 'ideabox', subs: null }, { view: 'settings', subs: null },
    { view: 'graph', subs: ['graph', 'tree'], active: 'graph' },
    { view: 'tree', subs: ['graph', 'tree'], active: 'tree' },
    { view: 'qa-scope', subs: ['gates', 'validate', 'qa-scope'], active: 'qa-scope' },
    { view: 'design', subs: ['design', 'pipeline', 'build-history', 'pipeline-editor'], active: 'design' },
    { view: 'process', subs: ['cadence', 'stratum', 'ops', 'sessions', 'usage', 'process'], active: 'process' },
    { view: 'journal', subs: ['docs', 'wiki', 'journal'], active: 'journal' },
    { view: 'journal', av: { ...ALL_YES, wiki: 'no' }, subs: ['docs', 'journal'], active: 'journal' },
    { view: 'sessions', av: { ops: 'no', stratum: 'no', cadence: 'no', wiki: 'no' }, subs: ['sessions', 'usage', 'process'], active: 'sessions' },
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
    render(<ViewSubTabs activeView="graph" availability={ALL_YES} onViewChange={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Graph', 'List']);
    cleanup();
    render(<ViewSubTabs activeView="pipeline" availability={ALL_YES} onViewChange={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Design', 'Live build', 'Builds', 'Flow editor']);
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
    localStorage.clear();
    window.history.pushState({}, '', '/');
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    useVisionStore.setState({ items: [], uiCommand: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

  it('fresh load: Home is highlighted, no sub-row, seven rooms and the gear', async () => {
    mockFetch();
    await renderApp();
    expect(await screen.findByTestId('home')).toBeTruthy();
    expect(selectedIds()).toEqual(['room-tab-home']);
    expect(screen.queryByTestId('sub-tabs')).toBeNull();
    expect(screen.getByTestId('room-tab-settings')).toBeTruthy();
  }, 30000);

  it('deep links: ?view=process opens Fleet > Process and ?view=design opens Build > Design (one row table)', async () => {
    const rows = [
      { q: '?view=process', top: 'room-tab-fleet', sub: 'sub-tab-process' },
      { q: '?view=design', top: 'room-tab-build', sub: 'sub-tab-design' },
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
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-review']));
    await new Promise((r) => setTimeout(r, 300));
    expect(selectedIds()).toEqual(['room-tab-review']);
    expect(screen.getByTestId('sub-tab-gates').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText(/View not found/i)).toBeNull();
    expect(localStorage.getItem('compose:mainTabs')).toBeNull();
    expect(localStorage.getItem('compose:activeTab')).toBeNull();
  }, 30000);

  it('a stored hidden key (tree) opens Roadmap > List', async () => {
    localStorage.setItem('compose:activeView', 'tree');
    mockFetch();
    await renderApp();
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-roadmap']));
    expect(screen.getByTestId('sub-tab-tree').getAttribute('aria-selected')).toBe('true');
  }, 30000);

  it('clicking a room and a sub-tab navigates and re-opens the room on its last view', async () => {
    mockFetch();
    await renderApp();
    await screen.findByTestId('home');
    fireEvent.click(screen.getByTestId('room-tab-review'));
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-review']));
    fireEvent.click(screen.getByTestId('sub-tab-validate'));
    await waitFor(() => expect(screen.getByTestId('sub-tab-validate').getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByTestId('room-tab-home'));
    await screen.findByTestId('home');
    fireEvent.click(screen.getByTestId('room-tab-review'));
    await waitFor(() => expect(screen.getByTestId('sub-tab-validate').getAttribute('aria-selected')).toBe('true'));
  }, 30000);

  it('a uiCommand with an unknown view is ignored with one warning (no jump to Home, no "not found")', async () => {
    localStorage.setItem('compose:activeView', 'usage');
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
    await screen.findByTestId('home');
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    await act(async () => { useVisionStore.setState({ uiCommand: { view: 'gates' } }); });
    await waitFor(() => expect(selectedIds()).toEqual(['room-tab-review']));
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
