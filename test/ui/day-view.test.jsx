/**
 * day-view.test.jsx — COMP-COCKPIT-RIBBON-TOP-1: the Day front page.
 *
 * One row table per behaviour. App rows render the whole shell (the URL and storage decide the first view); DayView rows
 * render the page with `/api/ribbon` answered from the shared fixture (`test/fixtures/ribbon/day.json`).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView, { EVT, IDLE_OPEN_KEY, sourceErrorLines, seatPcts } from '../../src/components/ribbon/DayView.jsx';

const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const PAST = '#ribbon.from=2026-10-20T00:00+08:00&to=2026-10-21T00:00+08:00';

function stubFetch(ribbon = FIXTURE) {
  wsFetch.mockImplementation(async (url) => (String(url).startsWith('/api/ribbon') ? ok(ribbon) : ok({})));
  global.fetch = vi.fn(async () => ok({}));
}

describe('Day front page (COMP-COCKPIT-RIBBON-TOP-1)', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
    wsFetch.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

  it('the first view per URL and storage (one row table)', async () => {
    stubFetch(); // the vision store fetches on import
    const { default: App } = await import('../../src/App.jsx');
    const rows = [
      { name: 'bare root', url: '/', want: 'day-view' },
      { name: '?view=dashboard opens Project home', url: '/?view=dashboard', want: 'home' },
      { name: 'a valid ribbon hash opens Day', url: `/${PAST}`, want: 'day-view' },
      { name: '?view=process with a ribbon hash opens Process', url: `/?view=process${PAST}`, want: 'sub-tab-process', selected: true },
      { name: 'a reload on Roadmap stays on Roadmap', url: '/', session: 'graph', want: 'sub-tab-graph', selected: true },
      { name: 'a broken ribbon hash does not open Day over the stored view', url: '/#ribbon.from=nope&to=nope', session: 'graph', want: 'sub-tab-graph', selected: true },
    ];
    for (const r of rows) {
      cleanup(); localStorage.clear(); sessionStorage.clear();
      window.history.pushState({}, '', r.url);
      if (r.session) sessionStorage.setItem('compose:activeView', r.session);
      stubFetch();
      render(<App />);
      const el = await screen.findByTestId(r.want, {}, { timeout: 5000 });
      if (r.selected) expect(el.getAttribute('aria-selected'), r.name).toBe('true');
    }
  }, 90000);

  it('the Projects tab, the breadcrumb and Esc (one row table, one App render)', async () => {
    stubFetch();
    window.history.pushState({}, '', '/?view=graph');
    const { default: App } = await import('../../src/App.jsx');
    render(<App />);
    const crumb = await screen.findByTestId('room-breadcrumb');
    const rows = [
      { name: 'breadcrumb parts', got: [...crumb.querySelectorAll('button')].map((b) => [b.dataset.testid, b.textContent]).map(([id, t]) => (id === 'crumb-project' ? [id, 'project'] : [id, t])), want: [['crumb-day', 'Day'], ['crumb-projects', 'Projects'], ['crumb-project', 'project'], ['crumb-room', 'Roadmap']] },
      { name: 'no chip, no hidden menu', got: [screen.queryByTestId('project-chip'), screen.queryByTestId('project-rooms')], want: [null, null] },
      { name: 'the Projects sub-row lists the five project rooms in order', got: [...screen.getByTestId('project-sub-tabs').querySelectorAll('[role="tab"]')].map((t) => t.dataset.testid), want: ['sub-tab-home', 'sub-tab-ideas', 'sub-tab-roadmap', 'sub-tab-build', 'sub-tab-review'] },
      { name: 'top row tabs', got: screen.getAllByRole('tab').filter((t) => t.dataset.testid.startsWith('room-tab-')).map((t) => t.dataset.testid), want: ['room-tab-day', 'room-tab-projects', 'room-tab-fleet', 'room-tab-library', 'room-tab-settings'] },
    ];
    for (const r of rows) expect(r.got, r.name).toEqual(r.want);
    fireEvent.click(screen.getByTestId('sub-tab-ideas'));
    await waitFor(() => expect(screen.getByTestId('crumb-room').textContent).toBe('Ideas'));
    // Esc from a project room's top level goes back to Day; a second Esc on Day does nothing.
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    await screen.findByTestId('day-view');
    expect(screen.queryByTestId('room-breadcrumb')).toBeNull();
    // The Projects tab re-opens the last project room, and the breadcrumb's Day part is a way back too.
    fireEvent.click(screen.getByTestId('room-tab-projects'));
    await waitFor(() => expect(screen.getByTestId('crumb-room').textContent).toBe('Ideas'));
    fireEvent.click(screen.getByTestId('crumb-day'));
    await screen.findByTestId('day-view');
  }, 60000);

  it('a past window from the hash is not following: no NOW line, the window is the hash', async () => {
    stubFetch();
    window.history.pushState({}, '', `/${PAST}`);
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('day-ribbon');
    // U2: Live is a toggle (aria-pressed), never disabled; the pickers open from the ribbon title.
    expect(screen.getByTestId('range-now').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('ribbon-title-button'));
    expect(screen.getByTestId('range-start').value).toBe('2026-10-20T00:00');
    expect(wsFetch.mock.calls.map((c) => c[0]).some((u) => u.includes(encodeURIComponent('2026-10-20T00:00+08:00')))).toBe(true);
  }, 30000);

  it('renders the WHAT line, range bar, ribbon, meter and the two footer links with fixtures', async () => {
    stubFetch();
    const onNavigate = vi.fn();
    render(<DayView onNavigate={onNavigate} />);
    expect(screen.getByTestId('day-skeleton')).toBeTruthy();
    await screen.findByTestId('day-ribbon');
    const parts = [
      { part: 'WHAT line (skeleton or line)', has: !!(screen.queryByTestId('what-line') || screen.queryByTestId('what-line-skeleton')) },
      { part: 'range bar', has: !!screen.queryByTestId('range-bar') },
      { part: 'ribbon', has: !!screen.queryByTestId('day-ribbon') },
      { part: 'meter', has: !!screen.queryByTestId('cost-meter') },
      { part: 'footer', has: !!screen.queryByTestId('day-footer') },
    ];
    for (const p of parts) expect(p.has, p.part).toBe(true);
    expect(screen.queryByTestId('day-skeleton')).toBeNull();
    // COMP-DAYVIEW-SPLIT-1 (owner 2026-11-03): the meter is full size with no scroll inside it, so the toggle that opened the
    // old capped box is gone; the upper panel is the resizable one, and the page (the root) scrolls.
    const box = screen.getByTestId('day-meter-box');
    expect([screen.queryByTestId('day-meter-toggle'), /max-h-|overflow-y-auto|overflow-auto/.test(box.className), !!box.querySelector('[data-testid="cost-meter"]')]).toEqual([null, false, true]);
    expect(screen.getByTestId('day-view').className.split(/\s+/)).toContain('overflow-y-auto');
    fireEvent.click(screen.getByTestId('day-link-process'));
    fireEvent.click(screen.getByTestId('day-link-ops'));
    expect(onNavigate.mock.calls.map((c) => c[0])).toEqual(['process', 'ops']);
  }, 30000);

  it('a lane click: the fallback opens Fleet > Process, a listener that takes the event stops it', async () => {
    stubFetch();
    const onNavigate = vi.fn();
    render(<DayView onNavigate={onNavigate} />);
    const lane = await screen.findByTestId('lane-main');
    fireEvent.click(lane);
    // RIBBON-LANE-1: the lane layer is the listener now, so a click on a lane the feed has opens its drawer, not Fleet > Process.
    expect([onNavigate.mock.calls, !!screen.queryByTestId('lane-drawer')]).toEqual([[], true]);
    fireEvent.click(screen.getByTestId('lane-drawer-close'));

    onNavigate.mockClear();
    const seen = [];
    const take = (e) => { seen.push(e.detail); e.preventDefault(); };
    window.addEventListener(EVT.openLane, take);
    fireEvent.click(screen.getByTestId('lane-main'));
    window.removeEventListener(EVT.openLane, take);
    expect(seen).toEqual([{ lane: 'main' }]);
    expect(onNavigate).not.toHaveBeenCalled();
  }, 30000);

  it('compose:ribbon-focus flashes the lane and opens the idle fold when the lane is folded', async () => {
    stubFetch();
    render(<DayView onNavigate={() => {}} />);
    const fold = await screen.findAllByTestId('idle-row');
    expect(fold[0].getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('lane-maya')).toBeNull();
    await act(async () => { window.dispatchEvent(new CustomEvent(EVT.focus, { detail: { lane: 'maya' } })); });
    await waitFor(() => expect(screen.getByTestId('lane-maya')).toBeTruthy());
    expect(screen.getByTestId('lane-maya').getAttribute('class')).toContain('rb-flash');
    expect(sessionStorage.getItem(IDLE_OPEN_KEY)).toBe('1');
    expect(screen.getAllByTestId('idle-row')[0].getAttribute('aria-expanded')).toBe('true');
  }, 30000);

  it('a missing source is named in plain words under the ribbon and the ribbon still draws', async () => {
    stubFetch({ ...FIXTURE, sourceErrors: { ownerQueue: 'wiki stopped', ledger: 'no file' } });
    render(<DayView onNavigate={() => {}} />);
    const list = await screen.findByTestId('day-source-errors');
    // U2 M4: plain words on screen, the raw reason only in the title.
    expect(list.textContent).toContain('Questions waiting on you: not read yet, retrying');
    expect(list.textContent).toContain('Landings and deploys: not read yet, retrying');
    expect(list.textContent).not.toContain('wiki stopped');
    expect(list.querySelectorAll('[title="wiki stopped"]').length).toBe(1);
    expect(screen.getByTestId('day-ribbon')).toBeTruthy();
  }, 30000);

  it('alert marks (NOTIFY-ACTIONS-1): an age in seconds lands at now - age; a stored entry whose source is gone still draws, cleared', async () => {
    const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const now = Date.now();
    const fleet = {
      sources: { sm_status: { value: { queue: { value: [{ id: 'S9', by: 'ops-main', text: 'SECURITY: test row', age: 1800, red: false }], error: null } }, error: null } },
      generated: new Date(now).toISOString(),
      notify: { v: 1, entries: { outage: { action: 'released', was: 'dismiss', at: new Date(now - 600_000).toISOString(), title: 'Claude API outage', sinceAt: new Date(now - 3_600_000).toISOString() } } },
    };
    wsFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.startsWith('/api/ribbon')) return ok(FIXTURE);
      if (u === '/api/fleet') return ok(fleet);
      return ok({});
    });
    global.fetch = vi.fn(async () => ok({}));
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('day-ribbon');
    // RESETS-COMPACT-1: both rows are lane-less, so they ride the range bar's alert chip (one open, one cleared) with the same tips.
    const chip = await screen.findByTestId('ribbon-alert-chip');
    expect(chip.textContent).toBe('⚠ 1 (+1 cleared)');
    expect(screen.queryAllByTestId('alert-mark')).toHaveLength(0);
    const lines = chip.getAttribute('title').split('\n');
    expect(lines).toHaveLength(2);
    const sec = lines.find((t) => t.startsWith('Alert · test row'));
    // the page reads its own clock a moment later: either minute is the right one
    expect([hm(now - 1_800_000), hm(now - 1_800_000 + 10_000)].some((t) => sec.includes(t))).toBe(true);
    const out = lines.find((t) => t.includes('Claude API outage'));
    expect(out).toContain(hm(now - 3_600_000));
    expect(out).toContain(`dismissed ${hm(now - 600_000)}`);
  }, 30000);

  it('pure helpers: source words and the seat percents the idle fold reads (one row table)', () => {
    const rows = [
      { name: 'known key', got: sourceErrorLines({ stamps: 'x' }), want: [{ key: 'stamps', text: 'What each lane is doing: not read yet, retrying', title: 'x' }] },
      { name: 'unknown key keeps its name', got: sourceErrorLines({ weird: 'y' }), want: [{ key: 'weird', text: 'weird: not read yet, retrying', title: 'y' }] },
      { name: 'one line per top-level source, reasons joined', got: sourceErrorLines({ 'quota.seat3': 'a', 'quota.seat4': 'b' }), want: [{ key: 'quota', text: 'Seat resets and quota waits: not read yet, retrying', title: 'a; b' }] },
      { name: 'a last clean read is named in the ref offset', got: sourceErrorLines({ seats: 'z' }, { seats: Date.parse('2026-11-03T06:02:00Z') }, '2026-11-03T16:00:00+08:00'), want: [{ key: 'seats', text: 'Seat usage: not read since 14:02, retrying', title: 'z' }] },
      { name: 'none', got: sourceErrorLines(undefined), want: [] },
      { name: 'seats: retired and the codex row are left out, a missing reading is null', got: seatPcts([
        { label: 'seat1', five_h: { used_pct: 40 } }, { label: 'seat2', retired: true, five_h: { used_pct: 10 } },
        { label: 'codex', codex_daily: {}, five_h: { used_pct: 5 } }, { label: 'seat3' },
      ]), want: [{ label: 'seat1', pct: 40 }, { label: 'seat3', pct: null }] },
    ];
    for (const r of rows) expect(r.got, r.name).toEqual(r.want);
  });
});
