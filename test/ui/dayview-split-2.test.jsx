/**
 * dayview-split-2.test.jsx — COMP-DAYVIEW-SPLIT-2, mounted:
 * - the seat bars are half as thick, and every seat reserves its "over pace" label row, so a seat over pace keeps its bars
 *   level with a seat that is not;
 * - a lane in `fleet.paused` draws muted with "paused", and is never idle, stale or waiting on you (ribbon and WHAT line);
 * - any span over an owner wait on the same lane is an outline only, so the waiting-on-you band stays solid red.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (sel) => { const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], iterationStates: new Map() }; return typeof sel === 'function' ? sel(s) : s; },
}));

const { default: CostMeter } = await import('../../src/components/cockpit/cost/CostMeter.jsx');
const { default: DayRibbon } = await import('../../src/components/ribbon/DayRibbon.jsx');
const { RIBBON_CSS } = await import('../../src/components/ribbon/dayRibbonCss.js');
const { ownerWaitsAtNow, pausedOf } = await import('../../src/components/ribbon/ribbonLayout.js');
const { default: WhatLine } = await import('../../src/components/cockpit/what/WhatLine.jsx');
const { resetFleetPoller } = await import('../../src/lib/fleetPoller.js');
const { resetUnitIndex } = await import('../../src/lib/useUnitIndex.js');

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ---- seats ----
const MNOW = '2026-11-01T12:00:00Z';
const mat = (min) => new Date(Date.parse(MNOW) + min * 60_000).toISOString();
const seat = (n, five, fable) => ({
  id: `seat${n}`, label: `Claude Team seat ${n}`, five_h: { used_pct: five, resets_at: mat(90) }, seven_d: { used_pct: null, resets_at: null, status: 'missing' },
  fable: { used_pct: fable.used, cap_pct: fable.cap, over_cap: fable.over === true, resets_at: mat(2 * 1440) },
});
const SEATS = [
  seat(2, 40, { used: 29, cap: 70, over: true }), // weekly over pace: amber, "over pace", its cap tick at 70
  seat(4, 17, { used: 53, cap: 100 }), // under pace: no label
  { id: 'codex', label: 'Codex prolite', five_h: {}, seven_d: {}, today_pts: 7, codex_daily: { cap_pct: 13, state: 'ok', off: false } },
];
const meter = () => render(<CostMeter bars compact seats={SEATS} spend={null} asOf={MNOW} now={MNOW} credit={null} />);
/** A pair's rendered shape: each child's tag and classes, and the path of classes from the pair down to each bar. */
const shape = (pair) => ({
  children: [...pair.children].map((c) => `${c.tagName}.${c.className}`),
  bars: [...pair.querySelectorAll('[role="progressbar"]')].map((b) => {
    const path = [];
    for (let n = b; n && n !== pair; n = n.parentElement) path.push(`${n.tagName}.${n.className.replace(/ ?ring-\S+/g, '')}`);
    return path.join(' < ');
  }),
});

