/**
 * COMP-MOBILE-1 Coverage Sweep
 *
 * Locking regression tests for the 4 Codex review findings fixed in 87ecced,
 * plus secondary edge-case coverage that the existing suites don't reach.
 *
 * Priority targets (must not regress):
 *  P1 - useBuildHistory: corrective alert fires via the 2.5s retry path (not just first fetch)
 *  P2 - createItem: direct-item POST response (no {item} wrapper) + WS-snapshot dedup
 *  P3 - visionState snapshot mid-flight: in-flight create survives / in-flight delete stays removed
 *  P4 - BuildDetailView + BuildCard abort disabled when status === 'complete'
 *
 * Secondary targets:
 *  S1 - useMonitorEvents: flowId change / repeated-status / aborted non-alert
 *  S2 - mergePipelineSteps: undefined liveSteps + unknown currentStepId + duplicate id
 *  S3 - ItemDetailSheet: deleteArmed disarms on other-field interaction
 *  S4 - Connection direction: ← vs → arrows
 *  S5 - MobileAlertBar: tap navigates and dismisses
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { renderHook, act as hookAct } from '@testing-library/react';

import { setSensitiveToken } from '../../src/lib/compose-api.js';
import { useBuildHistory } from '../../src/mobile/hooks/useBuildHistory.js';
import { useRoadmapItems } from '../../src/mobile/hooks/useRoadmapItems.js';
import useMonitorEvents from '../../src/mobile/hooks/useMonitorEvents.js';
import { mergePipelineSteps, PIPELINE_STEPS } from '../../src/lib/pipeline-steps.js';
import BuildDetailView from '../../src/mobile/components/BuildDetailView.jsx';
import BuildCard from '../../src/mobile/components/BuildCard.jsx';
import MobileAlertBar from '../../src/mobile/components/MobileAlertBar.jsx';
import RoadmapTab from '../../src/mobile/tabs/RoadmapTab.jsx';

// ─── Common WebSocket + EventSource stubs ─────────────────────────────────────

let capturedWS = null;

class CaptureWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    capturedWS = this;
    CaptureWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
}
CaptureWS.instances = [];

class FakeEventSource {
  constructor(url) { this.url = url; this.readyState = 0; FakeEventSource.instances.push(this); }
  addEventListener() {}
  close() { this.readyState = 2; }
  set onopen(_) {}
  set onmessage(_) {}
  set onerror(_) {}
}
FakeEventSource.instances = [];

beforeEach(() => {
  capturedWS = null;
  CaptureWS.instances = [];
  FakeEventSource.instances = [];
  globalThis.WebSocket = CaptureWS;
  globalThis.EventSource = FakeEventSource;
  setSensitiveToken('test-token');
});

afterEach(() => {
  setSensitiveToken(null);
  vi.restoreAllMocks();
});

// ─── P1: useBuildHistory — corrective alert fires via 2.5s retry path ────────
// This specifically tests the bugfix in 87ecced: processList is shared so the
// health-gate alert check also runs when the retry fetch settles (not only first fetch).

describe('P1: useBuildHistory corrective alert via 2.5s retry path', () => {
  let fetchCalls;

  function HookHarness({ active }) {
    const { builds, loading } = useBuildHistory({ active });
    return (
      <div>
        <span data-testid="loading">{loading ? 'loading' : 'done'}</span>
        <span data-testid="count">{builds.length}</span>
      </div>
    );
  }

  it('fires corrective alert when the failed history row only appears in the 2.5s retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const dispatchedEvents = [];
    vi.spyOn(window, 'dispatchEvent').mockImplementation((evt) => {
      if (evt?.type === 'compose:notify') dispatchedEvents.push(evt.detail ?? {});
    });

    fetchCalls = [];
    let buildsCalls = 0;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      fetchCalls.push({ url: u });
      if (u.includes('/api/builds')) {
        buildsCalls++;
        if (buildsCalls <= 2) {
          // mount fetch + first terminal-triggered fetch: both return empty
          return new Response(JSON.stringify({ builds: [] }), { status: 200 });
        }
        // 2.5s retry: returns the failed entry
        return new Response(JSON.stringify({
          builds: [{ flowId: 'f-retry', featureCode: 'RETRY-X', status: 'failed' }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const { rerender } = render(
      <HookHarness active={{ flowId: 'f-retry', featureCode: 'RETRY-X', status: 'running' }} />
    );

    // Drain mount fetch
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.runAllTicks(); });

    // Transition to terminal 'complete' (active-build side)
    await act(async () => {
      rerender(<HookHarness active={{ flowId: 'f-retry', featureCode: 'RETRY-X', status: 'complete' }} />);
    });

    // Drain terminal-triggered first fetch (returns empty)
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { vi.runAllTicks(); });

    // 2.5s retry timer fires
    await act(async () => { vi.advanceTimersByTime(2600); });

    // Drain retry fetch
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    act(() => { vi.runAllTicks(); });

    const alerts = dispatchedEvents.filter(d => d?.message?.includes('post-checks'));
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].level).toBe('error');
    expect(alerts[0].message).toContain('RETRY-X');

    vi.useRealTimers();
  }, 15000);
});

// ─── P2: createItem — direct-item response (no {item} wrapper) ────────────────
// Bugfix: `const serverItem = data?.item || (data?.id ? data : null)`

describe('P2: createItem handles direct-item POST response (no {item} wrapper)', () => {
  const BASE_ITEMS = [{ id: 'existing-1', title: 'Existing', status: 'planned' }];

  beforeEach(() => {
    setSensitiveToken('tok-p2');
  });

  afterEach(() => {
    setSensitiveToken(null);
  });

  it('swaps tmp-id row to server id when POST returns item directly (no {item} wrapper)', async () => {
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u === '/api/vision/items' && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      }
      if (u === '/api/vision/items' && opts.method === 'POST') {
        // Return the item DIRECTLY — no { item: ... } wrapper (server's actual contract)
        const body = JSON.parse(opts.body);
        return { ok: true, status: 201, json: async () => ({ id: 'direct-server-id', ...body }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { result } = renderHook(() => useRoadmapItems());

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    let createResult;
    await hookAct(async () => {
      createResult = await result.current.createItem({ title: 'Direct item' });
    });

    expect(createResult.ok).toBe(true);
    expect(result.current.items.some(i => i.id === 'direct-server-id')).toBe(true);
    expect(result.current.items.some(i => String(i.id).startsWith('tmp-'))).toBe(false);
  });

  it('drops tmp row without duplicate when visionState snapshot already contains the server item', async () => {
    let resolvePost;
    const serverItem = { id: 'ws-delivered-id', title: 'New item', type: 'feature' };

    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u === '/api/vision/items' && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      }
      if (u === '/api/vision/items' && opts.method === 'POST') {
        // Stall — resolve after WS snapshot arrives
        return new Promise(resolve => {
          resolvePost = () => resolve({
            ok: true, status: 201,
            json: async () => serverItem,  // direct, no wrapper
          });
        });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // Kick off createItem (in-flight, does not await)
    let createPromise;
    hookAct(() => {
      createPromise = result.current.createItem({ title: 'New item' });
    });

    // Wait a tick for optimistic prepend
    await new Promise(r => setTimeout(r, 15));

    // tmp row should be present
    expect(result.current.items.some(i => String(i.id).startsWith('tmp-'))).toBe(true);

    // WS snapshot arrives with the server item already in it
    await hookAct(async () => {
      capturedWS?.onmessage?.({
        data: JSON.stringify({
          type: 'visionState',
          items: [BASE_ITEMS[0], serverItem],
        }),
      });
    });

    // Settle the POST
    await hookAct(async () => {
      resolvePost?.();
      await createPromise;
    });

    // Exactly 2 items: existing + server item — no duplicate, no tmp
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items.filter(i => i.id === 'ws-delivered-id')).toHaveLength(1);
    expect(result.current.items.some(i => String(i.id).startsWith('tmp-'))).toBe(false);
  });
});

// ─── P3: visionState snapshot mid-flight: in-flight create + delete ───────────
// Bugfix: 87ecced added pendingCreatesRef/pendingDeletesRef to snapshot overlay.

describe('P3: visionState snapshot mid-flight — in-flight create and delete survive', () => {
  const BASE_ITEMS = [
    { id: 'keep-1', title: 'Keep', status: 'planned' },
    { id: 'del-1', title: 'To delete', status: 'planned' },
  ];

  beforeEach(() => {
    setSensitiveToken('tok-p3');
  });

  afterEach(() => {
    setSensitiveToken(null);
  });

  it('in-flight create item still appears after visionState snapshot without it', async () => {
    let resolvePost;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u === '/api/vision/items' && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      }
      if (u === '/api/vision/items' && opts.method === 'POST') {
        return new Promise(resolve => {
          resolvePost = () => resolve({
            ok: true, status: 201,
            json: async () => ({ item: { id: 'new-srv', title: 'New item', type: 'feature' } }),
          });
        });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    // Start create (in-flight)
    let createPromise;
    hookAct(() => {
      createPromise = result.current.createItem({ title: 'New item' });
    });
    await new Promise(r => setTimeout(r, 15));

    // Snapshot arrives WITHOUT the new item
    await hookAct(async () => {
      capturedWS?.onmessage?.({
        data: JSON.stringify({ type: 'visionState', items: BASE_ITEMS }),
      });
    });

    // Optimistic item must still be listed
    expect(result.current.items.some(i => String(i.id).startsWith('tmp-'))).toBe(true);
    expect(result.current.items.length).toBeGreaterThanOrEqual(3);

    // Settle POST
    await hookAct(async () => { resolvePost?.(); await createPromise; });
  });

  it('in-flight delete stays removed after visionState snapshot containing the deleted item', async () => {
    let resolveDelete;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u === '/api/vision/items' && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      }
      if (u.includes('/api/vision/items/') && opts.method === 'DELETE') {
        return new Promise(resolve => {
          resolveDelete = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    // Start delete (in-flight)
    let deletePromise;
    hookAct(() => {
      deletePromise = result.current.deleteItem('del-1');
    });
    await new Promise(r => setTimeout(r, 15));

    // del-1 should be gone optimistically
    expect(result.current.items.some(i => i.id === 'del-1')).toBe(false);

    // Snapshot arrives WITH del-1 still in it (server hasn't processed delete yet)
    await hookAct(async () => {
      capturedWS?.onmessage?.({
        data: JSON.stringify({ type: 'visionState', items: BASE_ITEMS }),
      });
    });

    // del-1 must STILL be removed — pending delete survives snapshot
    expect(result.current.items.some(i => i.id === 'del-1')).toBe(false);

    // Settle DELETE
    await hookAct(async () => { resolveDelete?.(); await deletePromise; });
  });
});

// ─── P4: abort button disabled when status === 'complete' ─────────────────────
// Bugfix: stale local isTerminal (missing 'complete') replaced with
// shared isTerminalBuildStatus in both BuildDetailView and BuildCard.

describe("P4: abort button disabled for status === 'complete'", () => {
  const activeBase = {
    featureCode: 'COMP-X',
    flowId: 'flow-1',
    mode: 'feature',
    steps: [],
    currentStepId: null,
    startedAt: new Date().toISOString(),
  };

  it("BuildDetailView abort is disabled when status is 'complete'", () => {
    render(<BuildDetailView active={{ ...activeBase, status: 'complete' }} onClose={() => {}} onAbort={() => {}} />);
    expect(screen.getByTestId('mobile-build-detail-abort').disabled).toBe(true);
  });

  it("BuildCard abort is disabled when status is 'complete'", () => {
    render(<BuildCard active={{ ...activeBase, status: 'complete' }} onOpen={() => {}} onAbort={() => {}} aborting={false} />);
    expect(screen.getByTestId('mobile-build-abort').disabled).toBe(true);
  });

  it("BuildDetailView abort is enabled when status is 'running'", () => {
    render(<BuildDetailView active={{ ...activeBase, status: 'running' }} onClose={() => {}} onAbort={() => {}} />);
    expect(screen.getByTestId('mobile-build-detail-abort').disabled).toBe(false);
  });

  it("BuildCard abort is enabled when status is 'running'", () => {
    render(<BuildCard active={{ ...activeBase, status: 'running' }} onOpen={() => {}} onAbort={() => {}} aborting={false} />);
    expect(screen.getByTestId('mobile-build-abort').disabled).toBe(false);
  });

  it.each(['completed', 'failed', 'aborted', 'killed', 'done'])(
    "BuildCard abort is disabled when status is '%s'",
    (status) => {
      render(<BuildCard active={{ ...activeBase, status }} onOpen={() => {}} onAbort={() => {}} aborting={false} />);
      expect(screen.getByTestId('mobile-build-abort').disabled).toBe(true);
    }
  );

  it.each(['completed', 'failed', 'aborted', 'killed', 'done'])(
    "BuildDetailView abort is disabled when status is '%s'",
    (status) => {
      render(<BuildDetailView active={{ ...activeBase, status }} onClose={() => {}} onAbort={() => {}} />);
      expect(screen.getByTestId('mobile-build-detail-abort').disabled).toBe(true);
    }
  );
});

// ─── S1: useMonitorEvents — flowId change / repeated-status / aborted ─────────

describe('S1: useMonitorEvents edge cases', () => {
  it('new flowId triggers alert independently of old flowId status', async () => {
    const notifyEvents = [];
    const handler = (e) => notifyEvents.push(e.detail);
    window.addEventListener('compose:notify', handler);

    const { rerender } = renderHook(
      ({ active }) => useMonitorEvents({ active, gates: [], items: [] }),
      { initialProps: { active: { flowId: 'f-old', featureCode: 'COMP-OLD', status: 'complete' } } }
    );

    await new Promise(r => setTimeout(r, 20));
    const countBefore = notifyEvents.length;

    // New build, different flowId: running → failed
    act(() => {
      rerender({ active: { flowId: 'f-new', featureCode: 'COMP-NEW', status: 'running' } });
    });
    act(() => {
      rerender({ active: { flowId: 'f-new', featureCode: 'COMP-NEW', status: 'failed' } });
    });

    await waitFor(() => {
      const newAlerts = notifyEvents.slice(countBefore);
      expect(newAlerts.some(e => e.level === 'error' && e.message.includes('COMP-NEW'))).toBe(true);
    });

    window.removeEventListener('compose:notify', handler);
  });

  it('same flowId does not re-alert on repeated same status', async () => {
    const notifyEvents = [];
    const handler = (e) => notifyEvents.push(e.detail);
    window.addEventListener('compose:notify', handler);

    const { rerender } = renderHook(
      ({ active }) => useMonitorEvents({ active, gates: [], items: [] }),
      { initialProps: { active: { flowId: 'f-stable', featureCode: 'COMP-S', status: 'running' } } }
    );

    // First transition: running → failed
    act(() => {
      rerender({ active: { flowId: 'f-stable', featureCode: 'COMP-S', status: 'failed' } });
    });

    await waitFor(() => {
      expect(notifyEvents.some(e => e.level === 'error' && e.message.includes('COMP-S'))).toBe(true);
    });
    const countAfterFirst = notifyEvents.length;

    // Re-render with same status — should NOT fire again
    act(() => {
      rerender({ active: { flowId: 'f-stable', featureCode: 'COMP-S', status: 'failed' } });
    });
    await new Promise(r => setTimeout(r, 30));

    expect(notifyEvents.length).toBe(countAfterFirst);

    window.removeEventListener('compose:notify', handler);
  });

  it("'aborted' terminal transition fires no build-failed or build-complete alert", async () => {
    const notifyEvents = [];
    const handler = (e) => notifyEvents.push(e.detail);
    window.addEventListener('compose:notify', handler);

    const { rerender } = renderHook(
      ({ active }) => useMonitorEvents({ active, gates: [], items: [] }),
      { initialProps: { active: { flowId: 'f-ab', featureCode: 'COMP-AB', status: 'running' } } }
    );

    act(() => {
      rerender({ active: { flowId: 'f-ab', featureCode: 'COMP-AB', status: 'aborted' } });
    });

    await new Promise(r => setTimeout(r, 30));

    const buildAlerts = notifyEvents.filter(e =>
      e.message?.includes('COMP-AB') && (e.level === 'error' || e.level === 'info')
    );
    expect(buildAlerts).toHaveLength(0);

    window.removeEventListener('compose:notify', handler);
  });
});

// ─── S2: mergePipelineSteps — edge cases ─────────────────────────────────────

describe('S2: mergePipelineSteps additional edge cases', () => {
  it('handles undefined liveSteps gracefully (returns full template)', () => {
    const merged = mergePipelineSteps(PIPELINE_STEPS, undefined, null);
    expect(merged).toHaveLength(24);
    expect(merged[0].status).toBeUndefined();
  });

  it('handles unknown currentStepId without throwing', () => {
    expect(() => mergePipelineSteps(PIPELINE_STEPS, [], 'nonexistent_step_id')).not.toThrow();
    const merged = mergePipelineSteps(PIPELINE_STEPS, [], 'nonexistent_step_id');
    expect(merged).toHaveLength(24);
    // No step should be marked active (none matched)
    expect(merged.every(s => s.status !== 'active')).toBe(true);
  });

  it('when duplicate ids in liveSteps, last entry wins (right-spread merge)', () => {
    const liveSteps = [
      { id: 'explore_design', status: 'done' },
      { id: 'explore_design', status: 'failed' },
    ];
    const merged = mergePipelineSteps(PIPELINE_STEPS, liveSteps, null);
    const step = merged.find(s => s.id === 'explore_design');
    expect(step.status).toBe('failed');
  });

  it('both currentStepId active and done live step: terminal live status wins over active', () => {
    // 'done' is terminal, so it should NOT be replaced by 'active'
    const liveSteps = [{ id: 'blueprint', status: 'done' }];
    const merged = mergePipelineSteps(PIPELINE_STEPS, liveSteps, 'blueprint');
    const step = merged.find(s => s.id === 'blueprint');
    expect(step.status).toBe('done');
    expect(step.status).not.toBe('active');
  });
});

// ─── S3: ItemDetailSheet deleteArmed disarms on other-field interaction ────────
// handleAnyFieldInteraction() is triggered by status/group/confidence change.

describe('S3: ItemDetailSheet deleteArmed disarms on field interaction', () => {
  const item = { id: 'COMP-X', title: 'Item X', status: 'planned', group: 'g1', confidence: 2 };
  const allItems = [item, { id: 'COMP-Y', title: 'Item Y', status: 'in_progress', group: 'g1' }];

  function sharedProps(overrides = {}) {
    return {
      items: allItems,
      loading: false,
      error: null,
      applyOptimisticEdit: vi.fn().mockResolvedValue({ ok: true }),
      createItem: vi.fn(),
      deleteItem: vi.fn().mockResolvedValue({ ok: true }),
      addConnection: vi.fn(),
      removeConnection: vi.fn(),
      fetchItemDetail: vi.fn().mockResolvedValue({ ok: true, item: { ...item, connections: [] } }),
      ...overrides,
    };
  }

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  });

  it('changing group field disarms a pending delete', async () => {
    const deleteItem = vi.fn().mockResolvedValue({ ok: true });
    render(<RoadmapTab {...sharedProps({ deleteItem })} />);

    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-X')); });
    await waitFor(() => expect(screen.getByTestId('mobile-item-sheet')).toBeTruthy());

    // Arm delete
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-sheet-delete')); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-item-sheet-delete').textContent).toMatch(/confirm/i);
    });

    // Change the group field — should disarm delete
    act(() => {
      fireEvent.change(screen.getByTestId('mobile-item-sheet-group'), {
        target: { value: 'new-group' },
      });
    });

    // Delete button should now read 'Delete' (disarmed)
    expect(screen.getByTestId('mobile-item-sheet-delete').textContent).toMatch(/^Delete$/i);
    expect(screen.getByTestId('mobile-item-sheet-delete').textContent).not.toMatch(/confirm/i);

    // A subsequent click re-arms (first tap) but does NOT call deleteItem yet
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-sheet-delete')); });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('changing status field disarms a pending delete', async () => {
    const deleteItem = vi.fn().mockResolvedValue({ ok: true });
    render(<RoadmapTab {...sharedProps({ deleteItem })} />);

    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-X')); });
    await waitFor(() => expect(screen.getByTestId('mobile-item-sheet')).toBeTruthy());

    act(() => { fireEvent.click(screen.getByTestId('mobile-item-sheet-delete')); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-item-sheet-delete').textContent).toMatch(/confirm/i);
    });

    act(() => {
      fireEvent.change(screen.getByTestId('mobile-item-sheet-status'), {
        target: { value: 'in_progress' },
      });
    });

    expect(screen.getByTestId('mobile-item-sheet-delete').textContent).not.toMatch(/confirm/i);
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('changing confidence field disarms a pending delete', async () => {
    const deleteItem = vi.fn().mockResolvedValue({ ok: true });
    render(<RoadmapTab {...sharedProps({ deleteItem })} />);

    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-X')); });
    await waitFor(() => expect(screen.getByTestId('mobile-item-sheet')).toBeTruthy());

    act(() => { fireEvent.click(screen.getByTestId('mobile-item-sheet-delete')); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-item-sheet-delete').textContent).toMatch(/confirm/i);
    });

    act(() => {
      fireEvent.change(screen.getByTestId('mobile-item-sheet-confidence'), {
        target: { value: '3' },
      });
    });

    expect(screen.getByTestId('mobile-item-sheet-delete').textContent).not.toMatch(/confirm/i);
    expect(deleteItem).not.toHaveBeenCalled();
  });
});

// ─── S4: Connection direction arrows (← vs →) ─────────────────────────────────
// isOut = conn.fromId === item.id → → ; else ←.

describe('S4: Connection direction arrows', () => {
  const item = { id: 'COMP-A', title: 'Alpha', status: 'planned', group: 'g1', confidence: 2 };
  const allItems = [
    item,
    { id: 'COMP-B', title: 'Beta', status: 'planned', group: 'g1' },
    { id: 'COMP-C', title: 'Gamma', status: 'planned', group: 'g1' },
  ];

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  });

  function tabProps(connections) {
    return {
      items: allItems,
      loading: false,
      error: null,
      applyOptimisticEdit: vi.fn().mockResolvedValue({ ok: true }),
      createItem: vi.fn(),
      deleteItem: vi.fn().mockResolvedValue({ ok: true }),
      addConnection: vi.fn(),
      removeConnection: vi.fn(),
      fetchItemDetail: vi.fn().mockResolvedValue({
        ok: true,
        item: { ...item, connections },
      }),
    };
  }

  it('renders → for outgoing connection (fromId === item.id)', async () => {
    const outConn = { id: 'c-out', fromId: 'COMP-A', toId: 'COMP-B', type: 'informs' };
    render(<RoadmapTab {...tabProps([outConn])} />);

    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });

    await waitFor(() => {
      expect(screen.getByTestId('mobile-item-conn-remove-0')).toBeTruthy();
    });

    const connRow = screen.getByTestId('mobile-item-conn-remove-0').closest('li');
    expect(connRow.textContent).toContain('→');
    expect(connRow.textContent).not.toContain('←');
    expect(connRow.textContent).toContain('Beta');
    expect(connRow.textContent).toContain('informs');
  });

  it('renders ← for incoming connection (toId === item.id)', async () => {
    // COMP-C → COMP-A: COMP-A is the target (incoming)
    const inConn = { id: 'c-in', fromId: 'COMP-C', toId: 'COMP-A', type: 'blocks' };
    render(<RoadmapTab {...tabProps([inConn])} />);

    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });

    await waitFor(() => {
      expect(screen.getByTestId('mobile-item-conn-remove-0')).toBeTruthy();
    });

    const connRow = screen.getByTestId('mobile-item-conn-remove-0').closest('li');
    expect(connRow.textContent).toContain('←');
    expect(connRow.textContent).not.toContain('→');
    expect(connRow.textContent).toContain('Gamma');
    expect(connRow.textContent).toContain('blocks');
  });
});

// ─── S5: MobileAlertBar — tap navigates and dismisses ────────────────────────

describe('S5: MobileAlertBar tap navigates and dismisses', () => {
  function dispatch(message, level = 'info', ttl = 0) {
    window.dispatchEvent(new CustomEvent('compose:notify', { detail: { message, level, ttl } }));
  }

  it('tapping a warn alert calls onNavigate with "agents" and dismisses it', async () => {
    const onNavigate = vi.fn();
    render(<MobileAlertBar onNavigate={onNavigate} />);

    act(() => { dispatch('Gate pending', 'warn', 0); });
    await waitFor(() => expect(screen.getByTestId('mobile-alert-warn')).toBeTruthy());

    act(() => { fireEvent.click(screen.getByTestId('mobile-alert-warn')); });

    expect(onNavigate).toHaveBeenCalledWith('agents');
    expect(screen.queryByTestId('mobile-alert-warn')).toBeFalsy();
  });

  it('tapping an error alert calls onNavigate with "builds"', async () => {
    const onNavigate = vi.fn();
    render(<MobileAlertBar onNavigate={onNavigate} />);

    act(() => { dispatch('Build failed', 'error', 0); });
    await waitFor(() => expect(screen.getByTestId('mobile-alert-error')).toBeTruthy());

    act(() => { fireEvent.click(screen.getByTestId('mobile-alert-error')); });

    expect(onNavigate).toHaveBeenCalledWith('builds');
    expect(screen.queryByTestId('mobile-alert-error')).toBeFalsy();
  });

  it('X button dismisses without calling onNavigate', async () => {
    const onNavigate = vi.fn();
    render(<MobileAlertBar onNavigate={onNavigate} />);

    act(() => { dispatch('Info message', 'info', 0); });
    await waitFor(() => expect(screen.getByTestId('mobile-alert-info')).toBeTruthy());

    const dismissBtn = screen.getByTestId('mobile-alert-info').querySelector('[aria-label="Dismiss"]');
    act(() => { fireEvent.click(dismissBtn); });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mobile-alert-info')).toBeFalsy();
  });
});
