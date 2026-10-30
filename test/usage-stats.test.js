/**
 * COMP-OBS-STATS-1: GET /api/usage/stats over a seeded dispatch ledger and
 * build history. One explicit row table (design.md acceptance list); each row
 * seeds its own tmp workspace and asserts the response body.
 */
// Local-day bucketing is asserted in a non-UTC zone: a 02:00Z dispatch is the
// previous local day in New York. Set before any Date is constructed.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attachUsageRoutes } from '../server/usage-routes.js';

const B_FAIL = 'b-failed-1';
const B_KILL = 'b-killed-1';
let seq = 0;

function dispatch(ts, fields = {}) {
  return {
    v: 1, ts, _seq: ++seq, kind: 'dispatch', dispatch_id: `d-${seq}`, site: 'build-step',
    agent: 'claude', outcome: 'ok', model: 'model-a', attempt: 1,
    tokens_in: 100, tokens_out: 10, tokens_total: 110, usd: 1, usd_source: 'reported', ...fields,
  };
}

function build(id, status, fields = {}) {
  return {
    featureCode: 'F-1', flowId: `flow-${id}`, mode: 'feature', status,
    startedAt: '2026-10-01T12:00:00.000Z', completedAt: '2026-10-01T13:00:00.000Z', durationMs: 1,
    accumulator_build_id: id, input_tokens: 300, output_tokens: 30,
    cache_read_tokens: 700, cache_creation_tokens: 5, usd_unknown_count: 0, stepCount: 0, steps: [], ...fields,
  };
}

