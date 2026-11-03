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
import { textWidth } from '../../src/components/ribbon/textFit.js';

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
    width: 1600,
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
      for (const k of ['land', 'decide']) expect(count(root, `mark-${k}`)).toBeGreaterThan(0);
      // U2 M5: a deploy 5 minutes after its landing sits ~3 px away at day width, so the two are one counted mark.
      expect(count(root, 'mark-deploy')).toBe(0);
      expect(count(root, 'mark-cluster')).toBe(2);
      expect(count(root, 'now-line')).toBe(1);
      expect(root.textContent).toContain('NOW 16:40');
      // U2 M2: the title is cut by what fits before the next unit and the ETA, never by a character count; here it all fits.
      expect(root.querySelector('[data-testid="lane-2.0"] [data-testid="current"]').textContent).toBe('Search filters by workspace · 7h 10m');
      expect(root.querySelector('[data-testid="lane-2.0"] [data-testid="current"]').getAttribute('data-state')).toBe('working');
      expect(root.querySelector('[data-testid="lane-2.0"] [data-testid="next"]').textContent).toMatch(/^→ Workspace/);
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
    width: 1600,
    p: () => props('day'),
    check: ({ root }) => {
      for (const id of ['span-work', 'span-wait', 'span-notRecorded', 'mark-land', 'mark-cluster', 'mark-deployFail', 'mark-decide', 'pin-seatReset', 'pin-expiry', 'current', 'next', 'eta']) {
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
    name: 'day: an ETA past the window reads "ETA Mon ▸", one inside it is a diamond at its time, an owner wait reads "on answer"',
    p: () => props('day'),
    check: ({ root }) => {
      const edge = [...root.querySelectorAll('[data-testid="eta"][data-where="edge"]')].map((e) => e.textContent);
      expect(edge).toEqual(['◆ ETA Mon ▸']);
      // U2 M3: web's 21:30 is inside the window, so it is a ◆ on the axis at 21:30 (X0 100 + 27.5/36 of the 1086 px track).
      const web = root.querySelector('[data-testid="lane-web"] [data-testid="eta"]');
      expect(web.getAttribute('data-where')).toBe('axis');
      expect(web.textContent).toBe('');
      expect(web.getAttribute('aria-label')).toBe('Expected landing, web lane: 21:30');
      expect(web.querySelector('path').getAttribute('d')).toMatch(/^M929\.6 /);
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
      // C2 (U1): the source-level gap is words under the ribbon, never a box over the lane field.
      expect(count(root, 'region-notRecorded')).toBe(1);
      expect(root.querySelector('svg [data-testid="region-notRecorded"]')).toBeNull();
      expect(root.querySelector('svg .reg-norec')).toBeNull();
      expect(root.querySelector('[data-testid="ribbon-gaps"] [data-testid="region-notRecorded"]').getAttribute('data-tip')).toBe('Not recorded · stamps.dispatched_at\nnot recorded: stamps begin 2026-09-01');
      expect(root.querySelector('[data-testid="ribbon-gaps"]').textContent).toBe('Not recorded in this window: stamps.dispatched_at (not recorded: stamps begin 2026-09-01)');
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
      expect(prev.getAttribute('class')).toBe('eta-pin prev');
      // ROWS L1: the earlier estimate is a tab stop that opens the ETA card, like the current one.
      expect(prev.getAttribute('tabindex')).toBe('0');
      expect(prev.getAttribute('data-tip')).toBe('Earlier estimate: 19:00 (as of 12:10)');
    },
  },
  {
    name: 'U2 ROWS L1 + RANGE M4: a missed earlier estimate (before now) stays drawn, is a tab stop, and a click or Enter opens the ETA card',
    p: () => props('day', { edit: (d) => { d.lanes[2].eta.prev = { p50: at('12:00'), asOf: at('08:10') }; } }),
    check: ({ root, cb }) => {
      const lane = load('day').lanes[2].lane;
      const prev = root.querySelector(`[data-testid="lane-${lane}"] [data-testid="eta-prev"]`);
      expect(prev).toBeTruthy();
      expect(prev.getAttribute('tabindex')).toBe('0');
      fireEvent.click(prev);
      key(prev, 'Enter');
      expect(cb.onMarkOpen).toHaveBeenCalledTimes(2);
      expect(cb.onMarkOpen.mock.calls[0][0]).toMatchObject({ kind: 'eta', lane });
      expect(cb.onLaneOpen).not.toHaveBeenCalled();
    },
  },
  {
    name: 'live estimator ETA: a duration "9h" is a diamond 9 h after now, and a click or Enter opens the ETA card, not the lane',
    p: () => props('day', { edit: (d) => { d.lanes[2].eta = { p50: '9h', p80: '32h', asOf: '2026-10-31T20:14', raw: 'r', prev: null }; } }),
    check: ({ root, cb }) => {
      const lane = load('day').lanes[2].lane;
      const pin = root.querySelector(`[data-testid="lane-${lane}"] [data-testid="eta"]`);
      expect(pin.getAttribute('data-where')).toBe('axis');
      expect(pin.getAttribute('aria-label')).toBe(`Expected landing, ${lane} lane: in 9h`);
      expect(pin.getAttribute('data-tip')).toBe('Expected landing of the current unit: in 9h (estimate.py, as of 20:14)');
      fireEvent.click(pin);
      key(pin, 'Enter');
      expect(cb.onMarkOpen).toHaveBeenCalledTimes(2);
      expect(cb.onMarkOpen.mock.calls[0][0]).toEqual({ kind: 'eta', lane, p50: '9h', p80: '32h', asOf: '2026-10-31T20:14', prev: null });
      expect(cb.onLaneOpen).not.toHaveBeenCalled();
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
      // RESETS-COMPACT-1: the lane-less alert (a3) no longer draws in the AHEAD row, the range bar's alert chip carries it.
      expect(count(root, 'alert-mark')).toBe(1);
      const x = Number(onMain[0].getAttribute('x'));
      expect(x).toBeGreaterThan(100);
      expect(x).toBeLessThan(1186);
    },
  },
  {
    // COMP-COCKPIT-NOTIFY-ACTIONS-1: a cleared alert keeps its mark, muted with a check, and the tip says what cleared it.
    name: 'alert: a cleared alert draws muted with ✓ and its tip names the clearing',
    p: () => props('day', { extra: { alerts: [
      { key: 'a1', lane: 'main', title: 'Gate stalled', since: at('13:00') },
      { key: 'a2', lane: 'main', title: 'Seat wall', since: at('14:00'), cleared: { action: 'ack', at: at('14:30') } },
    ] } }),
    check: ({ root }) => {
      const marks = [...root.querySelector('[data-testid="lane-main"]').querySelectorAll('[data-testid="alert-mark"]')];
      expect(marks.map((m) => [m.getAttribute('class'), m.textContent])).toEqual([['tk alert', '⚠'], ['tk alert cleared', '✓⚠']]);
      expect(marks[1].getAttribute('data-tip')).toBe('Alert · Seat wall\nsince today 14:00 · acknowledged 14:30');
    },
  },
  {
    name: 'keyboard: marks, pins, bands, lane names and the idle row are focusable and Enter or Space calls the right callback',
    p: () => props('day', { edit: (d) => { d.bands = [{ kind: 'hold', start: at('10:00'), end: at('12:00'), label: 'Batch hold', source: 'holds' }]; } }),
    check: ({ root, cb }) => {
      const focusable = [...root.querySelectorAll('[tabindex="0"]')];
      const lanes = root.querySelectorAll('[data-lane]').length;
      expect(lanes).toBe(5);
      const marks = count(root, 'mark-land') + count(root, 'mark-deploy') + count(root, 'mark-deployFail') + count(root, 'mark-decide') + count(root, 'mark-cluster');
      const pins = count(root, 'pin-seatReset') + count(root, 'pin-expiry');
      // LIVE-DATA-1: the ETA pin is a tab stop; U1 (C3): so is the owner marker at NOW on a lane waiting on you.
      expect(count(root, 'owner-now')).toBe(1);
      expect(focusable.length).toBe(lanes + 1 + marks + pins + count(root, 'eta') + 1 + count(root, 'owner-now'));

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
      const cl = [...root.querySelectorAll('[data-testid="mark-cluster"]')].find((e) => e.textContent === '4');
      expect(cl).toBeTruthy();
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
      // U2 M1: one svg unit is one px (box 1200 wide, viewBox the same), track 100..1186; 03:00 is 9/36 of 1086 px in.
      const H = Number(root.querySelector('svg[data-testid="ribbon-svg"]').getAttribute('height'));
      const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1200, height: H, right: 1200, bottom: H, x: 0, y: 0 });
      fireEvent.pointerDown(root.querySelector('[data-testid="axis-drag"]'), { clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 371.5, pointerId: 1 });
      expect(count(root, 'axis-selection')).toBe(1);
      fireEvent.pointerUp(window, { clientX: 371.5, pointerId: 1 });
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
  // ---- COMP-DAYVIEW-DESIGN-FIX-1 U2 ----
  ...[1200, 1600].map((width) => ({
    name: `U2 M2: at ${width} px no two words right of now overlap, on any lane (measured, 16 px apart)`,
    width,
    p: () => props('day', { edit: (d) => { d.lanes[0].current.title = 'Search filters by workspace with a much longer name than fits anywhere'; } }),
    check: ({ root }) => {
      const X1 = width - 14;
      let checked = 0;
      for (const lane of root.querySelectorAll('[data-lane]')) {
        const cur = lane.querySelector('[data-testid="current"] text');
        const nxt = lane.querySelector('[data-testid="next"]');
        const edge = lane.querySelector('[data-testid^="eta"][x]');
        const curEnd = cur ? Number(cur.getAttribute('x')) + textWidth(cur.textContent, 13, 550) : null;
        const nextEnd = nxt ? Number(nxt.getAttribute('x')) + textWidth(nxt.textContent, 13) : null;
        const edgeStart = edge ? X1 - textWidth(edge.textContent, 13) : X1;
        if (cur) { expect(curEnd, lane.dataset.lane).toBeLessThanOrEqual(edgeStart - 16 + 0.1); checked += 1; }
        if (nxt) {
          expect(Number(nxt.getAttribute('x')), lane.dataset.lane).toBeGreaterThanOrEqual(curEnd + 16 - 0.1);
          expect(nextEnd, lane.dataset.lane).toBeLessThanOrEqual(edgeStart - 16 + 0.1);
        }
      }
      expect(checked).toBeGreaterThan(3);
      // The long title is cut with an ellipsis to its room, never past it.
      expect(root.querySelector('[data-testid="lane-2.0"] [data-testid="current"]').textContent).toMatch(/…/);
    },
  })),
  {
    name: 'U2 M1: the svg is drawn 1:1, its width and viewBox the measured box width, so 13 px text is 13 px on screen',
    width: 1340,
    p: () => props('day'),
    check: ({ root }) => {
      const svg = root.querySelector('svg[data-testid="ribbon-svg"]');
      expect(svg.getAttribute('width')).toBe('1340');
      expect(svg.getAttribute('viewBox')).toBe(`0 0 1340 ${svg.getAttribute('height')}`);
      expect(root.querySelector('[data-testid="axis-drag"]').getAttribute('width')).toBe(String(1340 - 14 - 100));
    },
  },
  {
    name: 'U2 RANGE M1: a drag on a letterboxed svg reads the pointer through the box and viewBox (client 350 is the window start)',
    p: () => props('day', { extra: { onAxisSelect: AXIS } }),
    check: ({ root }) => {
      AXIS.mockClear();
      const H = Number(root.querySelector('svg[data-testid="ribbon-svg"]').getAttribute('height'));
      // The box is half as tall as the drawing: "meet" scales by 0.5 and centres it, 300 px of slack each side.
      const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1200, height: H / 2, right: 1200, bottom: H / 2, x: 0, y: 0 });
      fireEvent.pointerDown(root.querySelector('[data-testid="axis-drag"]'), { clientX: 350, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 350 + 271.5 / 2, pointerId: 1 });
      expect(AXIS).toHaveBeenCalledWith(Date.parse('2026-10-30T18:00:00-07:00'), Date.parse('2026-10-31T03:00:00-07:00'));
      box.mockRestore();
    },
  },
  {
    name: 'U2 M3: no "200h" anywhere (days instead), and no ETA on a lane that is waiting',
    p: () => props('day', { edit: (d) => { d.lanes[2].eta = { p50: '200h', p80: '240h', asOf: '2026-10-31T16:00', raw: 'r', prev: null }; } }),
    check: ({ root }) => {
      const web = root.querySelector('[data-testid="lane-web"] [data-testid="eta"]');
      expect(web.getAttribute('data-where')).toBe('edge');
      expect(web.textContent).toBe('◆ ETA in 8d 8h ▸');
      expect(root.textContent).not.toMatch(/\d{3}h/);
      // main waits on review: no ETA of any kind; ops waits on the owner: "on answer", never a time.
      expect(root.querySelector('[data-testid="lane-main"] [data-testid^="eta"]')).toBeNull();
      expect(root.querySelector('[data-testid="lane-ops"] [data-testid="eta"]')).toBeNull();
    },
  },
  {
    name: 'U2 M15: while updating, the axis and lane names draw with "updating…", no bars and no "nothing in this window"',
    p: () => props('day', { edit: (d) => { for (const l of d.lanes) { l.spans = []; l.marks = []; } d.pins = []; }, extra: { updating: true } }),
    check: ({ root }) => {
      expect(root.querySelector('[data-testid="ribbon-fresh"]').textContent).toBe('updating…');
      expect(count(root, 'lane-2.0')).toBe(1);
      expect(count(root, 'lane-empty')).toBe(0);
      expect(count(root, 'current')).toBe(0);
      expect(root.querySelectorAll('[data-testid="ribbon-svg"] .ax').length).toBeGreaterThan(3);
    },
  },
  {
    name: 'U2 M6: the group names its majority project once; a lane chip shows only where it differs',
    p: () => props('day', { extra: { laneProjects: { '2.0': { project: 'sm', label: 'SmartMemory', lane: 'x' }, main: { project: 'sm', label: 'SmartMemory', lane: 'y' }, web: { project: 'cp', label: 'Compose', lane: 'z' } }, onProjectOpen: vi.fn() } }),
    check: ({ root }) => {
      const g = root.querySelector('[data-testid="group-project-product"]');
      expect(g.textContent).toBe('SmartMemory');
      expect(count(root, 'lane-project-2.0')).toBe(0);
      expect(count(root, 'lane-project-main')).toBe(0);
      expect(root.querySelector('[data-testid="lane-project-web"]').textContent).toBe('Compose');
    },
  },
  {
    name: 'U2 M8: the window is said once (the title), never again as end labels on the axis',
    p: () => props('day'),
    check: ({ root }) => {
      const svgText = [...root.querySelectorAll('[data-testid="ribbon-svg"] text')].map((t) => t.textContent);
      expect(svgText).not.toContain('yesterday 18:00');
      expect(svgText).not.toContain('tomorrow 06:00');
      expect(root.querySelector('[data-testid="ribbon-title"]').textContent).toBe('Lanes · yesterday 18:00 to tomorrow 06:00');
    },
  },
  {
    name: 'M9: the legend lists exactly the span kinds this render draws, and drops one when it is gone',
    p: () => props('day'),
    check: ({ root, rerender }) => {
      const SPAN_KEYS = ['owner', 'work', 'stale', 'review', 'gate', 'quota', 'unknown', 'norec'];
      const spanKeys = () => {
        const out = new Set([...root.querySelectorAll('rect.seg')].map((r) => ({ 's-work': 'work', 's-stale': 'stale', 's-norec': 'norec' })[[...r.classList].find((c) => c.startsWith('s-'))] ?? [...r.classList].find((c) => c.startsWith('s-')).slice(2)));
        if (root.querySelector('[data-testid="span-wait"][data-cause="owner"], g[data-cause="owner"]')) out.add('owner');
        return [...out].sort();
      };
      const legendKeys = () => [...root.querySelectorAll('[data-testid="ribbon-legend"] [data-key]')].map((e) => e.getAttribute('data-key')).filter((k) => SPAN_KEYS.includes(k)).sort();
      const before = spanKeys();
      expect(before.length).toBeGreaterThan(1);
      expect(legendKeys()).toEqual(before);
      const gone = before.find((k) => k !== 'work');
      const strip = props('day', { edit: (d) => { for (const l of d.lanes) l.spans = (l.spans || []).filter((sp) => (sp.kind === 'wait' ? (['review', 'gate', 'quota', 'owner'].includes(sp.cause) ? sp.cause : 'unknown') : sp.kind === 'work' ? 'work' : 'norec') !== gone); } });
      rerender(<DayRibbon {...strip} />);
      expect(legendKeys()).not.toContain(gone);
      expect(legendKeys()).toEqual(spanKeys());
    },
  },
];

describe('DayRibbon', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const cb = spies();
      // U2 M1: the ribbon is as wide as its box; a row may set that width (jsdom measures nothing, so the default is 1200).
      const box = row.width ? vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: row.width, height: 600, right: row.width, bottom: 600, x: 0, y: 0 }) : null;
      try {
        const { container, rerender } = render(<DayRibbon {...cb} {...row.p()} />);
        const root = container.querySelector('[data-testid="day-ribbon"]') || container;
        row.check({ c: container, root, cb, rerender });
      } finally { box?.mockRestore(); }
    });
  }
});
