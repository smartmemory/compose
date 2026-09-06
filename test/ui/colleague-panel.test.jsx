/**
 * FOH-6 S3 — ColleaguePanel funnel states + conversation flow, and the
 * ViewTabs summon button. The panel NEVER hides a degraded state (funnel, not
 * hide — RecallTab's hide-when-disabled is the named anti-pattern) and never
 * offers a degraded plain-chat mode (COLLEAGUE-ALL-IN).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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
import ColleaguePanel, { FindingsAccordion, ContextNote } from '../../src/components/colleague/ColleaguePanel.jsx';
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
    return Promise.resolve(json({}));
  });
}
const json = (body) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json' },
});

function controlledSse() {
  const encoder = new TextEncoder();
  let controller;
  const response = new Response(new ReadableStream({
    start(c) { controller = c; },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  return {
    response,
    push: (frame) => controller.enqueue(encoder.encode(frame)),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

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
  it('renders tokens progressively, then replaces them with final context + write-back', async () => {
    const stream = controlledSse();
    routeFetch([
      ['/api/maya/message?stream=1', () => stream.response],
    ]);
    useIdeaboxStore.setState({ selectedIdeaId: 'IDEA-42' });

    renderPanel();
    const textarea = document.querySelector('textarea');
    textarea.value = 'stream this';
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('textarea').disabled).toBe(true));

    await act(async () => {
      stream.push(': heartbeat\n\nevent: token\ndata: {"text":"draft"}\n\n');
    });
    await waitFor(() => expect(screen.getByText('draft')).toBeTruthy());
    expect(screen.queryByText(/Maya is thinking/i)).toBeNull();
    expect(document.querySelector('textarea').disabled).toBe(true);

    // The second token frame is intentionally split across transport chunks.
    await act(async () => {
      stream.push('event: token\ndata: {"text":" words');
      stream.push('"}\n\nevent: ignored\ndata: {"value":true}\n\n');
    });
    await waitFor(() => expect(screen.getByText('draft words')).toBeTruthy());

    await act(async () => {
      stream.push(
        'event: final\ndata: {"ok":true,"reply":"Authoritative reply.","message_id":"msg_stream","memory_available":true,"context":{"sent":["compose:idea IDEA-42","compose:contradiction"],"omissions":["challenge omitted, over budget"],"blocks":[{"author":"compose:contradiction","text":"stream finding text"}]}}\n\n'
        + 'event: writeback\ndata: {"outcome":"ok","focusId":"IDEA-42"}\n\n',
      );
      stream.close();
    });

    await waitFor(() => expect(screen.getByText('Authoritative reply.')).toBeTruthy());
    expect(screen.queryByText('draft words')).toBeNull();
    expect(screen.getByText(/challenge omitted, over budget/)).toBeTruthy();
    expect(screen.getByText(/findings \(1\)/i)).toBeTruthy();
    expect(screen.getByText('stream finding text')).toBeTruthy();
    expect(screen.getByText(/noted on IDEA-42/i)).toBeTruthy();
    expect(document.querySelector('textarea').disabled).toBe(false);

    const call = wsFetch.mock.calls.find(([u]) => u.includes('/api/maya/message'));
    expect(call[0]).toBe('/api/maya/message?stream=1');
  });

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

  it('pre-flight JSON auth error → auth funnel with the two explicit continuity-costing actions', async () => {
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
    const call = wsFetch.mock.calls.find(([u]) => u.includes('/api/maya/message'));
    expect(call[0]).toBe('/api/maya/message?stream=1');
  });

  it('routes a terminal SSE error through the existing error taxonomy', async () => {
    const stream = controlledSse();
    routeFetch([
      ['/api/maya/message?stream=1', () => stream.response],
    ]);
    renderPanel();
    const textarea = document.querySelector('textarea');
    textarea.value = 'hi';
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await act(async () => {
      stream.push('event: token\ndata: {"text":"partial upstream text"}\n\n');
    });
    await waitFor(() => expect(screen.getByText('partial upstream text')).toBeTruthy());
    await act(async () => {
      stream.push('event: error\ndata: {"kind":"upstream","message":"Maya stopped"}\n\n');
      stream.close();
    });

    await waitFor(() => expect(screen.getByText('upstream: Maya stopped')).toBeTruthy());
    expect(screen.getByText('partial upstream text')).toBeTruthy();
    expect(document.querySelector('textarea').disabled).toBe(false);
  });

  it('keeps a partial reply and marks it failed when the stream cuts off without final', async () => {
    const stream = controlledSse();
    routeFetch([
      ['/api/maya/message?stream=1', () => stream.response],
    ]);
    renderPanel();
    const textarea = document.querySelector('textarea');
    textarea.value = 'hi';
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await act(async () => {
      stream.push('event: token\ndata: {"text":"keep this partial reply"}\n\n');
    });
    await waitFor(() => expect(screen.getByText('keep this partial reply')).toBeTruthy());
    await act(async () => {
      stream.fail(new Error('socket reset'));
    });

    await waitFor(() => expect(screen.getByText(/reply interrupted — not saved/i)).toBeTruthy());
    expect(screen.getByText('keep this partial reply')).toBeTruthy();
    expect(screen.queryByText(/noted on/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /re-render/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull();
    expect(document.querySelector('textarea').disabled).toBe(false);
  });

  it('final without the owed write-back event ends UNKNOWN — unconfirmed chip, idempotent retry', async () => {
    // The §5 outcome contract is transport-independent: a turn that owed a
    // writeback event must never read as clean when the stream dies after
    // final but before the outcome arrives (Codex r1 P2).
    const stream = controlledSse();
    routeFetch([
      ['/api/maya/message?stream=1', () => stream.response],
      ['/api/maya/writeback-retry', () => json({ ok: true, writeback: { outcome: 'ok', focusId: 'IDEA-42' } })],
    ]);
    useIdeaboxStore.setState({ selectedIdeaId: 'IDEA-42' });

    renderPanel();
    const textarea = document.querySelector('textarea');
    textarea.value = 'stream this';
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await act(async () => {
      stream.push(
        'event: token\ndata: {"text":"partial"}\n\n'
        + 'event: final\ndata: {"ok":true,"reply":"Full reply.","message_id":"msg_wb","memory_available":true,"context":{"sent":[],"omissions":[],"blocks":[]}}\n\n',
      );
      stream.close(); // connection dies before the writeback event
    });

    await waitFor(() => expect(screen.getByText(/save to IDEA-42 unconfirmed/i)).toBeTruthy());
    expect(screen.getByText('Full reply.')).toBeTruthy();
    expect(screen.queryByText(/noted on/i)).toBeNull();
    expect(document.querySelector('textarea').disabled).toBe(false);

    // Retry is reconcile-then-append keyed on message_id — resolving it
    // flips the chip to the confirmed state.
    fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));
    await waitFor(() => expect(screen.getByText(/noted on IDEA-42/i)).toBeTruthy());
    const retryCall = wsFetch.mock.calls.find(([u]) => u.includes('/api/maya/writeback-retry'));
    expect(JSON.parse(retryCall[1].body).message_id).toBe('msg_wb');
  });
});

describe('paste-token refusals render', () => {
  it('a fail-closed verification refusal shows its explanation, never a silent Save', async () => {
    routeFetch([
      ['/api/maya/identity', () => json({
        ok: false,
        error: { kind: 'auth', message: 'could not verify the token against SmartMemory (HTTP 500) — not storing it' },
      })],
    ]);
    renderPanel({
      status: { enabled: true, state: 'auth', auth: { mode: 'static', identity: false } },
    });
    fireEvent.click(screen.getByRole('button', { name: /paste a new token/i }));
    const input = screen.getByLabelText(/new maya token/i);
    input.value = 'some-token';
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/could not verify the token/i)).toBeTruthy());
    // Static mode: re-provision is a dead-end action and must not be offered.
    expect(screen.queryByRole('button', { name: /re-provision/i })).toBeNull();
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

// ---------------------------------------------------------------------------
// FOH-7 S4 — portfolio scope in the panel
// ---------------------------------------------------------------------------

describe('FOH-7 S4 — findings grouped by source', () => {
  const portfolioBlocks = [
    { author: 'compose:portfolio', text: 'From alpha', source: { id: 'alpha', root: '/r/alpha' } },
    { author: 'compose:portfolio', text: 'From beta', source: { id: 'beta', root: '/r/beta' } },
  ];

  it('renders one group per source, labelled', async () => {
    render(<FindingsAccordion blocks={portfolioBlocks} />);
    const groups = await screen.findAllByTestId('findings-group');
    expect(groups.length).toBe(2);
    const labels = screen.getAllByTestId('findings-source').map((n) => n.textContent);
    expect(labels).toEqual(['alpha', 'beta']);
  });

  // N products all emit `compose:conviction`. Keyed on the author alone, React
  // sees duplicate keys and the panel silently drops findings that were computed
  // and paid for.
  it('does not collide keys when two sources emit the same author', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<FindingsAccordion blocks={[
      { author: 'compose:conviction', text: 'a', source: { id: 'alpha', root: '/r/a' } },
      { author: 'compose:conviction', text: 'b', source: { id: 'beta', root: '/r/b' } },
    ]} />);
    await screen.findAllByTestId('findings-group');
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
    const dupKeyWarning = warn.mock.calls.some((c) => /same key|duplicate key/i.test(String(c[0])));
    expect(dupKeyWarning).toBe(false);
    warn.mockRestore();
  });

  it('renders a project-scoped turn exactly as before, ungrouped and unlabelled', async () => {
    render(<FindingsAccordion blocks={[
      { author: 'compose:conviction', text: 'just this project' },
    ]} />);
    await screen.findByTestId('findings-accordion');
    expect(screen.queryAllByTestId('findings-source').length).toBe(0);
    expect(screen.getByText('just this project')).toBeTruthy();
  });
});

describe('FOH-7 S4 — the context note', () => {
  it('does not repeat an author once per source', () => {
    render(<ContextNote context={{ sent: ['compose:conviction', 'compose:conviction', 'compose:conviction'] }} />);
    expect(screen.getByText(/context sent: conviction$/)).toBeTruthy();
  });

  it('renders two members failing with identical prose as two omissions', () => {
    const same = 'unreachable: connect ECONNREFUSED';
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ContextNote context={{ sent: [], omissions: [`alpha ${same}`, `beta ${same}`] }} />);
    expect(screen.getByText(`— alpha ${same}`)).toBeTruthy();
    expect(screen.getByText(`— beta ${same}`)).toBeTruthy();
    warn.mockRestore();
  });
});

describe('FOH-7 S4 — a refused portfolio turn reaches a funnel, not one grey line of chat', () => {
  // `misconfigured` and `workspace-collision` already had funnel views built;
  // they were reachable only from the startup status probe, so a TURN failing
  // for either reason rendered as inline chat text. And the card's copy blamed
  // the maya baseUrl unconditionally, so connecting it unchanged would have
  // pointed the reader at the wrong setting.
  it("shows the funnel with the error's own explanation, not the baseUrl copy", async () => {
    routeFetch([
      ['/api/maya/message', () => json({
        ok: false,
        error: {
          kind: 'misconfigured',
          message: 'this project declares no fluid.portfolio, so a portfolio turn has no members to ask',
        },
      })],
    ]);
    renderPanel();

    const input = await screen.findByPlaceholderText(/Message Maya/i);
    fireEvent.change(input, { target: { value: 'what did we decide' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/no fluid\.portfolio/)).toBeTruthy());
    expect(screen.queryByText(/has\s+no\s+baseUrl/)).toBeNull();
  });

  it('routes a workspace collision to its own funnel too', async () => {
    routeFetch([
      ['/api/maya/message', () => json({
        ok: false,
        error: { kind: 'workspace-collision', message: 'portfolio member(s) beta are configured at the colleague\'s own workspace' },
      })],
    ]);
    renderPanel();
    const input = await screen.findByPlaceholderText(/Message Maya/i);
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/configured at the colleague/)).toBeTruthy());
  });
});

describe('FOH-7 S4 — a turn funnel does not outlive the turn that opened it', () => {
  // Set and never cleared, the funnel is a dead end: the panel would keep
  // showing "this turn is misconfigured" after the configuration was fixed, with
  // no way back to the chat.
  it('offers a way back, and a later turn succeeds normally', async () => {
    let call = 0;
    routeFetch([
      ['/api/maya/message', () => {
        call += 1;
        return call === 1
          ? json({ ok: false, error: { kind: 'misconfigured', message: 'no fluid.portfolio declared here' } })
          : json({ ok: true, reply: 'all better', message_id: 'm2', context: { sent: [], omissions: [], blocks: [] } });
      }],
    ]);
    renderPanel();

    const input = await screen.findByPlaceholderText(/Message Maya/i);
    fireEvent.change(input, { target: { value: 'first' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/no fluid\.portfolio/)).toBeTruthy());

    // The funnel REPLACES the chat, so without an exit the panel is a dead end
    // until reload — worse than the inline error this replaced.
    fireEvent.click(screen.getByRole('button', { name: /back to the conversation/i }));

    const again = await screen.findByPlaceholderText(/Message Maya/i);
    fireEvent.change(again, { target: { value: 'second' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('all better')).toBeTruthy());
    expect(screen.queryByText(/no fluid\.portfolio/)).toBeNull();
  });
});