describe('Seats: thinner bars that keep their place (COMP-DAYVIEW-SPLIT-2)', () => {
  it('a seat over pace and a seat under it have the same rendered structure down to every bar, label row included', () => {
    meter();
    const over = screen.getByTestId('cost-meter-seat-seat2');
    const ok = screen.getByTestId('cost-meter-seat-seat4');
    expect(screen.getByTestId('cost-meter-seat-seat2-over').textContent).toBe('over pace');
    expect(screen.queryByTestId('cost-meter-seat-seat4-over')).toBeNull();
    // The label row is there on both, a fixed one-line height, a non-breaking space where there is nothing to say.
    for (const id of ['seat2', 'seat4']) expect(screen.getByTestId(`cost-meter-seat-${id}-label`).className).toContain('h-3');
    expect(screen.getByTestId('cost-meter-seat-seat4-label').textContent).toBe(' ');
    // jsdom lays nothing out (offsetTop is 0 everywhere), so the proof is structural: both pairs are the same stack of
    // the same rows with the same classes, in a row aligned by their tops. Same rows, same heights, same top: same bar offset.
    expect(shape(over)).toEqual(shape(ok));
    expect(over.parentElement.className).toContain('items-start');
    expect(over.parentElement.className).not.toContain('items-end');
  });
  it('the Codex block\'s "not reported" line hangs under its pair, in a row aligned by tops, so it cannot lift the pair', () => {
    render(<CostMeter bars compact seats={[SEATS[1], { id: 'codex', vendor: 'codex', label: 'Codex prolite', five_h: {}, seven_d: {}, today_pts: null }]} spend={null} asOf={MNOW} now={MNOW} credit={null} />);
    const codex = screen.getByTestId('cost-meter-codex');
    expect(screen.getByTestId('cost-meter-codex-label')).toBeTruthy();
    expect(screen.getByTestId('cost-meter-codex-unreported').previousElementSibling).toBe(codex); // the line sits under the pair
    expect(codex.parentElement.parentElement.className).toContain('items-start');
  });
  it('every seat bar is 6 px wide on its 36 px height (w-1.5 h-9, was w-3), and the pace tick still draws on it', () => {
    meter();
    const bars = [...document.querySelectorAll('[data-testid^="cost-meter-seat-"] [role="progressbar"]')];
    expect(bars.length).toBe(4);
    for (const b of bars) {
      expect(b.className.split(' ')).toEqual(expect.arrayContaining(['h-9', 'w-1.5']));
      expect(b.className.split(' ')).not.toContain('w-3');
    }
    const tick = screen.getByTestId('cost-meter-fable-seat2-tick');
    expect(tick.parentElement.className).toContain('w-1.5');
    expect(tick.className).toContain('-inset-x-0.5'); // wider than the bar on both sides, so it reads on the thin bar
  });
});

// ---- the ribbon ----
const load = (n) => JSON.parse(readFileSync(resolve(process.cwd(), `test/fixtures/ribbon/${n}.json`), 'utf8'));
const NOW = '2026-10-31T16:40:00-07:00';
const T = (h) => `2026-10-31T${h}:00-07:00`;
function ribbon(edit) {
  const data = load('day');
  edit?.(data);
  const r = render(<DayRibbon data={data} from={data.from} to={data.to} now={NOW} />);
  return { data, root: r.container };
}
const laneOf = (data, n) => data.lanes.find((l) => l.lane === n);
const legendKeys = (root) => [...root.querySelectorAll('[data-testid="ribbon-legend"] [data-key]')].map((e) => e.getAttribute('data-key'));
const pause = (...names) => (data) => { for (const n of names) laneOf(data, n).paused = true; };
/** The ops lane's owner wait made an open ask (a queue span counts at now). */
const askOnOps = (data) => { laneOf(data, 'ops').spans.find((s) => s.cause === 'owner').queueId = 'Q1'; };
/** The wiki lane's current unit, three days old with no newer stamp: stale. */
const staleWiki = (data) => {
  const w = laneOf(data, 'wiki');
  w.current = { id: 'W1', title: 'old unit', titleSource: 'stamp', since: '2026-10-28T10:00:00-07:00' };
  w.spans = [{ kind: 'work', unit: 'W1', start: data.from, end: NOW, since: '2026-10-28T10:00:00-07:00', title: 'old unit', job: null, cause: null }];
};

