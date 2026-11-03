/**
 * COMP-COCKPIT-NOTIFY-ACTIONS-1: inline actions on the chip tray, the inbox drawer and the security banner.
 * fetch is faked at the boundary only, by one small in-memory server: GET /api/fleet (the queue plus `notify`), the
 * cadence reads, POST /api/notify/state (applies the write, answers the whole list) and POST /api/fleet/owner-answer
 * (ProductReply bodies). A fleet re-poll is asked for the way the page does it, with a visibilitychange.
 * One row table: [name, scenario].
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

vi.mock('../../src/components/vision/useVisionStore.js', () => {
  const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], resolveGate: null, iterationStates: new Map() };
  return { useVisionStore: (sel) => (typeof sel === 'function' ? sel(s) : s) };
});

const { default: NotifyChip } = await import('../../src/components/cockpit/notify/NotifyChip.jsx');
const { default: SecurityBanner } = await import('../../src/components/cockpit/notify/SecurityBanner.jsx');
const { resetNotifyPoller } = await import('../../src/components/cockpit/notify/useNotifySources.js');
const { resetNotifyState, publishSeats } = await import('../../src/components/cockpit/notify/useNotifyState.js');

const up = (value) => ({ value, error: null });
const Q = {
  sec: { id: 'sec-1', by: 'ops-main', text: 'SECURITY: a token in history', age: 7200, red: true },
  opt: { id: 'ask-opt', by: 'ops-main', text: 'QUESTION: ship it? (a) yes (b) no', age: 900, red: false },
  free: { id: 'ask-free', by: 'ops-main', text: 'QUESTION: what should the cap be?', age: 600, red: false },
  fyi: { id: 'fyi-1', by: 'ops-main', text: 'FYI: moved the cron', age: 60, red: false },
};
const WALL = { name: 'seat1 5h', state: 'tripped', value: 99, trip: 95 };

/** The fake server. `answer(body)` returns `[status, json]`; `hold` delays the answer until released. */
function fakeServer({ queue = [Q.sec, Q.opt, Q.free, Q.fyi], alerts = [WALL] } = {}) {
  const s = { queue: [...queue], alerts, entries: {}, posts: [], failState: null, hold: null };
  s.answer = (body) => {
    s.entries[`${body.resolve ? 'security' : 'ask'}:${body.id}`] = { action: 'answered', at: new Date().toISOString(), answer: `OWNER (via cockpit): ${body.choice ? `(${body.choice})` : body.text}`, first: 'answered row' };
    s.queue = s.queue.filter((q) => q.id !== body.id);
    return [200, { reply: 'accepted' }];
  };
  const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === 'POST') s.posts.push([u, body]);
    if (u === '/api/fleet') {
      return reply(200, {
        sources: { sm_status: up({ queue: up(s.queue), sessions: up([]), df: up({ free_gb: 500 }) }) },
        generated: new Date().toISOString(),
        notify: { v: 1, entries: { ...s.entries } },
      });
    }
    if (u.endsWith('/outage')) return reply(200, { state: 'ok' });
    if (u.endsWith('/attention')) return reply(200, { alerts: s.alerts });
    if (u.endsWith('/review')) return reply(200, { reviewMaxH: 24, inReview: [], inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, errors: [] });
    if (u === '/api/notify/state' && method === 'POST') {
      if (s.failState && (!s.failOnly || s.failOnly === body.action)) return reply(500, { ok: false, error: s.failState });
      if (body.action === 'restore' || body.action === 'release') delete s.entries[body.key];
      else s.entries[body.key] = { action: body.action, at: new Date().toISOString(), ...(body.until ? { until: body.until } : {}), ...(body.meta ?? {}) };
      return reply(200, { ok: true, v: 1, entries: { ...s.entries }, generated: new Date().toISOString() });
    }
    if (u === '/api/fleet/owner-answer' && method === 'POST') {
      if (s.hold) await s.hold;
      const [status, json] = s.answer(body);
      return reply(status, json);
    }
    return reply(404, {});
  });
  return s;
}

