/**
 * dayview-u3.test.jsx — COMP-DAYVIEW-DESIGN-FIX-1 U3: the rendered half of the U3 boxes.
 *
 * The shared source state (review U2 F2 + SOURCE-ENVELOPE-1): every branch of the Day page (phone, desktop, Now drawer)
 * says when its data is old or incomplete. F4 (a past window never claims to retry), F6 (the svg is the content box's
 * width), the window-cache fetch time, the InboxDrawer focus left over from a loading open, the AHEAD tick's measured
 * width, and the polish list: marks as shapes, 24 px hits, a 2 px span gap, one as-of, accent links, the money bars, the
 * phone's 12 h strip and the header strip at 400 px.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView from '../../src/components/ribbon/DayView.jsx';
import DayRibbon, { ASOF_LAG_MS, hitBounds } from '../../src/components/ribbon/DayRibbon.jsx';
import { useRibbonFeed, RIBBON_POLL_MS } from '../../src/components/ribbon/useRibbonFeed.js';
import { HourBars } from '../../src/components/ribbon/meter/MeterPopover.jsx';
import InboxDrawer from '../../src/components/cockpit/notify/InboxDrawer.jsx';
import { HeaderCounters, AgentStatusPill } from '../../src/components/cockpit/HeaderStatus.jsx';
import WhatLine from '../../src/components/cockpit/what/WhatLine.jsx';
import { formatHash } from '../../src/components/ribbon/rangeLogic.js';
import { textWidth } from '../../src/components/ribbon/textFit.js';
import { sourceNoteText } from '../../src/lib/sourceState.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';
import { resetUnitIndex } from '../../src/lib/useUnitIndex.js';

const RIBBON = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const setWidth = (w) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
const clone = (o) => JSON.parse(JSON.stringify(o));
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const FLEET = {
  generated: new Date().toISOString(),
  sources: { sm_status: { value: { sessions: { value: [], error: null }, jobs: { value: [], error: null }, queue: { value: [], error: null } }, error: null, ts: 1, stale: false } },
};
const T0 = Date.parse('2026-11-03T10:59:30');
const PAST = { from: '2026-10-20T00:00:00-07:00', to: '2026-10-21T00:00:00-07:00' };
const isPast = (u) => String(u).includes(encodeURIComponent(PAST.from));

/**
 * `ribbon(url, n)` answers the n-th /api/ribbon call (0-based) for that url kind; it may throw (a rejected poll).
 * `index` is the /api/units/index response.
 */
function stub({ ribbon = () => ok(RIBBON), index = ok({ asOf: new Date().toISOString(), units: [] }), fleet = ok(FLEET) } = {}) {
  const calls = { live: 0, past: 0 };
  wsFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/ribbon')) {
      const kind = isPast(u) ? 'past' : 'live';
      return ribbon(u, calls[kind]++, kind);
    }
    if (u.startsWith('/api/fleet')) return typeof fleet === 'function' ? fleet() : fleet;
    if (u.startsWith('/api/units/index')) return index;
    return ok({});
  });
  global.fetch = vi.fn(async () => ok({}));
  return calls;
}
/** Run every 120 s poll the page armed, at `T0 + 120 s` on the clock. */
async function pollAt120(interval) {
  vi.setSystemTime(T0 + RIBBON_POLL_MS);
  const ticks = interval.mock.calls.filter((c) => c[1] === RIBBON_POLL_MS).map((c) => c[0]);
  expect(ticks.length).toBeGreaterThan(0);
  await act(async () => { for (const t of ticks) t(); await Promise.resolve(); await Promise.resolve(); });
}
const notes = (root) => [...root.querySelectorAll('[data-testid="source-note"]')];

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
  wsFetch.mockReset(); resetFleetPoller(); resetUnitIndex(); setWidth(1440);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); setWidth(1024); });

