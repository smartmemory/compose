/**
 * FOH-6 S3 — ColleaguePanel funnel states + conversation flow, and the
 * ViewTabs summon button. The panel NEVER hides a degraded state (funnel, not
 * hide — RecallTab's hide-when-disabled is the named anti-pattern) and never
 * offers a degraded plain-chat mode (COLLEAGUE-ALL-IN).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));
// The ideabox store attaches a live-update WebSocket on an import-time timer;
// neutralize the URL builder and give jsdom a WebSocket so the timer firing
// mid-test can never crash the suite.
vi.mock('../../src/lib/wsUrl.js', () => ({ visionWsUrl: () => 'ws://127.0.0.1:0/ws/vision' }));
globalThis.WebSocket = class {
  onmessage = null; onclose = null; onerror = null;
  close() {}
};
import { wsFetch } from '../../src/lib/wsFetch.js';
import ColleaguePanel from '../../src/components/colleague/ColleaguePanel.jsx';
import ViewTabs from '../../src/components/cockpit/ViewTabs.jsx';
import { useIdeaboxStore } from '../../src/components/vision/useIdeaboxStore.js';

const READY = {
  enabled: true, state: 'ready',
  auth: { mode: 'provision', identity: true },
  capabilities: { challenge: true, conviction: true, contradiction: true, calibration: false },
};

/** Route the wsFetch mock by URL; unrouted calls resolve empty-ok. */
function routeFetch(routes) {
  wsFetch.mockImplementation((url, opts = {}) => {
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) return Promise.resolve(handler(url, opts));
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}
const json = (body) => ({ ok: true, json: async () => body });

function renderPanel({ status = READY, refreshStatus = vi.fn() } = {}) {
  return render(
    <ColleaguePanel onClose={vi.fn()} status={status} refreshStatus={refreshStatus} />,
  );
}

beforeEach(() => {
  wsFetch.mockReset();
  routeFetch([]);
  useIdeaboxStore.setState({ ideas: [], killed: [], selectedIdeaId: null });
});
afterEach(() => vi.restoreAllMocks());

describe('ColleaguePanel funnel states', () => {
  it('connect-smartmemory: no chat, upgrade guidance (no degraded plain-chat mode)', () => {
    renderPanel({ status: { enabled: true, state: 'connect-smartmemory' } });
    expect(screen.getByRole('heading', { name: /needs SmartMemory/i })).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('offline: start hint + retry re-probes status', () => {
    const refreshStatus = vi.fn();
    renderPanel({
      status: { enabled: true, state: 'offline', baseUrl: 'http://localhost:9005', hint: 'start the Maya stack (dev.sh — port 9005), then reopen the panel' },
      refreshStatus,
    });
    expect(screen.getByText(/offline/i)).toBeTruthy();
    expect(screen.getByText(/dev\.sh/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refreshStatus).toHaveBeenCalled();
  });

  it('workspace-collision: refusal explained, no chat', () => {
    renderPanel({ status: { enabled: true, state: 'workspace-collision', error: 'claim equals fluid workspace' } });
    expect(screen.getByRole('heading', { name: /workspace collision/i })).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('ready: capability strip renders calibration as visibly unavailable, never hidden', () => {
    renderPanel();
    expect(screen.getByText(/calibration/i)).toBeTruthy();
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
    expect(document.querySelector('textarea')).toBeTruthy();
  });
});

describe('conversation flow', () => {
  it('sends text + focusId, disables input while pending, renders reply + context note', async () => {
    let resolveTurn;
    const turn = new Promise((r) => { resolveTurn = r; });
    routeFetch([
      ['/api/maya/message', () => { throw new Error('unused'); }],
    ]);
    wsFetch.mockImplementation((url) => {
      if (url.includes('/api/maya/message')) return turn;
      return Promise.resolve(json({}));
    });
    useIdeaboxStore.setState({ selectedIdeaId: 'IDEA-42' });

    renderPanel();
    const textarea = document.querySelector('textarea');
    textarea.value = 'what contradicts this?';
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Pending: input disabled until the turn resolves.
    await waitFor(() => expect(document.querySelector('textarea').disabled).toBe(true));

    resolveTurn(json({
      ok: true, reply: 'IDEA-7 contradicts it.', message_id: 'msg_9', writeback: null,
      context: { sent: ['compose:idea IDEA-42', 'compose:contradiction'], omissions: ['discussion omitted, over budget'] },
    }));
    await waitFor(() => expect(screen.getByText(/IDEA-7 contradicts it\./)).toBeTruthy());
    expect(document.querySelector('textarea').disabled).toBe(false);

    // The POST carried the cockpit-followed focus.
    const call = wsFetch.mock.calls.find(([u]) => u.includes('/api/maya/message'));
    const body = JSON.parse(call[1].body);
    expect(body.text).toBe('what contradicts this?');
    expect(body.focusId).toBe('IDEA-42');

    // Context note: sent sections + named omission, so a truncated turn is
    // never mistaken for a clean one.
    expect(screen.getByText(/discussion omitted, over budget/)).toBeTruthy();
  });

  it('findings accordion renders the latest turn\'s findings blocks (record/discussion excluded)', async () => {
    routeFetch([
      ['/api/maya/message', () => json({
        ok: true, reply: 'see the findings.', message_id: 'msg_2', writeback: null,
        context: {
          sent: ['compose:idea IDEA-42', 'compose:contradiction'],
          omissions: [],
          blocks: [
            { author: 'compose:idea IDEA-42', text: 'the record body' },
            { author: 'compose:contradiction', text: 'IDEA-7 contradicts it' },
          ],
        },
      })],
    ]);
    renderPanel();
    const textarea = document.querySelector('textarea');
    textarea.value = 'hi';
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('findings-accordion')).toBeTruthy());
    expect(screen.getByText(/findings \(1\)/i)).toBeTruthy();
    expect(screen.getByText(/IDEA-7 contradicts it/)).toBeTruthy();
    // The record-body block is context, not a finding — it stays out.
    expect(screen.queryByText(/the record body/)).toBeNull();
  });

  it('auth turn error → auth funnel with the two explicit continuity-costing actions', async () => {
    routeFetch([
      ['/api/maya/message', () => json({
        ok: false,
        error: { kind: 'auth', actions: ['re-provision — starts a fresh conversation', 'paste a new token'] },
      })],
    ]);
    renderPanel();
    const textarea = document.querySelector('textarea');
    textarea.value = 'hi';
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: /re-provision/i })).toBeTruthy());
    expect(screen.getByText(/starts a fresh conversation/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /paste a new token/i })).toBeTruthy();
    // Never silent: no chat input in the auth funnel.
    expect(document.querySelector('textarea')).toBeNull();
  });
});

