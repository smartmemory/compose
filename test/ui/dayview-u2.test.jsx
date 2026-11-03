/**
 * dayview-u2.test.jsx — COMP-DAYVIEW-DESIGN-FIX-1 U2: the rendered half of the U2 boxes and fold rows.
 *
 * F1 (one owner state for the ribbon and the phone), F2 (one ask draws once, through rendered owner spans), U2-DATA Q1 (a
 * Reverse opens the inbox on its row), MARKS M2/M3 (Show all, the card inside the viewport), NOW M1/M2 (a degraded body or
 * index never reads as an empty list), COUNT-ONE M2 (no "0 waiting" when the queue is unknown), M14 (the phone's
 * two-line lane items). The money block's M10/M4 rows live in cost-bars.test.jsx.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView from '../../src/components/ribbon/DayView.jsx';
import DayRibbon from '../../src/components/ribbon/DayRibbon.jsx';
import NowDrawer from '../../src/components/ribbon/now/NowDrawer.jsx';
import MarkPopover from '../../src/components/ribbon/marks/MarkPopover.jsx';
import { cardFor } from '../../src/components/ribbon/marks/markCards.js';
import InboxDrawer from '../../src/components/cockpit/notify/InboxDrawer.jsx';
import { reconcileOwnerSpans } from '../../lib/owner-spans.js';
import { ownerWaitsAtNow } from '../../src/components/ribbon/ribbonLayout.js';
import { formatHash, PRESETS } from '../../src/components/ribbon/rangeLogic.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';
import { resetUnitIndex } from '../../src/lib/useUnitIndex.js';

// CLOCK-TESTS-1: DayView draws its window from the browser clock (PRESETS.day of `Date.now()`, 18:00 yesterday to 06:00
// tomorrow), so an unpinned run moved NOW across the track with the time of day: near midnight NOW sits near the right edge,
// and every owner row here failed from 22:25 to 23:59 on the old fitting. Pinned to 22:25 LOCAL (the Date constructor, so the
// NOW position is the same in any zone a run uses): the first minute the old fitting cut "waiting on you", and the band
// ("waiting on you…" fits, the bare words do) where a width check without the ellipsis still cut it. Date only, not timers.
vi.setSystemTime(new Date(2026, 10, 2, 22, 25));
afterAll(() => { vi.useRealTimers(); });
const RIBBON = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const down = { ok: false, status: 500, json: async () => ({}), text: async () => 'down' };
const setWidth = (w) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
const clone = (o) => JSON.parse(JSON.stringify(o));
const fleetWith = ({ queue = [], notify = null } = {}) => ({
  generated: new Date().toISOString(),
  sources: { sm_status: { value: { sessions: { value: [], error: null }, jobs: { value: [], error: null }, queue: { value: queue, error: null } }, error: null, ts: 1, stale: false } },
  ...(notify ? { notify } : {}),
});

function stub({ ribbon = RIBBON, fleet = fleetWith(), index = ok({ asOf: new Date().toISOString(), units: [] }) } = {}) {
  wsFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/ribbon')) return ok(ribbon);
    if (u.startsWith('/api/fleet')) return ok(fleet);
    if (u.startsWith('/api/units/index')) return index;
    return ok({});
  });
  global.fetch = vi.fn(async () => ok({}));
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
  wsFetch.mockReset(); resetFleetPoller(); resetUnitIndex(); setWidth(1440);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); setWidth(1024); });

/** The fixture with ops' owner wait tied to queue ask A, and A open in the body. */
function askFixture() {
  const d = clone(RIBBON);
  const ops = d.lanes.find((l) => l.lane === 'ops');
  ops.spans = ops.spans.map((s) => (s.kind === 'wait' && s.cause === 'owner' ? { ...s, queueId: 'A' } : s));
  d.owner = { open: [{ id: 'A', by: 'forge-main', text: 'ASK: ship it?', age: 600 }] };
  return d;
}

