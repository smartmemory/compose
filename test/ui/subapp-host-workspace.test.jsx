/**
 * COMP-SUBAPP-HOST-WORKSPACE-1 (row 306b): a changed `host.workspace.id` makes the Stratum, Cadence and Wiki rooms re-read their
 * data and show nothing from the old workspace; with no change there is no extra read. The Wiki room also re-checks its served wiki
 * workspace (`useWikiTabState`) and says "checking" meanwhile, "unavailable" if the re-check fails. Real views, fake clients.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import StratumView from '../../src/components/cockpit/StratumView.jsx';
import CadenceView from '../../src/components/cockpit/CadenceView.jsx';
import WikiView from '../../src/components/cockpit/WikiView.jsx';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';
import { buildSubappHost, createAttentionSink } from '../../src/components/cockpit/subappHost.js';
import { useWikiTabState } from '../../src/components/cockpit/useWikiTab.js';
import { WorkspaceProvider, useWorkspace } from '../../src/contexts/WorkspaceContext.jsx';

const stratumLinked = typeof __STRATUM_UI__ !== 'undefined' && __STRATUM_UI__;
const cadenceLinked = typeof __CADENCE_UI__ !== 'undefined' && __CADENCE_UI__;
const wikiLinked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;

const hostIn = (id) => buildSubappHost({ workspace: id ? { id, root: `/w/${id}` } : null, attention: createAttentionSink().publish });
const never = () => new Promise(() => {});
beforeEach(() => resetPaneMemory());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const now = new Date().toISOString();
const run = (id) => ({
  id, label: `label-${id}`, featureCode: null, flowName: `flow-${id}`, status: 'running', displayStatus: 'running', stepCount: 2, completedSteps: 1,
  currentStepId: 's', round: 0, startedAt: now, updatedAt: now, lastEventAt: now, stale: false, spent: {}, waitingGates: 0,
});
const runIds = (c) => [...c.querySelectorAll('[data-run-id]')].map((el) => el.getAttribute('data-run-id'));

describe.skipIf(!stratumLinked)('Stratum room on a workspace switch', () => {
  it('re-reads the runs and shows none of the old workspace; the same workspace id reads nothing more', async () => {
    const client = {
      listRuns: vi.fn().mockResolvedValueOnce([run('old-1')]).mockImplementationOnce(never),
      getRun: vi.fn(async () => null), listGates: vi.fn(async () => []), resolveGate: vi.fn(),
    };
    const { container, rerender } = render(<StratumView client={client} host={hostIn('wa')} />);
    await waitFor(() => expect(runIds(container)).toEqual(['old-1']));
    const before = client.listRuns.mock.calls.length;
    rerender(<StratumView client={client} host={hostIn('wa')} />); // a new host object, the same workspace id
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(client.listRuns.mock.calls.length).toBe(before);
    rerender(<StratumView client={client} host={hostIn('wb')} />);
    await waitFor(() => expect(client.listRuns.mock.calls.length).toBeGreaterThan(before));
    expect(runIds(container)).toEqual([]); // the new read is still in flight: no old rows
    expect(screen.queryByTestId('host-scope-chip')).toBeNull(); // no workspace is claimed as a filter
  });
});

const at = '2026-10-30T00:00:00Z';
const unit = (id) => ({
  id, lane: 'ops', column: 'ready', rawState: 'ready', title: `unit ${id}`, priority: 'P1', model: null,
  since: at, blocker: null, blockers: [], decision: null, dependsOn: [], sha: null,
});
const belt = (units) => ({ generatedAt: at, units, lanes: ['ops'], landedWindowH: 24, offBelt: 0, readiness: null, errors: [] });
const unitIds = (c) => [...c.querySelectorAll('[data-unit]')].map((el) => el.getAttribute('data-unit')).sort();

describe.skipIf(!cadenceLinked)('Cadence room on a workspace switch', () => {
  it('re-reads the belt and shows none of the old workspace; the same workspace id reads nothing more', async () => {
    const client = {
      getBelt: vi.fn().mockResolvedValueOnce(belt([unit('OLD-1')])).mockImplementation(never),
      getSeats: vi.fn(async () => ({ generatedAt: at, source: 'cadence', seats: [], recommendation: null, unassignedJobs: [], errors: [] })),
      getChains: vi.fn(async () => ({ generatedAt: at, chains: [], errors: [] })),
      getLive: vi.fn(async () => ({ generatedAt: at, lanes: [], errors: [] })),
      getAttention: vi.fn(async () => ({ generatedAt: at, alerts: [], overdue: [], cadenceStatus: 'ok', cadenceTs: at, errors: [], asks: [] })),
      getReview: vi.fn(async () => ({ generatedAt: at, inReview: [], inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, reviewMaxH: 24, errors: [] })),
      getDiary: vi.fn(async () => ({ generatedAt: at, scanned: 0, skipped: 0, errors: [], events: [] })),
    };
    const { container, rerender } = render(<CadenceView client={client} host={hostIn('wa')} />);
    await waitFor(() => expect(unitIds(container)).toEqual(['OLD-1']));
    const before = client.getBelt.mock.calls.length;
    rerender(<CadenceView client={client} host={hostIn('wa')} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(client.getBelt.mock.calls.length).toBe(before);
    rerender(<CadenceView client={client} host={hostIn('wb')} />);
    await waitFor(() => expect(client.getBelt.mock.calls.length).toBeGreaterThan(before));
    expect(unitIds(container)).toEqual([]);
    expect(screen.queryByTestId('host-scope-chip')).toBeNull(); // Cadence's reads are fleet-wide: no filter is claimed
  });
});

const page = () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' });
const wikiClient = () => ({
  graphAll: vi.fn(), graphPage: vi.fn(), note: vi.fn(), identity: vi.fn(),
  featuresPage: vi.fn(async () => page()), featureHub: vi.fn(async () => page()),
  decisions: vi.fn(async () => page()), decisionsPage: vi.fn(async () => page()), sourcesPage: vi.fn(async () => page()),
  docsByArea: vi.fn(async () => page()), ledger: vi.fn(), upcomingCalls: vi.fn(),
  search: vi.fn(async () => ({ groups: [], generated_at: 't' })),
});
const json = (body) => ({ ok: true, status: 200, json: async () => body });

// The real WorkspaceProvider and useWikiTabState, with the server's two answers faked: the Compose workspace and the wiki's served one.
function Harness({ client }) {
  const { workspace, refresh } = useWorkspace();
  const tab = useWikiTabState();
  return (
    <>
      <button onClick={() => refresh()}>switch</button>
      <WikiView client={client} host={buildSubappHost({ workspace })} workspace={tab.workspace} frameBase={tab.frameBase}
        availability={tab.availability} recheckFailed={tab.recheckFailed} />
    </>
  );
}
const stubServer = ({ ws, available }) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  if (url === '/api/workspace') return json({ id: ws.id, root: `/w/${ws.id}`, source: 'boot' });
  if (url === '/api/health') return json({});
  if (url === '/api/wiki/available') return available(ws.id);
  throw new Error(`unexpected fetch ${url}`);
}));

describe.skipIf(!wikiLinked)('Wiki room on a workspace switch', () => {
  it('re-checks the served wiki workspace and says "checking" until it answers; the old workspace is never shown', async () => {
    const ws = { id: 'wa' };
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    stubServer({ ws, available: async (id) => { calls += 1; if (id === 'wb') await gate; return json({ available: true, workspace: `wiki-${id}`, frameBase: 'http://127.0.0.1:8791' }); } });
    const client = wikiClient();
    render(<WorkspaceProvider><Harness client={client} /></WorkspaceProvider>);
    await screen.findByText('wiki-wa');
    expect(calls).toBe(1);
    expect(client.featuresPage).toHaveBeenCalledWith({ workspace: 'wiki-wa', size: 50 });
    ws.id = 'wb';
    fireEvent.click(screen.getByText('switch'));
    await screen.findByTestId('wiki-checking');
    expect(screen.queryByText('wiki-wa')).toBeNull();
    release();
    await screen.findByText('wiki-wb');
    expect(screen.queryByTestId('wiki-checking')).toBeNull();
    expect(calls).toBe(2);
    expect(client.featuresPage).toHaveBeenLastCalledWith({ workspace: 'wiki-wb', size: 50 });
    // The same workspace id again: no re-check.
    fireEvent.click(screen.getByText('switch'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(calls).toBe(2);
  });

  it('shows "Wiki unavailable" when the re-check fails: not the previous workspace, not an empty hub', async () => {
    const ws = { id: 'wa' };
    stubServer({ ws, available: async (id) => { if (id === 'wb') throw new Error('connection refused'); return json({ available: true, workspace: 'wiki-wa', frameBase: 'http://127.0.0.1:8791' }); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<WorkspaceProvider><Harness client={wikiClient()} /></WorkspaceProvider>);
    await screen.findByText('wiki-wa');
    ws.id = 'wb';
    fireEvent.click(screen.getByText('switch'));
    await screen.findByTestId('wiki-unavailable', {}, { timeout: 8000 }); // checkAvailability retries once after 3 s
    expect(screen.queryByText('wiki-wa')).toBeNull();
    expect(screen.queryByTestId('wiki-checking')).toBeNull();
  }, 15000);
});

// Fix r1: the first availability check runs once the provider settles WITHOUT an id (an empty or a failed `/api/workspace`), against the
// server's target root, and the Wiki leaves "checking" for the real answer. The real provider, hook and room, the server faked.
function Probe({ client }) {
  const { workspace } = useWorkspace();
  const tab = useWikiTabState();
  return (
    <>
      <span data-testid="probe-availability">{tab.availability}</span>
      <WikiView client={client} host={buildSubappHost({ workspace })} workspace={tab.workspace} frameBase={tab.frameBase}
        availability={tab.availability} recheckFailed={tab.recheckFailed} />
    </>
  );
}
const NO_ID_ANSWERS = {
  'answers with no id': async () => json({}),
  'fails (HTTP 500)': async () => ({ ok: false, status: 500, json: async () => ({}) }),
  'fails (network)': async () => { throw new Error('connection refused'); },
};
function stubNoId(workspaceAnswer, availableBody) {
  const calls = { available: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url === '/api/workspace') return workspaceAnswer();
    if (url === '/api/health') return json({});
    if (url === '/api/wiki/available') { calls.available += 1; return json(availableBody); }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return calls;
}

describe.skipIf(!wikiLinked)('Wiki availability when the workspace read gives no id (fix r1)', () => {
  it('the provider settles with no id: the availability check runs, exactly once', async () => {
    const calls = stubNoId(NO_ID_ANSWERS['answers with no id'], { available: false });
    render(<WorkspaceProvider><Probe client={wikiClient()} /></WorkspaceProvider>);
    await waitFor(() => expect(calls.available).toBe(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(calls.available).toBe(1);
  });

  for (const [how, answer] of Object.entries(NO_ID_ANSWERS)) {
    for (const [body, want] of [[{ available: false }, 'no'], [{ available: true, workspace: 'wiki-root', frameBase: 'http://127.0.0.1:8791' }, 'yes']]) {
      it(`/api/workspace ${how}, the wiki says ${want}: the tab and room leave "checking"`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubNoId(answer, body);
        const client = wikiClient();
        render(<WorkspaceProvider><Probe client={client} /></WorkspaceProvider>);
        await waitFor(() => expect(screen.getByTestId('probe-availability').textContent).toBe(want));
        expect(screen.queryByTestId('wiki-checking')).toBeNull();
        expect(screen.queryByTestId('wiki-unavailable')).toBeNull();
        if (want === 'yes') await waitFor(() => expect(client.featuresPage).toHaveBeenCalledWith({ workspace: 'wiki-root', size: 50 }));
      });
    }
  }
});
