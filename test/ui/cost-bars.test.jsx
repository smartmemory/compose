/**
 * cost-bars.test.jsx — COMP-COCKPIT-MONEY-COMPACT-1: the compact money block (`CostMeter bars`). ONE row table; each row renders the
 * meter over fixed seat/spend rows and a fixed `now`, then reads what a person would see (text, bar state, hover).
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import CostMeter from '../../src/components/cockpit/cost/CostMeter.jsx';

const NOW = '2026-11-01T12:00:00Z';
const at = (min) => new Date(Date.parse(NOW) + min * 60_000).toISOString();
const seat = (n, five, mins, fable) => ({
  id: `seat${n}`, label: `Claude Team seat ${n}`, five_h: { used_pct: five, resets_at: at(mins) }, seven_d: { used_pct: null, resets_at: null, status: 'missing' },
  fable: fable ? { used_pct: fable.used, cap_pct: fable.cap, over_cap: fable.over === true, resets_at: at(fable.mins) } : undefined,
});
const SEATS = [
  seat(1, 70, 27, { used: 9, cap: 100, mins: 6 * 1440 }),
  seat(2, 100, 90, { used: 29, cap: 100, over: true, mins: 2470 }),
  seat(3, 23, 100, { used: 70, cap: 70, over: true, mins: 6 * 1440 }),
  seat(4, 17, 100, { used: 53, cap: 100, mins: 2 * 1440 }),
  { id: 'seat0', label: 'Claude Max', retired: true, five_h: {}, seven_d: {} },
  { id: 'codex', label: 'Codex prolite', five_h: {}, seven_d: {}, today_pts: 7, codex_daily: { cap_pct: 13, state: 'ok', off: false } },
];
const ROWS5 = ['$   30.00  s1-chat', '$   11.00  ops-main', '$   10.00  sm20-main', '$    4.00  wk-a', '$    2.00  wk-b'];
const spend = (warn, rows = ROWS5) => ({
  ceiling: { text: 'spend today $607 / $4,000 (15%) · last 1h $87 (trip $350)', pct: 15, warn },
  spend: { text: 'last 1h $87 API-equiv · 773 calls · 16 sessions', rows },
});
const meter = (over = {}) => render(<CostMeter bars compact seats={SEATS} spend={spend(false)} asOf={NOW} now={NOW} credit={null} {...over} />);
const t = (id) => screen.getByTestId(id).textContent;
const state = (id) => screen.getByTestId(id).querySelector('[role="progressbar"]').getAttribute('data-state');

describe('Day money block as bars (COMP-COCKPIT-MONEY-COMPACT-1)', () => {
  afterEach(() => cleanup());

  const ROW_TABLE = [
    ['a seat bar reads "s1 70% · 27m" and the 5h-only caption is not repeated per seat', () => {
      meter();
      expect(t('cost-meter-5h-seat1')).toBe('s1 70% · 27m');
      expect(screen.getByTestId('cost-meter').textContent.match(/5h-only/g)).toBeNull();
      expect(screen.getByTestId('cost-meter-seat-seat1').getAttribute('title')).toContain('Team seats are 5h-only');
    }],
    ['a seat at 100% of its window is red, a seat under it is plain', () => {
      meter();
      expect([state('cost-meter-seat-seat1'), state('cost-meter-seat-seat2')]).toEqual(['ok', 'full']);
    }],
    ['fable bars: used of cap and reset on the label, over pace is amber, at the cap is red, under pace is plain', () => {
      meter();
      expect([t('cost-meter-fable-seat1'), t('cost-meter-fable-seat3'), t('cost-meter-fable-seat2')]).toEqual(['s1 9%/100% · 6d', 's3 70%/70% · 6d', 's2 29%/100% · 41.2h']);
      expect([state('cost-meter-fable-seat4'), state('cost-meter-fable-seat2'), state('cost-meter-fable-seat3')]).toEqual(['ok', 'warn', 'full']);
    }],
    ['codex is one small bar reading "7/13 pts"', () => {
      meter();
      expect(t('cost-meter-codex')).toBe('Codex7/13 pts');
      expect(state('cost-meter-codex')).toBe('ok');
    }],
    ['the dollars line keeps its summary and bar together, and a warning turns the bar amber', () => {
      meter({ spend: spend(true) });
      expect(t('cost-meter-ceiling')).toContain('spend today $607 / $4,000 (15%)');
      expect(screen.getByTestId('cost-meter-ceiling-bar').getAttribute('data-state')).toBe('warn');
    }],
    ['sessions collapse to the top 3 inline and "+2 more" expands the rest, then "less" folds it back', () => {
      meter();
      expect(t('cost-meter-sessions')).toBe('s1-chat $30.00 · ops-main $11.00 · sm20-main $10.00');
      fireEvent.click(screen.getByTestId('cost-meter-sessions-more'));
      expect(t('cost-meter-sessions')).toContain('wk-b $2.00');
      expect(t('cost-meter-sessions-more')).toBe('less');
      fireEvent.click(screen.getByTestId('cost-meter-sessions-more'));
      expect(t('cost-meter-sessions')).not.toContain('wk-b');
    }],
    ['three or fewer sessions have no "more" control', () => {
      meter({ spend: spend(false, ROWS5.slice(0, 3)) });
      expect(screen.queryByTestId('cost-meter-sessions-more')).toBeNull();
    }],
    ['the retired seat is a hover on the Seats label, not a visible line', () => {
      meter();
      const label = screen.getByText(/Seats 5h/);
      expect(label.getAttribute('title')).toBe('1 retired seat hidden: Claude Max');
      expect(screen.getByTestId('cost-meter-retired').className).toContain('sr-only');
    }],
    ['credit, per-seat note and as-of stay on one footer', () => {
      meter();
      expect(t('cost-meter-foot')).toContain('API credit: reading…');
      expect(t('cost-meter-foot')).toContain('Dollars per seat: not recorded');
      expect(t('cost-meter-foot')).toMatch(/as of \d\d:\d\d \(0m ago\)/);
    }],
  ];
  it.each(ROW_TABLE)('%s', (_name, run) => { run(); });
});
