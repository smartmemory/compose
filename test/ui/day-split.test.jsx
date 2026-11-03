/**
 * day-split.test.jsx — COMP-DAYVIEW-SPLIT-1: the Day view's upper panel is drag-resizable (height remembered), and the meter
 * below it is full size with no scroll inside it; the page scrolls instead.
 *
 * Rows mount the desktop DayView over the shared ribbon fixture and a six-seat usage body. jsdom has no layout, so the upper
 * panel's top reads 0 and the max is the window height less the handle (DaySplit.jsx `maxFor`).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView from '../../src/components/ribbon/DayView.jsx';
import {
  HANDLE_PX, UPPER_DEFAULT_PX, UPPER_HEIGHT_KEY, UPPER_MIN_PX, UPPER_STEP_PX,
} from '../../src/components/ribbon/DaySplit.jsx';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const SEAT_IDS = ['seat1', 'seat2', 'seat3', 'seat4', 'seat5', 'seat6'];
const seat = (id, five) => ({ id, label: `Claude Team seat ${id.slice(4)}`, vendor: 'claude', status: 'ok', five_h: { used_pct: five, resets_at: '2099-01-01T00:00:00.000Z' }, seven_d: { used_pct: 10, resets_at: '2099-01-02T00:00:00.000Z', status: 'ok' } });
const SEATS = { v: 1, seats: { value: { generated_at: '2026-11-03T12:00:00Z', seats: SEAT_IDS.map((id, i) => seat(id, 10 + i * 10)) }, error: null } };

function stub() {
  wsFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/ribbon')) return ok(FIXTURE);
    if (u.startsWith('/api/usage/seats')) return ok(SEATS);
    return ok({});
  });
  global.fetch = vi.fn(async () => ok({}));
}
const WIN_H = 900;
const MAX = WIN_H - HANDLE_PX;
const setHeight = (h) => Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: h });
const handle = () => screen.getByTestId('day-split-handle');
const now = () => Number(handle().getAttribute('aria-valuenow'));
const upperPx = () => screen.getByTestId('day-upper').style.height;
const mount = async () => { render(<DayView onNavigate={() => {}} />); await screen.findByTestId('day-ribbon'); };

describe('Day split: resizable upper panel, full-size meter (COMP-DAYVIEW-SPLIT-1)', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
    wsFetch.mockReset(); resetFleetPoller(); setHeight(WIN_H);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); setHeight(768); });

  it('the separator carries its aria values, and the upper panel takes the default height', async () => {
    await mount();
    const h = handle();
    const got = ['role', 'aria-orientation', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'tabindex'].map((a) => h.getAttribute(a));
    expect(got).toEqual(['separator', 'horizontal', String(UPPER_DEFAULT_PX), String(UPPER_MIN_PX), String(MAX), '0']);
    expect(upperPx()).toBe(`${UPPER_DEFAULT_PX}px`);
    // The handle sits between the upper panel and the meter.
    expect([h.previousElementSibling?.dataset.testid, h.nextElementSibling?.dataset.testid]).toEqual(['day-upper', 'day-meter']);
  });

  it('key steps move the height within min and max, and each step is stored (one row table)', async () => {
    await mount();
    const rows = [
      { key: 'ArrowDown', want: UPPER_DEFAULT_PX + UPPER_STEP_PX },
      { key: 'ArrowUp', want: UPPER_DEFAULT_PX },
      { key: 'ArrowUp', want: UPPER_DEFAULT_PX - UPPER_STEP_PX },
      { key: 'Home', want: UPPER_MIN_PX },
      { key: 'ArrowUp', want: UPPER_MIN_PX }, // never below the min
      { key: 'End', want: MAX },
      { key: 'ArrowDown', want: MAX }, // never past the window
    ];
    for (const r of rows) {
      fireEvent.keyDown(handle(), { key: r.key });
      expect([now(), upperPx(), localStorage.getItem(UPPER_HEIGHT_KEY)], r.key).toEqual([r.want, `${r.want}px`, String(r.want)]);
    }
  });

  it('a pointer drag resizes live, stores once on release, and clamps to min and max', async () => {
    await mount();
    fireEvent.pointerDown(handle(), { clientY: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientY: 400, pointerId: 1 });
    expect([now(), upperPx(), localStorage.getItem(UPPER_HEIGHT_KEY)]).toEqual([UPPER_DEFAULT_PX - 100, `${UPPER_DEFAULT_PX - 100}px`, null]);
    fireEvent.pointerUp(window, { clientY: 400, pointerId: 1 });
    expect(localStorage.getItem(UPPER_HEIGHT_KEY)).toBe(String(UPPER_DEFAULT_PX - 100));

    fireEvent.pointerDown(handle(), { clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientY: 9000, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect([now(), localStorage.getItem(UPPER_HEIGHT_KEY)]).toEqual([MAX, String(MAX)]);

    fireEvent.pointerDown(handle(), { clientY: 800, pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientY: -5000, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect([now(), localStorage.getItem(UPPER_HEIGHT_KEY)]).toEqual([UPPER_MIN_PX, String(UPPER_MIN_PX)]);
  });

  it('the stored height is read back on remount; double-click resets to the default and forgets it', async () => {
    await mount();
    fireEvent.keyDown(handle(), { key: 'Home' });
    cleanup();
    await mount();
    expect([now(), upperPx()]).toEqual([UPPER_MIN_PX, `${UPPER_MIN_PX}px`]);
    fireEvent.doubleClick(handle());
    expect([now(), upperPx(), localStorage.getItem(UPPER_HEIGHT_KEY)]).toEqual([UPPER_DEFAULT_PX, `${UPPER_DEFAULT_PX}px`, null]);
  });

  it('a corrupt, out-of-range or unreadable stored value falls back to the default with no error (one row table)', async () => {
    const rows = ['abc', '', '   ', 'NaN', '-5', '12', '99999', 'Infinity', '{"h":300}'];
    for (const raw of rows) {
      cleanup(); localStorage.setItem(UPPER_HEIGHT_KEY, raw);
      await mount();
      expect([now(), upperPx()], JSON.stringify(raw)).toEqual([UPPER_DEFAULT_PX, `${UPPER_DEFAULT_PX}px`]);
    }
    // Storage that throws on read and on write: the default stands and a key step still moves the panel.
    cleanup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    await mount();
    expect(now()).toBe(UPPER_DEFAULT_PX);
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(now()).toBe(UPPER_DEFAULT_PX + UPPER_STEP_PX);
  });

  it('a short window caps the height so the handle stays on screen; a valid stored value is kept, only shown clamped', async () => {
    setHeight(400);
    localStorage.setItem(UPPER_HEIGHT_KEY, '700');
    await mount();
    expect([now(), handle().getAttribute('aria-valuemax'), localStorage.getItem(UPPER_HEIGHT_KEY)]).toEqual([400 - HANDLE_PX, String(400 - HANDLE_PX), '700']);
    setHeight(WIN_H);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(now()).toBe(700);
  });

  it('the meter is full size: every seat row in the DOM, no toggle, no capped or scrolling box inside it', async () => {
    await mount();
    for (const id of SEAT_IDS) await screen.findByTestId(`cost-meter-seat-${id}`);
    const meter = screen.getByTestId('day-meter');
    const classes = [meter, ...meter.querySelectorAll('*')].map((el) => String(el.getAttribute('class') || ''));
    expect([
      screen.queryByTestId('day-meter-toggle'),
      classes.filter((c) => /(^|\s)(max-h-\S+|overflow-y-auto|overflow-auto|overflow-y-scroll|overflow-scroll)(\s|$)/.test(c)),
      meter.className.split(/\s+/).includes('shrink-0'),
    ]).toEqual([null, [], true]);
  });

  it('the page gives way: the root scrolls, the upper panel does not flex, and the WHAT line still sticks', async () => {
    await mount();
    const root = screen.getByTestId('day-view').className.split(/\s+/);
    const upper = screen.getByTestId('day-upper').className.split(/\s+/);
    const what = screen.getByTestId('day-what').className.split(/\s+/);
    expect([
      root.includes('overflow-y-auto'), root.includes('overflow-hidden'),
      upper.includes('shrink-0'), upper.includes('flex-1'),
      what.includes('sticky') && what.includes('top-0'),
    ]).toEqual([true, false, true, false, true]);
  });
});
