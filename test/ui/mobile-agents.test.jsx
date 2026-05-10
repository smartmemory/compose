import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import AgentsTab from '../../src/mobile/tabs/AgentsTab.jsx';
import { setSensitiveToken } from '../../src/lib/compose-api.js';

// Stub EventSource (jsdom does not have it). Records URL + holds onerror so
// we never try to open a real network connection.
class FakeEventSource {
  constructor(url) { this.url = url; this.readyState = 0; FakeEventSource.instances.push(this); }
  addEventListener() {}
  close() { this.readyState = 2; }
  set onopen(_) {}
  set onmessage(_) {}
  set onerror(_) {}
}
FakeEventSource.instances = [];

// WebSocket stub
class FakeWS {
  constructor(url) { this.url = url; FakeWS.instances.push(this); }
  close() {}
  set onmessage(_) {}
  set onerror(_) {}
  set onclose(_) {}
}
FakeWS.instances = [];

const SAMPLE_AGENTS = [
  { agentId: 'agent-1', status: 'running', startedAt: new Date().toISOString() },
  { agentId: 'agent-2', status: 'completed', startedAt: new Date().toISOString() },
];

const SAMPLE_GATES = [
  { id: 'F:s1:1', flowId: 'F', stepId: 's1', toPhase: 'design', summary: 'Review design', status: 'pending' },
];

let fetchCalls = [];

function installFetchMock() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    const u = String(url);
    if (u.includes('/api/agents/tree')) {
      return new Response(JSON.stringify({ sessionId: null, agents: SAMPLE_AGENTS }), { status: 200 });
    }
    if (u.includes('/api/vision/gates') && (!opts.method || opts.method === 'GET')) {
      return new Response(JSON.stringify({ gates: SAMPLE_GATES }), { status: 200 });
    }
    if (u.includes('/api/vision/gates/') && opts.method === 'POST') {
      return new Response(JSON.stringify({ ok: true, gateId: 'F:s1:1' }), { status: 200 });
    }
    if (u.includes('/api/agent/session/status')) {
      return new Response(JSON.stringify({ active: true, sessionId: 'sess-1' }), { status: 200 });
    }
    if (u.endsWith('/stop') && opts.method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes('/api/agent/message') || u.includes('/api/agent/session')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('<AgentsTab>', () => {
  beforeEach(() => {
    setSensitiveToken('test-token');
    globalThis.EventSource = FakeEventSource;
    globalThis.WebSocket = FakeWS;
    FakeEventSource.instances = [];
    FakeWS.instances = [];
    installFetchMock();
  });

  afterEach(() => {
    setSensitiveToken(null);
  });

  it('renders three sections: spawned, interactive session, pending gates', async () => {
    render(<AgentsTab />);
    expect(screen.getByTestId('mobile-section-spawned')).toBeTruthy();
    expect(screen.getByTestId('mobile-section-session')).toBeTruthy();
    expect(screen.getByTestId('mobile-section-gates')).toBeTruthy();
  });

  it('renders an AgentCard per spawned agent and Kill calls /stop with x-compose-token', async () => {
    render(<AgentsTab />);
    await waitFor(() => screen.getByTestId('mobile-agent-card-agent-1'));
    expect(screen.getByTestId('mobile-agent-card-agent-2')).toBeTruthy();

    const killBtn = screen.getByTestId('mobile-agent-kill-agent-1');
    expect(killBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(killBtn);
    });

    const stopCall = fetchCalls.find(c => c.url.includes('/api/agent/agent-1/stop'));
    expect(stopCall).toBeTruthy();
    expect(stopCall.opts.method).toBe('POST');
    expect(stopCall.opts.headers['x-compose-token']).toBe('test-token');
  });

  it('renders a GateCard per pending gate, opens GatePromptSheet, approve hits /resolve with outcome=approve', async () => {
    render(<AgentsTab />);
    await waitFor(() => screen.getByTestId('mobile-gate-card-F:s1:1'));

    fireEvent.click(screen.getByTestId('mobile-gate-card-F:s1:1'));
    expect(screen.getByTestId('mobile-gate-sheet')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mobile-gate-outcome-approve'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-gate-submit'));
    });

    const resolveCall = fetchCalls.find(c =>
      c.url.includes('/api/vision/gates/F%3As1%3A1/resolve') && c.opts.method === 'POST'
    );
    expect(resolveCall).toBeTruthy();
    const body = JSON.parse(resolveCall.opts.body);
    expect(body.outcome).toBe('approve');
  });

  it('InteractiveSessionCard renders and shows the active sessionId', async () => {
    render(<AgentsTab />);
    expect(screen.getByTestId('mobile-interactive-session')).toBeTruthy();
    await waitFor(() => {
      const node = screen.getByTestId('mobile-interactive-session');
      expect(node.textContent.includes('sess-1') || node.textContent.includes('active')).toBe(true);
    });
  });
});
