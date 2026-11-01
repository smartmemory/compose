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
    ['each seat is a PAIR: two bars, left = its 5h value, right = its weekly value, each with its own reset, none stacked or shared', () => {
      meter();
      const pair = screen.getByTestId('cost-meter-seat-seat1');
      expect(pair.querySelectorAll('[role="progressbar"]').length).toBe(2);
      const [left, right] = [...pair.querySelectorAll('[role="progressbar"]')];
      expect([left.getAttribute('data-height'), right.getAttribute('data-height')]).toEqual(['70', '9']);
      expect(screen.getByTestId('cost-meter-5h-seat1').contains(left)).toBe(true);
      expect(screen.getByTestId('cost-meter-fable-seat1').contains(right)).toBe(true);
      expect([t('cost-meter-5h-seat1'), t('cost-meter-fable-seat1')]).toEqual(['70%27m', '9%6d']);
      expect(pair.textContent.endsWith('s1')).toBe(true);
      expect(screen.getByTestId('cost-meter').textContent.match(/5h-only/g)).toBeNull();
      expect(pair.getAttribute('title')).toContain('Team seats are 5h-only');
      expect(screen.getAllByRole('progressbar', { hidden: true }).filter((b) => b.closest('[data-testid^="cost-meter-seat-"]')).length).toBe(8);
    }],
    ['bar heights are used % on one 0-100 scale: a Fable bar at 70% of a 70 cap is 70 tall, not full', () => {
      meter();
      const h = (id) => screen.getByTestId(id).querySelector('[role="progressbar"]').getAttribute('data-height');
      expect([h('cost-meter-5h-seat2'), h('cost-meter-5h-seat4'), h('cost-meter-fable-seat3'), h('cost-meter-fable-seat4')]).toEqual(['100', '17', '70', '53']);
    }],
    ['the 5h bar is red at the cap and plain under it, and never amber', () => {
      meter();
      expect([state('cost-meter-5h-seat1'), state('cost-meter-5h-seat2')]).toEqual(['ok', 'full']);
    }],
    ['weekly bar: over pace is amber, under pace is plain, at its cap is red, and its pace/cap tick is on the weekly bar only', () => {
      meter();
      expect([state('cost-meter-fable-seat4'), state('cost-meter-fable-seat2'), state('cost-meter-fable-seat3')]).toEqual(['ok', 'warn', 'full']);
      expect(screen.getByTestId('cost-meter-fable-seat3-tick').getAttribute('data-tick')).toBe('70');
      expect(screen.queryByTestId('cost-meter-fable-seat1-tick')).toBeNull();
      expect(screen.queryByTestId('cost-meter-5h-seat3-tick')).toBeNull();
      expect(screen.getByTestId('cost-meter-fable-seat3').getAttribute('title')).toContain('pace line 70%');
    }],
    ['a pace_pct from the reader wins over the cap for the tick position', () => {
      const withPace = SEATS.map((s) => (s.id === 'seat4' ? { ...s, fable: { ...s.fable, pace_pct: 40 } } : s));
      meter({ seats: withPace });
      expect(screen.getByTestId('cost-meter-fable-seat4-tick').getAttribute('data-tick')).toBe('40');
    }],
    ['reset labels sit under each bar: 5h 27m / weekly 6d on one seat, 1.5h / 41.2h on another', () => {
      meter();
      expect([t('cost-meter-5h-seat1').endsWith('27m'), t('cost-meter-fable-seat1').endsWith('6d'), t('cost-meter-5h-seat2').endsWith('1.5h'), t('cost-meter-fable-seat2').endsWith('41.2h')]).toEqual([true, true, true, true]);
    }],
    ['Codex with no 5h reading draws only its 7d bar (Codex has no 5h window); a missing 7d is an "n/a" empty track; the points stay on the hover', () => {
      meter();
      expect(screen.getByTestId('cost-meter-codex').querySelectorAll('[role="progressbar"]').length).toBe(1);
      expect(screen.queryByTestId('cost-meter-5h-codex')).toBeNull();
      expect(t('cost-meter-7d-codex')).toBe('n/a\u00a0');
      expect(screen.getByTestId('cost-meter-7d-codex').querySelector('[role="progressbar"]').getAttribute('data-state')).toBe('empty');
      expect(screen.getByTestId('cost-meter-codex').getAttribute('title')).toContain('7/13 pts today');
    }],
    ['Codex with both readings draws them, and a non-ok state turns the 7d bar amber', () => {
      const codex = { id: 'codex', label: 'Codex prolite', five_h: { used_pct: 40, resets_at: at(120) }, seven_d: { used_pct: 80, resets_at: at(3 * 1440) }, today_pts: 7, codex_daily: { cap_pct: 13, state: 'warn', off: false } };
      meter({ seats: [...SEATS.slice(0, 5), codex] });
      expect([t('cost-meter-5h-codex'), t('cost-meter-7d-codex')]).toEqual(['40%2.0h', '80%3d']);
      expect(screen.getByTestId('cost-meter-7d-codex').querySelector('[role="progressbar"]').getAttribute('data-state')).toBe('warn');
      expect(screen.getByTestId('cost-meter-codex').getAttribute('title')).toContain('(warn)');
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
      const label = screen.getByText(/^Seats/);
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