const sumUsd = (rows) => rows.reduce((t, r) => t + r.usd, 0);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const ROWS = [
  {
    name: 'empty ledger: empty state, no zero-filled tiles mistaken for data',
    ledger: [], history: [],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-03T04:00:00.000Z',
    check: (b) => {
      assert.equal(b.current.empty, true);
      assert.equal(b.current.tiles.dispatches.value, 0);
      assert.deepEqual(b.current.models, []);
      assert.equal(b.current.days.length, 2);
      assert.equal(b.current.tiles.cache_hit_rate.rate, null);
      assert.deepEqual(b.scope, { workspace: 'current', spend: 'compose-dispatched' });
    },
  },
  {
    name: 'malformed line is skipped, valid rows around it still count',
    ledger: [dispatch('2026-10-01T15:00:00.000Z'), '{"v":1,"ts":"torn', dispatch('2026-10-01T16:00:00.000Z')],
    history: ['{not json', build(B_FAIL, 'failed')],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z',
    check: (b) => {
      assert.equal(b.current.tiles.dispatches.value, 2);
      close(b.current.tiles.total_cost.usd, 2);
      assert.equal(b.current.builds.in_range, 1);
    },
  },
  {
    name: 'model null is one Unknown row and its cost is in the tile total',
    ledger: [
      dispatch('2026-10-01T15:00:00.000Z', { model: null, usd: 0.5 }),
      dispatch('2026-10-01T15:30:00.000Z', { usd: 2 }),
      dispatch('2026-10-01T16:00:00.000Z', { usd: 1, model: undefined }),
    ],
    history: [],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z',
    check: (b) => {
      const unknown = b.current.models.filter((m) => m.unknown);
      assert.equal(unknown.length, 1);
      assert.equal(unknown[0].model, null);
      assert.equal(unknown[0].dispatch_count, 2);
      close(unknown[0].usd, 1.5);
      assert.equal(b.current.models.at(-1).unknown, true, 'Unknown row sorts last');
      close(sumUsd(b.current.models), b.current.tiles.total_cost.usd);
      close(b.current.tiles.total_cost.usd, 3.5);
      assert.ok(b.current.days[0].by_model.unknown, 'chart series keeps the Unknown model');
    },
  },
  {
    name: 'provenance: reported, estimated and absent reported separately; null counts as absent',
    ledger: [
      dispatch('2026-10-01T15:00:00.000Z', { usd: 1, usd_source: 'reported' }),
      dispatch('2026-10-01T15:01:00.000Z', { usd: 2, usd_source: 'estimated' }),
      dispatch('2026-10-01T15:02:00.000Z', { usd: 4, usd_source: undefined }),
      dispatch('2026-10-01T15:03:00.000Z', { usd: 8, usd_source: null }),
    ],
    history: [],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z',
    check: (b) => {
      const p = b.current.tiles.total_cost.provenance;
      assert.deepEqual(p.reported, { dispatch_count: 1, usd: 1 });
      assert.deepEqual(p.estimated, { dispatch_count: 1, usd: 2 });
      assert.deepEqual(p.absent, { dispatch_count: 2, usd: 12 });
      assert.equal(b.current.incomplete.marked, false);
    },
  },
  {
    name: 'usd_unknown_count > 0 marks the range incomplete',
    ledger: [dispatch('2026-10-01T15:00:00.000Z', { build_id: B_FAIL })],
    history: [build(B_FAIL, 'failed', { usd_unknown_count: 2 })],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z',
    check: (b) => {
      assert.equal(b.current.incomplete.marked, true);
      assert.equal(b.current.incomplete.usd_unknown_count, 2);
    },
  },
  {
    name: 'missing cache fields are excluded from the cache denominator, not zero; cache is build-level',
    ledger: [dispatch('2026-10-01T15:00:00.000Z')],
    history: [
      build('b-cache', 'failed'),
      build('b-nocache', 'failed', { cache_read_tokens: undefined, cache_creation_tokens: undefined }),
      build('b-nullcache', 'failed', { cache_read_tokens: null }),
    ],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z',
    check: (b) => {
      const c = b.current.tiles.cache_hit_rate;
      assert.equal(c.builds_counted, 1);
      assert.equal(c.builds_excluded, 2);
      close(c.rate, 700 / (700 + 300));
      assert.equal(c.scope, 'build');
      assert.equal(c.by_model, false);
      for (const m of b.current.models) assert.equal('cache_read_tokens' in m, false);
    },
  },
  {
    name: 'range boundary: from is inclusive, to is exclusive',
    ledger: [
      dispatch('2026-10-01T03:59:59.999Z', { usd: 100 }),
      dispatch('2026-10-01T04:00:00.000Z', { usd: 1 }),
      dispatch('2026-10-02T03:59:59.999Z', { usd: 2 }),
      dispatch('2026-10-02T04:00:00.000Z', { usd: 400 }),
    ],
    history: [],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z',
    check: (b) => {
      assert.equal(b.current.tiles.dispatches.value, 2);
      close(b.current.tiles.total_cost.usd, 3);
      assert.deepEqual(b.current.days.map((d) => d.date), ['2026-10-01']);
    },
  },
  {
    name: 'zero-dispatch day renders as a bucket; buckets are local calendar days',
    ledger: [
      dispatch('2026-10-02T02:00:00.000Z', { usd: 1 }), // 2026-10-01 22:00 in New York
      dispatch('2026-10-03T15:00:00.000Z', { usd: 2 }),
    ],
    history: [],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-04T04:00:00.000Z',
    check: (b) => {
      assert.deepEqual(b.current.days.map((d) => [d.date, d.dispatch_count]),
        [['2026-10-01', 1], ['2026-10-02', 0], ['2026-10-03', 1]]);
      assert.equal(b.current.tiles.active_days.value, 2);
    },
  },
  {
    name: 'builds with zero successful outcomes: wasted spend and retry cost, nothing divides by successes',
    ledger: [
      dispatch('2026-10-01T15:00:00.000Z', { build_id: B_FAIL, usd: 1 }),
      dispatch('2026-10-01T15:10:00.000Z', { build_id: B_KILL, usd: 2, attempt: 2 }),
      dispatch('2026-10-01T15:20:00.000Z', { build_id: 'b-not-in-history', usd: 4 }),
      dispatch('2026-10-01T15:30:00.000Z', { usd: 8 }),
    ],
    history: [build(B_FAIL, 'failed'), build(B_KILL, 'killed')],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z',
    check: (b) => {
      const w = b.current.tiles.wasted_spend;
      close(w.usd, 3);
      assert.deepEqual([w.dispatch_count, w.joined_count, w.unjoined_count, w.no_build_count], [2, 2, 1, 1]);
      close(b.current.tiles.retry_cost.usd, 2);
      assert.deepEqual(b.current.builds.statuses, { failed: 1, killed: 1 });
    },
  },
  {
    name: 'compare returns the same shape for the preceding window of equal length',
    ledger: [
      dispatch('2026-09-30T15:00:00.000Z', { usd: 5 }),
      dispatch('2026-10-01T15:00:00.000Z', { usd: 1 }),
    ],
    history: [],
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z&compare=1',
    check: (b) => {
      assert.deepEqual(b.previous_range, { from: '2026-09-30T04:00:00.000Z', to: '2026-10-01T04:00:00.000Z' });
      assert.deepEqual(Object.keys(b.previous).sort(), Object.keys(b.current).sort());
      assert.deepEqual(Object.keys(b.previous.tiles).sort(), Object.keys(b.current.tiles).sort());
      close(b.previous.tiles.total_cost.usd, 5);
      close(b.current.tiles.total_cost.usd, 1);
    },
  },
  {
    name: 'no limit truncation: 120 build records all join',
    ledger: Array.from({ length: 120 }, (_, i) => dispatch('2026-10-01T15:00:00.000Z', { build_id: `bulk-${i}` })),
    history: Array.from({ length: 120 }, (_, i) => build(`bulk-${i}`, 'failed')),
    query: 'from=2026-10-01T04:00:00.000Z&to=2026-10-02T04:00:00.000Z',
    check: (b) => {
      assert.equal(b.current.tiles.wasted_spend.joined_count, 120);
      assert.equal(b.current.builds.in_range, 120);
    },
  },
  {
    name: 'bad input is a 400',
    ledger: [], history: [],
    query: 'from=yesterday',
    status: 400,
    check: (b) => assert.match(b.error, /ISO 8601/),
  },
  {
    name: 'compare without from is a 400',
    ledger: [], history: [],
    query: 'compare=1',
    status: 400,
    check: (b) => assert.match(b.error, /bounded range/),
  },
];

