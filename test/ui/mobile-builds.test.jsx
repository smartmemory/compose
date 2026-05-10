import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import BuildsTab from '../../src/mobile/tabs/BuildsTab.jsx';
import { setSensitiveToken } from '../../src/lib/compose-api.js';

// EventSource stub — useAgentStream uses it
class FakeEventSource {
  constructor(url) { this.url = url; this.readyState = 0; FakeEventSource.instances.push(this); }
  addEventListener() {}
  close() { this.readyState = 2; }
  set onopen(_) {}
  set onmessage(_) {}
  set onerror(_) {}
}
FakeEventSource.instances = [];

class FakeWS {
  constructor(url) { this.url = url; FakeWS.instances.push(this); }
  close() {}
  set onmessage(_) {}
  set onerror(_) {}
  set onclose(_) {}
}
FakeWS.instances = [];

let fetchCalls = [];
let buildState = null;
let startResponse = { ok: true, status: 200, body: { started: true, featureCode: 'F-1' } };

function buildFetchMock() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    const u = String(url);
    if (u.includes('/api/build/state')) {
      return new Response(JSON.stringify({ state: buildState }), { status: 200 });
    }
    if (u.includes('/api/build/start') && opts.method === 'POST') {
      return new Response(JSON.stringify(startResponse.body), { status: startResponse.status });
    }
    if (u.includes('/api/build/abort') && opts.method === 'POST') {
      return new Response(JSON.stringify({ aborted: true }), { status: 200 });
    }
    if (u.includes('/api/vision/items')) {
      return new Response(JSON.stringify({ items: [
        { id: 'COMP-MOBILE', lifecycle: { featureCode: 'COMP-MOBILE' } },
        { id: 'COMP-X', lifecycle: { featureCode: 'COMP-X' } },
      ] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('<BuildsTab>', () => {
  beforeEach(() => {
    setSensitiveToken('test-token');
    globalThis.EventSource = FakeEventSource;
    globalThis.WebSocket = FakeWS;
    FakeEventSource.instances = [];
    FakeWS.instances = [];
    buildState = null;
    startResponse = { ok: true, status: 200, body: { started: true, featureCode: 'F-1' } };
    buildFetchMock();
  });

  afterEach(() => {
    setSensitiveToken(null);
    vi.restoreAllMocks();
  });

  it('renders empty state with Start button when no active build', async () => {
    render(<BuildsTab />);
    await waitFor(() => screen.getByTestId('mobile-build-empty'));
    expect(screen.getByTestId('mobile-build-start')).toBeTruthy();
  });

  it('renders BuildCard when an active build exists', async () => {
    buildState = {
      featureCode: 'COMP-MOBILE',
      mode: 'feature',
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    };
    render(<BuildsTab />);
    await waitFor(() => screen.getByTestId('mobile-build-card'));
    const card = screen.getByTestId('mobile-build-card');
    expect(card.getAttribute('data-feature')).toBe('COMP-MOBILE');
    expect(screen.getByTestId('mobile-build-abort')).toBeTruthy();
  });

  it('StartBuildSheet submits with featureCode + mode + description', async () => {
    render(<BuildsTab />);
    await waitFor(() => screen.getByTestId('mobile-build-start'));

    fireEvent.click(screen.getByTestId('mobile-build-start'));
    expect(screen.getByTestId('mobile-start-build-sheet')).toBeTruthy();

    fireEvent.change(screen.getByTestId('mobile-build-feature-input'), {
      target: { value: 'COMP-MOBILE' },
    });
    fireEvent.click(screen.getByTestId('mobile-build-mode-bug'));
    fireEvent.change(screen.getByTestId('mobile-build-description'), {
      target: { value: 'fix the thing' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-build-submit'));
    });

    const startCall = fetchCalls.find(c =>
      c.url.includes('/api/build/start') && c.opts.method === 'POST'
    );
    expect(startCall).toBeTruthy();
    expect(startCall.opts.headers['x-compose-token']).toBe('test-token');
    const body = JSON.parse(startCall.opts.body);
    expect(body.featureCode).toBe('COMP-MOBILE');
    expect(body.mode).toBe('bug');
    expect(body.description).toBe('fix the thing');
  });

  it('Abort button hits /api/build/abort with featureCode and x-compose-token', async () => {
    buildState = {
      featureCode: 'COMP-MOBILE',
      mode: 'feature',
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    };
    render(<BuildsTab />);
    await waitFor(() => screen.getByTestId('mobile-build-card'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-build-abort'));
    });

    const abortCall = fetchCalls.find(c =>
      c.url.includes('/api/build/abort') && c.opts.method === 'POST'
    );
    expect(abortCall).toBeTruthy();
    expect(abortCall.opts.headers['x-compose-token']).toBe('test-token');
    const body = JSON.parse(abortCall.opts.body);
    expect(body.featureCode).toBe('COMP-MOBILE');
  });

  it('409 already-active surfaces a toast', async () => {
    startResponse = {
      ok: false,
      status: 409,
      body: { error: 'Build is already active for COMP-MOBILE' },
    };
    render(<BuildsTab />);
    await waitFor(() => screen.getByTestId('mobile-build-start'));

    fireEvent.click(screen.getByTestId('mobile-build-start'));
    fireEvent.change(screen.getByTestId('mobile-build-feature-input'), {
      target: { value: 'COMP-MOBILE' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-build-submit'));
    });

    await waitFor(() => screen.getByTestId('mobile-toast'));
    const toast = screen.getByTestId('mobile-toast');
    expect(toast.getAttribute('data-kind')).toBe('error');
    expect(toast.textContent.toLowerCase()).toContain('already active');
  });
});
