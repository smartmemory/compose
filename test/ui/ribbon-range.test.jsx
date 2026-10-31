/**
 * ribbon-range.test.jsx — the ribbon's range control (COMP-COCKPIT-RIBBON-RANGE-1).
 *
 * One row table. A small harness wires `useRibbonWindow`, `useRibbonFeed`, `RangeBar` and `DayRibbon` the way
 * RIBBON-TOP-1 will, with a mocked `wsFetch`. Each row drives one control and asserts the hash written and the
 * `/api/ribbon` URL asked for. The clock is fixed (Sat 31 Oct 16:40, -07:00), so every window is exact.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayRibbon from '../../src/components/ribbon/DayRibbon.jsx';
import RangeBar from '../../src/components/ribbon/RangeBar.jsx';
import { useRibbonWindow } from '../../src/components/ribbon/useRibbonWindow.js';
import { useRibbonFeed } from '../../src/components/ribbon/useRibbonFeed.js';
import { formatHash } from '../../src/components/ribbon/rangeLogic.js';

const NOW = '2026-10-31T16:40:00-07:00';
const DAY = { from: '2026-10-30T18:00:00-07:00', to: '2026-11-01T06:00:00-07:00' };
const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const urlFor = (w) => `/api/ribbon?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`;
const asked = () => wsFetch.mock.calls.map((c) => c[0]);
const w = (from, to) => ({ from, to });

function Harness({ active = true, clock = () => NOW }) {
  const r = useRibbonWindow({ active, clock });
  const feed = useRibbonFeed(r.window);
  return (
    <div>
      <RangeBar window={r.window} following={r.following} clampedBecause={r.clampedBecause} onRange={r.setRange}
        onPreset={r.preset} onStep={r.step} onNow={r.goNow} />
      {feed.loading
        ? <div data-testid="skeleton" />
        : <DayRibbon data={feed.data || { lanes: [] }} from={r.window.from} to={r.window.to} now={r.now} onAxisSelect={r.zoom} />}
    </div>
  );
}

const q = (root, id) => root.querySelector(`[data-testid="${id}"]`);
const setPicker = (root, id, value) => { const el = q(root, id); fireEvent.change(el, { target: { value } }); fireEvent.blur(el); };
/** The svg reports a 1200 x 300 box at the origin, so clientX is the svg x (track runs 92 to 1188). */
const withBox = () => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1200, height: 300, right: 1200, bottom: 300, x: 0, y: 0 });
const drag = (root, fromX, toX) => {
  fireEvent.pointerDown(q(root, 'axis-drag'), { clientX: fromX, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: toX, pointerId: 1 });
  return () => fireEvent.pointerUp(window, { clientX: toX, pointerId: 1 });
};

