import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import IdeasTab from '../../src/mobile/tabs/IdeasTab.jsx';

const SAMPLE = {
  ideas: [
    { id: 'IDEA-1', num: 1, title: 'Fix the login flow', description: '', priority: 'P0', status: 'NEW', tags: ['auth'], cluster: 'Onboarding' },
    { id: 'IDEA-2', num: 2, title: 'Add dark mode', description: 'Toggle in settings', priority: 'P1', status: 'NEW', tags: [], cluster: null },
    { id: 'IDEA-3', num: 3, title: 'Cache the homepage', description: '', priority: 'P2', status: 'NEW', tags: ['perf'], cluster: 'Performance' },
    { id: 'IDEA-4', num: 4, title: 'Sticker store integration', description: '', priority: '—', status: 'NEW', tags: [], cluster: null },
  ],
  killed: [],
};

let fetchCalls = [];
let fetchImpl;

function defaultFetch(url, opts = {}) {
  fetchCalls.push({ url, method: opts.method || 'GET', body: opts.body });
  if (url === '/api/ideabox') {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(JSON.parse(JSON.stringify(SAMPLE))),
    });
  }
  if (url === '/api/ideabox/ideas' && opts.method === 'POST') {
    const body = JSON.parse(opts.body || '{}');
    const created = { id: 'IDEA-9', num: 9, title: body.title, description: body.description || '', tags: body.tags || [], cluster: body.cluster || null, priority: '—', status: 'NEW' };
    return Promise.resolve({
      ok: true,
      status: 201,
      json: () => Promise.resolve(created),
    });
  }
  if (/\/api\/ideabox\/ideas\/[^/]+\/promote$/.test(url) && opts.method === 'POST') {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'IDEA-1', featureCode: 'IDEA-1-FIX' }),
    });
  }
  if (/\/api\/ideabox\/ideas\/[^/]+\/kill$/.test(url) && opts.method === 'POST') {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'IDEA-1', status: 'KILLED' }),
    });
  }
  if (/\/api\/ideabox\/ideas\/[^/]+$/.test(url) && opts.method === 'PATCH') {
    const body = JSON.parse(opts.body || '{}');
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: url.split('/').pop(), priority: body.priority }),
    });
  }
  return Promise.resolve({
    ok: false,
    status: 404,
    json: () => Promise.resolve({ error: 'not found' }),
  });
}

beforeEach(() => {
  fetchCalls = [];
  fetchImpl = defaultFetch;
  // jsdom has no WebSocket — stub a no-op
  globalThis.WebSocket = class {
    constructor() { this.readyState = 0; }
    close() { this.onclose && this.onclose(); }
  };
  vi.stubGlobal('fetch', (url, opts) => fetchImpl(url, opts));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderAndLoad() {
  let utils;
  await act(async () => {
    utils = render(<IdeasTab />);
  });
  // Wait for initial fetch to settle
  await waitFor(() => {
    expect(screen.queryByTestId('ideas-loading')).toBeNull();
  });
  return utils;
}

describe('<IdeasTab>', () => {
  it('renders the ideas list with priority badges', async () => {
    await renderAndLoad();
    const list = screen.getByTestId('ideas-list');
    const cards = within(list).getAllByTestId('idea-card');
    expect(cards.length).toBe(4);
    // Sorted by priority desc → P0 first
    expect(cards[0].getAttribute('data-idea-id')).toBe('IDEA-1');
    expect(within(cards[0]).getByTestId('priority-badge-IDEA-1').textContent).toBe('P0');
  });

  it('filters by priority', async () => {
    await renderAndLoad();
    await act(async () => {
      fireEvent.click(screen.getByTestId('filter-P1'));
    });
    const cards = screen.getAllByTestId('idea-card');
    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute('data-idea-id')).toBe('IDEA-2');

    await act(async () => {
      fireEvent.click(screen.getByTestId('filter-untriaged'));
    });
    const cards2 = screen.getAllByTestId('idea-card');
    expect(cards2.length).toBe(1);
    expect(cards2[0].getAttribute('data-idea-id')).toBe('IDEA-4');
  });

  it('shows empty state when filter has no matches', async () => {
    fetchImpl = (url, opts) => {
      if (url === '/api/ideabox') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ideas: [], killed: [] }) });
      }
      return defaultFetch(url, opts);
    };
    await renderAndLoad();
    expect(screen.getByTestId('ideas-empty')).toBeTruthy();
  });

  it('capture sheet creates an idea via POST /api/ideabox/ideas', async () => {
    await renderAndLoad();
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-capture'));
    });
    expect(screen.getByTestId('capture-sheet')).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByTestId('capture-title'), { target: { value: 'Brand new idea' } });
      fireEvent.change(screen.getByTestId('capture-description'), { target: { value: 'with detail' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('capture-submit'));
    });

    await waitFor(() => {
      const post = fetchCalls.find(c => c.url === '/api/ideabox/ideas' && c.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post.body);
      expect(body.title).toBe('Brand new idea');
      expect(body.description).toBe('with detail');
    });
    // Sheet closes on success
    await waitFor(() => {
      expect(screen.queryByTestId('capture-sheet')).toBeNull();
    });
  });

  it('detail sheet promote button calls /promote endpoint', async () => {
    await renderAndLoad();
    const cards = screen.getAllByTestId('idea-card');
    await act(async () => {
      fireEvent.click(cards[0]);  // IDEA-1
    });
    expect(screen.getByTestId('idea-detail-sheet')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('detail-promote'));
    });

    await waitFor(() => {
      const promote = fetchCalls.find(c => c.url === '/api/ideabox/ideas/IDEA-1/promote' && c.method === 'POST');
      expect(promote).toBeTruthy();
    });
  });

  it('detail sheet kill button calls /kill endpoint', async () => {
    await renderAndLoad();
    const cards = screen.getAllByTestId('idea-card');
    await act(async () => {
      fireEvent.click(cards[0]);  // IDEA-1
    });
    expect(screen.getByTestId('idea-detail-sheet')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('detail-kill'));
    });

    await waitFor(() => {
      const killCall = fetchCalls.find(c => c.url === '/api/ideabox/ideas/IDEA-1/kill' && c.method === 'POST');
      expect(killCall).toBeTruthy();
    });
  });

  it('priority selector calls PATCH with the new priority', async () => {
    await renderAndLoad();
    const cards = screen.getAllByTestId('idea-card');
    await act(async () => {
      fireEvent.click(cards[0]);  // IDEA-1 (P0)
    });
    // Pick P2
    await act(async () => {
      fireEvent.click(screen.getByTestId('priority-chip-p2'));
    });
    await waitFor(() => {
      const patch = fetchCalls.find(c => c.url === '/api/ideabox/ideas/IDEA-1' && c.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch.body)).toEqual({ priority: 'P2' });
    });
  });
});
