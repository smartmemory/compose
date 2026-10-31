/**
 * ribbon-meter.test.jsx — COMP-COCKPIT-RIBBON-METER-1: the cards behind the Day page's meter and the tray's jump.
 * ONE row table. Each row renders Day (and the chip when it needs it) over the shared ribbon fixture with the seats, hourly
 * and credit readers answered, then clicks like a person would.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
const { ROWS } = vi.hoisted(() => ({
  ROWS: [
    { key: 'attention:seat2 5h', kind: 'attention', severity: 'warn', title: 'seat2 5h: trip', detail: 'at the wall', since: null, sourceLabel: 'cadence attention', action: 'cadence', seat: 'seat2' },
    { key: 'ctx:ops-main', kind: 'context', severity: 'warn', title: 'ops-main is over 260K context', detail: 'Compaction due', since: null, sourceLabel: 'sessions', action: 'fleet', lane: 'ops' },
    { key: 'ctx:sm20-main', kind: 'context', severity: 'warn', title: 'sm20-main is over 260K context', detail: 'Compaction due', since: null, sourceLabel: 'sessions', action: 'fleet', lane: 'sm20' },
  ],
}));
vi.mock('../../src/components/cockpit/notify/useNotifySources.js', () => ({
  useNotifySources: () => ({ loading: false, collected: { rows: ROWS, unknown: [], defaults: [] }, chip: { state: 'alerts', count: ROWS.length, critical: 0, unavailable: 0 } }),
}));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView from '../../src/components/ribbon/DayView.jsx';
import NotifyChip from '../../src/components/cockpit/notify/NotifyChip.jsx';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const seat = (id, five) => ({ id, label: `Claude Team seat ${id.slice(4)}`, vendor: 'claude', status: 'missing', five_h: { used_pct: five, resets_at: '2099-01-01T00:00:00.000Z' }, seven_d: { used_pct: null, resets_at: null, status: 'missing' } });
const SEATS = { v: 1, seats: { value: { generated_at: '2026-10-31T12:00:00Z', seats: [seat('seat1', 20), seat('seat2', 96), { ...seat('codex', null), label: 'Codex prolite', today_pts: 9, codex_daily: { cap_pct: 13, state: 'ok', off: false } }] }, error: null } };
const HOURLY = { v: 1, hourly: { value: { buckets: [{ start: '2026-10-31T01:00:00+00:00', usd: 40 }, { start: '2026-10-31T02:00:00+00:00', usd: 235 }] }, error: null } };
const CREDIT = { v: 1, credit: { value: { balance_usd: null, hold: true }, error: null } };
const FLEET = { generated: 'x', sources: { sm_status: { value: { ceiling: { value: { line: 'spend today $2,403 / $4,000 (60%) · last 1h $153 (trip $350)', pct: 60, warn: false }, error: null }, spend: { value: { head: 'last 1h $153 API-equiv', rows: [] }, error: null } }, error: null } } };

function stub({ hourlyFails = false } = {}) {
  wsFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/ribbon')) return ok(FIXTURE);
    if (u.startsWith('/api/usage/seats')) return ok(SEATS);
    if (u.startsWith('/api/usage/hourly')) return hourlyFails ? { ok: false, status: 500, json: async () => ({ error: 'down' }) } : ok(HOURLY);
    if (u.startsWith('/api/usage/credit')) return ok(CREDIT);
    if (u.startsWith('/api/fleet')) return ok(FLEET);
    return ok({});
  });
  global.fetch = vi.fn(async () => ok(FLEET));
}
const text = (id) => screen.getByTestId(id).textContent;
const press = async (el) => { await act(async () => { fireEvent.click(el); }); };
const dayAndChip = (onNavigate = () => {}, dayActive = true) => render(<><NotifyChip onNavigate={onNavigate} onOpenFleet={() => {}} dayActive={dayActive} /><DayView onNavigate={onNavigate} /></>);

describe('Day meter cards and tray jump (COMP-COCKPIT-RIBBON-METER-1)', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/'); wsFetch.mockReset(); resetFleetPoller(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const ROW_TABLE = [
    ['a seat click shows its card with 5h, 5h-only 7d and each no-source line as not recorded; the link opens Usage', async () => {
      const nav = vi.fn();
      render(<DayView onNavigate={nav} />);
      await press(await screen.findByTestId('cost-meter-seat-seat2'));
      const pop = await screen.findByTestId('meter-popover');
      expect(pop.getAttribute('data-kind')).toBe('seat');
      expect(text('meter-row-5h used')).toBe('96%');
      expect(text('meter-row-7d used')).toBe('Team seats are 5h-only');
      for (const k of ['burn', 'on it', 'auto-hop']) expect(text(`meter-row-${k}`)).toBe('not recorded');
      await press(screen.getByTestId('meter-popover-link'));
      expect(nav).toHaveBeenCalledWith('usage');
      expect(screen.queryByTestId('meter-popover')).toBeNull();
    }],
    ['the money click shows today, last hour, Codex against the cap in the data, the hourly bars and credit', async () => {
      render(<DayView onNavigate={() => {}} />);
      await press(await screen.findByTestId('cost-meter-money'));
      await screen.findByTestId('meter-popover-bars');
      await waitFor(() => expect(text('meter-row-today')).toContain('$2,403 / $4,000')); // the card is live: it fills as the fleet poll answers
      expect(text('meter-row-last hour')).toContain('$153');
      expect(text('meter-row-Codex')).toBe('9 of 13 pts today');
      expect(text('meter-row-closed hours')).toMatch(/^peak \$235 at \d\d:\d\d$/);
      expect(text('meter-row-API credit')).toBe('balance not set · API billing on hold');
    }],
    ['hourly reader down: the money card says hourly is not recorded and draws no bars', async () => {
      stub({ hourlyFails: true });
      render(<DayView onNavigate={() => {}} />);
      await press(await screen.findByTestId('cost-meter-money'));
      await screen.findByTestId('meter-popover');
      await waitFor(() => expect(text('meter-row-hourly')).toBe('not recorded'));
      expect(screen.queryByTestId('meter-popover-bars')).toBeNull();
    }],
    ['close rules: Esc, a press outside and a second seat replacing the first; focus returns to the seat row', async () => {
      render(<DayView onNavigate={() => {}} />);
      const row = await screen.findByTestId('cost-meter-seat-seat2');
      row.focus();
      await press(row);
      await screen.findByTestId('meter-popover');
      await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
      expect(screen.queryByTestId('meter-popover')).toBeNull();
      expect(document.activeElement).toBe(row);
      await press(row);
      await screen.findByTestId('meter-popover');
      await act(async () => { fireEvent.pointerDown(document.body); });
      expect(screen.queryByTestId('meter-popover')).toBeNull();
      await press(row);
      await press(screen.getByTestId('cost-meter-seat-seat1'));
      expect(screen.getAllByTestId('meter-popover')).toHaveLength(1);
      expect(text('meter-popover-title')).toBe('Claude Team seat 1');
    }],
    ['on Day a tray row about a seat flashes that seat in the meter; the card machinery stays closed', async () => {
      dayAndChip();
      await screen.findByTestId('cost-meter-seat-seat2');
      await press(screen.getByTestId('notify-chip'));
      const jumps = screen.getAllByTestId('notify-row-jump');
      expect(jumps.map((b) => b.textContent)).toEqual(['Show seat2 ▸', 'Show ops lane ▸', 'Show sm20 lane ▸']);
      await press(jumps[0]);
      await waitFor(() => expect(screen.getByTestId('cost-meter-seat-seat2').getAttribute('data-flash')).toBe('true'));
      expect(screen.queryByTestId('notify-tray')).toBeNull();
      expect(screen.queryByTestId('meter-popover')).toBeNull();
    }],
    ['on Day a tray row about a lane flashes that lane row', async () => {
      dayAndChip();
      await screen.findByTestId('lane-ops');
      await press(screen.getByTestId('notify-chip'));
      await press(screen.getAllByTestId('notify-row-jump')[1]);
      await waitFor(() => expect(screen.getByTestId('lane-ops').getAttribute('class')).toContain('rb-flash'));
      expect(screen.queryByTestId('notify-tray')).toBeNull();
    }],
    ['a lane Day does not draw is not taken: the row\'s own action runs instead', async () => {
      const nav = vi.fn();
      const open = vi.fn();
      render(<><NotifyChip onNavigate={nav} onOpenFleet={open} dayActive /><DayView onNavigate={nav} /></>);
      await screen.findByTestId('lane-ops');
      await press(screen.getByTestId('notify-chip'));
      await press(screen.getAllByTestId('notify-row-jump')[2]);
      expect(open).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('lane-ops').getAttribute('class')).not.toContain('rb-flash');
    }],
    ['off Day the tray shows no jump and the old Open action runs', async () => {
      const nav = vi.fn();
      render(<NotifyChip onNavigate={nav} onOpenFleet={() => {}} dayActive={false} />);
      await press(screen.getByTestId('notify-chip'));
      expect(screen.queryAllByTestId('notify-row-jump')).toHaveLength(0);
      await press(screen.getAllByTestId('notify-row-action')[0]);
      expect(nav).toHaveBeenCalledWith('cadence');
    }],
  ];

  for (const [name, fn] of ROW_TABLE) {
    it(name, async () => { stub(); await fn(); }, 30000);
  }
});
