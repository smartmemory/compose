/**
 * COMP-COCKPIT-FLEET-PROJECTS-2: the left bar's PROJECTS list in every room. In the project rooms (Home, Ideas,
 * Roadmap, Build, Review) a row switches the whole cockpit to that lane's Compose project through the one existing
 * switch (POST /api/project/switch, the header's project name follows); a lane with no project shows one plain line
 * instead of any project's data; the saved order is the same after a switch. The App rows mount the real App over a
 * URL-routed fetch stub (the recorded GET /api/process envelope, lanes hub and main). Never a live server. One row table.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { ROOMS } = await import('../../lib/view-keys.js');
const { default: AttentionQueueSidebar } = await import('../../src/components/vision/AttentionQueueSidebar.jsx');
const { projectsModeFor } = await import('../../src/lib/fleetProjects.js');
const { resetProcessPoller } = await import('../../src/lib/processPoller.js');

const BOOT = '/tmp/fp2/boot';
const HUB = '/tmp/fp2/hub';
const envelope = (projects) => {
  const env = structuredClone(JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'process', 'api-process.json'), 'utf8')));
  env.fleet = { known: ['hub', 'main'], projects, error: null };
  return env;
};
const ROOTS = { roots: { hub: { root: HUB, hasCompose: true }, main: { root: null, hasCompose: false } }, error: null };

/** A fetch stub routed by URL; records every call as [method, url, body]. */
function stubFetch({ projects = ['main', 'hub'], rootsStatus = 200 } = {}) {
  const calls = [];
  let bound = BOOT;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push([opts.method ?? 'GET', u, body]);
    let json = {};
    if (u === '/api/project') json = { targetRoot: bound, name: bound.split('/').pop(), dataDir: `${bound}/.compose/data` };
    else if (u === '/api/project/switch') { bound = body.path; json = { ok: true, targetRoot: bound, name: bound.split('/').pop() }; }
    else if (u.startsWith('/api/process')) json = envelope(projects);
    else if (u === '/api/fleet/roots') {
      if (rootsStatus !== 200) return { ok: false, status: rootsStatus, json: async () => ({ error: 'Not Found' }), text: async () => '' };
      json = ROOTS;
    }
    return { ok: true, status: 200, json: async () => json, text: async () => '' };
  }));
  return calls;
}

async function mountApp(view, stub = {}) {
  localStorage.setItem('compose:activeView', view);
  resetProcessPoller();
  const calls = stubFetch(stub);
  const { default: App } = await import('../../src/App.jsx');
  render(<App />);
  await screen.findByTestId('fleet-project-hub');
  await waitFor(() => expect(screen.getByTestId('project-btn').textContent).toContain('boot'));
  return calls;
}

const switches = (calls) => calls.filter(([m, u]) => m === 'POST' && u === '/api/project/switch').map(([, , b]) => b.path);
const listed = () => screen.queryAllByTestId(/^fleet-project-(hub|main)$/).map((el) => el.dataset.testid.slice('fleet-project-'.length));

