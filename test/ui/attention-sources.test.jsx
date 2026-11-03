/**
 * COMP-SUBAPP-ATTENTION-1 (row 307): the real NotifyChip and the real AttentionQueueSidebar, inside a NavigationContext with
 * spies, over three sources: Cadence attention (fetch faked at the boundary, the notify-actions server), Stratum gates and
 * Compose gates (published into the real host attention sink by the real publishers over fake data). Nothing here resolves,
 * approves or dismisses a gate. One row table: [name, scenario].
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';
import { NavigationContext } from '../../src/lib/navigation.jsx';

vi.mock('../../src/components/vision/useVisionStore.js', () => {
  const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], resolveGate: null, iterationStates: new Map() };
  return { useVisionStore: (sel) => (typeof sel === 'function' ? sel(s) : s) };
});

const { default: NotifyChip } = await import('../../src/components/cockpit/notify/NotifyChip.jsx');
const { default: AttentionQueueSidebar } = await import('../../src/components/vision/AttentionQueueSidebar.jsx');
const { resetNotifyPoller } = await import('../../src/components/cockpit/notify/useNotifySources.js');
const { resetNotifyState } = await import('../../src/components/cockpit/notify/useNotifyState.js');
const { attentionSink } = await import('../../src/components/cockpit/subappHost.js');
const { stratumGateRows, publishComposeGates, pollStratumGates, STRATUM_SOURCE, COMPOSE_SOURCE } = await import('../../src/components/cockpit/notify/gatePublishers.js');

const up = (value) => ({ value, error: null });
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const WALL = { name: 'seat2 5h', state: 'tripped', value: 97, trip: 95 };
const PG = { runId: 'run-a', flowName: 'build', stepId: 'review', gateToken: 'tok-secret', onApprove: 'n', onRevise: null, onKill: null, round: 0, maxRounds: null, reviseEndsRun: true, waitingSince: ago(600) };
const CG = { id: 'flow-1:design:1', flowId: 'flow-1', stepId: 'design', round: 1, itemId: 'item-1', status: 'pending', createdAt: ago(120) };

/** The boundary: GET /api/fleet (an empty owner queue), the cadence reads; every other URL 404s (no POST is expected). */
function fakeServer({ alerts = [WALL] } = {}) {
  const posts = [];
  const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const u = String(url);
    if ((init.method ?? 'GET') !== 'GET') posts.push(u);
    if (u === '/api/fleet') {
      return reply(200, { sources: { sm_status: up({ queue: up([]), sessions: up([]), df: up({ free_gb: 500 }) }) }, generated: new Date().toISOString(), notify: { v: 1, entries: {} } });
    }
    if (u.endsWith('/outage')) return reply(200, { state: 'ok' });
    if (u.endsWith('/attention')) return reply(200, { alerts });
    if (u.endsWith('/review')) return reply(200, { reviewMaxH: 24, inReview: [], inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, errors: [] });
    return reply(404, {});
  });
  return { posts };
}

const publishBoth = () => act(() => {
  attentionSink.publish(STRATUM_SOURCE, stratumGateRows([PG]).rows);
  publishComposeGates(attentionSink, { gates: [CG], connected: true, items: [{ id: 'item-1', title: 'Gate sources' }] });
});

const sidebarProps = {
  items: [], gates: [], onViewChange: vi.fn(), connected: true, visibleTracks: [], spawnedAgents: [], agentRelays: [],
  agentActivity: [], agentErrors: [], storageScope: 'attention-sources',
};

function mount() {
  const nav = { openRoom: vi.fn(), openGate: vi.fn(), openView: vi.fn(), openItem: vi.fn() };
  const onNavigate = vi.fn();
  const onOpenFleet = vi.fn();
  const onViewChange = vi.fn();
  render(
    <NavigationContext.Provider value={nav}>
      <NotifyChip onNavigate={onNavigate} onOpenFleet={onOpenFleet} />
      <AttentionQueueSidebar {...sidebarProps} onViewChange={onViewChange} />
    </NavigationContext.Provider>,
  );
  return { nav, onNavigate, onOpenFleet, onViewChange };
}

const ready = () => waitFor(() => expect(screen.getByTestId('notify-chip').getAttribute('data-state')).not.toBe('loading'));
const trayKinds = () => screen.getAllByTestId('notify-row').map((r) => r.getAttribute('data-kind'));
const trayRow = (kind) => screen.getAllByTestId('notify-row').find((r) => r.getAttribute('data-kind') === kind);
const listRows = () => screen.getAllByTestId('needs-attention-row');

