import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import RoadmapTab from '../../src/mobile/tabs/RoadmapTab.jsx';

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

async function renderAndHydrate() {
  const utils = render(<RoadmapTab />);
  // Wait for initial fetch + state to settle
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
