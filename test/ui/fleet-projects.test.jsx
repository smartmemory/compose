/**
 * COMP-COCKPIT-FLEET-PROJECTS-1: the Fleet room's PROJECTS list beside the Process view, both fed by the recorded
 * GET /api/process envelope (test/fixtures/process/api-process.json, lanes hub and main) with its `fleet` block
 * edited per row. Up, down, remove and add each POST the whole list to /api/fleet/projects and the Process columns
 * and time-split rows follow; a failed POST rolls back with an error line; a row click selects the lane for the KPI
 * tiles. Other rooms keep GROUPS. One row table.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (sel) => { const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], iterationStates: new Map() }; return typeof sel === 'function' ? sel(s) : s; },
}));

const { default: ProcessView } = await import('../../src/components/cockpit/ProcessView.jsx');
const { default: FleetProjectsSection } = await import('../../src/components/vision/FleetProjectsSection.jsx');
const { default: AttentionQueueSidebar } = await import('../../src/components/vision/AttentionQueueSidebar.jsx');
const { resetProcessPoller } = await import('../../src/lib/processPoller.js');
const { resetFleetPoller } = await import('../../src/lib/fleetPoller.js');

const envelope = (projects) => {
  const env = structuredClone(JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'process', 'api-process.json'), 'utf8')));
  env.fleet = { known: ['hub', 'main'], projects, error: null };
  return env;
};

function mount(projects, { postStatus = 200 } = {}) {
  resetProcessPoller();
  resetFleetPoller();
  const posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u === '/api/fleet/projects') {
      const body = JSON.parse(opts.body);
      posts.push([opts.method, body.projects]);
      return { ok: postStatus === 200, status: postStatus, json: async () => (postStatus === 200 ? body : { error: 'disk full' }) };
    }
    const body = u.startsWith('/api/process') ? envelope(projects) : { generated: 'x', sources: {} };
    return { ok: true, status: 200, json: async () => body };
  }));
  const onViewChange = vi.fn();
  render(<><FleetProjectsSection onViewChange={onViewChange} /><ProcessView /></>);
  return { posts, onViewChange };
}

/** The lanes in DOM order for a test-id prefix (`process-col-`, `p6-lane-`, `fleet-project-`). */
const order = (prefix) => screen.queryAllByTestId(new RegExp(`^${prefix}(hub|main)$`)).map((el) => el.dataset.testid.slice(prefix.length));
const ready = () => screen.findByTestId('fleet-project-hub').then(() => screen.findByTestId('process-col-hub'));
const click = (id) => fireEvent.click(screen.getByTestId(id));