describe('paused lanes on the Day ribbon (COMP-DAYVIEW-SPLIT-2)', () => {
  it('each paused lane renders muted with a "paused" label, an idle one and a busy one alike; its spans still draw', () => {
    const { root } = ribbon(pause('trader', 'main'));
    for (const n of ['trader', 'main']) {
      const g = root.querySelector(`[data-testid="lane-${n}"]`);
      expect(g.getAttribute('class')).toContain('lane-paused');
      expect(g.getAttribute('data-paused')).toBe('true');
      expect(g.querySelector(`[data-testid="lane-paused-${n}"]`).textContent).toBe('paused');
    }
    const main = root.querySelector('[data-testid="lane-main"]');
    expect(main.querySelectorAll('[data-testid="span-work"]').length).toBe(2); // data is never hidden
    expect(main.querySelectorAll('[data-testid="span-wait"]').length).toBe(1);
    expect(main.querySelector('[data-testid="current"]')).toBeNull(); // no "waiting on review 5h" NOW words
    expect(main.querySelector('[data-testid="eta"], [data-testid="next"]')).toBeNull();
    expect(legendKeys(root)).toContain('paused');
    expect(RIBBON_CSS).toMatch(/\.day-ribbon \.lane-paused \.seg\{opacity:\.35\}/);
  });
  it('a paused lane is not in the idle group: trader leaves the fold, which counts the other two', () => {
    const { root } = ribbon(pause('trader'));
    const idle = root.querySelector('[data-testid="idle-row"]');
    expect(idle.textContent).toContain('2 lanes idle');
    expect(idle.textContent).not.toContain('trader');
    expect(root.querySelector('[data-testid="lane-trader"]')).not.toBeNull(); // drawn as its own muted row, not folded away
  });
  it('a paused lane is never styled stale (control: the same lane unpaused is)', () => {
    const control = ribbon(staleWiki).root;
    expect(control.querySelector('[data-testid="lane-wiki"] .s-stale')).not.toBeNull();
    cleanup();
    const { root } = ribbon((d) => { staleWiki(d); pause('wiki')(d); });
    const wiki = root.querySelector('[data-testid="lane-wiki"]');
    expect(wiki.querySelector('.s-stale')).toBeNull();
    expect(wiki.querySelector('[data-testid="current"]')).toBeNull();
    expect(wiki.querySelector('[data-testid="eta-stale"]')).toBeNull();
    expect(wiki.querySelectorAll('[data-testid="span-work"]').length).toBe(1);
  });
  it('a paused lane adds no owner wait: no Needs-you marker, no "waiting on you" key, none at now (control: unpaused it does)', () => {
    const control = ribbon(askOnOps);
    expect(control.root.querySelector('[data-testid="owner-now"]')).not.toBeNull();
    expect(legendKeys(control.root)).toContain('owner');
    expect(ownerWaitsAtNow(control.data.lanes, NOW)).toEqual([{ lane: 'ops', queueId: 'Q1' }]);
    cleanup();
    const { root, data } = ribbon((d) => { askOnOps(d); pause('ops')(d); });
    expect(root.querySelector('[data-testid="owner-now"]')).toBeNull();
    expect(legendKeys(root)).not.toContain('owner');
    expect(ownerWaitsAtNow(data.lanes, NOW)).toEqual([]);
    // Still drawn, muted: the span is there, without the loud band's "?".
    const ops = root.querySelector('[data-testid="lane-ops"]');
    expect(ops.querySelector('[data-cause="owner"]')).not.toBeNull();
    expect(ops.querySelector('.own-q')).toBeNull();
  });
  it('pausedOf: the paused lane names, and the open asks placed on them', () => {
    const body = { lanes: [{ lane: 'hub', paused: true }, { lane: 'forge', paused: false }, { lane: 'setup' }],
      owner: { open: [{ id: 'Q1', lane: 'hub' }, { id: 'Q2', lane: 'forge' }] } };
    expect(pausedOf(body)).toEqual({ lanes: ['hub'], asks: ['Q1'] });
    expect(pausedOf(null)).toEqual({ lanes: [], asks: [] });
  });
});

