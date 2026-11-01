/**
 * ribbon-marks.test.jsx — COMP-COCKPIT-RIBBON-MARKS-1: a click on a tick, pin or band opens a small card.
 *
 * The harness wires DayRibbon's three open callbacks to the same cancelable window events DayView sends, with the marks
 * layer listening, so each row goes click -> event -> card the way the page does. One row table per behaviour.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayRibbon from '../../src/components/ribbon/DayRibbon.jsx';
import DayView, { EVT, dispatchRibbon } from '../../src/components/ribbon/DayView.jsx';
import RibbonMarksLayer from '../../src/components/ribbon/marks/RibbonMarksLayer.jsx';

const day = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const NOW = '2026-10-31T16:40:00-07:00';
const at = (h) => `2026-10-31T${h}:00-07:00`;
const SEATS = [{ label: 'seat2', pct: 96 }];
const BANDS = [
  { kind: 'hold', start: at('10:00'), end: at('12:00'), label: 'Batch hold', source: 'holds' },
  { kind: 'outage', start: at('15:00'), end: null, label: 'API outage', source: 'ledger' },
];

function Harness({ data = day, from = data.from, to = data.to, onNavigate = () => {} }) {
  return (
    <>
      <DayRibbon data={data} from={from} to={to} now={NOW} seats={SEATS}
        onMarkOpen={(mark, rect) => dispatchRibbon(EVT.openMark, { mark, rect })}
        onPinOpen={(pin, rect) => dispatchRibbon(EVT.openPin, { pin, rect })}
        onBandOpen={(band) => dispatchRibbon(EVT.openBand, { band })} />
      <RibbonMarksLayer lanes={data.lanes} seats={SEATS} now={NOW} onNavigate={onNavigate} />
    </>
  );
}
const withBands = () => ({ ...day, bands: BANDS });
const title = () => screen.getByTestId('mark-popover-title').textContent;
const lane = (c, id) => c.querySelector(`[data-testid="lane-${id}"]`);

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('marks open a card (COMP-COCKPIT-RIBBON-MARKS-1)', () => {
  it('one card per kind, opened by its own event (one row table)', () => {
    const rows = [
      { name: 'land tick', pick: (c) => lane(c, 'web').querySelector('[data-testid="mark-land"]'), want: '✓ Landed', has: 'unit page ▸' },
      { name: 'deploy tick', pick: (c) => lane(c, 'web').querySelector('[data-testid="mark-deploy"]'), want: '▲ Deployed', has: 'Pricing grid live on smartmemory.ai' },
      { name: 'failed deploy tick, in red', pick: (c) => c.querySelector('[data-testid="mark-deployFail"]'), want: '▲ Deploy failed', red: true },
      { name: 'decided-for-you tick', pick: (c) => lane(c, 'ops').querySelector('[data-testid="mark-decide"]'), want: '⚖︎ Decided for you', has: 'Reverse: Remove the bypass flag.' },
      { name: 'seat reset pin', pick: (c) => c.querySelector('[data-testid="pin-seatReset"]'), want: '↻ seat2 resets 18:10', has: 'It is at 96% now with ops work queued.' },
      { name: 'hold band', data: withBands(), pick: (c) => c.querySelector('[data-testid="band-hold"] [data-tip]'), want: 'Hold: Batch hold, 2h' },
      { name: 'outage band', data: withBands(), pick: (c) => c.querySelector('[data-testid="band-outage"] [data-tip]'), want: 'Outage since 15:00', red: true },
    ];
    for (const r of rows) {
      cleanup();
      const { container } = render(<Harness data={r.data} />);
      const el = r.pick(container);
      expect(el, r.name).toBeTruthy();
      fireEvent.click(el);
      expect(title(), r.name).toBe(r.want);
      if (r.has) expect(screen.getByTestId('mark-popover').textContent, r.name).toContain(r.has);
      if (r.red) expect(screen.getByTestId('mark-popover-title').className, r.name).toContain('text-destructive');
    }
  });

  it('a cluster badge at week width lists its items, and a row opens that item\'s own card', () => {
    const week = { from: '2026-10-25T00:00:00-07:00', to: '2026-11-01T00:00:00-07:00' };
    const { container } = render(<Harness {...week} />);
    const badge = lane(container, 'web').querySelector('[data-testid="mark-cluster"]');
    expect(badge).toBeTruthy();
    fireEvent.click(badge);
    const n = Number(title().split(' ')[0]);
    const items = screen.getByTestId('mark-popover-list').querySelectorAll('button');
    expect([title(), items.length]).toEqual([`${n} events`, n]);
    fireEvent.click(items[items.length - 1]);
    expect(['✓ Landed', '▲ Deployed', '▲ Deploy failed']).toContain(title());
  });

  it('close and focus return (one row table)', async () => {
    const closers = [
      { name: 'Esc', go: () => fireEvent.keyDown(window, { key: 'Escape' }) },
      { name: 'a press outside', go: () => fireEvent.pointerDown(document.body) },
      { name: 'a scroll elsewhere', go: () => fireEvent.scroll(document.body) },
      { name: 'a resize', go: () => fireEvent(window, new Event('resize')) },
    ];
    for (const c of closers) {
      cleanup();
      const { container } = render(<Harness />);
      const mark = lane(container, 'web').querySelector('[data-testid="mark-land"]');
      mark.focus();
      fireEvent.click(mark);
      expect(screen.getByTestId('mark-popover'), c.name).toBeTruthy();
      expect(screen.getByTestId('mark-popover').contains(document.activeElement), `${c.name}: focus moved in`).toBe(true);
      act(() => c.go());
      expect(screen.queryByTestId('mark-popover'), c.name).toBeNull();
      await waitFor(() => expect(document.activeElement, `${c.name}: focus back on the mark`).toBe(mark)); // an outside press settles on the next tick
    }
  });

  it('a press or scroll inside the card does not close it', () => {
    const { container } = render(<Harness />);
    fireEvent.click(lane(container, 'ops').querySelector('[data-testid="mark-decide"]'));
    const card = screen.getByTestId('mark-popover');
    fireEvent.pointerDown(card);
    fireEvent.scroll(card);
    expect(screen.queryByTestId('mark-popover')).toBeTruthy();
  });

  it('reverse opens the inbox (or Fleet when nobody takes it) and sends no request; unit page copies the path', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    wsFetch.mockReset();
    const onNavigate = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const openReverse = () => {
      const { container } = render(<Harness onNavigate={onNavigate} />);
      fireEvent.click(lane(container, 'ops').querySelector('[data-testid="mark-decide"]'));
      fireEvent.click(screen.getByText('reverse ▸'));
    };

    const seen = [];
    const take = (e) => { seen.push(e.detail); e.preventDefault(); };
    window.addEventListener('compose:open-inbox', take);
    openReverse();
    window.removeEventListener('compose:open-inbox', take);
    expect([seen, onNavigate.mock.calls, screen.queryByTestId('mark-popover')]).toEqual([[{ focus: 'O-2' }], [], null]);

    cleanup();
    openReverse();
    expect(onNavigate.mock.calls).toEqual([['fleet']]);

    cleanup();
    const { container } = render(<Harness />);
    fireEvent.click(lane(container, 'ops').querySelector('[data-testid="mark-decide"]'));
    await act(async () => { fireEvent.click(screen.getByText('unit page ▸')); });
    expect([writeText.mock.calls, screen.getByTestId('mark-popover-note').textContent]).toEqual([[['smart-memory-ops/units/O-2/']], 'Path copied: smart-memory-ops/units/O-2/']);
    expect([global.fetch.mock.calls.length, wsFetch.mock.calls.length]).toEqual([0, 0]);
  });

  it('an ETA item and the 2.0 lane offer the initiative link, which opens Ops', () => {
    const onNavigate = vi.fn();
    render(<RibbonMarksLayer lanes={day.lanes} seats={SEATS} now={NOW} onNavigate={onNavigate} />);
    act(() => { window.dispatchEvent(new CustomEvent(EVT.openMark, { detail: { mark: { kind: 'eta', lane: '2.0', p50: day.lanes[0].eta.p50, p80: day.lanes[0].eta.p80, asOf: NOW, prev: null }, rect: { left: 0, top: 0, bottom: 0, width: 0 } }, cancelable: true })); });
    fireEvent.click(screen.getByText('How far is 2.0 from flipping? ▸'));
    expect(onNavigate.mock.calls).toEqual([['ops']]);
  });

  it('DayView mounts the layer: a pin event reaches a card', async () => {
    // DayView reads its clock from Date.now; pin it to the fixture's now so the 18:10 reset pin is ahead ("resets"), not
    // past ("reset", the MARKS-1 wording for a reset already gone). Only Date is faked: findBy/waitFor keep real timers.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
    wsFetch.mockImplementation(async (url) => ({ ok: true, status: 200, json: async () => (String(url).startsWith('/api/ribbon') ? day : {}), text: async () => '' }));
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('day-ribbon');
    act(() => { dispatchRibbon(EVT.openPin, { pin: day.pins[0], rect: { left: 0, top: 0, bottom: 0, width: 0 } }); });
    expect(title()).toMatch(/^↻ seat2 resets \d\d:\d\d$/); // the clock reads in the browser's zone here
  }, 30000);
});