const ROWS = [
  {
    name: 'no hash: the day default, following, no hash written, fetched once',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      expect(asked()).toEqual([urlFor(DAY)]);
      expect(window.location.hash).toBe('');
      expect(q(root, 'ribbon-title').textContent).toBe('Lanes · yesterday 18:00 to tomorrow 06:00');
      expect(q(root, 'range-now').disabled).toBe(true);
      expect(q(root, 'range-preset-day').getAttribute('aria-pressed')).toBe('true');
      expect(q(root, 'now-line')).toBeTruthy();
    },
  },
  {
    name: 'loading: a skeleton until the first response, never an empty ribbon',
    setup: () => { wsFetch.mockImplementation(() => new Promise(() => {})); },
    run: async ({ root }) => {
      expect(q(root, 'skeleton')).toBeTruthy();
      expect(q(root, 'day-ribbon')).toBeNull();
    },
  },
  {
    name: 'a #ribbon. hash for 2026-10-20 on load: that past window, no NOW line, not following',
    setup: () => { window.history.replaceState(null, '', `/${formatHash(w('2026-10-20T00:00:00-07:00', '2026-10-21T00:00:00-07:00'))}`); },
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      expect(asked()).toEqual([urlFor(w('2026-10-20T00:00:00-07:00', '2026-10-21T00:00:00-07:00'))]);
      expect(q(root, 'now-line')).toBeNull();
      expect(q(root, 'range-now').disabled).toBe(false);
      expect(q(root, 'ribbon-title').textContent).toBe('Lanes · Tue 20 Oct 00:00 to Wed 21 Oct 00:00');
    },
  },
  {
    name: 'preset 6h: the resolved window is fetched and written to the hash',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      fireEvent.click(q(root, 'range-preset-6h'));
      const six = w('2026-10-31T12:40:00-07:00', '2026-10-31T18:40:00-07:00');
      await waitFor(() => expect(asked()).toContain(urlFor(six)));
      expect(window.location.hash).toBe(formatHash(six));
      expect(q(root, 'range-preset-6h').getAttribute('aria-pressed')).toBe('true');
      expect(q(root, 'range-now').disabled).toBe(false);
    },
  },
  {
    name: 'preset on a past window keeps its centre (3d around 2026-10-20 noon)',
    setup: () => { window.history.replaceState(null, '', `/${formatHash(w('2026-10-19T18:00:00-07:00', '2026-10-21T06:00:00-07:00'))}`); },
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      fireEvent.click(q(root, 'range-preset-3d'));
      const want = w('2026-10-18T12:00:00-07:00', '2026-10-22T12:00:00-07:00');
      await waitFor(() => expect(asked()).toContain(urlFor(want)));
      expect(window.location.hash).toBe(formatHash(want));
    },
  },
  {
    name: 'arrows move one window width back and forward',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      fireEvent.click(q(root, 'range-back'));
      const back = w('2026-10-29T06:00:00-07:00', '2026-10-30T18:00:00-07:00');
      await waitFor(() => expect(window.location.hash).toBe(formatHash(back)));
      expect(asked()).toContain(urlFor(back));
      fireEvent.click(q(root, 'range-forward'));
      await waitFor(() => expect(window.location.hash).toBe(formatHash(DAY)));
    },
  },
  {
    name: 'picker: editing start commits on blur, writes the hash and fetches that window',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      const n = asked().length;
      fireEvent.change(q(root, 'range-start'), { target: { value: '2026-10-30T12:00' } });
      expect(asked().length).toBe(n);
      expect(window.location.hash).toBe('');
      fireEvent.blur(q(root, 'range-start'));
      const want = w('2026-10-30T12:00:00-07:00', DAY.to);
      await waitFor(() => expect(asked()).toContain(urlFor(want)));
      expect(window.location.hash).toBe(formatHash(want));
      expect(q(root, 'range-start').value).toBe('2026-10-30T12:00');
    },
  },
  {
    name: 'picker: a 40-day start clamps to 31 days with the reason shown',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      setPicker(root, 'range-start', '2026-09-21T00:00');
      const want = w('2026-10-01T06:00:00-07:00', DAY.to);
      await waitFor(() => expect(window.location.hash).toBe(formatHash(want)));
      expect(q(root, 'range-clamp').textContent).toBe('A window is at most 31 days (what the feed serves).');
      expect(asked()).toContain(urlFor(want));
    },
  },
  {
    name: 'picker: an end before the start never reaches the feed',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      setPicker(root, 'range-end', '2026-10-30T10:00');
      const want = w(DAY.from, '2026-10-30T19:00:00-07:00');
      await waitFor(() => expect(window.location.hash).toBe(formatHash(want)));
      expect(q(root, 'range-clamp').textContent).toContain('end must be after the start');
      expect(asked().every((u) => { const p = new URL(u, 'http://x').searchParams; return Date.parse(p.get('from')) < Date.parse(p.get('to')); })).toBe(true);
    },
  },
  {
    name: 'Now: back to the live default, hash cleared, button disabled again',
    setup: () => { window.history.replaceState(null, '', `/${formatHash(w('2026-10-20T00:00:00-07:00', '2026-10-21T00:00:00-07:00'))}`); },
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      fireEvent.click(q(root, 'range-now'));
      await waitFor(() => expect(asked()).toContain(urlFor(DAY)));
      expect(window.location.hash).toBe('');
      expect(q(root, 'range-now').disabled).toBe(true);
      await waitFor(() => expect(q(root, 'now-line')).toBeTruthy());
    },
  },
  {
    name: 'Now leaves a hash that is not the ribbon\'s alone',
    setup: () => { window.history.replaceState(null, '', '/#other'); },
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      fireEvent.click(q(root, 'range-preset-6h'));
      await waitFor(() => expect(window.location.hash).toContain('#ribbon.'));
      window.history.replaceState(null, '', '/#other');
      fireEvent.click(q(root, 'range-now'));
      expect(window.location.hash).toBe('#other');
    },
  },
  {
    name: 'drag on the axis: release zooms to the dragged span and writes the hash',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      const box = withBox();
      const release = drag(root, 92, 92 + 1096 / 4);
      expect(q(root, 'axis-selection')).toBeTruthy();
      expect(window.location.hash).toBe('');
      release();
      const want = w('2026-10-30T18:00:00-07:00', '2026-10-31T03:00:00-07:00');
      await waitFor(() => expect(window.location.hash).toBe(formatHash(want)));
      expect(asked()).toContain(urlFor(want));
      expect(q(root, 'axis-selection')).toBeNull();
      box.mockRestore();
    },
  },
  {
    name: 'drag on the axis: Esc during the drag cancels, nothing is written',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      const box = withBox();
      const n = asked().length;
      const release = drag(root, 92, 400);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(q(root, 'axis-selection')).toBeNull();
      release();
      expect(window.location.hash).toBe('');
      expect(asked().length).toBe(n);
      box.mockRestore();
    },
  },
  {
    name: 'drag on the axis: under 15 minutes is a click, not a zoom',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      const box = withBox();
      drag(root, 200, 202)();
      expect(window.location.hash).toBe('');
      box.mockRestore();
    },
  },
  {
    name: 'one hash write per committed change, none for the same window twice',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      const spy = vi.spyOn(window.history, 'replaceState');
      fireEvent.click(q(root, 'range-preset-3d'));
      await waitFor(() => expect(window.location.hash).toContain('#ribbon.'));
      expect(spy).toHaveBeenCalledTimes(1);
      fireEvent.click(q(root, 'range-preset-3d'));
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    },
  },
  {
    name: 'inactive: the window still changes and fetches, but no hash is written',
    props: { active: false },
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      fireEvent.click(q(root, 'range-preset-6h'));
      await waitFor(() => expect(asked()).toContain(urlFor(w('2026-10-31T12:40:00-07:00', '2026-10-31T18:40:00-07:00'))));
      expect(window.location.hash).toBe('');
    },
  },
  {
    name: 'hashchange: a pasted ribbon hash moves the window',
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      const want = w('2026-10-20T00:00:00-07:00', '2026-10-21T00:00:00-07:00');
      window.history.replaceState(null, '', `/${formatHash(want)}`);
      act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
      await waitFor(() => expect(asked()).toContain(urlFor(want)));
      expect(q(root, 'range-now').disabled).toBe(false);
    },
  },
  {
    name: 'a past window already fetched comes back from memory without asking again',
    setup: () => { window.history.replaceState(null, '', `/${formatHash(w('2026-10-19T18:00:00-07:00', '2026-10-21T06:00:00-07:00'))}`); },
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      fireEvent.click(q(root, 'range-back'));
      await waitFor(() => expect(asked()).toContain(urlFor(w('2026-10-18T06:00:00-07:00', '2026-10-19T18:00:00-07:00'))));
      const n = asked().length;
      fireEvent.click(q(root, 'range-forward'));
      await waitFor(() => expect(q(root, 'range-start').value).toBe('2026-10-19T18:00'));
      expect(q(root, 'day-ribbon')).toBeTruthy();
      expect(asked().length).toBe(n);
    },
  },
  {
    name: 'only the last 5 windows are kept: the 6th step back asks again for the first',
    setup: () => { window.history.replaceState(null, '', `/${formatHash(w('2026-10-19T18:00:00-07:00', '2026-10-21T06:00:00-07:00'))}`); },
    run: async ({ root }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      for (let i = 0; i < 5; i += 1) {
        const n = asked().length;
        fireEvent.click(q(root, 'range-back'));
        await waitFor(() => expect(asked().length).toBe(n + 1));
      }
      const n = asked().length;
      for (let i = 0; i < 5; i += 1) fireEvent.click(q(root, 'range-forward'));
      await waitFor(() => expect(q(root, 'range-start').value).toBe('2026-10-19T18:00'));
      expect(asked().length).toBe(n + 1);
    },
  },
  {
    name: 'poll: a window holding now refetches on the 120 s tick',
    setup: ({ spies }) => { spies.date = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW)); spies.interval = vi.spyOn(globalThis, 'setInterval'); },
    run: async ({ root, spies }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      const tick = spies.interval.mock.calls.find((c) => c[1] === 120_000)?.[0];
      expect(tick).toBeTypeOf('function');
      const n = asked().length;
      await act(async () => { tick(); });
      expect(asked().length).toBe(n + 1);
    },
  },
  {
    name: 'poll: a past window never refetches on the tick',
    setup: ({ spies }) => {
      window.history.replaceState(null, '', `/${formatHash(w('2026-10-20T00:00:00-07:00', '2026-10-21T00:00:00-07:00'))}`);
      spies.date = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
      spies.interval = vi.spyOn(globalThis, 'setInterval');
    },
    run: async ({ root, spies }) => {
      await waitFor(() => expect(q(root, 'day-ribbon')).toBeTruthy());
      const tick = spies.interval.mock.calls.find((c) => c[1] === 120_000)?.[0];
      expect(tick).toBeTypeOf('function');
      const n = asked().length;
      await act(async () => { tick(); });
      expect(asked().length).toBe(n);
    },
  },
];

describe('ribbon range control', () => {
  beforeEach(() => {
    wsFetch.mockReset();
    wsFetch.mockImplementation(async () => ({ ok: true, json: async () => FIXTURE }));
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => { window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); });

  for (const row of ROWS) {
    it(row.name, async () => {
      const spies = {};
      row.setup?.({ spies });
      const { container } = render(<Harness {...(row.props || {})} />);
      await row.run({ root: container, spies });
    });
  }
});
