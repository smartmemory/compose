/**
 * ribbon-resets.test.jsx — COMP-COCKPIT-RIBBON-RESETS-COMPACT-1: the AHEAD resets row is one line of ticks.
 *
 * One row table. Each row draws `DayRibbon` (or the whole `DayView`) from the day fixture and asserts what the unit's
 * acceptance criteria name: tick labels, the next reset's full label, merging with a count, state colors, the alert
 * relocation to the range bar's chip, and the toggle with its `localStorage` memory.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayRibbon from '../../src/components/ribbon/DayRibbon.jsx';
import DayView, { RESETS_HIDDEN_KEY } from '../../src/components/ribbon/DayView.jsx';
import RangeBar from '../../src/components/ribbon/RangeBar.jsx';
import { orphanAlerts, resetTag, RESET_MERGE_PX } from '../../src/components/ribbon/ribbonLayout.js';

const day = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const NOW = '2026-10-31T16:40:00-07:00';
const at = (h) => `2026-10-31T${h}:00-07:00`;
const NEXT = (h) => `2026-11-01T${h}:00-07:00`;
const pin = (seat, h, extra = {}) => ({ kind: 'seatReset', at: at(h), label: `${seat} 5h limit resets`, seat, atGate: false, ...extra });
const draw = (pins, extra = {}) => render(<DayRibbon data={{ ...day, pins }} from={day.from} to={day.to} now={NOW} {...extra} />).container;
const ticks = (root) => [...root.querySelectorAll('[data-testid="pin-seatReset"]')];
const word = (g) => g.querySelector('text').textContent.trim();
const svgHeight = (root) => Number(root.querySelector('svg').getAttribute('viewBox').split(' ')[3]);

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

const ROWS = [
  {
    name: 'labels: a tick is just s1..s4 or cx, the fixture day reads s2, s1 and one merged x2',
    run: () => {
      const root = draw(day.pins);
      expect(ticks(root).map(word)).toEqual(['s2', 's1', 'x2']);
      expect(['seat2', 'seat1', 'seat3', 'seat4', 'codex', 'other'].map((s) => resetTag({ seat: s }))).toEqual(['s2', 's1', 's3', 's4', 'cx', 'other']);
      // one line: every tick sits on the same baseline
      expect(new Set(root.querySelectorAll('[data-testid^="pin-"] text')).size).toBeGreaterThan(0);
      expect(new Set([...root.querySelectorAll('[data-testid^="pin-"] text')].map((t) => t.getAttribute('y'))).size).toBe(1);
    },
  },
  {
    name: 'next reset: only each seat\'s first reset after now carries the full words, the rest are tags with the text on hover',
    run: () => {
      const root = draw([pin('seat2', '18:10'), pin('seat2', '23:10'), pin('codex', '03:00', { at: NEXT('03:00') })]);
      const g = ticks(root);
      expect(g.map(word)).toEqual(['seat2 resets in 1.5h', 's2', 'cx']);
      expect(g[0].getAttribute('data-tip')).toBe('Seat reset · seat2 5h limit resets\ntoday 18:10');
      expect(g[1].getAttribute('data-tip')).toContain('23:10');
    },
  },
  {
    name: `merge: ticks under ${RESET_MERGE_PX} px apart become one counted tick whose hover lists each reset`,
    run: () => {
      const root = draw([pin('seat1', '22:40'), pin('seat3', '22:50'), pin('seat4', '23:05')]);
      const g = ticks(root);
      expect(g).toHaveLength(1);
      expect(word(g[0])).toBe('x3');
      expect(g[0].getAttribute('data-count')).toBe('3');
      expect(g[0].getAttribute('data-tip')).toBe('3 resets 22:40\nseat1 5h limit resets 22:40\nseat3 5h limit resets 22:50\nseat4 5h limit resets 23:05');
      // a click on it opens the list as a cluster of resets
      const onPinOpen = vi.fn();
      cleanup();
      const again = draw([pin('seat1', '22:40'), pin('seat3', '22:50')], { onPinOpen });
      fireEvent.click(ticks(again)[0]);
      expect(onPinOpen.mock.calls[0][0]).toMatchObject({ kind: 'cluster', count: 2 });
      expect(onPinOpen.mock.calls[0][0].items.map((p) => p.seat)).toEqual(['seat1', 'seat3']);
    },
  },
  {
    name: 'state colors: at the cap is red (gate), a seat with an open alert is amber, a cleared alert does not count, the rest plain',
    run: () => {
      const alerts = [{ key: 'a1', seat: 'seat1', title: 'seat1 hot', since: at('15:00') }, { key: 'a2', seat: 'seat3', title: 'old', since: at('15:00'), cleared: { action: 'ack', at: at('15:30') } }];
      const root = draw([pin('seat2', '18:10', { atGate: true }), pin('seat1', '19:30'), pin('seat3', '22:40'), pin('seat4', '03:00', { at: NEXT('03:00') })], { alerts });
      expect(ticks(root).map((g) => g.getAttribute('data-tone'))).toEqual(['gate', 'alert', 'plain', 'plain']);
    },
  },
  {
    name: 'height: nine overlapping resets used to stack nine deep, now the row is one line (same svg height as a single reset)',
    run: () => {
      const nine = ['seat1', 'seat2', 'seat3', 'seat4', 'codex'].flatMap((s, i) => [pin(s, `1${i}:00`), pin(s, `2${i}:00`)]).slice(0, 9);
      const many = svgHeight(draw(nine));
      cleanup();
      const one = svgHeight(draw([pin('seat2', '18:10')]));
      cleanup();
      const none = svgHeight(draw([]));
      expect(many).toBe(one);
      expect(one - none).toBe(6 + 12 + 17); // the row's 6 px gap, 12 px heading space and one 17 px line
    },
  },
  {
    name: 'alerts: a lane-less alert is not drawn in the row, the pure filter keeps the same ones the row used to draw',
    run: () => {
      const alerts = [
        { key: 'a1', lane: 'main', title: 'lane one', since: at('13:00') },
        { key: 'a3', title: 'orphan', since: at('15:00') },
        { key: 'a4', title: 'too old', since: '2026-10-20T13:00:00-07:00' },
        { key: 'a5', title: 'orphan cleared', since: at('14:00'), cleared: { action: 'ack', at: at('14:30') } },
      ];
      const root = draw(day.pins, { alerts });
      expect(root.querySelectorAll('[data-testid="alert-mark"]')).toHaveLength(1); // only the lane's
      expect(orphanAlerts(alerts, day.from, day.to).map((a) => a.key)).toEqual(['a3', 'a5']);
      // the chip: open count, cleared count, and an all-cleared chip says so instead of "0 alerts"
      const bar = (chip) => render(<RangeBar window={{ from: day.from, to: day.to }} following={false} onRange={() => {}} onPreset={() => {}} onStep={() => {}} onNow={() => {}} alertChip={chip} onAlertChip={() => {}} />);
      bar({ open: 1, cleared: 1, tip: 'x' });
      expect(screen.getByTestId('ribbon-alert-chip').textContent).toBe('⚠ 1 (+1 cleared)');
      cleanup();
      bar({ open: 0, cleared: 2, tip: 'x' });
      expect(screen.getByTestId('ribbon-alert-chip').textContent).toBe('✓ 2 cleared');
    },
  },
  {
    name: 'next-resets line: always visible under the row, one entry per seat in time order, alert seat toned, hidden with none',
    run: () => {
      // the live-like case: seats within minutes of each other, so every tick merges and no tick carries full words
      const live = [pin('seat3', '17:15'), pin('seat2', '17:10'), pin('seat4', '17:20'), pin('seat2', '22:10'), pin('seat1', '16:00')];
      const root = draw(live, { alerts: [{ seat: 'seat3', since: NOW, title: 'x' }] });
      expect(ticks(root).map(word)).toEqual(['s1', 'x3', 's2']);
      const line = root.querySelector('[data-testid="next-resets"]');
      expect([...line.querySelectorAll('.nr')].map((n) => n.textContent)).toEqual(['s2 30m', 's3 35m', 's4 40m']);
      expect(line.querySelector('[data-seat="seat3"]').className).toContain('nr-alert');
      expect(line.querySelector('[data-seat="seat2"]').className).toContain('nr-plain');
      cleanup();
      expect(draw([pin('seat1', '16:00')]).querySelector('[data-testid="next-resets"]')).toBeNull();
    },
  },
  {
    name: 'toggle: hides the AHEAD row, survives a remount through localStorage, and still works when storage throws',
    run: async () => {
      // DayView's window comes from Date.now; pin it to the fixture's NOW so the fixture resets stay ahead on any real date.
      // Only Date is faked: findBy/waitFor keep real timers.
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
      wsFetch.mockImplementation(async (url) => ({ ok: true, status: 200, json: async () => (String(url).startsWith('/api/ribbon') ? day : {}), text: async () => '' }));
      global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      const first = render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('day-ribbon');
      expect(screen.queryAllByTestId('pin-seatReset').length).toBeGreaterThan(0);
      const heightOn = svgHeight(first.container);
      const btn = screen.getByTestId('range-resets-toggle');
      expect(btn.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(btn);
      expect(localStorage.getItem(RESETS_HIDDEN_KEY)).toBe('1');
      expect(screen.queryAllByTestId('pin-seatReset')).toHaveLength(0);
      expect(screen.queryAllByTestId('pin-expiry')).toHaveLength(0);
      expect(svgHeight(first.container)).toBeLessThan(heightOn);
      expect(screen.getByTestId('range-resets-toggle').getAttribute('aria-pressed')).toBe('false');
      first.unmount();
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('day-ribbon');
      expect(screen.queryAllByTestId('pin-seatReset')).toHaveLength(0);
      fireEvent.click(screen.getByTestId('range-resets-toggle'));
      expect(localStorage.getItem(RESETS_HIDDEN_KEY)).toBe('0');
      expect(screen.queryAllByTestId('pin-seatReset').length).toBeGreaterThan(0);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
      fireEvent.click(screen.getByTestId('range-resets-toggle'));
      expect(screen.queryAllByTestId('pin-seatReset')).toHaveLength(0);
      expect(within(screen.getByTestId('range-bar')).getByTestId('range-resets-toggle')).toBeTruthy();
    },
  },
];

describe('AHEAD resets row (COMP-COCKPIT-RIBBON-RESETS-COMPACT-1)', () => {
  for (const row of ROWS) it(row.name, async () => { await row.run(); }, 30000);
});