const ROWS = [
  ['the sidebar shows ONE "Needs attention" list across all three sources, in the tray\'s rank order and keys', async () => {
    fakeServer();
    mount();
    await ready();
    publishBoth();
    await waitFor(() => expect(listRows()).toHaveLength(3));
    expect(screen.getAllByTestId('needs-attention')).toHaveLength(1);
    // older wait first (Stratum 600 s, Compose 120 s), the ageless Cadence wall last
    expect(listRows().map((r) => r.getAttribute('data-key'))).toEqual(['stratum-gate:run-a:review', 'compose-gate:flow-1:design:1', 'attention:seat2 5h']);
    fireEvent.click(screen.getByTestId('notify-chip'));
    expect(trayKinds()).toEqual(['stratum-gate', 'compose-gate', 'attention']);
    expect(screen.getByTestId('needs-attention-count').textContent).toBe(String(screen.getAllByTestId('notify-row').length));
    // "Blocked features" (roadmap items) is untouched: with no blocked items it does not render.
    expect(screen.queryByTestId('attention-toggle')).toBeNull();
    // the owner count does not move: no ask, so the chip names the kinds without a number
    expect(screen.getByTestId('notify-chip').textContent).toMatch(/Alerts: gates, Cadence/);
    expect(document.body.innerHTML).not.toContain('tok-secret');
  }],
  ['tray Open: a Stratum gate opens the Stratum Gates pane at its run and step, a Compose gate opens that gate, Cadence opens Cadence', async () => {
    const s = fakeServer();
    const { nav, onNavigate, onOpenFleet } = mount();
    await ready();
    publishBoth();
    fireEvent.click(screen.getByTestId('notify-chip'));
    await waitFor(() => expect(trayKinds()).toHaveLength(3));
    fireEvent.click(within(trayRow('stratum-gate')).getByTestId('notify-row-action'));
    expect(nav.openRoom).toHaveBeenCalledWith('stratum', { kind: 'gates', runId: 'run-a', stepId: 'review' });
    fireEvent.click(screen.getByTestId('notify-chip'));
    fireEvent.click(within(trayRow('compose-gate')).getByTestId('notify-row-action'));
    expect(nav.openGate).toHaveBeenCalledWith('flow-1:design:1');
    fireEvent.click(screen.getByTestId('notify-chip'));
    fireEvent.click(within(trayRow('attention')).getByTestId('notify-row-action'));
    expect(onNavigate).toHaveBeenCalledWith('cadence');
    expect(nav.openRoom).toHaveBeenCalledTimes(1);
    expect(nav.openGate).toHaveBeenCalledTimes(1);
    expect(onOpenFleet).not.toHaveBeenCalled();
    expect(s.posts).toEqual([]);
  }],
  ['sidebar row click opens the same room as the tray', async () => {
    const s = fakeServer();
    const { nav, onViewChange } = mount();
    await ready();
    publishBoth();
    await waitFor(() => expect(listRows()).toHaveLength(3));
    const byKind = (k) => listRows().find((r) => r.getAttribute('data-kind') === k);
    fireEvent.click(byKind('stratum-gate'));
    expect(nav.openRoom).toHaveBeenCalledWith('stratum', { kind: 'gates', runId: 'run-a', stepId: 'review' });
    fireEvent.click(byKind('compose-gate'));
    expect(nav.openGate).toHaveBeenCalledWith('flow-1:design:1');
    fireEvent.click(byKind('attention'));
    expect(onViewChange).toHaveBeenCalledWith('cadence');
    expect(s.posts).toEqual([]);
  }],
  ['a Stratum read that fails keeps its last rows and the list names "stratum gates", never "nothing needs attention"', async () => {
    fakeServer({ alerts: [] });
    mount();
    await ready();
    await act(async () => {
      await pollStratumGates({ client: { listGates: async () => { throw new Error('HTTP 502'); } }, sink: attentionSink, warn: () => {} });
    });
    await waitFor(() => expect(screen.getByTestId('needs-attention-unknown').textContent).toBe('Could not read: stratum gates'));
    expect(screen.queryAllByTestId('needs-attention-row')).toHaveLength(0);
    expect(screen.getByTestId('notify-chip').getAttribute('data-state')).toBe('unknown');
    await act(async () => {
      await pollStratumGates({ client: { listGates: async () => [PG] }, sink: attentionSink, warn: () => {} });
      await pollStratumGates({ client: { listGates: async () => { throw new Error('HTTP 502'); } }, sink: attentionSink, warn: () => {} });
    });
    await waitFor(() => expect(listRows().map((r) => r.getAttribute('data-key'))).toEqual(['stratum-gate:run-a:review']));
    expect(screen.getByTestId('needs-attention-unknown').textContent).toBe('Also unavailable: stratum gates');
  }],
  ['a disconnected store names "compose gates"; with nothing waiting and every source up, no list at all', async () => {
    fakeServer({ alerts: [] });
    mount();
    await ready();
    expect(screen.queryByTestId('needs-attention')).toBeNull();
    act(() => { publishComposeGates(attentionSink, { gates: [], connected: false }); });
    await waitFor(() => expect(screen.getByTestId('needs-attention-unknown').textContent).toBe('Could not read: compose gates'));
  }],
];

describe('COMP-SUBAPP-ATTENTION-1: gates in the inbox and the sidebar', () => {
  beforeEach(() => {
    resetFleetPoller(); resetNotifyPoller(); resetNotifyState();
    attentionSink.publish(STRATUM_SOURCE, []);
    attentionSink.publish(COMPOSE_SOURCE, []);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it.each(ROWS)('%s', async (_name, scenario) => { await scenario(); });
});