const repoll = async () => {
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise((r) => setTimeout(r, 0)); });
};
const mountChip = async (props = {}) => {
  const view = render(<NotifyChip {...props} />);
  await waitFor(() => expect(screen.getByTestId('notify-chip').getAttribute('data-state')).not.toBe('loading'));
  return view;
};
const openTray = async () => { await mountChip(); fireEvent.click(screen.getByTestId('notify-chip')); return screen.getByTestId('notify-tray'); };
const openDrawer = async () => {
  await mountChip();
  act(() => { window.dispatchEvent(new CustomEvent('compose:open-inbox', { cancelable: true })); });
  return screen.findByTestId('inbox-drawer');
};
const drawerRow = (id) => screen.getAllByTestId('inbox-row').find((r) => r.getAttribute('data-id') === id);
const trayRow = (title) => screen.getAllByTestId(/^notify-row/).find((r) => r.textContent.includes(title));
const chipText = () => screen.getByTestId('notify-chip').textContent;
const posted = (s, url) => s.posts.filter(([u]) => u === url).map(([, b]) => b);
const key = (k) => fireEvent.keyDown(document.body, { key: k });

const ROWS = [
  ['an ask with options: one button per option; a click sends that choice and shows "answered HH:MM"', async () => {
    const s = fakeServer();
    await openDrawer();
    const row = drawerRow('ask-opt');
    expect(within(row).getByTestId('notify-actions').getAttribute('data-class')).toBe('ask');
    expect(within(row).getAllByTestId('notify-option').map((b) => b.textContent)).toEqual(['(a) yes', '(b) no']);
    fireEvent.click(within(row).getAllByTestId('notify-option')[1]);
    await waitFor(() => expect(within(drawerRow('ask-opt')).getByTestId('notify-answered').textContent).toMatch(/^answered \d\d:\d\d: OWNER \(via cockpit\): \(b\) no$/));
    expect(posted(s, '/api/fleet/owner-answer')).toEqual([{ id: 'ask-opt', choice: 'b' }]);
    expect(drawerRow('ask-opt').getAttribute('data-answered')).toBe('true');
  }],
  ['accepted, then a fleet body without the id: the row leaves its group for the Answered fold', async () => {
    fakeServer();
    await openDrawer();
    fireEvent.click(within(drawerRow('ask-opt')).getAllByTestId('notify-option')[0]);
    await waitFor(() => expect(within(drawerRow('ask-opt')).queryByTestId('notify-answered')).not.toBeNull());
    await repoll();
    await waitFor(() => expect(screen.queryAllByTestId('inbox-row').map((r) => r.getAttribute('data-id'))).not.toContain('ask-opt'));
    fireEvent.click(screen.getByTestId('inbox-answered-toggle'));
    expect(screen.getAllByTestId('inbox-answered-row')).toHaveLength(1);
    expect(screen.getByTestId('inbox-answered-row').textContent).toMatch(/answered \d\d:\d\d: OWNER \(via cockpit\): \(a\)/);
  }],
  ['a free-text-only ask: no option buttons; Send is off until text is typed and sends the text', async () => {
    const s = fakeServer();
    await openDrawer();
    const row = drawerRow('ask-free');
    expect(within(row).queryAllByTestId('notify-option')).toHaveLength(0);
    expect(within(row).getByTestId('notify-send').disabled).toBe(true);
    fireEvent.change(within(row).getByTestId('notify-reply'), { target: { value: '  cap at 12  ' } });
    fireEvent.click(within(row).getByTestId('notify-send'));
    await waitFor(() => expect(within(drawerRow('ask-free')).queryByTestId('notify-answered')).not.toBeNull());
    expect(posted(s, '/api/fleet/owner-answer')).toEqual([{ id: 'ask-free', text: 'cap at 12' }]);
  }],
  ['Enter in the reply box does not submit', async () => {
    const s = fakeServer();
    await openDrawer();
    const input = within(drawerRow('ask-free')).getByTestId('notify-reply');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(posted(s, '/api/fleet/owner-answer')).toEqual([]);
  }],
  ['while sending, every control on that ask is disabled and the line says Sending…', async () => {
    const s = fakeServer();
    let release;
    s.hold = new Promise((r) => { release = r; });
    await openDrawer();
    fireEvent.click(within(drawerRow('ask-opt')).getAllByTestId('notify-option')[0]);
    await waitFor(() => expect(within(drawerRow('ask-opt')).getByTestId('notify-answer-line').getAttribute('data-phase')).toBe('sending'));
    const row = drawerRow('ask-opt');
    expect(within(row).getAllByTestId('notify-option').every((b) => b.disabled)).toBe(true);
    expect(within(row).getByTestId('notify-reply').disabled).toBe(true);
    expect(within(row).getByTestId('notify-send').disabled).toBe(true);
    await act(async () => { release(); await s.hold; });
    await waitFor(() => expect(within(drawerRow('ask-opt')).queryByTestId('notify-answered')).not.toBeNull());
  }],
  ['conflict: the row stays open and names the winning answer and its channel', async () => {
    const s = fakeServer();
    s.answer = () => [200, { reply: 'conflict', winning_value: '(a) yes', channel: 's1-chat' }];
    await openDrawer();
    fireEvent.click(within(drawerRow('ask-opt')).getAllByTestId('notify-option')[1]);
    const line = await waitFor(() => within(drawerRow('ask-opt')).getByTestId('notify-answer-line'));
    expect(line.getAttribute('data-phase')).toBe('conflict');
    expect(line.textContent).toBe('Already answered (via s1-chat): (a) yes');
    expect(drawerRow('ask-opt').getAttribute('data-answered')).toBe('false');
  }],
  ['rejected and a route error: "Not sent" with the reason, controls usable again', async () => {
    const s = fakeServer();
    s.answer = () => [200, { reply: 'rejected', reason: 'the row is not open' }];
    await openDrawer();
    fireEvent.click(within(drawerRow('ask-opt')).getAllByTestId('notify-option')[0]);
    await waitFor(() => expect(within(drawerRow('ask-opt')).getByTestId('notify-answer-line').textContent).toBe('Not sent: the row is not open'));
    expect(within(drawerRow('ask-opt')).getAllByTestId('notify-option')[0].disabled).toBe(false);
    s.answer = () => [502, { error: 'owner_queue.py exited 2' }];
    fireEvent.click(within(drawerRow('ask-opt')).getAllByTestId('notify-option')[0]);
    await waitFor(() => expect(within(drawerRow('ask-opt')).getByTestId('notify-answer-line').textContent).toBe('Not sent: owner_queue.py exited 2'));
    expect(within(drawerRow('ask-opt')).getByTestId('notify-answer-line').getAttribute('data-phase')).toBe('error');
  }],
  ['alert Acknowledge: the row leaves the count, sits under Cleared (1) with Restore, Restore brings it back', async () => {
    const s = fakeServer();
    await openTray();
    expect(chipText()).toContain('3 alerts · Cadence');
    fireEvent.click(within(trayRow('seat1 5h')).getByTestId('notify-ack'));
    await waitFor(() => expect(chipText()).toMatch(/3 alerts$/));
    expect(posted(s, '/api/notify/state').at(-1)).toMatchObject({ key: 'attention:seat1 5h', action: 'ack' });
    fireEvent.click(screen.getByTestId('notify-cleared-toggle'));
    const cleared = screen.getByTestId('notify-row-cleared');
    expect(within(cleared).getByTestId('notify-cleared-line').textContent).toMatch(/^acknowledged \d\d:\d\d/);
    fireEvent.click(within(cleared).getByTestId('notify-restore'));
    await waitFor(() => expect(chipText()).toContain('3 alerts · Cadence'));
    expect(posted(s, '/api/notify/state').at(-1)).toEqual({ key: 'attention:seat1 5h', action: 'restore' });
  }],
  ['alert Dismiss then Restore', async () => {
    const s = fakeServer();
    await openTray();
    fireEvent.click(within(trayRow('seat1 5h')).getByTestId('notify-dismiss'));
    await waitFor(() => expect(chipText()).toMatch(/3 alerts$/));
    expect(s.entries['attention:seat1 5h'].action).toBe('dismiss');
    fireEvent.click(screen.getByTestId('notify-cleared-toggle'));
    expect(within(screen.getByTestId('notify-row-cleared')).getByTestId('notify-cleared-line').textContent).toMatch(/^dismissed/);
    fireEvent.click(within(screen.getByTestId('notify-row-cleared')).getByTestId('notify-restore'));
    await waitFor(() => expect(chipText()).toContain('3 alerts · Cadence'));
    expect(s.entries['attention:seat1 5h']).toBeUndefined();
  }],
  ['snooze menu: "Until reset" only once the Day page published the seat; a pick stores until', async () => {
    const s = fakeServer();
    await openTray();
    fireEvent.click(within(trayRow('seat1 5h')).getByTestId('notify-snooze'));
    expect(within(screen.getByTestId('notify-snooze-menu')).getAllByRole('menuitem').map((b) => b.getAttribute('data-testid')))
      .toEqual(['notify-snooze-1h', 'notify-snooze-tomorrow']);
    const resets = new Date(Date.now() + 2 * 3_600_000).toISOString();
    act(() => publishSeats([{ id: 'seat1', five_h: { resets_at: resets } }]));
    expect(within(screen.getByTestId('notify-snooze-menu')).getAllByRole('menuitem').map((b) => b.getAttribute('data-testid')))
      .toEqual(['notify-snooze-1h', 'notify-snooze-reset', 'notify-snooze-tomorrow']);
    fireEvent.click(screen.getByTestId('notify-snooze-reset'));
    await waitFor(() => expect(chipText()).toMatch(/3 alerts$/));
    expect(posted(s, '/api/notify/state').at(-1)).toMatchObject({ key: 'attention:seat1 5h', action: 'snooze', until: resets });
    expect(screen.queryByTestId('notify-snooze-menu')).toBeNull();
  }],
  ['a failed write moves the row back and says why', async () => {
    const s = fakeServer();
    s.failState = 'disk is read-only';
    await openTray();
    fireEvent.click(within(trayRow('seat1 5h')).getByTestId('notify-ack'));
    await waitFor(() => expect(within(trayRow('seat1 5h')).getByTestId('notify-write-error').textContent).toBe('Not saved: disk is read-only'));
    expect(chipText()).toContain('3 alerts · Cadence');
  }],
  ['info row (FYI) Acknowledge in the drawer: it moves into the Cleared fold, the chip never counted it', async () => {
    const s = fakeServer();
    await openDrawer();
    expect(chipText()).toContain('3 alerts · Cadence');
    fireEvent.click(screen.getAllByTestId('inbox-group-toggle').find((b) => b.textContent.includes('fyi')));
    const row = drawerRow('fyi-1');
    expect(within(row).getByTestId('notify-actions').getAttribute('data-class')).toBe('info');
    fireEvent.click(within(row).getByTestId('notify-ack'));
    await waitFor(() => expect(screen.getByTestId('inbox-cleared-toggle').textContent).toContain('Cleared (1)'));
    expect(screen.queryAllByTestId('inbox-row').map((r) => r.getAttribute('data-id'))).not.toContain('fyi-1');
    expect(posted(s, '/api/notify/state').at(-1)).toMatchObject({ key: 'queue:fyi-1', action: 'ack' });
    expect(chipText()).toContain('3 alerts · Cadence');
  }],
  ['security banner Acknowledge: the banner goes, the chip stays at its count, the drawer row is marked acknowledged', async () => {
    const s = fakeServer();
    render(<SecurityBanner />);
    await openDrawer();
    expect(await screen.findByTestId('security-banner')).toBeTruthy();
    expect(within(drawerRow('sec-1')).getByTestId('notify-actions').getAttribute('data-class')).toBe('security');
    expect(within(drawerRow('sec-1')).queryByTestId('notify-dismiss')).toBeNull();
    expect(within(drawerRow('sec-1')).queryByTestId('notify-snooze')).toBeNull();
    fireEvent.click(screen.getByTestId('security-banner-ack'));
    await waitFor(() => expect(screen.queryByTestId('security-banner')).toBeNull());
    expect(posted(s, '/api/notify/state').at(-1)).toMatchObject({ key: 'security:sec-1', action: 'ack' });
    expect(posted(s, '/api/notify/state').at(-1).meta.textHash).toMatch(/^[0-9a-f]{8}$/);
    expect(chipText()).toContain('3 alerts · Cadence');
    expect(drawerRow('sec-1').getAttribute('data-acked')).toBe('true');
    expect(within(drawerRow('sec-1')).getByTestId('notify-acked').textContent).toMatch(/^acknowledged \d\d:\d\d$/);
  }],
  ['security Resolved…: Confirm needs text, sends resolve through the answer route, the banner goes', async () => {
    const s = fakeServer();
    render(<SecurityBanner />);
    await mountChip();
    fireEvent.click(await screen.findByTestId('security-resolve'));
    expect(screen.getByTestId('security-resolve-confirm').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('security-resolve-text'), { target: { value: 'rotated it' } });
    fireEvent.click(screen.getByTestId('security-resolve-confirm'));
    await waitFor(() => expect(screen.queryByTestId('security-banner')).toBeNull());
    expect(posted(s, '/api/fleet/owner-answer')).toEqual([{ id: 'sec-1', resolve: true, text: 'rotated it' }]);
    expect(posted(s, '/api/notify/state')).toEqual([]);
  }],
  ['keys in the tray: j/k select, a focuses the first option, d dismisses, s opens snooze, Esc closes only the menu, security says why not', async () => {
    const s = fakeServer();
    await openTray();
    const idx = (i) => screen.getByTestId('notify-tray').querySelector(`[data-row-index="${i}"]`);
    // rows: security, ask-opt, ask-free, wall
    key('j');
    expect(idx(0).getAttribute('aria-selected')).toBe('true');
    key('d');
    expect(screen.getByTestId('notify-key-hint').textContent).toBe('security rows can be acknowledged or resolved');
    key('j');
    expect(idx(1).getAttribute('aria-selected')).toBe('true');
    key('a');
    expect(document.activeElement.getAttribute('data-action')).toBe('option');
    expect(posted(s, '/api/fleet/owner-answer')).toEqual([]);
    act(() => document.activeElement.blur());
    key('j'); key('j'); key('j');
    expect(idx(3).getAttribute('aria-selected')).toBe('true');
    key('k'); key('j');
    expect(idx(3).getAttribute('aria-selected')).toBe('true');
    key('s');
    expect(screen.getByTestId('notify-snooze-menu')).toBeTruthy();
    key('Escape');
    expect(screen.queryByTestId('notify-snooze-menu')).toBeNull();
    expect(screen.getByTestId('notify-tray')).toBeTruthy();
    key('d');
    await waitFor(() => expect(chipText()).toMatch(/3 alerts$/));
    expect(posted(s, '/api/notify/state').at(-1)).toMatchObject({ key: 'attention:seat1 5h', action: 'dismiss' });
    key('Escape');
    expect(screen.queryByTestId('notify-tray')).toBeNull();
  }],
  ['at 390 px the tray is held inside the viewport and every action is still on the row', async () => {
    fakeServer();
    const prev = window.innerWidth;
    window.innerWidth = 390;
    window.dispatchEvent(new Event('resize'));
    try {
      const tray = await openTray();
      expect(tray.className).toContain('max-w-[calc(100vw-1rem)]');
      expect(tray.className).toContain('max-h-[70vh]');
      expect(screen.getAllByTestId('notify-actions').map((a) => a.getAttribute('data-class'))).toEqual(['security', 'ask', 'ask', 'alert']);
      for (const b of tray.querySelectorAll('button')) expect(b.className).not.toMatch(/text-\[(?:[0-9]|10)px\]|opacity-/);
    } finally {
      window.innerWidth = prev;
    }
  }],
  ['a recurring alert is released on every ack: ack, gone, back, ack, gone, back sends two releases and leaves the row open', async () => {
    const s = fakeServer();
    const tray = await openTray();
    expect(tray).toBeTruthy();
    for (let round = 1; round <= 2; round += 1) {
      fireEvent.click(within(trayRow('seat1 5h')).getByTestId('notify-dismiss'));
      await waitFor(() => expect(s.entries['attention:seat1 5h']).toBeTruthy(), { timeout: 5000 });
      s.alerts = [];
      await repoll();
      await waitFor(() => expect(posted(s, '/api/notify/state').filter((b) => b.action === 'release')).toHaveLength(round), { timeout: 5000 });
      s.alerts = [WALL];
      await repoll();
      await waitFor(() => expect(trayRow('seat1 5h')).toBeTruthy(), { timeout: 5000 });
    }
    expect(posted(s, '/api/notify/state').filter((b) => b.action === 'release')).toEqual([
      { key: 'attention:seat1 5h', action: 'release' }, { key: 'attention:seat1 5h', action: 'release' }]);
    expect(within(trayRow('seat1 5h')).queryByTestId('notify-dismiss')).not.toBeNull();
  }],
  ['a failed release POST is retried on the next poll, and does not loop on its own re-render', async () => {
    const s = fakeServer();
    await openTray();
    fireEvent.click(within(trayRow('seat1 5h')).getByTestId('notify-dismiss'));
    await waitFor(() => expect(s.entries['attention:seat1 5h']).toBeTruthy(), { timeout: 5000 });
    s.alerts = [];
    s.failState = 'boom';
    s.failOnly = 'release';
    await repoll();
    await waitFor(() => expect(posted(s, '/api/notify/state').filter((b) => b.action === 'release')).toHaveLength(1), { timeout: 5000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(posted(s, '/api/notify/state').filter((b) => b.action === 'release')).toHaveLength(1);
    s.failState = null;
    await repoll();
    await waitFor(() => expect(posted(s, '/api/notify/state').filter((b) => b.action === 'release')).toHaveLength(2), { timeout: 5000 });
    await waitFor(() => expect(s.entries['attention:seat1 5h']).toBeUndefined(), { timeout: 5000 });
  }],
  ['a security id re-raised after a cockpit resolve, in the same page, shows its controls again in the tray (answerHolds, as the asks path)', async () => {
    const s = fakeServer();
    await openTray();
    fireEvent.click(within(trayRow('a token in history')).getByTestId('security-resolve'));
    fireEvent.change(within(trayRow('a token in history')).getByTestId('security-resolve-text'), { target: { value: 'rotated it' } });
    fireEvent.click(within(trayRow('a token in history')).getByTestId('security-resolve-confirm'));
    await waitFor(() => expect(within(trayRow('a token in history')).queryByTestId('notify-resolved')).not.toBeNull(), { timeout: 1500 });
    await repoll(); // the server's own answered entry arrives and settles the page's overlay
    // the same id comes back as a NEW record: ten minutes later it opened 5 s ago, well past the answer's slack
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: Date.now() + 600_000 });
    s.queue = [{ ...Q.sec, age: 5 }];
    await repoll();
    await waitFor(() => expect(within(trayRow('a token in history')).queryByTestId('notify-resolved')).toBeNull(), { timeout: 1500 });
  }],
];

describe('COMP-COCKPIT-NOTIFY-ACTIONS-1 inline actions', () => {
  beforeEach(() => { resetFleetPoller(); resetNotifyPoller(); resetNotifyState(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it.each(ROWS)('%s', async (_name, scenario) => { await scenario(); });
});