describe('U3 shared source state: every branch says when its data is old (review U2 F2)', () => {
  // [name, width, window, which ribbon read fails, where to look, source word]
  const ROWS = [
    ['phone, live window: a good read then a rejected poll', 400, null, 'live', 'day-phone-now', 'The ribbon'],
    ['desktop, past window: the Now feed behind it', 1440, PAST, 'live', 'day-view', 'The Now list'],
    ['phone, past window: the Now feed it reads', 400, PAST, 'live', 'day-phone-now', 'The Now list'],
  ];
  for (const [name, width, win, failKind, where, source] of ROWS) {
    it(name, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
      setWidth(width);
      if (win) window.history.replaceState(null, '', `/${formatHash(win)}`);
      const interval = vi.spyOn(globalThis, 'setInterval');
      stub({ ribbon: (u, n, kind) => { if (kind === failKind && n > 0) throw new Error('network down'); return ok(RIBBON); } });
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId(width < 768 ? 'day-phone-lanes' : 'day-ribbon');
      expect(notes(document.body)).toHaveLength(0);
      await pollAt120(interval);
      const box = screen.getByTestId(where);
      await waitFor(() => expect(notes(box).some((n) => n.getAttribute('data-source') === source)).toBe(true));
      const text = notes(box).find((n) => n.getAttribute('data-source') === source).textContent;
      expect(text).toContain(`unreadable since ${hhmm(T0 + RIBBON_POLL_MS)}`);
      expect(text).toContain(`last good read from ${hhmm(T0)}`);
    }, 30000);
  }

  it('the Now drawer draws the same note as the page under it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    window.history.replaceState(null, '', `/${formatHash(PAST)}`);
    const interval = vi.spyOn(globalThis, 'setInterval');
    stub({ ribbon: (u, n, kind) => { if (kind === 'live' && n > 0) throw new Error('network down'); return ok(RIBBON); } });
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('day-ribbon');
    await pollAt120(interval);
    fireEvent.click(await screen.findByTestId('what-count-working'));
    const drawer = await screen.findByTestId('now-drawer');
    await waitFor(() => expect(notes(drawer).map((n) => n.getAttribute('data-source'))).toContain('The Now list'));
  }, 30000);

  it('SOURCE-ENVELOPE-1: a partial unit index reads "incomplete" in the phone Now list and in the drawer', async () => {
    setWidth(400);
    stub({ index: ok({ asOf: new Date().toISOString(), units: [], warnings: ['ledger unreadable'] }) });
    render(<DayView onNavigate={() => {}} />);
    const now = await screen.findByTestId('day-phone-now');
    await waitFor(() => expect(notes(now).map((n) => n.textContent)).toContain('The unit index incomplete: ledger unreadable'));
    cleanup(); resetUnitIndex(); setWidth(1440);
    render(<DayView onNavigate={() => {}} />);
    fireEvent.click(await screen.findByTestId('what-count-review'));
    const drawer = await screen.findByTestId('now-drawer');
    await waitFor(() => expect(notes(drawer).map((n) => n.textContent)).toContain('The unit index incomplete: ledger unreadable'));
  }, 30000);
});

describe('U3 F4: a failed past window never says "retrying"', () => {
  const ROWS = [
    ['live window: it is read again', null, 'live', 'The ribbon could not be read; retrying every 2 minutes.'],
    ['past window: change the window to try again', PAST, 'past', 'The ribbon could not be read. A past window is not read again: change the window to try again.'],
  ];
  for (const [name, win, failKind, want] of ROWS) {
    it(name, async () => {
      if (win) window.history.replaceState(null, '', `/${formatHash(win)}`);
      stub({ ribbon: (u, n, kind) => { if (kind === failKind) throw new Error('route down'); return ok(RIBBON); } });
      render(<DayView onNavigate={() => {}} />);
      const errs = await screen.findAllByTestId('day-feed-error');
      expect(errs.find((e) => e.getAttribute('data-source') === 'ribbon').textContent).toBe(want);
    });
  }
  it('a missing source on a past window says it is not read again', async () => {
    window.history.replaceState(null, '', `/${formatHash(PAST)}`);
    stub({ ribbon: (u, n, kind) => ok(kind === 'past' ? { ...clone(RIBBON), sourceErrors: { ledger: 'x' } } : RIBBON) });
    render(<DayView onNavigate={() => {}} />);
    const list = await screen.findByTestId('day-source-errors');
    expect(list.textContent).toBe('Landings and deploys: not read yet, not read again for a past window');
  });
});

describe('U3 follow-up: a body from the window cache keeps its fetch time', () => {
  it('back to a cached live window, a failed refresh still says "last good read from HH:MM"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const n = Date.now();
    const A = { from: new Date(n - 3_600_000).toISOString(), to: new Date(n + 3_600_000).toISOString() };
    const B = { from: new Date(n - 7_200_000).toISOString(), to: new Date(n + 7_200_000).toISOString() };
    let aReads = 0;
    wsFetch.mockImplementation(async (url) => {
      if (String(url).includes(encodeURIComponent(A.from))) { aReads += 1; if (aReads > 1) throw new Error('down'); }
      return ok(RIBBON);
    });
    const { result, rerender } = renderHook(({ w }) => useRibbonFeed(w), { initialProps: { w: A } });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    vi.setSystemTime(T0 + 60_000);
    rerender({ w: B });
    await waitFor(() => expect(result.current.fetchedAt).toBe(T0 + 60_000));
    vi.setSystemTime(T0 + 120_000);
    rerender({ w: A });
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.fetchedAt).toBe(T0);
    expect(sourceNoteText('The ribbon', result.current)).toContain(`last good read from ${hhmm(T0)}`);
  });
});

