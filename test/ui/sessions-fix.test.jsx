/**
 * COMP-COCKPIT-SESSIONS-FIX-1: Fleet > Sessions stops looking wacky. jsdom has no layout, so these pin the
 * structure that produces the layout (measured live in the unit report): the cards flow in CSS columns, never
 * a row-aligned grid (1298 px of blank space at 1440); job and ready rows are fixed-track grids whose cells clip
 * to one line with the full text in `title` (310 of 337 ready rows wrapped, the lane column sat at 139 x
 * positions); the mobile variant is untouched; and every row set equals its source count.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';
import { resetUnitIndex } from '../../src/lib/useUnitIndex.js';

const { default: FleetView } = await import('../../src/components/cockpit/FleetView.jsx');
const { default: FleetPanels } = await import('../../src/components/cockpit/FleetPanels.jsx');

const LONG = 'parked-until 145, no-brief 130, held 49, claimed 19, '.repeat(3).trim();

const job = (i, o = {}) => ({ session: `s${i}`, id: `job-${i}`, kind: i % 2 ? 'bash' : 'detached', age: 60 * (i + 1), alive: i === 0, aliveFrom: 'sm_status', ...o });
const unit = (i, o = {}) => ({ id: `u-${i}`, lane: i % 2 ? 'ops' : 'cadence', priority: 'P1', decision: i === 0 ? 'launchable' : 'held', blocker: 'no brief', ...o });

function fleetData({ jobs = 3, ready = 4, sessions = 2, readyOver = {} } = {}) {
  return {
    generated: '2026-11-01T00:00:00.000Z',
    sources: {
      stratum: { value: { count: 1, max: 8, jobs: [{ session: 's2-coord', label: 'x' }] }, error: null, ts: Date.now(), stale: false },
      sm_status: {
        value: {
          sessions: { value: Array.from({ length: sessions }, (_, i) => ({ name: `tab-${i}`, ctx: 10_000 * (i + 1), busy: i === 0 })), error: null },
          jobs: { value: Array.from({ length: jobs }, (_, i) => job(i)), error: null },
          queue: { value: [], error: null },
          df: { value: { free_gb: 500, pct: '70%' }, error: null },
          spend: { value: { head: 'last 1h $1', rows: [] }, error: null },
          ceiling: { value: { line: 'spend today $1', warn: false }, error: null },
          ledger: { value: ['line one'], error: null },
        },
        error: null, ts: Date.now(), stale: false,
      },
      cadence: { value: { ready: Array.from({ length: ready }, (_, i) => unit(i, i === 1 ? readyOver : {})), errors: [], wouldLaunch: { value: { units: [] } }, readiness: { byRule: {} } }, error: null, ts: Date.now(), stale: false },
    },
  };
}

const view = (data) => render(<FleetView fleet={{ data, error: null, loading: false }} />);

beforeEach(() => {
  resetFleetPoller();
  resetUnitIndex();
  vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })); // no unit index: UnitName prints the code alone
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Fleet > Sessions layout contract', () => {
  it('cards flow in CSS columns (no row-aligned grid) and every card is a direct child, whole', () => {
    view(fleetData());
    const box = screen.getByTestId('fleet-cards');
    expect(box.style.columnWidth).toBe('320px');
    expect(box.style.gridTemplateColumns).toBe('');
    expect(box.className).toContain('break-inside-avoid');
    const ids = [...box.children].map((c) => c.getAttribute('data-testid'));
    expect(ids).toEqual(['fleet-owner', 'fleet-sessions', 'fleet-jobs', 'fleet-stratum', 'fleet-disk', 'fleet-spend', 'fleet-ceiling', 'fleet-cadence', 'fleet-ledger']);
  });

  it('job and ready rows are four-cell fixed-track grids, long text clips with the full text in title', () => {
    view(fleetData({ readyOver: { blocker: LONG } }));
    const jobRow = screen.getAllByTestId('fleet-job-row')[0];
    expect(jobRow.className).toContain('grid-cols-[1rem_3.25rem_minmax(0,1fr)_5rem]');
    expect(jobRow.className).toContain('[&>*]:truncate');
    expect(jobRow.children).toHaveLength(4);
    expect(jobRow.lastElementChild.getAttribute('title')).toBe(jobRow.lastElementChild.textContent);
    const rows = screen.getAllByTestId('fleet-ready-row');
    expect(rows.every((r) => r.className.includes('grid-cols-[1rem_minmax(0,3fr)_3.5rem_minmax(0,2fr)]') && r.children.length === 4)).toBe(true);
    const note = rows[1].lastElementChild;
    expect(note.textContent).toBe(LONG);
    expect(note.getAttribute('title')).toBe(LONG);
    expect(rows[0].lastElementChild.getAttribute('title')).toBe('no brief');
  });

  it('row sets equal their source counts, for empty, one and many', () => {
    const table = [
      { jobs: 0, ready: 0, sessions: 0 },
      { jobs: 1, ready: 1, sessions: 1 },
      { jobs: 29, ready: 37, sessions: 8 },
    ];
    for (const row of table) {
      view(fleetData(row));
      expect(screen.queryAllByTestId('fleet-job-row')).toHaveLength(row.jobs);
      expect(screen.queryAllByTestId('fleet-ready-row')).toHaveLength(row.ready);
      expect(screen.queryAllByTestId('fleet-session-row')).toHaveLength(row.sessions);
      expect(within(screen.getByTestId('fleet-jobs')).getByRole('heading').textContent).toContain(String(row.jobs));
      cleanup();
    }
  });

  it('a failing sessions source keeps its own card and the rest of the cards stay', () => {
    const data = fleetData();
    data.sources.sm_status.value.sessions = { value: null, error: 'RuntimeError: osascript timed out' };
    view(data);
    expect(screen.getByTestId('fleet-unavailable-sessions').textContent).toBe('unavailable: RuntimeError: osascript timed out');
    expect(screen.getByTestId('fleet-cards').children).toHaveLength(9);
  });

  it('the mobile variant keeps its own row class (not the desktop grid)', () => {
    render(<FleetPanels data={fleetData()} variant="mobile" />);
    expect(screen.getAllByTestId('fleet-job-row')[0].className).toBe('m-fleet-row');
    expect(screen.getAllByTestId('fleet-ready-row')[0].className).toBe('m-fleet-row');
  });
});
