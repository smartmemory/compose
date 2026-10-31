/**
 * day-ribbon.test.jsx — the Day ribbon drawing (COMP-COCKPIT-RIBBON-ROWS-1).
 *
 * One row table. Each row builds props from a contract-shaped fixture (test/fixtures/ribbon), renders `DayRibbon`
 * and asserts the elements, tooltip strings and callbacks the unit's acceptance criteria name. The component fetches
 * nothing, so there is no network double: the data goes in as a prop.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import DayRibbon from '../../src/components/ribbon/DayRibbon.jsx';

const load = (n) => JSON.parse(readFileSync(resolve(process.cwd(), `test/fixtures/ribbon/${n}.json`), 'utf8'));
const NOW = '2026-10-31T16:40:00-07:00';
const at = (h) => `2026-10-31T${h}:00-07:00`;

/** Props for a fixture; `edit(data)` mutates a clone first; `extra` overrides props. */
function props(name, { edit, extra } = {}) {
  const data = load(name);
  if (edit) edit(data);
  return { data, from: data.from, to: data.to, now: NOW, ...extra };
}
const spies = () => ({ onIdleToggle: vi.fn(), onLaneOpen: vi.fn(), onMarkOpen: vi.fn(), onPinOpen: vi.fn(), onBandOpen: vi.fn() });
const tips = (root, id) => [...root.querySelectorAll(`[data-testid="${id}"]`)].map((e) => e.getAttribute('data-tip') || e.closest('[data-tip]')?.getAttribute('data-tip'));
const count = (root, id) => root.querySelectorAll(`[data-testid="${id}"]`).length;
const key = (el, k = 'Enter') => fireEvent.keyDown(el, { key: k });

const AXIS = vi.fn();

