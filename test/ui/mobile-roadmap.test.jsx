import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { renderHook, act as hookAct } from '@testing-library/react';
import RoadmapTab from '../../src/mobile/tabs/RoadmapTab.jsx';
import { useRoadmapItems } from '../../src/mobile/hooks/useRoadmapItems.js';
import { setSensitiveToken } from '../../src/lib/compose-api.js';
import CreateItemSheet from '../../src/mobile/components/CreateItemSheet.jsx';

const ITEMS = [
  {
    id: 'COMP-A',
    title: 'Alpha feature',
    description: 'First alpha description with KEYWORD-X.',
    status: 'planned',
    group: 'group-one',
    confidence: 3,
  },
  {
    id: 'COMP-B',
    title: 'Beta feature',
    description: 'Second beta description.',
    status: 'in_progress',
    group: 'group-two',
    confidence: 2,
  },
  {
    id: 'COMP-C',
    title: 'Gamma feature',
    description: 'Third gamma keyword-x description.',
    status: 'complete',
    group: 'group-one',
    confidence: 5,
  },
];

let mockSocket;
class MockWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    mockSocket = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

let patchCalls;
let nextPatchResponse;

function setupFetchMock() {
  patchCalls = [];
  nextPatchResponse = { ok: true, status: 200, body: () => ({ item: null }) };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (typeof url === 'string' && url.startsWith('/api/vision/items') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: ITEMS }),
      };
    }
    if (typeof url === 'string' && url.startsWith('/api/vision/items/') && opts.method === 'PATCH') {
      const id = url.split('/').pop();
      patchCalls.push({ id, body: JSON.parse(opts.body) });
      const res = nextPatchResponse;
      return {
        ok: res.ok,
        status: res.status,
        json: async () => res.body(),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

beforeEach(() => {
  globalThis.WebSocket = MockWS;
  setupFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: create a mock applyOptimisticEdit that calls through to the mock fetch
function makeMockApplyOptimisticEdit() {
  return async (id, patch) => {
    const res = await fetch(`/api/vision/items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
    const serverItem = data?.item || null;
    return { ok: true, item: serverItem };
  };
}

async function renderAndHydrate() {
  // Items come from props now (RoadmapTab lifted to shell)
  const utils = render(
    <RoadmapTab
      items={ITEMS}
      loading={false}
      error={null}
      applyOptimisticEdit={makeMockApplyOptimisticEdit()}
    />
  );
  // Items are passed directly — no async fetch needed, but wait for render to settle
  await waitFor(() => {
    expect(screen.queryByTestId('mobile-roadmap-list')).toBeTruthy();
  });
  return utils;
}

describe('<RoadmapTab>', () => {
  it('renders the list given mock items', async () => {
    await renderAndHydrate();
    expect(screen.getByTestId('mobile-item-card-COMP-A')).toBeTruthy();
    expect(screen.getByTestId('mobile-item-card-COMP-B')).toBeTruthy();
    expect(screen.getByTestId('mobile-item-card-COMP-C')).toBeTruthy();
  });

  it('filters by status', async () => {
    await renderAndHydrate();
    act(() => {
      fireEvent.click(screen.getByTestId('mobile-filter-status-in_progress'));
    });
    expect(screen.queryByTestId('mobile-item-card-COMP-A')).toBeFalsy();
    expect(screen.getByTestId('mobile-item-card-COMP-B')).toBeTruthy();
    expect(screen.queryByTestId('mobile-item-card-COMP-C')).toBeFalsy();
  });

  it('filters by group', async () => {
    await renderAndHydrate();
    act(() => {
      fireEvent.change(screen.getByTestId('mobile-filter-group'), { target: { value: 'group-one' } });
    });
    expect(screen.getByTestId('mobile-item-card-COMP-A')).toBeTruthy();
    expect(screen.queryByTestId('mobile-item-card-COMP-B')).toBeFalsy();
    expect(screen.getByTestId('mobile-item-card-COMP-C')).toBeTruthy();
  });

  it('filters by keyword (case-insensitive substring on title and description)', async () => {
    await renderAndHydrate();
    act(() => {
      fireEvent.change(screen.getByTestId('mobile-filter-keyword'), { target: { value: 'keyword-x' } });
    });
    // COMP-A description has KEYWORD-X (uppercase); COMP-C has keyword-x; COMP-B has neither.
    expect(screen.getByTestId('mobile-item-card-COMP-A')).toBeTruthy();
    expect(screen.queryByTestId('mobile-item-card-COMP-B')).toBeFalsy();
    expect(screen.getByTestId('mobile-item-card-COMP-C')).toBeTruthy();
  });

  it('shows empty state when filters yield zero matches', async () => {
    await renderAndHydrate();
    act(() => {
      fireEvent.change(screen.getByTestId('mobile-filter-keyword'), { target: { value: 'no-such-text' } });
    });
    expect(screen.getByTestId('mobile-roadmap-empty')).toBeTruthy();
  });

  it('opens detail sheet, edits group, saves with correct PATCH payload', async () => {
    nextPatchResponse = {
      ok: true,
      status: 200,
      body: () => ({ item: { id: 'COMP-A', title: 'Alpha feature', status: 'planned', group: 'new-group', confidence: 3 } }),
    };
    await renderAndHydrate();
    act(() => {
      fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A'));
    });
    expect(screen.getByTestId('mobile-item-sheet')).toBeTruthy();
    const groupInput = screen.getByTestId('mobile-item-sheet-group');
    act(() => {
      fireEvent.change(groupInput, { target: { value: 'new-group' } });
    });
    const saveBtn = screen.getByTestId('mobile-item-sheet-save');
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(patchCalls.length).toBe(1);
    });
    expect(patchCalls[0]).toEqual({ id: 'COMP-A', body: { group: 'new-group' } });
    // Sheet closes on success
    await waitFor(() => {
      expect(screen.queryByTestId('mobile-item-sheet')).toBeFalsy();
    });
  });

  it('cancel discards edits without firing PATCH', async () => {
    await renderAndHydrate();
    act(() => {
      fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A'));
    });
    const groupInput = screen.getByTestId('mobile-item-sheet-group');
    act(() => {
      fireEvent.change(groupInput, { target: { value: 'temporary' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('mobile-item-sheet-cancel'));
    });
    expect(screen.queryByTestId('mobile-item-sheet')).toBeFalsy();
    expect(patchCalls.length).toBe(0);
    // Group filter should still see original group on COMP-A
    act(() => {
      fireEvent.change(screen.getByTestId('mobile-filter-group'), { target: { value: 'group-one' } });
    });
    expect(screen.getByTestId('mobile-item-card-COMP-A')).toBeTruthy();
  });
});

// ─── S01: useRoadmapItems WS rewire + PATCH token ─────────────────────────

describe('useRoadmapItems WS rewire (S01)', () => {
  let capturedSocket;

  class CaptureMockWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      capturedSocket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  const BASE_ITEMS = [
    { id: 'i1', title: 'Item 1', status: 'planned' },
    { id: 'i2', title: 'Item 2', status: 'in_progress' },
  ];

  const UPDATED_ITEMS = [
    { id: 'i1', title: 'Item 1 updated', status: 'planned' },
    { id: 'i3', title: 'Item 3', status: 'complete' },
  ];

  let patchCalls;

  beforeEach(() => {
    setSensitiveToken('test-token');
    patchCalls = [];
    capturedSocket = null;
    globalThis.WebSocket = CaptureMockWS;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/vision/items') && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      }
      if (u.includes('/api/vision/items/') && opts.method === 'PATCH') {
        patchCalls.push({ url: u, opts });
        return { ok: true, status: 200, json: async () => ({ item: null }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
  });

  afterEach(() => {
    setSensitiveToken(null);
    vi.restoreAllMocks();
  });

  it('visionState snapshot replaces items wholesale', async () => {
    const { result } = renderHook(() => useRoadmapItems());

    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });

    await hookAct(async () => {
      capturedSocket.onmessage?.({
        data: JSON.stringify({ type: 'visionState', items: UPDATED_ITEMS }),
      });
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0].title).toBe('Item 1 updated');
    expect(result.current.items[1].id).toBe('i3');
  });

  it('hydrate snapshot replaces items wholesale', async () => {
    const { result } = renderHook(() => useRoadmapItems());

    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await hookAct(async () => {
      capturedSocket.onmessage?.({
        data: JSON.stringify({ type: 'hydrate', items: UPDATED_ITEMS }),
      });
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[1].id).toBe('i3');
  });

  it('pending optimistic edit survives a visionState snapshot mid-flight', async () => {
    const { result } = renderHook(() => useRoadmapItems());

    await waitFor(() => expect(result.current.items).toHaveLength(2));

    // Set up a stalling PATCH
    let resolveOptimistic;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/vision/items') && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      }
      if (u.includes('/api/vision/items/') && opts.method === 'PATCH') {
        return new Promise(resolve => { resolveOptimistic = resolve; });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    // Kick off optimistic edit (does not await — in-flight)
    hookAct(() => {
      result.current.applyOptimisticEdit('i1', { title: 'Optimistic title' });
    });

    // Wait a tick for optimistic update to apply
    await new Promise(r => setTimeout(r, 10));

    // Snapshot arrives while edit is in-flight
    await hookAct(async () => {
      capturedSocket.onmessage?.({
        data: JSON.stringify({ type: 'visionState', items: UPDATED_ITEMS }),
      });
    });

    // The item being edited should still show the optimistic title
    const i1 = result.current.items.find(i => i.id === 'i1');
    expect(i1?.title).toBe('Optimistic title');

    // Settle the PATCH
    resolveOptimistic({ ok: true, status: 200, json: async () => ({ item: null }) });
  });

  it('PATCH carries x-compose-token when setSensitiveToken is set', async () => {
    const { result } = renderHook(() => useRoadmapItems());

    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await hookAct(async () => {
      await result.current.applyOptimisticEdit('i1', { status: 'complete' });
    });

    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0].opts.headers['x-compose-token']).toBe('test-token');
  });
});

// ─── S03: Contract alignment ──────────────────────────────────────────────
describe('ItemDetailSheet contract alignment (S03)', () => {
  const baseItem = { id: 'COMP-A', title: 'Alpha', status: 'planned', group: '', confidence: '' };

  it('STATUS_OPTIONS does not include partial', async () => {
    render(
      <RoadmapTab
        items={[baseItem]}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { ...baseItem, connections: [] } })}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    const select = screen.getByTestId('mobile-item-sheet-status');
    const options = Array.from(select.options).map(o => o.value);
    expect(options).not.toContain('partial');
    expect(options).toContain('ready');
    expect(options).toContain('review');
  });

  it('confidence input has max=4 not max=5', async () => {
    render(
      <RoadmapTab
        items={[baseItem]}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { ...baseItem, connections: [] } })}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    const confInput = screen.getByTestId('mobile-item-sheet-confidence');
    expect(confInput.getAttribute('max')).toBe('4');
  });
});

// ─── S03: useRoadmapItems mutations ──────────────────────────────────────
describe('useRoadmapItems mutations (S03)', () => {
  const BASE_ITEMS = [
    { id: 'i1', title: 'Item 1', status: 'planned' },
    { id: 'i2', title: 'Item 2', status: 'in_progress' },
  ];

  let calls;

  class CaptureMockWS2 {
    constructor(url) {
      this.url = url; this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send() {} close() { this.readyState = 3; this.onclose?.(); }
  }

  beforeEach(() => {
    setSensitiveToken('tok-s03');
    calls = [];
    globalThis.WebSocket = CaptureMockWS2;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers, body: opts.body });

      if (u === '/api/vision/items' && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      }
      if (u === '/api/vision/items' && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        return { ok: true, status: 201, json: async () => ({ item: { ...body, id: 'server-new-id' } }) };
      }
      if (u.match(/\/api\/vision\/items\/.+/) && opts.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u === '/api/vision/connections' && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        return { ok: true, status: 201, json: async () => ({ connection: { id: 'conn-1', ...body } }) };
      }
      if (u.match(/\/api\/vision\/connections\/.+/) && opts.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.match(/\/api\/vision\/items\/.+/) && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ id: 'i1', title: 'Item 1', status: 'planned', connections: [{ id: 'c1', fromId: 'i1', toId: 'i2', type: 'informs' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
  });

  afterEach(() => {
    setSensitiveToken(null);
    vi.restoreAllMocks();
  });

  it('createItem sends POST with type:feature and x-compose-token; item appears optimistically', async () => {
    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    let createResult;
    await hookAct(async () => {
      createResult = await result.current.createItem({ title: 'New item' });
    });

    expect(createResult.ok).toBe(true);
    const postCall = calls.find(c => c.url === '/api/vision/items' && c.method === 'POST');
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall.body);
    expect(body.type).toBe('feature');
    expect(postCall.headers['x-compose-token']).toBe('tok-s03');
    // Server id was swapped in
    expect(result.current.items.some(i => i.id === 'server-new-id')).toBe(true);
    // Temp id was removed
    expect(result.current.items.some(i => String(i.id).startsWith('tmp-'))).toBe(false);
  });

  it('createItem rolls back on 500', async () => {
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u === '/api/vision/items' && (!opts.method || opts.method === 'GET'))
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      if (u === '/api/vision/items' && opts.method === 'POST')
        return { ok: false, status: 500, json: async () => ({ error: 'Server error' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    let createResult;
    await hookAct(async () => {
      createResult = await result.current.createItem({ title: 'Doomed item' });
    });

    expect(createResult.ok).toBe(false);
    // Items should be back to BASE_ITEMS length
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items.every(i => !String(i.id).startsWith('tmp-'))).toBe(true);
  });

  it('deleteItem fires DELETE with token and removes item', async () => {
    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    let deleteResult;
    await hookAct(async () => {
      deleteResult = await result.current.deleteItem('i1');
    });

    expect(deleteResult.ok).toBe(true);
    const deleteCall = calls.find(c => c.url === '/api/vision/items/i1' && c.method === 'DELETE');
    expect(deleteCall).toBeTruthy();
    expect(deleteCall.headers['x-compose-token']).toBe('tok-s03');
    expect(result.current.items.some(i => i.id === 'i1')).toBe(false);
  });

  it('deleteItem rollback on 500 restores item', async () => {
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u === '/api/vision/items' && (!opts.method || opts.method === 'GET'))
        return { ok: true, status: 200, json: async () => ({ items: BASE_ITEMS }) };
      if (u.includes('/api/vision/items/') && opts.method === 'DELETE')
        return { ok: false, status: 500, json: async () => ({ error: 'fail' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    let deleteResult;
    await hookAct(async () => {
      deleteResult = await result.current.deleteItem('i1');
    });

    expect(deleteResult.ok).toBe(false);
    expect(result.current.items.some(i => i.id === 'i1')).toBe(true);
  });

  it('addConnection posts {fromId, toId, type} with token', async () => {
    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    let connResult;
    await hookAct(async () => {
      connResult = await result.current.addConnection({ fromId: 'i1', toId: 'i2', type: 'informs' });
    });

    expect(connResult.ok).toBe(true);
    const postCall = calls.find(c => c.url === '/api/vision/connections' && c.method === 'POST');
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall.body);
    expect(body).toEqual({ fromId: 'i1', toId: 'i2', type: 'informs' });
    expect(postCall.headers['x-compose-token']).toBe('tok-s03');
  });

  it('removeConnection DELETEs with token', async () => {
    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    let removeResult;
    await hookAct(async () => {
      removeResult = await result.current.removeConnection('conn-xyz');
    });

    expect(removeResult.ok).toBe(true);
    const delCall = calls.find(c => c.url === '/api/vision/connections/conn-xyz' && c.method === 'DELETE');
    expect(delCall).toBeTruthy();
    expect(delCall.headers['x-compose-token']).toBe('tok-s03');
  });

  it('fetchItemDetail returns item with connections', async () => {
    const { result } = renderHook(() => useRoadmapItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    let detailResult;
    await hookAct(async () => {
      detailResult = await result.current.fetchItemDetail('i1');
    });

    expect(detailResult.ok).toBe(true);
    expect(detailResult.item.id).toBe('i1');
    expect(Array.isArray(detailResult.item.connections)).toBe(true);
    expect(detailResult.item.connections[0].type).toBe('informs');
  });
});

// ─── S03: CreateItemSheet component ──────────────────────────────────────
describe('CreateItemSheet (S03)', () => {
  it('does not render when open=false', () => {
    render(<CreateItemSheet open={false} onCreate={vi.fn()} onClose={vi.fn()} groupOptions={[]} />);
    expect(screen.queryByTestId('mobile-create-sheet')).toBeFalsy();
  });

  it('renders when open=true with all required fields', () => {
    render(<CreateItemSheet open={true} onCreate={vi.fn()} onClose={vi.fn()} groupOptions={['g1']} />);
    expect(screen.getByTestId('mobile-create-sheet')).toBeTruthy();
    expect(screen.getByTestId('mobile-create-title')).toBeTruthy();
    expect(screen.getByTestId('mobile-create-desc')).toBeTruthy();
    expect(screen.getByTestId('mobile-create-group')).toBeTruthy();
    expect(screen.getByTestId('mobile-create-status')).toBeTruthy();
    expect(screen.getByTestId('mobile-create-confidence')).toBeTruthy();
    expect(screen.getByTestId('mobile-create-submit')).toBeTruthy();
    expect(screen.getByTestId('mobile-create-cancel')).toBeTruthy();
  });

  it('submit button disabled when title empty', () => {
    render(<CreateItemSheet open={true} onCreate={vi.fn()} onClose={vi.fn()} groupOptions={[]} />);
    expect(screen.getByTestId('mobile-create-submit').disabled).toBe(true);
  });

  it('submit button enabled once title is filled', () => {
    render(<CreateItemSheet open={true} onCreate={vi.fn()} onClose={vi.fn()} groupOptions={[]} />);
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-title'), { target: { value: 'New feature' } }); });
    expect(screen.getByTestId('mobile-create-submit').disabled).toBe(false);
  });

  it('calls onCreate with correct fields', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CreateItemSheet open={true} onCreate={onCreate} onClose={vi.fn()} groupOptions={['g1']} />);
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-title'), { target: { value: 'My feature' } }); });
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-desc'), { target: { value: 'A description' } }); });
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-group'), { target: { value: 'g1' } }); });
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-status'), { target: { value: 'ready' } }); });
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-confidence'), { target: { value: '3' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('mobile-create-submit')); });
    expect(onCreate).toHaveBeenCalledWith({
      title: 'My feature',
      description: 'A description',
      group: 'g1',
      status: 'ready',
      confidence: 3,
    });
  });

  it('shows inline error when onCreate rejects', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('Server down'));
    render(<CreateItemSheet open={true} onCreate={onCreate} onClose={vi.fn()} groupOptions={[]} />);
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-title'), { target: { value: 'Fail' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('mobile-create-submit')); });
    expect(screen.getByTestId('mobile-create-error')).toBeTruthy();
    expect(screen.getByTestId('mobile-create-error').textContent).toContain('Server down');
  });

  it('calls onClose on cancel', () => {
    const onClose = vi.fn();
    render(<CreateItemSheet open={true} onCreate={vi.fn()} onClose={onClose} groupOptions={[]} />);
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-title'), { target: { value: 'Something' } }); });
    act(() => { fireEvent.click(screen.getByTestId('mobile-create-cancel')); });
    expect(onClose).toHaveBeenCalled();
  });

  it('status select does not include partial', () => {
    render(<CreateItemSheet open={true} onCreate={vi.fn()} onClose={vi.fn()} groupOptions={[]} />);
    const select = screen.getByTestId('mobile-create-status');
    const options = Array.from(select.options).map(o => o.value);
    expect(options).not.toContain('partial');
    expect(options).toContain('ready');
  });

  it('confidence max is 4', () => {
    render(<CreateItemSheet open={true} onCreate={vi.fn()} onClose={vi.fn()} groupOptions={[]} />);
    expect(screen.getByTestId('mobile-create-confidence').getAttribute('max')).toBe('4');
  });
});

// ─── S03: RoadmapTab FAB + create flow ───────────────────────────────────
describe('RoadmapTab FAB and create flow (S03)', () => {
  const BASE_ITEMS = [
    { id: 'i1', title: 'Item 1', status: 'planned', group: 'g1' },
  ];

  it('has a FAB button', async () => {
    render(
      <RoadmapTab
        items={BASE_ITEMS}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { id: 'i1', connections: [] } })}
      />
    );
    expect(screen.getByTestId('mobile-roadmap-fab')).toBeTruthy();
  });

  it('FAB opens CreateItemSheet', async () => {
    render(
      <RoadmapTab
        items={BASE_ITEMS}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { id: 'i1', connections: [] } })}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-roadmap-fab')); });
    expect(screen.getByTestId('mobile-create-sheet')).toBeTruthy();
  });

  it('create flow calls createItem', async () => {
    const createItem = vi.fn().mockResolvedValue({ ok: true, item: { id: 'new-1', title: 'New thing' } });
    render(
      <RoadmapTab
        items={BASE_ITEMS}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={createItem}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { id: 'i1', connections: [] } })}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-roadmap-fab')); });
    act(() => { fireEvent.change(screen.getByTestId('mobile-create-title'), { target: { value: 'New thing' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('mobile-create-submit')); });
    expect(createItem).toHaveBeenCalled();
    await waitFor(() => { expect(screen.queryByTestId('mobile-create-sheet')).toBeFalsy(); });
  });
});

// ─── S03: ItemDetailSheet delete two-tap ─────────────────────────────────
describe('ItemDetailSheet delete two-tap (S03)', () => {
  const item = { id: 'COMP-A', title: 'Alpha', status: 'planned', group: 'g1', confidence: 2 };
  const allItems = [item, { id: 'COMP-B', title: 'Beta', status: 'in_progress', group: 'g1' }];

  it('shows delete button', () => {
    render(
      <RoadmapTab
        items={allItems}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        deleteItem={vi.fn().mockResolvedValue({ ok: true })}
        addConnection={vi.fn()}
        removeConnection={vi.fn()}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { ...item, connections: [] } })}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    expect(screen.getByTestId('mobile-item-sheet-delete')).toBeTruthy();
  });

  it('first tap arms delete button (shows confirm text)', async () => {
    render(
      <RoadmapTab
        items={allItems}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        deleteItem={vi.fn().mockResolvedValue({ ok: true })}
        addConnection={vi.fn()}
        removeConnection={vi.fn()}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { ...item, connections: [] } })}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-sheet-delete')); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-item-sheet-delete').textContent).toMatch(/confirm/i);
    });
  });

  it('second tap calls deleteItem and closes sheet', async () => {
    const deleteItem = vi.fn().mockResolvedValue({ ok: true });
    render(
      <RoadmapTab
        items={allItems}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        deleteItem={deleteItem}
        addConnection={vi.fn()}
        removeConnection={vi.fn()}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { ...item, connections: [] } })}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-sheet-delete')); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-item-sheet-delete').textContent).toMatch(/confirm/i);
    });
    await act(async () => { fireEvent.click(screen.getByTestId('mobile-item-sheet-delete')); });
    expect(deleteItem).toHaveBeenCalledWith('COMP-A');
    await waitFor(() => { expect(screen.queryByTestId('mobile-item-sheet')).toBeFalsy(); });
  });

  it('delete button disarms after 3s (fake timers)', async () => {
    vi.useFakeTimers();
    render(
      <RoadmapTab
        items={allItems}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        deleteItem={vi.fn().mockResolvedValue({ ok: true })}
        addConnection={vi.fn()}
        removeConnection={vi.fn()}
        fetchItemDetail={vi.fn().mockResolvedValue({ ok: true, item: { ...item, connections: [] } })}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-sheet-delete')); });
    // Armed state
    await act(async () => { vi.advanceTimersByTime(3001); });
    // Should have disarmed
    expect(screen.getByTestId('mobile-item-sheet-delete').textContent).toMatch(/delete/i);
    expect(screen.getByTestId('mobile-item-sheet-delete').textContent).not.toMatch(/confirm/i);
    vi.useRealTimers();
  });
});

// ─── S03: ItemDetailSheet connections ────────────────────────────────────
describe('ItemDetailSheet connections (S03)', () => {
  const item = { id: 'COMP-A', title: 'Alpha', status: 'planned', group: 'g1', confidence: 2 };
  const allItems = [
    item,
    { id: 'COMP-B', title: 'Beta', status: 'in_progress', group: 'g1' },
  ];
  const connections = [
    { id: 'c1', fromId: 'COMP-A', toId: 'COMP-B', type: 'informs' },
  ];

  it('renders connections from fetchItemDetail after sheet opens', async () => {
    const fetchItemDetail = vi.fn().mockResolvedValue({
      ok: true,
      item: { ...item, connections },
    });
    render(
      <RoadmapTab
        items={allItems}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        deleteItem={vi.fn().mockResolvedValue({ ok: true })}
        addConnection={vi.fn()}
        removeConnection={vi.fn()}
        fetchItemDetail={fetchItemDetail}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    await waitFor(() => { expect(fetchItemDetail).toHaveBeenCalledWith('COMP-A'); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-item-conn-remove-0')).toBeTruthy();
    });
  });

  it('add connection button opens picker', async () => {
    const fetchItemDetail = vi.fn().mockResolvedValue({ ok: true, item: { ...item, connections: [] } });
    render(
      <RoadmapTab
        items={allItems}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        deleteItem={vi.fn().mockResolvedValue({ ok: true })}
        addConnection={vi.fn().mockResolvedValue({ ok: true, connection: { id: 'c2', fromId: 'COMP-A', toId: 'COMP-B', type: 'informs' } })}
        removeConnection={vi.fn()}
        fetchItemDetail={fetchItemDetail}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    await waitFor(() => { expect(fetchItemDetail).toHaveBeenCalled(); });
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-conn-add')); });
    await waitFor(() => { expect(screen.getByTestId('mobile-item-conn-search')).toBeTruthy(); });
  });

  it('remove connection calls removeConnection (two-tap)', async () => {
    const removeConnection = vi.fn().mockResolvedValue({ ok: true });
    const fetchItemDetail = vi.fn().mockResolvedValue({
      ok: true,
      item: { ...item, connections },
    });
    render(
      <RoadmapTab
        items={allItems}
        loading={false}
        error={null}
        applyOptimisticEdit={makeMockApplyOptimisticEdit()}
        createItem={vi.fn()}
        deleteItem={vi.fn().mockResolvedValue({ ok: true })}
        addConnection={vi.fn()}
        removeConnection={removeConnection}
        fetchItemDetail={fetchItemDetail}
      />
    );
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-card-COMP-A')); });
    await waitFor(() => { expect(screen.getByTestId('mobile-item-conn-remove-0')).toBeTruthy(); });
    // First tap arms
    act(() => { fireEvent.click(screen.getByTestId('mobile-item-conn-remove-0')); });
    // Second tap removes
    await act(async () => { fireEvent.click(screen.getByTestId('mobile-item-conn-remove-0')); });
    expect(removeConnection).toHaveBeenCalledWith('c1');
  });
});
