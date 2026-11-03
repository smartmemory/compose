/**
 * COMP-SUBAPP-ATTENTION-FU-2: the App-level wiring of the two gate publishers, on the real App, the real vision store and the
 * real host attention sink. Stratum's availability and client are faked at their module boundary, `fetch` answers
 * `/api/workspace` with a workspace id the test sets, and `WebSocket` is a stub that never connects (the test drives the
 * store's `connected` and `gates` the way its socket handlers do). Pins: the poller starts only on 'yes'; a built Stratum
 * whose check is 'unknown' is published unavailable, so the chip never says "All clear"; the Compose publish carries the
 * workspace and answers only after that workspace's first hydrate. Nothing here resolves or dismisses a gate.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, waitFor, act, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => {
  const listeners = new Set();
  const avail = { value: 'unknown', built: true };
  return {
    avail,
    setAvail: (v) => { avail.value = v; for (const fn of listeners) fn(); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    listGates: null,
    workspaceId: 'ws-a',
  };
});

vi.mock('../../src/components/cockpit/useStratumUiAvailable.js', async (orig) => {
  const real = await orig();
  const { useSyncExternalStore } = await import('react');
  const useStratumUiAvailability = () => useSyncExternalStore(h.subscribe, () => h.avail.value);
  return { ...real, useStratumUiAvailability, stratumUiBuilt: () => h.avail.built, default: () => useStratumUiAvailability() === 'yes' };
});
vi.mock('../../src/lib/clients/stratum.js', async (orig) => ({
  ...(await orig()),
  createStratumDataClient: () => ({ listGates: (...a) => h.listGates(...a) }),
}));

class StubSocket { constructor() { this.readyState = 0; } close() {} send() {} addEventListener() {} removeEventListener() {} }
vi.stubGlobal('WebSocket', StubSocket);
globalThis.fetch = vi.fn(async (url) => {
  if (String(url).includes('/api/workspace')) return { ok: true, status: 200, json: async () => ({ id: h.workspaceId, root: `/w/${h.workspaceId}` }), text: async () => '' };
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
});

const { default: App } = await import('../../src/App.jsx');
const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
const { attentionSink } = await import('../../src/components/cockpit/subappHost.js');
const { STRATUM_LABEL, COMPOSE_LABEL, STRATUM_SOURCE, COMPOSE_SOURCE } = await import('../../src/components/cockpit/notify/gatePublishers.js');
const { collect, chipState } = await import('../../src/components/cockpit/notify/notifyLogic.js');
const { releaseKeys } = await import('../../src/components/cockpit/notify/notifyState.js');

const up = (value) => ({ value, error: null });
const FLEET = { sources: { sm_status: up({ queue: up([]), sessions: up([]), df: up({ free_gb: 500 }) }) } };
const ALL = { fleet: FLEET, outage: up({ state: 'ok' }), attention: up({ alerts: [] }), review: up({ reviewMaxH: 24, inReview: [] }) };
const collected = (state = null) => collect({ ...ALL, sink: attentionSink.readState() }, Date.now(), state);
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const cg = (flowId, stepId) => ({ id: `${flowId}:${stepId}:1`, flowId, stepId, round: 1, itemId: 'item-1', status: 'pending', createdAt: ago(120) });
const answeredBy = (source) => attentionSink.readState().answered.find((a) => a.source === source) ?? null;

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  attentionSink.retire(STRATUM_SOURCE);
  attentionSink.retire(COMPOSE_SOURCE);
  useVisionStore.setState({ connected: false, gates: useVisionStore.getInitialState().gates });
});

describe('COMP-SUBAPP-ATTENTION-FU-2: App wires the gate publishers', () => {
  it('F3: a built Stratum whose check is unknown is "stratum gates" unknown, never "All clear"; the poller starts only on yes, and no is silent', async () => {
    h.listGates = vi.fn(async () => []);
    h.avail.built = true;
    h.setAvail('unknown');
    render(<App />);
    await waitFor(() => expect(attentionSink.readState().unavailable).toContain(STRATUM_LABEL));
    expect(h.listGates).not.toHaveBeenCalled();
    expect(chipState(collected()).state).not.toBe('all-clear');
    act(() => h.setAvail('yes'));
    await waitFor(() => expect(h.listGates).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(answeredBy(STRATUM_SOURCE)).not.toBeNull());
    expect(attentionSink.readState().unavailable).not.toContain(STRATUM_LABEL);
    act(() => h.setAvail('no'));
    await waitFor(() => expect(answeredBy(STRATUM_SOURCE)).toBeNull());
    expect(attentionSink.readState().unavailable).not.toContain(STRATUM_LABEL);
  }, 30000);

  it('a stub build (not built) publishes nothing for Stratum while its check is unknown', async () => {
    h.listGates = vi.fn(async () => []);
    h.avail.built = false;
    h.setAvail('unknown');
    render(<App />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(attentionSink.readState().unavailable).not.toContain(STRATUM_LABEL);
    expect(h.listGates).not.toHaveBeenCalled();
    h.avail.built = true;
  }, 30000);

  it('the Compose publish carries the workspace and answers only after its first hydrate; a switch never answers for the old project', async () => {
    h.listGates = vi.fn(async () => []);
    h.setAvail('no');
    h.workspaceId = 'ws-a';
    render(<App />);
    await waitFor(() => expect(attentionSink.readState().unavailable).toContain(COMPOSE_LABEL)); // not connected yet
    act(() => useVisionStore.setState({ connected: true }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(attentionSink.readState().unavailable).toContain(COMPOSE_LABEL); // connected, no hydrate yet: not an answer
    expect(answeredBy(COMPOSE_SOURCE)).toBeNull();
    act(() => useVisionStore.setState({ gates: [cg('flowA', 'design')] })); // the hydrate
    await waitFor(() => expect(answeredBy(COMPOSE_SOURCE)?.scope).toBe('ws-a'));
    const [row] = attentionSink.read();
    expect(row.key).toBe('compose-gate:ws-a:flowA:design:1');
    const state = { v: 1, entries: { [row.key]: { action: 'dismiss', at: ago(1) } } };
    // The switch: the old server closes the socket, the workspace moves, the new socket opens and hydrates project B.
    act(() => useVisionStore.setState({ connected: false }));
    h.workspaceId = 'ws-b';
    act(() => useVisionStore.setState({ connected: true }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(attentionSink.readState().unavailable).toContain(COMPOSE_LABEL); // project A's list is still in the store: no answer
    expect(releaseKeys(collected(state), state, null)).toEqual([]);
    act(() => useVisionStore.setState({ gates: [] })); // project B's hydrate
    await waitFor(() => expect(answeredBy(COMPOSE_SOURCE)?.scope).toBe('ws-b'));
    expect(attentionSink.readState().unavailable).not.toContain(COMPOSE_LABEL);
    expect(releaseKeys(collected(state), state, null)).toEqual([]); // B's empty list is no answer for A's dismissal
  }, 30000);
});