const ROWS = [
  {
    name: 'the left bar shows PROJECTS, never GROUPS, in each of the seven rooms; project rooms switch, Fleet and Library pick a lane',
    async run() {
      const seen = [];
      for (const { key } of ROOMS) {
        resetProcessPoller();
        stubFetch();
        const props = { items: [{ id: '1', type: 'feature', title: 'A', status: 'in_progress', group: 'G' }, { id: '2', type: 'feature', title: 'B', status: 'planned', group: 'H' }], gates: [], connected: true, onViewChange: vi.fn(), spawnedAgents: [], agentRelays: [], agentActivity: [], agentErrors: [], storageScope: `fp2-${key}` };
        const r = render(<AttentionQueueSidebar {...props} projectsMode={projectsModeFor(key)} projectRoot={BOOT} />);
        await screen.findByTestId('fleet-project-hub');
        seen.push([key, projectsModeFor(key), screen.queryByText('Groups') !== null, screen.queryAllByTestId('fleet-projects').length]);
        r.unmount();
      }
      expect(seen).toEqual([
        ['home', 'project', false, 1], ['ideas', 'project', false, 1], ['roadmap', 'project', false, 1],
        ['build', 'project', false, 1], ['review', 'project', false, 1], ['fleet', 'lane', false, 1], ['library', 'lane', false, 1],
      ]);
    },
  },
  {
    name: 'Roadmap: a row whose lane has a Compose project switches the cockpit to it and the header name follows',
    async run() {
      const calls = await mountApp('graph');
      fireEvent.click(screen.getByTestId('fleet-project-select-hub'));
      await waitFor(() => expect(screen.getByTestId('project-btn').textContent).toContain('hub'));
      expect(switches(calls)).toEqual([HUB]);
      await waitFor(() => expect(screen.getByTestId('fleet-project-select-hub').getAttribute('aria-pressed')).toBe('true'));
      expect(screen.queryByTestId('no-compose-project')).toBeNull();
    },
  },
  {
    name: 'Home: a lane with no Compose project shows the plain line, switches nothing, and the next project row clears it',
    async run() {
      const calls = await mountApp('dashboard');
      fireEvent.click(screen.getByTestId('fleet-project-select-main'));
      expect((await screen.findByTestId('no-compose-project')).textContent).toBe('No Compose project for main');
      expect(screen.getByTestId('fleet-project-select-main').getAttribute('aria-pressed')).toBe('true');
      expect(switches(calls)).toEqual([]);
      expect(screen.getByTestId('project-btn').textContent).toContain('boot');
      fireEvent.click(screen.getByTestId('fleet-project-select-hub'));
      await waitFor(() => expect(screen.queryByTestId('no-compose-project')).toBeNull());
      expect(switches(calls)).toEqual([HUB]);
    },
  },
  {
    name: 'Roadmap: when the roots route fails (a server not yet restarted) a click switches nothing and claims no "no project"',
    async run() {
      const calls = await mountApp('graph', { rootsStatus: 404 });
      expect((await screen.findByTestId('fleet-roots-error')).textContent).toContain('Not Found');
      fireEvent.click(screen.getByTestId('fleet-project-select-main'));
      fireEvent.click(screen.getByTestId('fleet-project-select-hub'));
      expect([switches(calls), screen.queryByTestId('no-compose-project')]).toEqual([[], null]);
    },
  },
  {
    name: 'Fleet: a row picks the Process lane and never switches the project (the room is cross-project)',
    async run() {
      const calls = await mountApp('process');
      fireEvent.click(screen.getByTestId('fleet-project-select-main'));
      await waitFor(() => expect(screen.getByTestId('fleet-project-select-main').getAttribute('aria-pressed')).toBe('true'));
      expect([switches(calls), screen.queryByTestId('no-compose-project'), calls.some(([, u]) => u === '/api/fleet/roots')]).toEqual([[], null, false]);
    },
  },
  {
    name: 'the saved order is the same list after a project switch (read from the boot project, not the active one)',
    async run() {
      const calls = await mountApp('graph');
      expect(listed()).toEqual(['main', 'hub']);
      fireEvent.click(screen.getByTestId('fleet-project-select-hub'));
      await waitFor(() => expect(switches(calls)).toEqual([HUB]));
      await waitFor(() => expect(screen.getByTestId('project-btn').textContent).toContain('hub'));
      expect(listed()).toEqual(['main', 'hub']);
    },
  },
  {
    name: 'the Roadmap graph toolbar opens the Groups popover (GROUPS moved out of the left bar)',
    async run() {
      await mountApp('graph');
      fireEvent.click(screen.getByTestId('graph-groups-toggle'));
      const pop = screen.getByTestId('graph-groups-popover');
      expect(within(pop).getByText(/Click a group/)).toBeTruthy();
    },
  },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('COMP-COCKPIT-FLEET-PROJECTS-2 PROJECTS in every room', () => {
  for (const row of ROWS) it(row.name, () => row.run(), 30000);
});
