/**
 * launch-refused.test.jsx — the Day ribbon's refused mark and retry-queue count (COMP-DOGFOOD-LAUNCH-GATE-1 boxes 3 and 4).
 *
 * The data goes in as a prop (the component fetches nothing): the RIBBON-ROWS-1 day fixture plus one `refused` mark on ops
 * and `launches.queue` in the shape GET /api/ribbon answers (lib/launch-events.js applyLaunchFeed).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import DayRibbon from '../../src/components/ribbon/DayRibbon.jsx';
import { MARK_SHAPES } from '../../src/components/ribbon/marks/MarkShape.jsx';

const NOW = '2026-10-31T16:40:00-07:00';
const GATE = 'WORK MODEL GATE (claude shim): SEAT CEILING GATE: target account seat4 (Claude Team seat 4) 5h used 97% >= its ceiling 70%, resets 23:00. No new work.';

function props({ queue }) {
  const data = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
  data.lanes.find((l) => l.lane === 'ops').marks.push({ kind: 'refused', at: '2026-10-31T14:00:00-07:00', unit: 'O-9', title: 'seat-equalize', label: 'seat-equalize',
    text: 'refused: SEAT CEILING GATE: seat4 5h used 97% >= its ceiling 70%', full: GATE, reverse: null, source: 'launch-events', laneGuess: false, attempt: 0 });
  data.launches = { queue };
  return { data, from: data.from, to: data.to, now: NOW, onIdleToggle: vi.fn(), onLaneOpen: vi.fn(), onMarkOpen: vi.fn(), onPinOpen: vi.fn(), onBandOpen: vi.fn() };
}
const entry = { label: 'seat-equalize', meter: 'overall', seat: 'seat4', frees_at: '2026-10-31T23:00:00.000Z', gate_line: GATE };

describe('DayRibbon: a launch the gate refused', () => {
  it('draws a cross on the job\'s lane with "refused: <gate line>" beside it, and the queue count with its labels on hover', () => {
    expect(MARK_SHAPES.has('refused')).toBe(true);
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1600, height: 600, right: 1600, bottom: 600, x: 0, y: 0 });
    try {
      const { container } = render(<DayRibbon {...props({ queue: { count: 1, labels: ['seat-equalize'], entries: [entry], expired: [] } })} />);
      const legend = container.querySelector('[data-testid="ribbon-legend"]');
      expect(legend.querySelectorAll('[data-shape="cross"]').length).toBe(1);
      expect([...container.querySelectorAll('[data-shape="cross"]')].filter((el) => !legend.contains(el)).length).toBe(1);
      const words = container.querySelector('[data-testid="mark-refused-text"]');
      expect(words?.textContent).toMatch(/^refused: SEAT CEILING GATE/);
      const q = container.querySelector('[data-testid="launch-queue"]');
      expect(q?.textContent).toContain('1 queued');
      expect(q?.getAttribute('data-tip')).toContain('seat-equalize');
    } finally { box.mockRestore(); }
  });
  it('shows no queue count when nothing is queued, or when the store could not be read (null)', () => {
    for (const queue of [{ count: 0, labels: [], entries: [], expired: [] }, null]) {
      const { container, unmount } = render(<DayRibbon {...props({ queue })} />);
      expect(container.querySelector('[data-testid="launch-queue"]')).toBeNull();
      unmount();
    }
  });
});