const ROWS = [
  {
    name: 'day: groups, idle fold, bars, marks, now line, current, next and ETA',
    p: () => props('day', { extra: { seats: [{ label: 'seat3', pct: 21 }] } }),
    check: ({ c, root }) => {
      expect(root.textContent).toContain('PRODUCT');
      expect(root.textContent).toContain('OPS');
      const idle = root.querySelector('[data-testid="idle-row"]');
      expect(idle.textContent).toContain('3 lanes idle ▸');
      expect(idle.textContent).toContain('(seat3 has room for them)');
      expect(idle.getAttribute('aria-expanded')).toBe('false');
      expect(count(root, 'span-work')).toBeGreaterThan(0);
      expect(count(root, 'span-wait')).toBeGreaterThan(0);
      expect(count(root, 'span-notRecorded')).toBe(1);
      for (const k of ['land', 'deploy', 'decide']) expect(count(root, `mark-${k}`)).toBeGreaterThan(0);
      expect(count(root, 'now-line')).toBe(1);
      expect(root.textContent).toContain('NOW 16:40');
      expect(root.textContent).toContain('Search filters by workspace');
      expect(root.textContent).toContain('→ Workspace switcher…');
      expect(count(root, 'eta')).toBeGreaterThan(0);
      expect(root.querySelector('[data-testid="ribbon-title"]').textContent).toBe('Lanes · yesterday 18:00 to tomorrow 06:00');
      expect(root.querySelector('[data-testid="ribbon-fresh"]').textContent).toBe('as of 16:40 · start stamps on 59% of landings');
      expect(c).toBeTruthy();
    },
  },
  {
    name: 'day, idle row open: aria-expanded true and the idle lanes appear',
    p: () => props('day', { extra: { idleOpen: true } }),
    check: ({ root }) => {
      const idle = root.querySelector('[data-testid="idle-row"]');
      expect(idle.getAttribute('aria-expanded')).toBe('true');
      expect(idle.textContent).toContain('3 lanes idle ▾');
      for (const n of ['maya', 'docs', 'trader']) expect(root.querySelector(`[data-testid="lane-${n}"]`)).toBeTruthy();
    },
  },
  {
    name: 'day: every span, mark, pin, current, next and ETA carries its tip text',
    p: () => props('day'),
    check: ({ root }) => {
      for (const id of ['span-work', 'span-wait', 'span-notRecorded', 'mark-land', 'mark-deploy', 'mark-deployFail', 'mark-decide', 'pin-seatReset', 'pin-expiry', 'current', 'next', 'eta']) {
        const t = tips(root, id);
        expect(t.length, id).toBeGreaterThan(0);
        for (const s of t) expect(s, id).toBeTruthy();
      }
      expect(tips(root, 'span-notRecorded')[0]).toBe('web · not recorded 6h 15m\nnot recorded: no dispatch stamp (rule U-d)');
      expect(tips(root, 'span-wait')).toContain('main · waiting on review 5h\nSession token refresh\n11:40 to now');
      expect(tips(root, 'span-wait')).toContain('ops · waiting on you 2h\nLaunch gate author bypass\n14:40 to now');
      expect(tips(root, 'mark-land')).toContain('Landed · Auth retry\nyesterday 22:10 · click for detail');
      expect(tips(root, 'current')).toContain('Working on Search filters by workspace since 09:30 (7h 10m)');
      expect(tips(root, 'current')).toContain('Session token refresh waiting on review since 11:40');
      expect(tips(root, 'next')).toContain('Next: Workspace switcher polish, then Facet counts');
      expect(tips(root, 'eta')).toContain('Expected landing of the current unit: 21:30 (estimate.py, as of 16:40)');
      expect(tips(root, 'pin-seatReset')[0]).toBe('Seat reset · seat2 18:10\ntoday 18:10 · at the quota gate');
    },
  },
  {
    name: 'day: an ETA past the window reads "ETA Mon ▸" and an owner wait reads "on answer"',
    p: () => props('day'),
    check: ({ root }) => {
      const etas = [...root.querySelectorAll('[data-testid="eta"]')].map((e) => e.textContent);
      expect(etas).toContain('◆ ETA Mon ▸');
      expect(etas).toContain('◆ ETA 02:00 Sun');
      expect(root.querySelector('[data-testid="lane-ops"] [data-testid="eta-answer"]').textContent).toContain('on answer');
      expect(root.querySelector('[data-testid="lane-ops"] [data-testid="eta"]')).toBeNull();
      expect(root.querySelector('[data-testid="pin-expiry"]').textContent).toBe('◇ credits 11-10 ▸');
    },
  },
  {
    name: 'past: rows, spans and marks, with no now line, tint, current, next or ETA',
    p: () => props('past'),
    check: ({ root }) => {
      expect(count(root, 'now-line')).toBe(0);
      expect(root.querySelector('.future-bg')).toBeNull();
      expect(count(root, 'current')).toBe(0);
      expect(count(root, 'next')).toBe(0);
      expect(count(root, 'eta')).toBe(0);
      expect(count(root, 'span-work')).toBeGreaterThan(0);
      expect(count(root, 'span-wait')).toBeGreaterThan(0);
      expect(count(root, 'mark-land')).toBeGreaterThan(0);
      expect(root.querySelector('[data-testid="lane-2.0"]')).toBeTruthy();
      expect(root.querySelector('[data-testid="ribbon-title"]').textContent).toBe('Lanes · Thu 29 Oct 18:00 to Fri 30 Oct 18:00');
    },
  },
  {
    name: 'prehistory: dashed not-recorded regions name the source and no lane is blank',
    p: () => props('prehistory'),
    check: ({ root }) => {
      expect(count(root, 'region-notRecorded')).toBe(1);
      expect(root.querySelector('[data-testid="region-notRecorded"] [data-tip]').getAttribute('data-tip')).toBe('Not recorded · stamps.dispatched_at\nnot recorded: stamps begin 2026-09-01');
      for (const n of ['2.0', 'ops']) {
        const lane = root.querySelector(`[data-testid="lane-${n}"]`);
        expect(within(lane).getByTestId('lane-empty').textContent).toBe('not recorded in this window');
      }
    },
  },
  {
    name: 'a lane with nothing in a covered window says so in words',
    p: () => props('past', { edit: (d) => { d.lanes[0].spans = []; d.lanes[0].marks = []; } }),
    check: ({ root }) => {
      expect(within(root.querySelector('[data-testid="lane-2.0"]')).getByTestId('lane-empty').textContent).toBe('nothing in this window');
    },
  },
  {
    name: 'slipped ETA: the old pin is drawn greyed with "Earlier estimate" in its tip',
    p: () => props('day', { edit: (d) => { d.lanes[2].eta.prev = { p50: at('19:00'), asOf: at('12:10') }; } }),
    check: ({ root }) => {
      const prev = root.querySelector('[data-testid="eta-prev"]');
      expect(prev.getAttribute('class')).toContain('eta-prev');
      expect(prev.getAttribute('data-tip')).toBe('Earlier estimate: 19:00 (as of 12:10)');
    },
  },
  {
    name: 'bands: a hold and an outage each span the lanes with a tip',
    p: () => props('day', {
      edit: (d) => {
        d.bands = [
          { kind: 'hold', start: at('10:00'), end: at('12:00'), label: 'Batch hold', source: 'holds' },
          { kind: 'outage', start: at('15:00'), end: null, label: 'API outage', source: 'ledger' },
        ];
      },
    }),
    check: ({ root }) => {
      const hold = root.querySelector('[data-testid="band-hold"]');
      const outage = root.querySelector('[data-testid="band-outage"]');
      expect(hold.querySelector('rect.band-hold')).toBeTruthy();
      expect(outage.querySelector('rect.band-outage')).toBeTruthy();
      expect(hold.querySelector('[data-tip]').getAttribute('data-tip')).toBe('Hold · Batch hold\ntoday 10:00 to 12:00 · holds');
      expect(outage.querySelector('[data-tip]').getAttribute('data-tip')).toBe('Outage · API outage\ntoday 15:00 to ongoing · ledger');
      const lanesH = (r) => Number(r.querySelector('rect').getAttribute('height'));
      expect(lanesH(hold)).toBe(lanesH(outage));
      expect(lanesH(hold)).toBeGreaterThan(5 * 28);
    },
  },
  {
    name: 'alert: a ⚠ lands on its lane when since is in the window, and not when it is outside',
    p: () => props('day', { extra: { alerts: [
      { key: 'a1', lane: 'main', title: 'Gate stalled', since: at('13:00') },
      { key: 'a2', lane: 'main', title: 'Too old', since: '2026-10-20T13:00:00-07:00' },
      { key: 'a3', title: 'Seat 2 at the gate', since: at('15:00') },
    ] } }),
    check: ({ root }) => {
      const onMain = root.querySelector('[data-testid="lane-main"]').querySelectorAll('[data-testid="alert-mark"]');
      expect(onMain.length).toBe(1);
      expect(onMain[0].getAttribute('data-tip')).toBe('Alert · Gate stalled\nsince today 13:00');
      expect(count(root, 'alert-mark')).toBe(2);
      const x = Number(onMain[0].getAttribute('x'));
      expect(x).toBeGreaterThan(92);
      expect(x).toBeLessThan(1188);
    },
  },
  {
    name: 'keyboard: marks, pins, bands, lane names and the idle row are focusable and Enter or Space calls the right callback',
    p: () => props('day', { edit: (d) => { d.bands = [{ kind: 'hold', start: at('10:00'), end: at('12:00'), label: 'Batch hold', source: 'holds' }]; } }),
    check: ({ root, cb }) => {
      const focusable = [...root.querySelectorAll('[tabindex="0"]')];
      const lanes = root.querySelectorAll('[data-lane]').length;
      expect(lanes).toBe(5);
      const marks = count(root, 'mark-land') + count(root, 'mark-deploy') + count(root, 'mark-deployFail') + count(root, 'mark-decide');
      const pins = count(root, 'pin-seatReset') + count(root, 'pin-expiry');
      expect(focusable.length).toBe(lanes + 1 + marks + pins + 1);

      const land = root.querySelector('[data-testid="mark-land"]');
      key(land);
      expect(cb.onMarkOpen).toHaveBeenCalledTimes(1);
      expect(cb.onMarkOpen.mock.calls[0][0]).toMatchObject({ kind: 'land', title: 'Auth retry' });
      expect(cb.onLaneOpen).not.toHaveBeenCalled();
      key(root.querySelector('[data-testid="pin-seatReset"]'), ' ');
      expect(cb.onPinOpen.mock.calls[0][0]).toMatchObject({ kind: 'seatReset', label: 'seat2 18:10' });
      key(root.querySelector('[data-testid="band-hold"] [role="button"]'));
      expect(cb.onBandOpen.mock.calls[0][0]).toMatchObject({ kind: 'hold', label: 'Batch hold' });
      key(root.querySelector('[data-testid="lane-web"]'));
      expect(cb.onLaneOpen.mock.calls[0][0]).toMatchObject({ lane: 'web' });
      key(root.querySelector('[data-testid="idle-row"]'), ' ');
      expect(cb.onIdleToggle).toHaveBeenCalledTimes(1);
      key(root.querySelector('[data-testid="lane-web"]'), 'Escape');
      expect(cb.onLaneOpen).toHaveBeenCalledTimes(1);
      fireEvent.click(root.querySelector('[data-testid="lane-main"]'));
      expect(cb.onLaneOpen.mock.calls[1][0]).toMatchObject({ lane: 'main' });
    },
  },
  {
    name: 'a cluster mark draws its count and calls onMarkOpen',
    p: () => props('day', { edit: (d) => { d.lanes[0].marks.push({ kind: 'cluster', at: at('12:00'), count: 4, marks: [] }); } }),
    check: ({ root, cb }) => {
      const cl = root.querySelector('[data-testid="mark-cluster"]');
      expect(cl.textContent).toBe('4');
      expect(cl.getAttribute('data-tip')).toBe('4 events near today 12:00\nclick to open');
      fireEvent.click(cl);
      expect(cb.onMarkOpen.mock.calls[0][0]).toMatchObject({ kind: 'cluster', count: 4 });
    },
  },
  {
    name: 'hover and focus show the one tooltip element with the item text',
    p: () => props('day'),
    check: ({ root }) => {
      expect(count(root, 'ribbon-tip')).toBe(0);
      fireEvent.mouseOver(root.querySelector('[data-testid="span-notRecorded"]'));
      expect(root.querySelector('[data-testid="ribbon-tip"]').textContent).toBe('web · not recorded 6h 15m\nnot recorded: no dispatch stamp (rule U-d)');
      fireEvent.mouseOut(root.querySelector('[data-testid="span-notRecorded"]'));
      expect(count(root, 'ribbon-tip')).toBe(0);
      fireEvent.focus(root.querySelector('[data-testid="mark-decide"]'));
      expect(root.querySelectorAll('[data-testid="ribbon-tip"]').length).toBe(1);
      expect(root.querySelector('[data-testid="ribbon-tip"]').textContent).toContain('Decided for you · Hold beta for search filters');
    },
  },
  {
    name: 'flashLane: the named row flashes for 1.5 s and then stops',
    p: () => props('day', { extra: { flashLane: 'ops' } }),
    check: ({ root }) => {
      expect(root.querySelector('[data-testid="lane-ops"]').getAttribute('class')).toContain('rb-flash');
      expect(root.querySelector('[data-testid="lane-web"]').getAttribute('class')).not.toContain('rb-flash');
    },
  },
  {
    name: 'type floor: no 8, 9 or 10 px text in the ribbon sources',
    p: () => props('day'),
    check: () => {
      for (const f of ['DayRibbon.jsx', 'ribbonLayout.js']) {
        const src = readFileSync(resolve(process.cwd(), `src/components/ribbon/${f}`), 'utf8');
        expect(src.match(/text-\[(8|9|10)px\]/g) || []).toHaveLength(0);
        expect(src.match(/font-size:(8|9|10)(\.\d+)?px/g) || []).toHaveLength(0);
      }
    },
  },
  // ---- COMP-COCKPIT-RIBBON-RANGE-1: week-scale clusters and the axis drag (rows added, none changed) ----
  {
    name: 'week width: marks closer than 16 px merge into a count badge that opens like any mark',
    p: () => props('day', { extra: { from: '2026-10-25T00:00:00-07:00', to: '2026-11-02T00:00:00-07:00' } }),
    check: ({ root, cb }) => {
      expect(count(root, 'mark-cluster')).toBeGreaterThan(0);
      const cl = root.querySelector('[data-testid="mark-cluster"]');
      expect(cl.textContent).toBe('2');
      expect(count(root, 'mark-deploy')).toBe(0);
      fireEvent.click(cl);
      expect(cb.onMarkOpen.mock.calls[0][0]).toMatchObject({ kind: 'cluster', count: 2 });
      expect(cb.onMarkOpen.mock.calls[0][0].items.map((m) => m.kind)).toEqual(['land', 'deploy']);
    },
  },
  {
    name: 'axis drag: the axis strip draws a selection and a release over 15 minutes calls onAxisSelect(fromMs, toMs)',
    p: () => props('day', { extra: { onAxisSelect: AXIS } }),
    check: ({ root }) => {
      AXIS.mockClear();
      const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1200, height: 300, right: 1200, bottom: 300, x: 0, y: 0 });
      fireEvent.pointerDown(root.querySelector('[data-testid="axis-drag"]'), { clientX: 92, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 366, pointerId: 1 });
      expect(count(root, 'axis-selection')).toBe(1);
      fireEvent.pointerUp(window, { clientX: 366, pointerId: 1 });
      expect(AXIS).toHaveBeenCalledTimes(1);
      expect(AXIS).toHaveBeenCalledWith(Date.parse('2026-10-30T18:00:00-07:00'), Date.parse('2026-10-31T03:00:00-07:00'));
      expect(count(root, 'axis-selection')).toBe(0);
      box.mockRestore();
    },
  },
  {
    name: 'axis drag: Esc cancels and a drag under 15 minutes is ignored',
    p: () => props('day', { extra: { onAxisSelect: AXIS } }),
    check: ({ root }) => {
      AXIS.mockClear();
      const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1200, height: 300, right: 1200, bottom: 300, x: 0, y: 0 });
      fireEvent.pointerDown(root.querySelector('[data-testid="axis-drag"]'), { clientX: 92, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 500, pointerId: 1 });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(window, { clientX: 500, pointerId: 1 });
      fireEvent.pointerDown(root.querySelector('[data-testid="axis-drag"]'), { clientX: 300, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 302, pointerId: 1 });
      expect(AXIS).not.toHaveBeenCalled();
      box.mockRestore();
    },
  },
];

describe('DayRibbon', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const cb = spies();
      const { container, rerender } = render(<DayRibbon {...row.p()} {...cb} />);
      const root = container.querySelector('[data-testid="day-ribbon"]') || container;
      row.check({ c: container, root, cb, rerender });
    });
  }
});
