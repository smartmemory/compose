/**
 * COMP-COCKPIT-13 U2: the Process view renders the recorded GET /api/process envelope
 * (test/fixtures/process/api-process.json) and a fake GET /api/fleet body. Row 1 is the agreement test:
 * every rendered P1-P5 figure equals the matching field of the fixture summary.json, and every P8 cell
 * equals the fixture process.json cell, both read from disk here (no value is copied into this file).
 * The other rows edit a deep copy of the envelope.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ProcessView from '../../src/components/cockpit/ProcessView.jsx';
import { resetProcessPoller } from '../../src/lib/processPoller.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

const FIX = join(process.cwd(), 'test', 'fixtures', 'process');
const readJson = (...p) => JSON.parse(readFileSync(join(FIX, ...p), 'utf8'));
const envelope = () => structuredClone(readJson('api-process.json'));
const fleetBody = (queue) => ({
  generated: '2026-10-30T20:00:00Z',
  sources: { sm_status: queue === null
    ? { value: null, error: 'sm_status down', ts: 1, stale: false }
    : { value: { queue }, error: null, ts: 1, stale: false } },
});
const QUEUE = { value: [{ id: 'Q-1', by: 'someone', text: 'a fake question', age: 125 }], error: null };

const PUBLISH = { url: 'http://127.0.0.1:5195/?view=process', generatedAt: '2026-10-30T21:00:00.000Z' };

function mount(env, fleet = fleetBody(QUEUE), publish = { status: 200, body: PUBLISH }) {
  resetProcessPoller();
  resetFleetPoller();
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    calls.push([String(url), opts.method || 'GET']);
    if (String(url) === '/api/process/publish') return { ok: publish.status === 200, status: publish.status, json: async () => publish.body };
    const body = String(url).startsWith('/api/process') ? env : fleet;
    return { ok: true, status: 200, json: async () => body };
  }));
  render(<ProcessView />);
  return calls;
}
const text = (id) => screen.getByTestId(id).textContent;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const FIGURES = (name, s) => [
  [`${name}-waiting_share-pct`, s.waiting_share?.pct],
  [`${name}-waiting_units_stamped`, s.waiting_units_stamped],
  [`${name}-first_pass_clean-clean`, s.first_pass_clean?.clean],
  [`${name}-first_pass_clean-total`, s.first_pass_clean?.total],
  [`${name}-review_rounds-median`, s.review_rounds?.median],
  [`${name}-review_rounds-max`, s.review_rounds?.max],
  [`${name}-review_rounds-n`, s.review_rounds?.n],
  [`${name}-gate_minutes-day`, s.gate_minutes?.day],
  [`${name}-gate_minutes-lands`, s.gate_minutes?.lands],
  [`${name}-gate_minutes-median`, s.gate_minutes?.median],
  [`${name}-gate_minutes-max`, s.gate_minutes?.max],
  [`${name}-standard-with`, s.standard?.stamps?.with],
  [`${name}-standard-of`, s.standard?.stamps?.of],
  [`${name}-standard-review_files`, s.standard?.review_files],
  [`${name}-standard-gate_runs`, s.standard?.gate_runs],
  [`${name}-standard-gate_passes`, s.standard?.gate_passes],
];

const ROWS = [
  {
    name: 'agreement: every P1-P5 figure and P8 cell equals the builder file',
    async run() {
      mount(envelope());
      const table = readJson('out', 'master', 'process.json');
      await screen.findByTestId('process-rollup-table');
      table.rows.forEach((r, ri) => {
        expect(text(`rollup-measure-${ri}`).startsWith(r.measure)).toBe(true);
        r.cells.forEach((c, ci) => expect(text(`rollup-cell-${ri}-${ci}`)).toBe(c));
      });
      for (const p of table.projects) {
        const summary = readJson('out', p.name, 'summary.json');
        fireEvent.click(screen.getByRole('button', { name: p.label }));
        for (const [id, want] of FIGURES(p.name, summary)) {
          if (want === undefined) continue;
          expect(text(`val-${id}`), id).toBe(String(want));
        }
        (summary.gate_minutes?.last5 ?? []).forEach(([u, m], i) => {
          expect(text(`val-${p.name}-gate_minutes-last5-${i}-unit`)).toBe(String(u));
          expect(text(`val-${p.name}-gate_minutes-last5-${i}-min`)).toBe(String(m));
        });
        expect(text(`fig-${p.name}-standard-review_files`)).toContain('units with a first-round verdict');
      }
    },
  },
  {
    name: 'a key the summary lacks says its no_data text verbatim, else "not reported"',
    async run() {
      const env = envelope();
      delete env.sources.builder.value.pages.hub.value.review_rounds;
      mount(env);
      await screen.findByTestId('process-rollup-table');
      expect(text('empty-hub-review_rounds')).toBe('not reported');
      fireEvent.click(screen.getByRole('button', { name: 'Fixture main' }));
      expect(text('empty-main-gate_minutes')).toBe(readJson('out', 'main', 'summary.json').no_data.gate_minutes);
    },
  },
  {
    name: 'a failed page and a stale page carry their markers; a stale figure reads "stale: <text>"',
    async run() {
      const env = envelope();
      env.sources.builder.value.pages.hub.stale = true;
      env.sources.builder.value.pages.main.value.waiting_share.stale = true;
      mount(env);
      await screen.findByTestId('process-rollup-table');
      const markers = screen.getAllByTestId('process-col-marker').map((e) => e.textContent);
      expect(markers).toEqual(['stale', 'build failed']);
      expect(text('process-col-main')).toContain('fixture reason');
      fireEvent.click(screen.getByRole('button', { name: 'Fixture hub' }));
      expect(text('stale-hub-gate_minutes')).toBe(`stale: ${readJson('out', 'hub', 'summary.json').gate_minutes.stale}`);
      fireEvent.click(screen.getByRole('button', { name: 'Fixture main' }));
      expect(text('stale-main-waiting_share')).toBe('stale: the builder marks this figure stale');
    },
  },
  {
    name: 'status dir missing: one unavailable card, P6 and the owner card still render',
    async run() {
      const env = envelope();
      env.sources.builder = { value: null, error: 'status dir not found', ts: 1, stale: false };
      mount(env);
      expect(await screen.findByTestId('process-unavailable-builder')).toBeTruthy();
      expect(text('process-unavailable-builder')).toBe('unavailable: status dir not found');
      expect(screen.queryByTestId('process-rollup-table')).toBeNull();
      expect(screen.getByTestId('process-p6-table')).toBeTruthy();
      await screen.findByTestId('fleet-owner');
    },
  },
  {
    name: 'process.json missing: rollup card names it, per-page detail still renders from summary.json',
    async run() {
      const env = envelope();
      env.sources.builder.value.table = null;
      env.sources.builder.value.tableError = 'process.json not found';
      mount(env);
      expect((await screen.findByTestId('process-rollup-missing-text')).textContent).toContain('OPS-STATUS-PROCESS-JSON-1');
      expect(screen.queryByTestId('process-rollup-table')).toBeNull();
      expect(screen.getByTestId('process-page-hub')).toBeTruthy();
      expect(text('val-hub-waiting_share-pct')).toBe(String(readJson('out', 'hub', 'summary.json').waiting_share.pct));
    },
  },
  {
    name: 'stamps outage: P6 is an unavailable card, P1-P5 and P8 still render',
    async run() {
      const env = envelope();
      env.sources.stamps = { value: null, error: 'queues dir not found', ts: 1, stale: false };
      mount(env);
      expect((await screen.findByTestId('process-unavailable-p6')).textContent).toBe('unavailable: queues dir not found');
      expect(screen.getByTestId('process-rollup-table')).toBeTruthy();
    },
  },
  {
    name: 'P6: each unknown rule is named, unknown is never 0, minutes round at display, escalation is not recorded',
    async run() {
      const env = envelope();
      const lanes = env.sources.stamps.value.lanes;
      lanes.hub.timeSplit = { known: 0, unknown: 2, outside: 1, byRule: { 'U-a': 1, 'U-e': 1 }, minutes: { authoring: 0, review: 0, fix_rounds: 0, gate: 0, waiting_owner: 0, waiting: 0 } };
      lanes.main.timeSplit.minutes.review = 29.6;
      lanes.main.timeSplit.known = 3;
      mount(env);
      await screen.findByTestId('process-p6-table');
      expect(text('p6-hub-authoring')).toBe('no known units');
      expect(text('p6-units-hub')).toBe('0 known, 2 unknown (U-a: end without start x1, U-e: unreadable or reversed stamp x1), 1 not in split (1 warning)');
      expect(text('p6-main-review')).toBe('30 min');
      expect(screen.getByTestId('p6-lane-main').textContent).toContain('not recorded (stamps carry no such interval)');
      expect(screen.getByTestId('process-p6').textContent).toContain('Job buckets can overlap; waiting cannot');
    },
  },
  {
    name: 'owner card: rows under the Fleet card, a partial read keeps its lower-bound note, a down reader hides it',
    async run() {
      mount(envelope());
      expect((await screen.findByTestId('fleet-owner')).textContent).toContain('a fake question');
      cleanup();
      mount(envelope(), fleetBody({ value: QUEUE.value, error: 'ledger unreadable' }));
      expect((await screen.findByTestId('fleet-partial-owner')).textContent).toContain('lower bound');
      cleanup();
      mount(envelope(), fleetBody(null));
      await screen.findByTestId('process-rollup-table');
      await waitFor(() => expect(screen.queryByTestId('fleet-owner')).toBeNull());
    },
  },
  {
    name: 'the view only GETs /api/process and /api/fleet',
    async run() {
      const calls = mount(envelope());
      await screen.findByTestId('process-rollup-table');
      await screen.findByTestId('fleet-owner');
      expect(calls.every(([u, m]) => m === 'GET' && (u === '/api/process' || u === '/api/fleet'))).toBe(true);
    },
  },
  {
    name: 'U3: no publish call until the button is clicked, then one GET /api/process/publish shows the URL, copy and the CLI line',
    async run() {
      const calls = mount(envelope());
      await screen.findByTestId('process-rollup-table');
      expect(calls.some(([u]) => u === '/api/process/publish')).toBe(false);
      expect(screen.queryByTestId('process-publish-url')).toBeNull();
      const writeText = vi.fn(async () => {});
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      fireEvent.click(screen.getByTestId('process-publish-button'));
      await screen.findByTestId('process-publish-url');
      expect(text('process-publish-url')).toBe(PUBLISH.url);
      expect(text('process-publish-cli')).toContain('compose process publish');
      fireEvent.click(screen.getByTestId('process-publish-copy'));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(PUBLISH.url));
      expect(calls.filter(([u]) => u === '/api/process/publish')).toEqual([['/api/process/publish', 'GET']]);
      expect(calls.every(([u, m]) => m === 'GET' && ['/api/process', '/api/fleet', '/api/process/publish'].includes(u))).toBe(true);
    },
  },
  {
    name: 'U3: a refused host (409) shows the reason and no URL',
    async run() {
      mount(envelope(), fleetBody(QUEUE), { status: 409, body: { error: 'cockpit host 192.168.1.5 is not 127.0.0.1, localhost or [::1]' } });
      await screen.findByTestId('process-rollup-table');
      fireEvent.click(screen.getByTestId('process-publish-button'));
      await screen.findByTestId('process-publish-error');
      expect(text('process-publish-error')).toContain('192.168.1.5');
      expect(screen.queryByTestId('process-publish-url')).toBeNull();
    },
  },
];

describe('Process view', () => {
  it('row table', async () => {
    for (const row of ROWS) {
      try { await row.run(); } catch (e) { e.message = `${row.name}: ${e.message}`; throw e; }
      cleanup();
    }
  });
});