const ROWS = [
  {
    name: 'no saved order: every lane in builder order, as before',
    async run() {
      const { posts } = mount(null);
      await ready();
      expect([order('fleet-project-'), order('process-col-'), order('p6-lane-')]).toEqual([['hub', 'main'], ['hub', 'main'], ['hub', 'main']]);
      expect(posts).toEqual([]);
    },
  },
  {
    name: 'saved order drives the columns and time-split rows',
    async run() {
      mount(['main', 'hub']);
      await ready();
      expect([order('fleet-project-'), order('process-col-'), order('p6-lane-')]).toEqual([['main', 'hub'], ['main', 'hub'], ['main', 'hub']]);
    },
  },
  {
    name: 'move up POSTs the new list and the Process columns follow',
    async run() {
      const { posts } = mount(null);
      await ready();
      click('fleet-project-up-main');
      await waitFor(() => expect(posts).toEqual([['POST', ['main', 'hub']]]));
      expect([order('process-col-'), order('p6-lane-')]).toEqual([['main', 'hub'], ['main', 'hub']]);
    },
  },
  {
    name: 'move down POSTs the new list and the Process columns follow',
    async run() {
      const { posts } = mount(['hub', 'main']);
      await ready();
      click('fleet-project-down-hub');
      await waitFor(() => expect(posts).toEqual([['POST', ['main', 'hub']]]));
      expect([order('process-col-'), order('p6-lane-')]).toEqual([['main', 'hub'], ['main', 'hub']]);
    },
  },
  {
    name: 'remove POSTs the shorter list; the lane leaves the columns and rows and joins the Add picker',
    async run() {
      const { posts } = mount(null);
      await ready();
      click('fleet-project-remove-main');
      await waitFor(() => expect(posts).toEqual([['POST', ['hub']]]));
      expect([order('fleet-project-'), order('process-col-'), order('p6-lane-')]).toEqual([['hub'], ['hub'], ['hub']]);
      click('fleet-projects-add');
      expect(screen.getByTestId('fleet-projects-add-main')).toBeTruthy();
    },
  },
  {
    name: 'add from the picker POSTs the longer list and the lane comes back last',
    async run() {
      const { posts } = mount(['hub']);
      await ready();
      expect(screen.queryByTestId('process-col-main')).toBeNull();
      click('fleet-projects-add');
      click('fleet-projects-add-main');
      await waitFor(() => expect(posts).toEqual([['POST', ['hub', 'main']]]));
      expect([order('process-col-'), order('p6-lane-')]).toEqual([['hub', 'main'], ['hub', 'main']]);
      expect(screen.queryByTestId('fleet-projects-add-picker')).toBeNull();
    },
  },
  {
    name: 'a failed POST rolls the order back and shows an error line',
    async run() {
      const { posts } = mount(null, { postStatus: 500 });
      await ready();
      click('fleet-project-up-main');
      await screen.findByTestId('fleet-projects-error');
      expect(posts).toEqual([['POST', ['main', 'hub']]]);
      expect(screen.getByTestId('fleet-projects-error').textContent).toContain('disk full');
      expect([order('fleet-project-'), order('process-col-')]).toEqual([['hub', 'main'], ['hub', 'main']]);
    },
  },
  {
    name: 'a row click selects the lane for the KPI tiles (same state as the column header) and opens Process',
    async run() {
      const { onViewChange } = mount(null);
      await ready();
      expect(screen.getByTestId('process-page-hub')).toBeTruthy();
      click('fleet-project-select-main');
      await screen.findByTestId('process-page-main');
      expect(onViewChange).toHaveBeenCalledWith('process');
      expect(screen.getByTestId('process-col-main').querySelector('button[aria-pressed]').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('fleet-project-select-main').getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(screen.getByTestId('process-col-hub').querySelector('button'));
      await waitFor(() => expect(screen.getByTestId('fleet-project-select-hub').getAttribute('aria-pressed')).toBe('true'));
    },
  },
  {
    name: 'the left bar shows PROJECTS in the Fleet room and GROUPS everywhere else',
    async run() {
      resetProcessPoller();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => envelope(null) })));
      const items = [{ id: '1', type: 'feature', title: 'A', status: 'in_progress', group: 'G' }, { id: '2', type: 'feature', title: 'B', status: 'planned', group: 'H' }];
      const props = { items, gates: [], connected: true, hiddenGroups: new Set(), onToggleGroup: vi.fn(), onViewChange: vi.fn(), spawnedAgents: [], agentRelays: [], agentActivity: [], agentErrors: [], storageScope: 'fleet-projects-test' };
      const other = render(<AttentionQueueSidebar {...props} />);
      expect([screen.queryByText('Groups') !== null, screen.queryByTestId('fleet-projects')]).toEqual([true, null]);
      other.unmount();
      render(<AttentionQueueSidebar {...props} fleetRoom />);
      await screen.findByTestId('fleet-project-hub');
      expect(screen.queryByText('Groups')).toBeNull();
    },
  },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('COMP-COCKPIT-FLEET-PROJECTS-1 PROJECTS list', () => {
  for (const row of ROWS) it(row.name, () => row.run());
});
