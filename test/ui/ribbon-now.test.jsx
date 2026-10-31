/**
 * ribbon-now.test.jsx — COMP-COCKPIT-RIBBON-NOW-1: the WHAT counts open "now" lists on Day, navigate everywhere else, and
 * the Day page collapses to the phone layout below 768 px. One row table per behaviour; DayView rows answer /api/ribbon,
 * /api/fleet and /api/units/index through the mocked `wsFetch`.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView from '../../src/components/ribbon/DayView.jsx';
import WhatLine from '../../src/components/cockpit/what/WhatLine.jsx';
import { LAST_VISIT_KEY } from '../../src/components/cockpit/what/whatRules.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';
import { resetUnitIndex } from '../../src/lib/useUnitIndex.js';

const RIBBON = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const down = { ok: false, status: 500, json: async () => ({}), text: async () => 'down' };
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const FLEET = {
  generated: new Date().toISOString(),
  sources: { sm_status: { value: {
    sessions: { value: [{ name: 'main-main', busy: true }, { name: 'web-main', busy: false }], error: null },
    jobs: { value: [{ session: 'web-main', id: 'job-1', kind: 'review', age: 600, alive: true }], error: null },
    queue: { value: [], error: null },
  }, error: null, ts: 1, stale: false } },
};
const INDEX = {
  asOf: new Date().toISOString(),
  units: [
    { id: 'W-1', lane: 'web', title: 'Waiting review', waiting: 'review', authorDoneAt: hoursAgo(3), landedAt: null, deployedAt: null },
    { id: 'L-1', lane: 'main', title: 'Landed just now', waiting: null, authorDoneAt: null, landedAt: hoursAgo(1), deployedAt: hoursAgo(0.5) },
    { id: 'L-0', lane: 'ops', title: 'Landed long ago', waiting: null, authorDoneAt: null, landedAt: hoursAgo(40), deployedAt: null },
  ],
};

function stub({ index = ok(INDEX), fleet = ok(FLEET), ribbon = null } = {}) {
  wsFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/ribbon')) return ribbon ? ribbon() : ok(RIBBON);
    if (u.startsWith('/api/fleet')) return fleet;
    if (u.startsWith('/api/units/index')) return index;
    return ok({});
  });
  global.fetch = vi.fn(async () => ok({}));
}
const setWidth = (w) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });

describe('now lists (COMP-COCKPIT-RIBBON-NOW-1)', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now() - 5 * 3_600_000));
    wsFetch.mockReset(); resetFleetPoller(); resetUnitIndex(); setWidth(1440);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); setWidth(1024); });

  it('each count opens its list on Day, with the mock headings (one row table)', async () => {
    stub();
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('what-line');
    await waitFor(() => expect(screen.getByTestId('what-count-landed').textContent).toBe('1 landed since your last visit'));
    const ROWS = [
      { name: 'working', count: 'what-count-working', kind: 'working', title: '2 working', line: 'Agents running a unit right now', section: 'Working now', rows: 2 },
      { name: 'waiting', count: 'what-count-review', kind: 'waiting', title: '1 waiting', line: 'review 1, you 0', section: 'Waiting now', rows: 1 },
      { name: 'landed', count: 'what-count-landed', kind: 'landed', title: '1 landed since you left', line: /^Since .+, newest first$/, section: '', rows: 1 },
    ];
    for (const r of ROWS) {
      fireEvent.click(screen.getByTestId(r.count));
      const drawer = await screen.findByTestId('now-drawer');
      expect([drawer.dataset.kind, screen.getByTestId('now-title').textContent, screen.getByTestId('now-section').textContent], r.name).toEqual([r.kind, r.title, r.section]);
      const line = screen.getByTestId('now-subline').textContent;
      if (r.line instanceof RegExp) expect(line, r.name).toMatch(r.line); else expect(line, r.name).toBe(r.line);
      expect(screen.getAllByTestId('now-row').length, r.name).toBe(r.rows);
      // Esc closes, and focus goes back to the count that opened it.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('now-drawer'), r.name).toBeNull());
      await waitFor(() => expect(document.activeElement, r.name).toBe(screen.getByTestId(r.count)));
    }
    // The landed list also has its "Also" part (deploys and decisions from the ribbon feed).
    fireEvent.click(screen.getByTestId('what-count-landed'));
    await screen.findByTestId('now-group-also');
    // The ✕ and the scrim close it too.
    fireEvent.click(screen.getByTestId('now-close'));
    await waitFor(() => expect(screen.queryByTestId('now-drawer')).toBeNull());
    fireEvent.click(screen.getByTestId('what-count-working'));
    await screen.findByTestId('now-drawer');
    fireEvent.click(screen.getByTestId('now-scrim'));
    await waitFor(() => expect(screen.queryByTestId('now-drawer')).toBeNull());
  }, 30000);

  it('waiting on review lists the unit and its wait; waiting on you still opens the inbox', async () => {
    stub();
    const seen = [];
    const take = (e) => { seen.push('inbox'); e.preventDefault(); };
    window.addEventListener('compose:open-inbox', take);
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('what-line');
    fireEvent.click(screen.getByTestId('what-count-review'));
    const group = await screen.findByTestId('now-group-review');
    expect(group.textContent).toMatch(/Waiting review/);
    expect(group.textContent).toMatch(/waiting 3 h/);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('what-count-you'));
    window.removeEventListener('compose:open-inbox', take);
    expect(seen).toEqual(['inbox']);
    expect(screen.queryByTestId('now-drawer')).toBeNull();
  }, 30000);

  it('the waiting drawer\'s "Waiting on you" is the shared count, with a wait word; a down queue says so (one row table)', async () => {
    const withQueue = (queue) => ({ ...FLEET, sources: { sm_status: { ...FLEET.sources.sm_status, value: { ...FLEET.sources.sm_status.value, queue } } } });
    const ROWS = [
      { name: '1 security, 1 overdue, 1 not overdue, 1 decided, 1 fyi reads 3', fleet: withQueue({ value: [
        { id: 'q1', by: 'a', text: 'SECURITY: x', age: 3600, red: false }, { id: 'q2', by: 'a', text: 'QUESTION: y', age: 7200, red: true }, { id: 'q3', by: 'a', text: 'QUESTION: z', age: 600, red: false },
        { id: 'q4', by: 'a', text: 'APPLIED: d', age: 5, red: true }, { id: 'q5', by: 'a', text: 'FYI: f', age: 5, red: true }], error: null }), heading: /Waiting on you \(3\)/, rows: 3 },
      { name: 'queue source down: ? and source unavailable, never 0', fleet: withQueue({ value: null, error: 'down' }), heading: /Waiting on you \(\?\)/, rows: 0 },
    ];
    for (const r of ROWS) {
      cleanup(); resetFleetPoller(); resetUnitIndex(); wsFetch.mockReset(); stub({ fleet: ok(r.fleet) });
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('what-line');
      fireEvent.click(screen.getByTestId('what-count-review'));
      const group = await screen.findByTestId('now-group-you');
      expect(group.textContent, r.name).toMatch(r.heading);
      expect(group.querySelectorAll('[data-testid="now-row"]').length, r.name).toBe(r.rows);
      if (r.rows) { expect(group.textContent, r.name).toMatch(/waiting \d+ (min|h)/); expect(group.textContent, r.name).not.toMatch(/time not recorded/); }
      else expect(group.textContent, r.name).toMatch(/source unavailable/);
    }
  }, 30000);

  it('a source that is down says "source unavailable", never an empty list (one row table)', async () => {
    const ROWS = [
      { name: 'unit index down: waiting', stubs: { index: down }, count: 'what-count-review', want: 'now-unavailable' },
      { name: 'unit index down: landed', stubs: { index: down }, count: 'what-count-landed', want: 'now-unavailable' },
      { name: 'fleet down but the ribbon feed is up: working falls back to the lanes', stubs: { fleet: down }, count: 'what-count-working', want: 'now-rows' },
      { name: 'fleet down and the ribbon feed still loading: Loading, not "source unavailable"', stubs: { fleet: down, ribbon: () => new Promise(() => {}) }, count: 'what-count-working', want: 'now-loading' },
    ];
    for (const r of ROWS) {
      cleanup(); resetFleetPoller(); resetUnitIndex(); wsFetch.mockReset(); stub(r.stubs);
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('what-line');
      fireEvent.click(screen.getByTestId(r.count));
      const el = await screen.findByTestId(r.want);
      if (r.want === 'now-unavailable') expect(el.textContent, r.name).toMatch(/source unavailable/);
      else if (r.want === 'now-loading') expect(el.textContent, r.name).toMatch(/Loading/);
      else expect(screen.getAllByTestId('now-row').length, r.name).toBeGreaterThan(0);
    }
  }, 60000);

  it('off Day the counts navigate as before (WhatLine without onCountOpen)', async () => {
    stub();
    const onOpenFleet = vi.fn(); const onNavigate = vi.fn();
    render(<WhatLine onOpenFleet={onOpenFleet} onNavigate={onNavigate} />);
    await screen.findByTestId('what-line');
    await waitFor(() => expect(screen.getByTestId('what-count-landed').textContent).toMatch(/^1 /));
    fireEvent.click(screen.getByTestId('what-count-working'));
    fireEvent.click(screen.getByTestId('what-count-review'));
    fireEvent.click(screen.getByTestId('what-count-landed'));
    expect([onOpenFleet.mock.calls.length, onNavigate.mock.calls.map((c) => c[0])]).toEqual([1, ['process', 'process']]);
    expect(screen.queryByTestId('now-drawer')).toBeNull();
  }, 30000);

  it('below 768 px the Day page is the WHAT line, the meter and the now list (no ribbon)', async () => {
    setWidth(390);
    stub();
    render(<DayView onNavigate={() => {}} />);
    await screen.findByTestId('day-phone');
    await screen.findByTestId('what-line');
    await screen.findAllByTestId('day-phone-lane');
    const parts = [
      ['what line', !!screen.queryByTestId('what-line')],
      ['meter', !!screen.queryByTestId('cost-meter')],
      ['meter box is capped, not collapsed', screen.getByTestId('day-phone-meter-box').className.includes('max-h-[120px]') && screen.getByTestId('day-phone-meter').className.includes('shrink-0')],
      ['now list', screen.getAllByTestId('day-phone-lane').length > 0],
      ['landed list', !!screen.queryByTestId('day-phone-landed')],
      ['no ribbon', !screen.queryByTestId('day-ribbon')],
      ['no range bar', !screen.queryByTestId('range-bar')],
      ['no sideways scroll class', screen.getByTestId('day-phone').className.includes('overflow-x-hidden')],
    ];
    for (const [name, has] of parts) expect(has, name).toBe(true);
    expect(screen.getAllByTestId('day-phone-lane')[0].textContent).toMatch(/ETA/);
    await waitFor(() => expect(screen.getAllByTestId('day-phone-landed-row').length).toBe(1));
    // The counts open the same drawer on a phone.
    fireEvent.click(screen.getByTestId('what-count-working'));
    expect((await screen.findByTestId('now-drawer')).dataset.kind).toBe('working');
  }, 30000);
});