describe('the waiting-on-you band stays solid (s2-coord 2026-11-03)', () => {
  /** ops: the owner wait 14:40-16:40 as an open ask, with a review, an unrecorded-cause wait, a not-recorded gap and work over it. */
  const layered = (data) => {
    askOnOps(data);
    const o = laneOf(data, 'ops');
    o.spans.push(
      { kind: 'wait', cause: 'review', start: T('15:00'), end: T('15:30'), unit: 'U1', title: null, job: null },
      { kind: 'wait', cause: null, start: T('15:10'), end: T('15:30'), unit: 'U1', title: null, job: null },
      { kind: 'notRecorded', cause: null, start: T('15:40'), end: T('16:00'), unit: null, title: null, job: null, why: 'gap' },
      { kind: 'work', cause: null, start: T('16:00'), end: T('16:40'), unit: 'U1', title: null, job: null },
    );
  };
  it('work, review, unknown and not-recorded spans inside the owner wait carry the outline class; the band and spans outside it do not', () => {
    const { root } = ribbon(layered);
    const ops = root.querySelector('[data-testid="lane-ops"]');
    const rect = (sel) => [...ops.querySelectorAll(sel)];
    const inOwner = (r) => r.getAttribute('class').split(' ').includes('in-owner');
    const xs = (rs) => rs.map((r) => Number(r.getAttribute('x')));
    const ownerX0 = Number(ops.querySelector('rect.s-owner').getAttribute('x'));
    const spans = rect('rect.seg[data-testid^="span-"]'); // not the NOW swatch, which is a .seg too
    const inside = spans.filter((r) => Number(r.getAttribute('x')) >= ownerX0);
    expect(inside.map((r) => r.getAttribute('class').split(' ').find((c) => c.startsWith('s-')))).toEqual(
      expect.arrayContaining(['s-review', 's-unknown', 's-norec', 's-work']));
    expect(inside.length).toBe(4);
    expect(inside.every(inOwner)).toBe(true);
    // The two work spans before 14:40 (the second ends exactly where the wait starts) are untouched.
    const before = spans.filter((r) => Number(r.getAttribute('x')) < ownerX0);
    expect(xs(before).length).toBe(2);
    expect(before.some(inOwner)).toBe(false);
    expect(ops.querySelector('rect.s-owner').getAttribute('class')).not.toContain('in-owner');
    // The class means outline only: no fill, the state's own stroke. Nothing changes outside an owner wait.
    expect(RIBBON_CSS).toContain('.day-ribbon .seg.in-owner{fill:none;');
    for (const [cls, v] of [['s-work', 'rb-work'], ['s-review', 'rb-wait'], ['s-unknown', 'rb-muted'], ['s-norec', 'rb-muted']]) {
      expect(RIBBON_CSS).toMatch(new RegExp(`\\.day-ribbon \\.${cls}\\.in-owner\\{stroke:var\\(--${v}\\)`));
    }
  });
});

// ---- the WHAT line ----
const fleetBody = (queue) => ({
  generated: '2026-10-31T11:58:00Z',
  sources: { sm_status: { value: {
    sessions: { value: [{ name: 's0', busy: false }], error: null },
    jobs: { value: [], error: null },
    queue: { value: queue, error: null },
  }, error: null, ts: 1, stale: false } },
});
const routeFetch = (routes) => {
  global.fetch = vi.fn(async (url) => {
    const hit = Object.entries(routes).find(([p]) => String(url).startsWith(p));
    return { ok: true, status: 200, json: async () => (hit ? hit[1] : {}), text: async () => '' };
  });
};
const unit = (id, lane, waiting) => ({ id, lane, landedAt: null, waiting });

describe('the WHAT line leaves paused lanes out (COMP-DAYVIEW-SPLIT-2)', () => {
  beforeEach(() => { resetFleetPoller(); resetUnitIndex(); });
  const mount = async (paused) => {
    routeFetch({
      '/api/fleet': fleetBody([{ id: 'Q1', text: 'resume hub?' }, { id: 'Q2', text: 'ship forge?' }]),
      '/api/units/index': { units: [unit('H1', 'hub', 'review'), unit('F1', 'forge', 'review')], asOf: '2026-10-31T11:55:00Z' },
    });
    render(<WhatLine onOpenFleet={vi.fn()} onNavigate={vi.fn()} paused={paused} />);
    await screen.findByTestId('what-line');
    return ['you', 'review'].map((id) => screen.getByTestId(`what-count-${id}`).textContent);
  };
  it('control, no paused lanes: both asks and both review waits count', async () => {
    expect(await mount(undefined)).toEqual(['2 needs you: resume hub?', '2 waiting on review']);
  });
  it('hub paused: its review wait and the ask placed on it leave the counts', async () => {
    expect(await mount({ lanes: ['hub'], asks: ['Q1'] })).toEqual(['1 needs you: ship forge?', '1 waiting on review']);
  });
  it('only paused waits: the state word is Idle, never Stalled', async () => {
    routeFetch({
      '/api/fleet': fleetBody([{ id: 'Q1', text: 'resume hub?' }]),
      '/api/units/index': { units: [unit('H1', 'hub', 'review')], asOf: '2026-10-31T11:55:00Z' },
    });
    render(<WhatLine onOpenFleet={vi.fn()} onNavigate={vi.fn()} paused={{ lanes: ['hub'], asks: ['Q1'] }} />);
    await screen.findByTestId('what-line');
    expect(screen.getByTestId('what-state').textContent).toBe('Idle');
    expect(screen.getByTestId('what-count-you').textContent).toBe('Nothing needs you');
  });
});