describe('U3 F6 and the AHEAD tick: measured, never estimated', () => {
  const NOW = '2026-10-31T16:40:00-07:00';
  const base = () => ({ data: clone(RIBBON), from: RIBBON.from, to: RIBBON.to, now: NOW });
  it('the svg takes the content box (clientWidth), not the border box with a classic scrollbar in it', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0 });
    const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function cwOf() { return this.getAttribute('data-testid') === 'ribbon-box' ? 985 : 0; });
    render(<DayRibbon {...base()} />);
    expect(screen.getByTestId('ribbon-svg').getAttribute('width')).toBe('985');
    cw.mockRestore();
  });
  it('each AHEAD tick hit is its measured label plus padding', () => {
    render(<DayRibbon {...base()} />);
    const pins = screen.getAllByTestId('pin-seatReset').filter((g) => g.classList.contains('rt'));
    expect(pins.length).toBeGreaterThan(0);
    for (const g of pins) {
      const label = g.querySelector('text').textContent;
      expect(Number(g.querySelector('rect.hit').getAttribute('width'))).toBeCloseTo(Math.round((textWidth(label, 11) + 9) * 10) / 10, 1);
    }
  });
});

describe('U3 polish (merged.md U3)', () => {
  const NOW = '2026-10-31T16:40:00-07:00';
  const base = (edit) => { const d = clone(RIBBON); if (edit) edit(d); return { data: d, from: d.from, to: d.to, now: NOW }; };
  it('AD#16 / DT#17: marks and their legend items are drawn shapes, never font glyphs', () => {
    const { container } = render(<DayRibbon {...base()} />);
    const want = { land: 'check', deploy: 'triangle', deployFail: 'triangle', decide: 'square' };
    let seen = 0;
    for (const [kind, shape] of Object.entries(want)) {
      for (const m of container.querySelectorAll(`[data-testid="mark-${kind}"]`)) {
        seen += 1;
        expect(m.querySelector(`[data-shape="${shape}"]`), kind).toBeTruthy();
        expect(m.querySelector('text'), kind).toBeNull();
      }
      const item = container.querySelector(`[data-testid="ribbon-legend"] [data-key="${kind}"]`);
      if (item) expect(item.querySelector(`[data-testid="mark-icon-${kind}"] [data-shape="${shape}"]`), `legend ${kind}`).toBeTruthy();
    }
    expect(seen).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="ribbon-legend"] [data-key="decide"]')?.textContent).toBe('decided for you');
  });
  it('DV#18 / IMP#18: hits are 24 px, cut at the midpoint on a dense row; spans keep a 2 px gap', () => {
    expect(hitBounds([100])).toEqual([{ x: 100, lo: 88, hi: 112 }]);
    expect(hitBounds([116, 100])).toEqual([{ x: 116, lo: 108, hi: 128 }, { x: 100, lo: 88, hi: 108 }]);
    const { container } = render(<DayRibbon {...base()} />);
    const lone = [...container.querySelectorAll('[data-testid="mark-hit"]')].map((r) => Number(r.getAttribute('width')));
    expect(Math.max(...lone)).toBe(24);
    // Two touching spans: the first ends where the second starts, so their rects are 2 px apart.
    const { container: c2 } = render(<DayRibbon {...base((d) => {
      const l = d.lanes.find((x) => x.lane === 'ops');
      l.spans = [{ kind: 'work', start: '2026-10-31T08:00:00-07:00', end: '2026-10-31T10:00:00-07:00' }, { kind: 'work', start: '2026-10-31T10:00:00-07:00', end: '2026-10-31T12:00:00-07:00' }];
    })} />);
    const [a, b] = [...c2.querySelectorAll('[data-testid="lane-ops"] [data-testid="span-work"]')].map((r) => ({ x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')) }));
    expect(Math.abs(b.x - (a.x + a.w) - 2)).toBeLessThanOrEqual(0.15); // x and width each round to 0.1 px; the old gap was 0.8
  });
  it('DV#17: the ribbon adds its own as-of only when its body lags the page', () => {
    const lag = new Date(Date.parse(NOW) - ASOF_LAG_MS - 60_000).toISOString();
    const fresh = new Date(Date.parse(NOW) - 60_000).toISOString();
    const { container } = render(<DayRibbon {...base((d) => { d.asOf = fresh; delete d.coverage; })} />);
    expect(container.querySelector('[data-testid="ribbon-fresh"]').textContent).toBe('');
    cleanup();
    const { container: c2 } = render(<DayRibbon {...base((d) => { d.asOf = lag; delete d.coverage; })} />);
    expect(c2.querySelector('[data-testid="ribbon-fresh"]').textContent).toMatch(/^lanes as of \d\d:\d\d$/);
  });
  it('AD#18: the two questions at the bottom read as links (accent ink, body size)', async () => {
    stub();
    render(<DayView onNavigate={() => {}} />);
    for (const id of ['day-link-process', 'day-link-ops']) {
      const cls = (await screen.findByTestId(id)).className;
      expect(cls).toContain('text-[color:var(--rb-accent)]');
      expect(cls).toContain('text-[length:var(--type-body)]');
      expect(cls).not.toContain('text-muted-foreground');
    }
  });
  it('IMP#19: the WHAT line state ("Moving") is not underlined like a link', async () => {
    stub();
    render(<WhatLine />);
    const cls = (await screen.findByTestId('what-state')).className.split(/\s+/);
    expect(cls).not.toContain('underline');
    expect(cls).toContain('focus-visible:underline');
  });
  it('DV#19: the money bars have 2 px gaps, a labelled peak and a "now" slot for the open hour', () => {
    const bars = { hours: [{ label: '08', usd: 40 }, { label: '09', usd: 235.4 }, { label: '10', usd: 90 }], max: 235.4 };
    render(<HourBars bars={bars} />);
    const box = screen.getByTestId('meter-popover-bars');
    expect(box.querySelector('.gap-0\\.5')).toBeTruthy();
    expect(screen.getByTestId('meter-bar-peak').textContent).toBe('$235');
    expect(screen.getByTestId('meter-bar-peak').parentElement.querySelector('[data-testid="meter-bar"]').getAttribute('title')).toBe('09:00 $235');
    expect(screen.getAllByTestId('meter-bar').map((b) => b.getAttribute('title'))).toEqual(['08:00 $40', '09:00 $235', '10:00 $90']);
    expect(screen.getByTestId('meter-bar-now')).toBeTruthy();
    expect(box.getAttribute('aria-label')).toBe('Spend by closed hour today, peak $235 at 09:00');
  });
  it('DV#15: at 400 px each phone Now row carries a 12 h strip in the ribbon palette', async () => {
    setWidth(400);
    stub();
    render(<DayView onNavigate={() => {}} />);
    const rows = await screen.findAllByTestId('day-phone-lane');
    for (const r of rows) {
      const strip = r.querySelector('[data-testid="day-phone-strip"]');
      expect(strip, r.getAttribute('aria-label')).toBeTruthy();
      expect(strip.getAttribute('width')).toBe('72');
      expect(strip.getAttribute('height')).toBe('12');
    }
    const fills = [...document.querySelectorAll('[data-testid="day-phone-strip"] rect')].map((x) => x.style.fill).filter(Boolean);
    expect(fills.some((f) => f.includes('--rb-'))).toBe(true);
  });
  it('M14: at 400 px the header strip shrinks and truncates (full words in the title), it never spills off the left', () => {
    setWidth(400);
    stub();
    const items = [{ id: 'a', status: 'in_progress' }, { id: 'b', status: 'blocked' }];
    render(<div data-testid="strip" className="flex justify-end"><HeaderCounters items={items} gates={[]} /><AgentStatusPill /></div>);
    const counters = screen.getByTestId('header-counters');
    expect(counters.className).toContain('min-w-0');
    expect(counters.className).toContain('truncate');
    expect(counters.className).not.toContain('shrink-0');
    expect(counters.getAttribute('title')).toMatch(/^Compose: 2 items/);
    const pill = screen.getByTestId('header-agent-pill');
    expect(pill.className).toContain('min-w-0');
    expect(pill.className).not.toContain('shrink-0');
    expect(screen.getByTestId('header-agent-status').className).toContain('truncate');
  });
});

describe('U3 follow-up: InboxDrawer drops a focus that never ran', () => {
  it('a focus asked for while the queue loads is cleared on close; the next plain open selects nothing', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const queue = [{ id: 'Q1', by: 'forge-main', text: 'ASK: one?', age: 60 }, { id: 'Q2', by: 'forge-main', text: 'ASK: two?', age: 90 }];
    const fleet = clone(FLEET);
    fleet.sources.sm_status.value.queue.value = queue;
    stub({ fleet: () => gate.then(() => ok(fleet)) });
    render(<InboxDrawer />);
    await act(async () => { window.dispatchEvent(new CustomEvent('compose:open-inbox', { detail: { focus: 'Q2' }, cancelable: true })); });
    fireEvent.click(await screen.findByTestId('inbox-close'));
    await act(async () => { release(); await gate; await Promise.resolve(); });
    await act(async () => { window.dispatchEvent(new CustomEvent('compose:open-inbox', { cancelable: true })); });
    const rows = await screen.findAllByTestId('inbox-row');
    expect(rows.length).toBe(2);
    expect(rows.filter((n) => n.getAttribute('aria-selected') === 'true')).toHaveLength(0);
  });
});
