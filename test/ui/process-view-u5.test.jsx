/**
 * COMP-COCKPIT-13-POLISH U5: the Flow of work DAG, the tile sparklines and deltas, and the share beside the CLEAN
 * and Std-process counts, on the recorded GET /api/process envelope (test/fixtures/process/api-process.json). Each
 * row edits a clone of the envelope; every expected figure is read from the envelope, never typed in. One row table.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ProcessView from '../../src/components/cockpit/ProcessView.jsx';
import { resetProcessPoller } from '../../src/lib/processPoller.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

const FIX = join(process.cwd(), 'test', 'fixtures', 'process');
const envelope = () => structuredClone(JSON.parse(readFileSync(join(FIX, 'api-process.json'), 'utf8')));
const FLEET = { generated: '2026-10-30T20:00:00Z', sources: { sm_status: { value: { queue: { value: [], error: null } }, error: null, ts: 1, stale: false } } };
const hub = (env) => env.sources.builder.value.pages.hub.value;
const withPace = (env, text) => { env.sources.builder.value.table.rows.push({ measure: 'Measured pace', cells: [text, null], basis: [] }); return env; };
const withHistory = (env, rows) => { env.sources.history = { value: { lanes: { hub: rows }, warnings: [] }, error: null, ts: 1, stale: false }; return env; };
const day = (date, v) => ({ date, waiting_share: v.w ?? null, first_pass_clean: v.c ?? null, review_rounds: v.r ?? null, gate_minutes: v.g ?? null, standard: v.s ?? null });
const q = (id) => screen.queryByTestId(id);
const t = (id) => screen.getByTestId(id).textContent;

async function mount(env) {
  resetProcessPoller();
  resetFleetPoller();
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, status: 200, json: async () => (String(url).startsWith('/api/process') ? env : FLEET) })));
  render(<ProcessView />);
  await screen.findByTestId('process-flow-hub');
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ROWS = [
  {
    name: 'DAG: every box is its summary.json field, landed/day is the pace cell number, needed fix is derived',
    env: () => withPace(envelope(), '12.5 landed/day, dispatch to landed median 3 h (n=40)'),
    check(env) {
      const v = hub(env);
      expect(t('flow-hub-val-stamped')).toBe(String(v.standard.stamps.with));
      expect(t('flow-hub-val-review')).toBe(String(v.first_pass_clean.total));
      expect(t('flow-hub-val-clean')).toBe(String(v.first_pass_clean.clean));
      expect(t('flow-hub-val-fix')).toBe(String(v.first_pass_clean.total - v.first_pass_clean.clean));
      expect(q('flow-hub-fix').getAttribute('data-derived')).toBe('true');
      expect(q('flow-hub-fix').querySelector('title').textContent).toContain('derived: reviewed minus clean');
      expect(t('flow-hub-val-gate')).toBe(String(v.standard.gate_runs));
      expect(t('flow-hub-val-passed')).toBe(String(v.standard.gate_passes));
      expect(t('flow-hub-val-landed')).toBe('12.5');
      expect(t('flow-hub-rounds')).toBe(`median ${v.review_rounds.median}, worst ${v.review_rounds.max}`);
    },
  },
  {
    name: 'DAG: recorded edges are solid with their count, unrecorded ones dashed with no number, the footnote is shown',
    env: () => envelope(),
    check(env) {
      const v = hub(env);
      const kinds = { 'stamped-review': 'recorded', 'review-clean': 'recorded', 'review-fix': 'derived', 'gate-passed': 'recorded',
        'fix-loop': 'not-in-data', 'clean-gate': 'not-in-data', 'fix-gate': 'not-in-data', 'passed-landed': 'not-in-data' };
      for (const [edge, kind] of Object.entries(kinds)) {
        const el = q(`flow-hub-edge-${edge}`);
        expect([edge, el.getAttribute('data-kind')]).toEqual([edge, kind]);
        expect([edge, el.hasAttribute('stroke-dasharray')]).toEqual([edge, kind === 'not-in-data']);
        expect([edge, q(`flow-hub-edge-val-${edge}`) !== null]).toEqual([edge, kind !== 'not-in-data']);
      }
      expect(t('flow-hub-edge-val-stamped-review')).toBe(String(v.first_pass_clean.total));
      expect(t('flow-hub-edge-val-gate-passed')).toBe(String(v.standard.gate_passes));
      expect(Number(q('flow-hub-edge-review-clean').getAttribute('stroke-width'))).toBeLessThan(Number(q('flow-hub-edge-stamped-review').getAttribute('stroke-width')));
      expect(t('flow-hub-note')).toContain('Not in the data: how clean vs fixed units split into gate runs');
      expect(t('flow-hub-val-landed')).toBe('not reported');
    },
  },
  {
    name: 'DAG: a lane with no first-round verdicts says not reported, and those edges turn dashed',
    env: () => { const e = envelope(); delete hub(e).first_pass_clean; return e; },
    check() {
      for (const n of ['review', 'clean', 'fix']) expect([n, t(`flow-hub-val-${n}`)]).toEqual([n, 'not reported']);
      for (const edge of ['stamped-review', 'review-clean', 'review-fix']) expect([edge, q(`flow-hub-edge-${edge}`).getAttribute('data-kind')]).toEqual([edge, 'not-in-data']);
    },
  },
  {
    name: 'percent: CLEAN and Std tiles show the share of their own two counts; a zero whole shows none',
    env: () => { const e = envelope(); hub(e).standard.stamps = { with: 0, of: 0 }; return e; },
    check(env) {
      const fp = hub(env).first_pass_clean;
      expect(t('pct-hub-first_pass_clean')).toBe(`= ${Math.round((100 * fp.clean) / fp.total)}%`);
      expect(q('pct-hub-standard')).toBeNull();
      expect(t('val-hub-standard-with')).toBe('0');
    },
  },
  {
    name: 'trend: no history (missing file) draws no sparkline and no delta',
    env: () => envelope(),
    check() {
      for (const k of ['waiting_share', 'first_pass_clean', 'review_rounds', 'gate_minutes', 'standard']) {
        expect([k, q(`spark-hub-${k}`), q(`delta-hub-${k}`)]).toEqual([k, null, null]);
      }
    },
  },
  {
    name: 'trend: one recorded day draws one point and no delta',
    env: () => withHistory(envelope(), [day('2026-10-31', { w: 17, c: 40, r: 1, s: 90 })]),
    check() {
      expect(q('spark-hub-waiting_share').getAttribute('data-points')).toBe('1');
      expect(q('delta-hub-waiting_share')).toBeNull();
      expect(q('spark-hub-gate_minutes')).toBeNull();
    },
  },
  {
    name: 'trend: the delta compares the newest day with the oldest within 7 days and says the real span',
    env: () => withHistory(envelope(), [
      day('2026-10-20', { w: 90 }), day('2026-10-25', { w: 20, r: 2 }), day('2026-10-28', { w: 18.5 }), day('2026-10-30', { r: null }), day('2026-11-01', { w: 17, r: 1 }),
    ]),
    check() {
      expect(q('spark-hub-waiting_share').getAttribute('data-points')).toBe('4');
      expect(t('delta-hub-waiting_share')).toBe('▼ 3 7d');
      expect(q('delta-hub-waiting_share').style.color).toBe('hsl(var(--success))');
      expect(t('delta-hub-review_rounds')).toBe('▼ 1 7d');
    },
  },
  {
    name: 'trend: two days a day apart show a 1d delta; a rise on a lower-is-better tile is red',
    env: () => withHistory(envelope(), [day('2026-10-30', { w: 15, s: 88.5 }), day('2026-10-31', { w: 17, s: 90 })]),
    check() {
      expect(t('delta-hub-waiting_share')).toBe('▲ 2 1d');
      expect(q('delta-hub-waiting_share').style.color).toBe('hsl(var(--destructive))');
      expect(t('delta-hub-standard')).toBe('▲ 1.5 1d');
      expect(q('delta-hub-standard').style.color).toBe('hsl(var(--success))');
    },
  },
];

describe('ProcessView U5: flow DAG, tile trends, tile percents', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const env = row.env();
      await mount(env);
      row.check(env);
    });
  }
});