describe('U2 F1: the ribbon and the phone read one owner state', () => {
  // [name, notify, ribbon says owner, phone says owner]
  const ROWS = [
    ['the ask open: both say waiting on you', null, true],
    ['the ask answered from the cockpit: neither does', { v: 1, entries: { 'ask:A': { action: 'answered', at: new Date(Date.now() - 60_000).toISOString() } } }, false],
  ];
  for (const [name, notify, owner] of ROWS) {
    it(name, async () => {
      const queue = [{ id: 'A', by: 'forge-main', text: 'ASK: ship it?', age: 600, red: false }];
      stub({ ribbon: askFixture(), fleet: fleetWith({ queue, notify }) });
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('day-ribbon');
      await waitFor(() => {
        const cur = screen.getByTestId('lane-ops').querySelector('text.cur')?.textContent ?? '';
        expect(/on you/.test(cur), `ribbon: ${cur}`).toBe(owner);
      });
      cleanup(); resetFleetPoller(); resetUnitIndex();
      setWidth(400);
      render(<DayView onNavigate={() => {}} />);
      await waitFor(() => {
        const row = screen.getAllByTestId('day-phone-lane').find((r) => r.getAttribute('aria-label').startsWith('ops:'));
        expect(row.getAttribute('data-tone') === 'owner', `phone: ${row.getAttribute('aria-label')}`).toBe(owner);
      });
    }, 30000);
  }
});

describe('CLOCK-TESTS-1: late in the day the owner wait still says "waiting on you"', () => {
  // [now, the right-edge "◆ on answer" is drawn]. The fixture's own zone and Day window, so NOW lands at the same x in any
  // run, and ops' open owner wait ends at the read, as the route sends it. At 15:00 everything fits; from 22:25 the NOW words win and the right-edge words go (the lane drawer still says it).
  const ROWS = [
    ['2026-10-31T15:00:00-07:00', true],
    ['2026-10-31T22:25:00-07:00', false],
    ['2026-10-31T23:59:00-07:00', false],
  ];
  for (const [now, onAnswer] of ROWS) {
    it(`at ${now.slice(11, 16)}: ops reads "waiting on you"${onAnswer ? ' and "◆ on answer"' : ''}`, () => {
      const d = clone(RIBBON);
      const { from, to } = PRESETS.day(now);
      d.now = now; d.asOf = now;
      const ops = d.lanes.find((l) => l.lane === 'ops');
      ops.spans = ops.spans.map((s) => (s.kind === 'wait' && s.cause === 'owner' ? { ...s, end: now } : s));
      render(<DayRibbon data={d} from={from} to={to} now={now} />);
      const cur = screen.getByTestId('lane-ops').querySelector('text.cur')?.textContent ?? '';
      expect(cur, `NOW words at ${now}`).toMatch(/^waiting on you/);
      expect(screen.getByTestId('lane-ops').querySelector('[data-testid="eta-answer"]') != null).toBe(onAnswer);
      expect(screen.getAllByTestId('owner-now').map((m) => m.closest('[data-testid^="lane-"]')?.getAttribute('data-testid'))).toEqual(['lane-ops']);
    });
  }
});

describe('U2 F2: one ask draws one owner span', () => {
  it('a stamp span and the queue span of the same ask draw once, the count the headline reads; its age is the real start', () => {
    const d = clone(RIBBON);
    const ops = d.lanes.find((l) => l.lane === 'ops');
    const own = ops.spans.find((s) => s.kind === 'wait' && s.cause === 'owner');
    // The stamp span starts before the window (clipped to `from`, real start in `since`), and is open (extended to now).
    const stamp = { ...own, unit: own.unit ?? 'U-ask', start: d.from, since: '2026-10-30T10:40:00-07:00', open: true };
    ops.spans = reconcileOwnerSpans([...ops.spans.filter((s) => s !== own), stamp, { ...own, unit: stamp.unit, start: d.from, since: stamp.since, queueId: 'A' }], { asOf: Date.parse(d.now) });
    render(<DayRibbon data={d} from={d.from} to={d.to} now={d.now} />);
    const drawn = screen.getByTestId('lane-ops').querySelectorAll('[data-testid="span-wait"][data-cause="owner"]');
    expect(drawn.length).toBe(1);
    expect(drawn[0].getAttribute('data-queue')).toBe('A');
    expect(ownerWaitsAtNow(d.lanes, d.now, d.now)).toEqual([{ lane: 'ops', queueId: 'A' }]);
    // The fold: an unclipped stamp span reads its age from its real start, not the window's left edge.
    const d2 = clone(RIBBON);
    const ops2 = d2.lanes.find((l) => l.lane === 'ops');
    ops2.spans = ops2.spans.map((s) => (s.kind === 'wait' && s.cause === 'owner' ? { ...s, start: d2.from, since: '2026-10-30T10:40:00-07:00' } : s));
    cleanup();
    render(<DayRibbon data={d2} from={d2.from} to={d2.to} now={d2.now} />);
    expect(screen.getByTestId('lane-ops').querySelector('text.cur').textContent).toContain('1d 6h');
  });
});

