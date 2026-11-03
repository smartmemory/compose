/**
 * ribbon-lane.test.jsx — COMP-COCKPIT-RIBBON-LANE-1: the lane drawer and lane page on the Day front page.
 * One row table of steps over one rendered DayView (`/api/ribbon` answered from `test/fixtures/ribbon/day.json`); each step
 * names what it does and the value it must produce. Cadence is not reachable here, so the chain block must say so.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView from '../../src/components/ribbon/DayView.jsx';
import LanePage from '../../src/components/ribbon/lane/LanePage.jsx';
import LaneDrawer from '../../src/components/ribbon/lane/LaneDrawer.jsx';
import { sessionsSource } from '../../src/components/ribbon/lane/laneLogic.js';
import { NavigationContext } from '../../src/lib/navigation.jsx';

// Cadence availability is the one thing faked: the real `@cadence/ui` (ChainGraph, providers) renders in the FU-1 rows.
const cadence = vi.hoisted(() => ({ up: false }));
vi.mock('../../src/components/cockpit/useCadenceUiAvailable.js', () => ({
  default: () => cadence.up,
  useCadenceUiAvailability: () => (cadence.up ? 'yes' : 'no'),
}));

const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const PAST = '#ribbon.from=2026-10-30T18:00-07:00&to=2026-11-01T06:00-07:00';

function stubFetch(ribbon) {
  wsFetch.mockImplementation(async (url) => (String(url).startsWith('/api/ribbon') ? ok(ribbon) : ok({})));
  global.fetch = vi.fn(async () => ok({}));
}
const texts = (ids) => ids.map((id) => screen.getByTestId(id).querySelector('h3').textContent);
const key = (k) => act(async () => { fireEvent.keyDown(document.body, { key: k }); });

describe('lane drawer and lane page (COMP-COCKPIT-RIBBON-LANE-1)', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
    wsFetch.mockReset();
    cadence.up = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

  it('one row table: open, close three ways with focus return, page and back, Cadence unavailable', async () => {
    stubFetch(FIXTURE);
    const onNavigate = vi.fn();
    render(<DayView onNavigate={onNavigate} />);
    const row = await screen.findByTestId('lane-2.0');
    const steps = [
      { name: 'a lane click opens the drawer and the fallback does not run', run: () => fireEvent.click(row), got: () => [!!screen.queryByTestId('lane-drawer'), onNavigate.mock.calls.length], want: [true, 0] },
      { name: 'six sections in the mock order', got: () => texts(['drawer-now', 'drawer-next', 'drawer-landing', 'drawer-landed', 'drawer-lost', 'drawer-who']), want: ['NOW', 'NEXT', 'EXPECTED LANDING', 'LAST LANDED', 'TIME LOST', 'WHO AND WHERE'] },
      { name: 'NOW names the current unit', got: () => screen.getByTestId('drawer-now').textContent.includes('Search filters by workspace'), want: true },
      { name: 'EXPECTED LANDING shows the estimate with its as-of', got: () => screen.getByTestId('drawer-landing').textContent, want: 'EXPECTED LANDINGp50 Mon · p80 Monas of today 16:40' },
      { name: 'LAST LANDED lists newest first with live words', got: () => [...screen.getAllByTestId('drawer-landed-row')].map((r) => r.textContent.includes('deployed') && !r.textContent.includes('not deployed')), want: [true, false] },
      { name: 'TIME LOST adds up the review wait', got: () => screen.getAllByTestId('drawer-lost-row').map((r) => r.textContent), want: ['waiting on review: 3h 30m'] },
      { name: 'the X closes it and focus returns to the row', run: () => fireEvent.click(screen.getByTestId('lane-drawer-close')), got: () => [!!screen.queryByTestId('lane-drawer'), document.activeElement === row], want: [false, true] },
      { name: 'Esc closes it and focus returns to the row', run: async () => { fireEvent.click(row); await screen.findByTestId('lane-drawer'); await key('Escape'); }, got: () => [!!screen.queryByTestId('lane-drawer'), document.activeElement === row], want: [false, true] },
      { name: 'the scrim closes it and focus returns to the row', run: async () => { fireEvent.click(row); await screen.findByTestId('lane-drawer'); fireEvent.click(screen.getByTestId('lane-drawer-scrim')); }, got: () => [!!screen.queryByTestId('lane-drawer'), document.activeElement === row], want: [false, true] },
      { name: 'Open lane page shows the page with the title in question form', run: async () => { fireEvent.click(row); fireEvent.click(await screen.findByTestId('lane-open-page')); }, got: () => [!!screen.queryByTestId('lane-drawer'), screen.getByTestId('lane-page').querySelector('h2').textContent], want: [false, 'Who is on what in 2.0?'] },
      { name: 'the page has one row per unit, newest first', got: () => screen.getAllByTestId('lane-unit-row').map((r) => r.dataset.unit), want: ['COMP-SEARCH-1', 'S-3', 'S-2', 'S-1'] },
      { name: 'the page carries a legend for the segment colours', got: () => screen.getByTestId('lane-legend').textContent, want: 'authorreviewfixgatewaiting on reviewwaiting on younot recordedlanded' },
      { name: 'the landed vs live strip has words for every landed unit', got: () => screen.getAllByTestId('lane-live-row').map((r) => r.textContent.replace(/^.*· /, '')), want: ['deployed', 'landed, not deployed yet'] },
      { name: 'with Cadence unreachable the chain block says so and the rest rendered', got: async () => { await waitFor(() => screen.getByTestId('lane-chain-unavailable')); return [screen.getByTestId('lane-chain-unavailable').textContent, !!screen.queryByTestId('lane-units')]; }, want: ['Cadence not available', true] },
      { name: 'Esc on the page returns to the ribbon, same window', run: () => key('Escape'), got: () => [!!screen.queryByTestId('lane-page'), !!screen.queryByTestId('day-ribbon'), document.activeElement === row, screen.getByTestId('range-bar') != null], want: [false, true, true, true] },
      { name: 'the Day breadcrumb on the page returns too', run: async () => { fireEvent.click(row); fireEvent.click(await screen.findByTestId('lane-open-page')); fireEvent.click(await screen.findByTestId('lane-page-back')); }, got: () => !!screen.queryByTestId('lane-page'), want: false },
    ];
    for (const s of steps) {
      if (s.run) await act(async () => { await s.run(); });
      expect(await s.got(), s.name).toEqual(s.want);
    }
  }, 60000);

  it('in a past window NOW and NEXT read "past window" and the rest still shows', async () => {
    stubFetch({ ...FIXTURE, live: false });
    window.history.pushState({}, '', `/${PAST}`);
    render(<DayView onNavigate={() => {}} />);
    fireEvent.click(await screen.findByTestId('lane-2.0'));
    const rows = [
      { name: 'NOW', got: screen.getByTestId('drawer-now').textContent, want: 'NOWpast window' },
      { name: 'NEXT', got: screen.getByTestId('drawer-next').textContent, want: 'NEXTpast window' },
      { name: 'LAST LANDED still lists landings', got: screen.getAllByTestId('drawer-landed-row').length, want: 2 },
      { name: 'TIME LOST still adds up', got: screen.getAllByTestId('drawer-lost-row').length, want: 1 },
    ];
    for (const r of rows) expect(r.got, r.name).toEqual(r.want);
  }, 30000);

  describe('FU-1: chain graph provider, sessions source state, Fleet link', () => {
    const lane = FIXTURE.lanes.find((l) => l.lane === '2.0');
    const WIN = { from: FIXTURE.window?.from ?? '2026-11-01T00:00:00-07:00', to: FIXTURE.window?.to ?? '2026-11-02T00:00:00-07:00', now: FIXTURE.now };
    const chainFor = (names) => ({ id: 'units/X/wave-plan.md', unit: 'X', title: 'X plan', problems: [], updatedAt: '2026-11-03T00:00:00Z',
      steps: names.map((n, i) => ({ name: n, dependsOn: i ? [names[i - 1]] : [], state: i ? 'READY' : 'DONE', stateKind: i ? 'ready' : 'done', artifact: null, repo: null, level: i })) });

    it('H1: the real ChainGraph renders through LanePage with the injected client, and its belt read goes to that client', async () => {
      cadence.up = true;
      const client = {
        getChains: vi.fn(async () => ({ chains: [chainFor([lane.current.id, 'AFTER-IT'])] })),
        getBelt: vi.fn(async () => ({ units: [{ id: lane.current.id, lane: lane.lane }] })),
      };
      render(<LanePage lane={lane} {...WIN} onBack={() => {}} client={client} />);
      const graph = await screen.findByTestId('lane-chain-graph');
      expect([!!graph.querySelector('.cb-graph'), screen.queryByTestId('lane-chain-error') == null], 'graph drawn, no error').toEqual([true, true]);
      await waitFor(() => expect(client.getBelt).toHaveBeenCalled());
    });

    it('M1: a failed or loading sessions source says so, never "no session found"', () => {
      const text = (sessions) => { cleanup(); render(<LaneDrawer lane={lane} live now={WIN.now} sessions={sessions} onClose={() => {}} onOpenPage={() => {}} />); return screen.getByTestId('drawer-who').textContent; };
      const failed = sessionsSource({ data: { sources: { sm_status: { value: null, error: 'reader failed' } } }, error: null, loading: false }, '2.0');
      const loading = sessionsSource({ data: null, error: null, loading: true }, '2.0');
      const empty = sessionsSource({ data: { sources: { sm_status: { value: { sessions: { value: [], error: null } } } } }, error: null, loading: false }, '2.0');
      expect([failed.status, loading.status, empty.status]).toEqual(['unavailable', 'loading', 'ok']);
      expect(text(failed)).toContain('sessions unavailable: reader failed');
      expect(text(failed)).not.toContain('no session found');
      expect(text(loading)).toContain('reading…');
      expect(text(empty)).toContain('no session found for this lane');
    });

    it('M2: "See Fleet › Cadence" is a control that opens the Fleet pane through the host navigation', async () => {
      cadence.up = true;
      const openRoom = vi.fn();
      const client = { getChains: vi.fn(async () => ({ chains: [] })), getBelt: vi.fn(async () => ({ units: [] })) };
      render(<NavigationContext.Provider value={{ openRoom }}><LanePage lane={lane} {...WIN} onBack={() => {}} client={client} onOpenFleet={() => openRoom('fleet')} /></NavigationContext.Provider>);
      fireEvent.click(await screen.findByTestId('lane-chain-open-fleet'));
      expect(openRoom).toHaveBeenCalledWith('fleet');
    });
  });
});
