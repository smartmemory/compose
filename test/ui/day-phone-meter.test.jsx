/**
 * day-phone-meter.test.jsx — COMP-COCKPIT-PHONE-1: at 390 px the Day page's meter opens the same seat and money cards as
 * the desktop one. ONE row table, each row renders the phone Day page over the shared ribbon fixture and clicks like a person.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView, { EVT } from '../../src/components/ribbon/DayView.jsx';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const seat = (id, five) => ({ id, label: `Claude Team seat ${id.slice(4)}`, vendor: 'claude', status: 'missing', five_h: { used_pct: five, resets_at: '2099-01-01T00:00:00.000Z' }, seven_d: { used_pct: null, resets_at: null, status: 'missing' } });
const SEATS = { v: 1, seats: { value: { generated_at: '2026-10-31T12:00:00Z', seats: [seat('seat1', 20), seat('seat2', 96)] }, error: null } };
const HOURLY = { v: 1, hourly: { value: { buckets: [{ start: '2026-10-31T01:00:00+00:00', usd: 40 }] }, error: null } };
const CREDIT = { v: 1, credit: { value: { balance_usd: null, hold: true }, error: null } };
const FLEET = { generated: 'x', sources: { sm_status: { value: { ceiling: { value: { line: 'spend today $2,403 / $4,000 (60%) · last 1h $153 (trip $350)', pct: 60, warn: false }, error: null }, spend: { value: { head: 'last 1h $153 API-equiv', rows: [] }, error: null } }, error: null } } };

function stub() {
  wsFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/ribbon')) return ok(FIXTURE);
    if (u.startsWith('/api/usage/seats')) return ok(SEATS);
    if (u.startsWith('/api/usage/hourly')) return ok(HOURLY);
    if (u.startsWith('/api/usage/credit')) return ok(CREDIT);
    if (u.startsWith('/api/fleet')) return ok(FLEET);
    return ok({});
  });
  global.fetch = vi.fn(async () => ok(FLEET));
}
const setWidth = (w) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
const press = async (el) => { await act(async () => { fireEvent.click(el); }); };

describe('phone Day meter cards (COMP-COCKPIT-PHONE-1)', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/'); wsFetch.mockReset(); resetFleetPoller(); setWidth(390); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); setWidth(1024); });

  const ROW_TABLE = [
    ['the box and meter keep their phone classes and test ids', async () => {
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('cost-meter-seat-seat2');
      // C5 (U1): no height cap and no inner scroll, so every seat row is whole.
      expect(screen.getByTestId('day-phone-meter-box').className).not.toMatch(/max-h-|overflow-y-auto/);
      expect(screen.queryByTestId('day-phone-meter-toggle')).toBeNull();
      expect(screen.getByTestId('day-phone-meter').className).toContain('shrink-0');
      expect(screen.queryByTestId('day-ribbon')).toBeNull();
    }],
    ['a seat tap opens the seat card, Esc closes it and focus returns to the row', async () => {
      render(<DayView onNavigate={() => {}} />);
      const row = await screen.findByTestId('cost-meter-seat-seat2');
      row.focus();
      await press(row);
      expect((await screen.findByTestId('meter-popover')).getAttribute('data-kind')).toBe('seat');
      await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
      expect(screen.queryByTestId('meter-popover')).toBeNull();
      expect(document.activeElement).toBe(row);
    }],
    ['U2 PHONE-1 M1: an outside tap that closes the card gives focus back to the row it came from', async () => {
      render(<DayView onNavigate={() => {}} />);
      const row = await screen.findByTestId('cost-meter-seat-seat2');
      row.focus();
      await press(row);
      await screen.findByTestId('meter-popover');
      // A browser moves focus to the body after a press on nothing focusable; jsdom does not, so the test does it.
      await act(async () => { fireEvent.pointerDown(document.body); document.activeElement?.blur(); await new Promise((r) => setTimeout(r, 5)); });
      expect(screen.queryByTestId('meter-popover')).toBeNull();
      expect(document.activeElement).toBe(row);
    }],
    ['U2 METER M1: a jump the page cannot draw is not taken (the phone has no ribbon; a seat the meter does not show has no row)', async () => {
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('cost-meter-seat-seat2');
      const send = (detail) => { const e = new CustomEvent(EVT.focus, { detail, cancelable: true }); act(() => { window.dispatchEvent(e); }); return e.defaultPrevented; };
      expect([send({ lane: 'main' }), send({ seat: 'seat2' })]).toEqual([false, false]);
      cleanup();
      setWidth(1440);
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('day-ribbon');
      await screen.findByTestId('cost-meter-seat-seat2');
      expect([send({ seat: 'seat9' }), send({ lane: 'no-such-lane' }), send({ seat: 'seat2' })]).toEqual([false, false, true]);
    }],
    ['the money tap opens the money card', async () => {
      render(<DayView onNavigate={() => {}} />);
      await press(await screen.findByTestId('cost-meter-money'));
      expect((await screen.findByTestId('meter-popover')).getAttribute('data-kind')).toBe('money');
    }],
    ['the card link calls onNavigate with usage and closes the card', async () => {
      const nav = vi.fn();
      render(<DayView onNavigate={nav} />);
      await press(await screen.findByTestId('cost-meter-seat-seat1'));
      await press(await screen.findByTestId('meter-popover-link'));
      expect(nav).toHaveBeenCalledWith('usage');
      expect(screen.queryByTestId('meter-popover')).toBeNull();
    }],
  ];

  for (const [name, run] of ROW_TABLE) it(name, async () => { stub(); await run(); });
});