describe('U3-FU: owner waits at now come from the queue only', () => {
  it('an open queue ask plus a stamp clipped at the read on the same lane: only the queue ask counts at now, and the mounted marker count is that count', () => {
    const d = clone(RIBBON);
    const ops = d.lanes.find((l) => l.lane === 'ops');
    const own = ops.spans.find((s) => s.kind === 'wait' && s.cause === 'owner');
    const stamp = { ...own, queueId: undefined, unit: 'U-stamp', start: d.from, since: d.from, open: true };
    ops.spans = reconcileOwnerSpans([...ops.spans.filter((s) => s !== own), stamp, { ...own, unit: 'U-ask', queueId: 'A' }], { asOf: Date.parse(d.now) });
    const clipped = ops.spans.find((s) => s.kind === 'wait' && s.cause === 'owner' && !s.queueId);
    expect(clipped, 'the stamp stays as history, clipped at the read').toMatchObject({ open: false });
    const atNow = ownerWaitsAtNow(d.lanes, d.now, d.now);
    expect(atNow).toEqual([{ lane: 'ops', queueId: 'A' }]);
    render(<DayRibbon data={d} from={d.from} to={d.to} now={d.now} />);
    const marked = screen.getAllByTestId('owner-now');
    expect(marked.length).toBe(atNow.length);
    expect(marked.map((m) => m.getAttribute('data-queue'))).toEqual(['A']);
  });
});

describe('U2-DATA Q1: a Reverse with no unit opens the inbox on its queue row', () => {
  it('the card targets the queue id, and the drawer opens with that row selected and expanded', async () => {
    const card = cardFor({ kind: 'decide', at: RIBBON.now, lane: 'ops', text: 'Applied the bypass flag', reverse: 'Remove the bypass flag', queueId: 'Q2' }, { now: RIBBON.now });
    expect(card.links.find((l) => l.action?.type === 'reverse').action.id).toBe('Q2');
    const queue = ['Q1', 'Q2', 'Q3'].map((id, i) => ({ id, by: 'forge-main', text: `ASK: question ${id}?`, age: 600 + i, red: false }));
    stub({ fleet: fleetWith({ queue }) });
    render(<InboxDrawer />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await act(async () => { window.dispatchEvent(new CustomEvent('compose:open-inbox', { detail: { focus: 'Q2' }, cancelable: true })); });
    await waitFor(() => {
      const row = screen.getAllByTestId('inbox-row').find((n) => n.getAttribute('data-id') === 'Q2');
      expect(row.getAttribute('aria-selected')).toBe('true');
      expect(row.querySelector('[data-testid="inbox-row-toggle"]').getAttribute('aria-expanded')).toBe('true');
    });
  });
});

describe('U2 MARKS M2 + M3: the card', () => {
  const long = `${'The bypass flag stays on for the batch window while the gate is rebuilt. '.repeat(8)}`;
  const card = () => cardFor({ kind: 'decide', at: RIBBON.now, lane: 'ops', text: 'Applied the bypass flag', reverse: long, unit: 'U7' }, { now: RIBBON.now });
  it('a cut body offers "Show all", which shows the whole text and toggles back', () => {
    const c = card();
    expect(c.full).toBeTruthy();
    render(<MarkPopover card={c} rect={{ left: 100, top: 100, width: 10, height: 10 }} onClose={() => {}} onAction={() => {}} />);
    const body = () => screen.getByTestId('mark-popover-body').textContent;
    expect(body().length).toBeLessThan(c.full.length);
    fireEvent.click(screen.getByTestId('mark-popover-all'));
    expect(body()).toBe(c.full);
    expect(screen.getByTestId('mark-popover-all').textContent).toBe('Show less');
  });
  it('at 400 x 860 a card 1200 px tall, opened at the bottom right, stays whole on screen: clamped, placed by its clamped height, scrolling inside', () => {
    setWidth(400);
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 860 });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1200);
    render(<MarkPopover card={card()} rect={{ left: 390, top: 840, width: 6, height: 6 }} onClose={() => {}} onAction={() => {}} />);
    const s = screen.getByTestId('mark-popover').style;
    const [left, width, top] = [parseFloat(s.left), parseFloat(s.width), parseFloat(s.top)];
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(400);
    expect(s.maxHeight).toMatch(/^calc\(100vh - \d+px\)$/);
    expect(s.overflowY).toBe('auto');
    const gap = Number(/(\d+)px/.exec(s.maxHeight)[1]) / 2;
    expect(top).toBe(gap);
  });
});