describe('write-back chips', () => {
  async function sendWith(writeback) {
    routeFetch([
      ['/api/maya/message', () => json({
        ok: true, reply: 'noted.', message_id: 'msg_1', writeback,
        context: { sent: [], omissions: [] },
      })],
    ]);
    useIdeaboxStore.setState({ selectedIdeaId: 'IDEA-42' });
    renderPanel();
    const textarea = document.querySelector('textarea');
    textarea.value = 'hi';
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/noted\./)).toBeTruthy());
  }

  it('ok → confirmation chip', async () => {
    await sendWith({ outcome: 'ok', focusId: 'IDEA-42' });
    expect(screen.getByText(/noted on IDEA-42/i)).toBeTruthy();
  });

  it('landed-unrendered → visible warning with a re-render repair affordance', async () => {
    await sendWith({ outcome: 'landed-unrendered', focusId: 'IDEA-42' });
    expect(screen.getByText(/saved.*stale/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /re-render/i })).toBeTruthy();
  });

  it('failed → warning chip whose retry posts APPEND-ONLY, never the chat turn', async () => {
    await sendWith({ outcome: 'failed', focusId: 'IDEA-42' });
    const retry = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    await waitFor(() => {
      const call = wsFetch.mock.calls.find(([u]) => u.includes('/api/maya/writeback-retry'));
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.message_id).toBe('msg_1');
      expect(body.focusId).toBe('IDEA-42');
    });
    // The chat endpoint was hit exactly once (the original turn) — retry must
    // never resend the turn.
    const chatCalls = wsFetch.mock.calls.filter(([u]) => u.includes('/api/maya/message'));
    expect(chatCalls.length).toBe(1);
  });
});

describe('ViewTabs summon button', () => {
  it('renders iff the colleague is installed; toggles', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ViewTabs tabs={['ideabox']} activeTab="ideabox" onTabChange={vi.fn()}
        colleague={{ installed: false, open: false, onToggle }} />,
    );
    expect(screen.queryByTestId('colleague-summon')).toBeNull();

    rerender(
      <ViewTabs tabs={['ideabox']} activeTab="ideabox" onTabChange={vi.fn()}
        colleague={{ installed: true, open: false, onToggle }} />,
    );
    const btn = screen.getByTestId('colleague-summon');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });
});