function seed(ws, { ledger, history }) {
  const dataDir = join(ws, '.compose', 'data');
  mkdirSync(dataDir, { recursive: true });
  const line = (r) => (typeof r === 'string' ? r : JSON.stringify(r));
  writeFileSync(join(dataDir, 'dispatch-ledger.jsonl'), ledger.map(line).join('\n') + (ledger.length ? '\n' : ''));
  if (history.length) writeFileSync(join(dataDir, 'build-history.jsonl'), history.map(line).join('\n') + '\n');
  return dataDir;
}

async function get(ws, dataDir, query) {
  const app = express();
  attachUsageRoutes(app, { getTargetRoot: () => ws, getDataDir: () => dataDir, now: () => Date.parse('2026-10-05T00:00:00Z') });
  const server = await new Promise((res) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => res(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/usage/stats?${query}`);
    return { status: r.status, body: await r.json() };
  } finally {
    await new Promise((res) => server.close(res));
  }
}

test('GET /api/usage/stats row table', async (t) => {
  for (const row of ROWS) {
    await t.test(row.name, async () => {
      const ws = mkdtempSync(join(tmpdir(), 'usage-stats-'));
      try {
        const dataDir = seed(ws, row);
        const { status, body } = await get(ws, dataDir, row.query);
        assert.equal(status, row.status ?? 200, JSON.stringify(body));
        row.check(body);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  }
});