describe('U2 NOW M1 + COUNT-ONE M2: the Now drawer never reads an unknown as none', () => {
  beforeEach(() => { stub(); });
  it('working, with the stamps unreadable and no fleet: "source unavailable", not an empty list', () => {
    render(<NowDrawer kind="working" onClose={() => {}} fleet={null} index={null} feed={{ ...RIBBON, sourceErrors: { stamps: 'x' } }} />);
    expect(screen.getByTestId('now-drawer').textContent).toContain('source unavailable');
    expect(screen.queryByTestId('now-empty')).toBeNull();
  });
  it('waiting, with the owner queue unreadable: the title says owner questions are unknown, never "0 waiting"', () => {
    const fleet = { sources: { sm_status: { value: { queue: { value: null, error: 'queue down' } }, error: null } } };
    const index = { asOf: new Date().toISOString(), units: [{ id: 'W-1', lane: 'web', title: 'Waiting review', waiting: 'review', authorDoneAt: new Date().toISOString() }] };
    render(<NowDrawer kind="waiting" onClose={() => {}} fleet={fleet} index={index} feed={RIBBON} />);
    expect(screen.getByTestId('now-drawer').getAttribute('aria-label')).toBe('1 waiting on review, owner questions unknown');
  });
});

describe('U2 NOW M2 + M14: the phone', () => {
  it('with the unit index down, a waiting lane stays (from the ribbon) and the page says waits are unknown', async () => {
    setWidth(400);
    stub({ index: down });
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('now-waits-unknown');
    const rows = screen.getAllByTestId('day-phone-lane');
    expect(rows.find((r) => r.getAttribute('aria-label').startsWith('ops:')).getAttribute('data-tone')).toBe('owner');
    expect(rows.find((r) => r.getAttribute('aria-label').startsWith('main:')).getAttribute('data-tone')).toBe('review');
  }, 30000);
  it('each lane item is two lines: the state (with its ETA) over the title', async () => {
    setWidth(400);
    stub();
    render(<DayView onNavigate={() => {}} />);
    const rows = await screen.findAllByTestId('day-phone-lane');
    for (const r of rows) {
      const title = r.querySelector('[data-testid="day-phone-title"]');
      expect(title, r.getAttribute('aria-label')).toBeTruthy();
      expect(r.firstElementChild.contains(title)).toBe(false);
    }
  }, 30000);
});

describe('U2 TOP M1 + NOW M3: kept data and the window the Now lists read', () => {
  it('TOP M1: a refresh that fails over kept data says so beside it, and the ribbon stays drawn', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    let fail = false;
    stub();
    const base = wsFetch.getMockImplementation();
    wsFetch.mockImplementation(async (url) => (fail && String(url).startsWith('/api/ribbon') ? down : base(url)));
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('day-ribbon');
    expect(screen.queryByTestId('source-note')).toBeNull();
    fail = true;
    const ticks = interval.mock.calls.filter((c) => c[1] === 120_000).map((c) => c[0]);
    expect(ticks.length).toBeGreaterThan(0);
    await act(async () => { for (const t of ticks) t(); await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(screen.getByTestId('source-note')).toBeTruthy());
    expect(screen.getByTestId('day-ribbon')).toBeTruthy();
  }, 30000);
  it('NOW M3: with a past window selected, the phone\'s Now list reads the window that holds now, not the past one', async () => {
    setWidth(400);
    const past = { from: '2026-10-20T00:00:00-07:00', to: '2026-10-21T00:00:00-07:00' };
    window.history.replaceState(null, '', `/${formatHash(past)}`);
    stub();
    const base = wsFetch.getMockImplementation();
    wsFetch.mockImplementation(async (url) => (String(url).includes(encodeURIComponent(past.from)) ? ok({ ...clone(RIBBON), ...past, lanes: [] }) : base(url)));
    render(<DayView onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('day-phone-lane').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('now-empty')).toBeNull();
    expect(wsFetch.mock.calls.some((c) => String(c[0]).includes(encodeURIComponent(past.from)))).toBe(true);
  }, 30000);
});
