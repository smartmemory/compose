/**
 * COMP-COCKPIT-PROCESS-DATA-1: GET /api/usage/seats runs the usage watcher (argv, no shell) and returns one quota row
 * per account. One explicit row table; each row writes its own fixture reader script into a tmp dir and the route
 * really spawns it (COMPOSE_USAGE_WATCH), so the spawn, parse, cache and error paths are the production ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attachUsageRoutes } from '../server/usage-routes.js';

const ACCOUNTS = {
  generated_at: '2026-10-31T12:00:00',
  accounts: [
    { id: 'max', label: 'Claude Max 20x (someone@example.com)', vendor: 'claude', status: 'stale', today_pts: 0.0,
      windows: { '5h': { used_pct: 0.0, resets_at: 1793289571.066284 }, '7d': { used_pct: 44.0, resets_at: 1793728800.0 } } },
    { id: 'seat1', label: 'Claude Team seat 1', vendor: 'claude', status: 'missing',
      windows: { '5h': { used_pct: 39.0, resets_at: 1793425200.0 }, '7d': { used_pct: null, resets_at: null } } },
    { id: 'codex', label: 'Codex prolite', vendor: 'codex', status: 'ok', today_pts: 4.0, windows: { '7d': { used_pct: 19.0, resets_at: 1793774756.0 } } },
  ],
};

// COMP-COCKPIT-COST-METER-1: usage_watch's real shape, epoch `generated_at`, retired Max, Team seat with no 7d, Fable, Codex cap.
const WATCH = {
  generated_at: 1793438788.498388,
  accounts: [
    { id: 'max', label: 'Claude Max 20x', vendor: 'claude', status: 'stale', retired: true, retire_state: 'retired',
      windows: { '5h': { used_pct: 0, resets_at: null, status: 'expired' }, '7d': { used_pct: 44, resets_at: 1793728800, status: 'stale' } },
      fable: { reading: { used_pct: 44, resets_at: 1793728800 }, cap_pct: 100, pace_pct: 52.04, over_cap: false } },
    { id: 'seat3', label: 'Claude Team seat 3', vendor: 'claude', status: 'missing', retired: false, retire_state: '',
      windows: { '5h': { used_pct: 31.0000001, resets_at: 1793425200, status: 'ok' }, '7d': { used_pct: null, resets_at: null, status: 'missing' } },
      fable: { reading: null, cap_pct: 70, pace_pct: null, over_cap: false },
      seat_idle: { used_pct: 31, hours_left: 2.06, ready_units: 91 } },
    { id: 'codex', label: 'Codex prolite', vendor: 'codex', status: 'ok', today_pts: 6,
      windows: { '7d': { used_pct: 19, resets_at: 1793774756, status: 'ok' } }, codex_daily: { cap_pct: 13, state: 'ok', off: false } },
  ],
};
const bySeat = (body, id) => body.seats.value.seats.find((r) => r.id === id);

/** A fixture reader: appends one line to `runs` per call, then prints `out` and exits `code`. */
function script(dir, out, code = 0) {
  const p = join(dir, 'usage_watch.py');
  writeFileSync(p, [
    'import sys',
    `open(${JSON.stringify(join(dir, 'runs'))}, 'a').write('x\\n')`,
    `assert sys.argv[1:] == ['status', '--json'], sys.argv`,
    `sys.stdout.write(${JSON.stringify(out)})`,
    `sys.exit(${code})`,
  ].join('\n'));
  return p;
}

const runs = (dir) => (existsSync(join(dir, 'runs')) ? readFileSync(join(dir, 'runs'), 'utf8').split('\n').filter(Boolean).length : 0);

const ROWS = [
  {
    name: 'reader ok: one row per account, quota windows as ISO resets, the email cut from the label',
    setup: (dir) => script(dir, JSON.stringify(ACCOUNTS)),
    check(body) {
      assert.equal(body.seats.error, null);
      assert.equal(body.seats.value.generated_at, '2026-10-31T12:00:00');
      assert.deepEqual(body.seats.value.seats, [
        { id: 'max', label: 'Claude Max 20x', vendor: 'claude', status: 'stale', today_pts: 0,
          five_h: { used_pct: 0, resets_at: new Date(1793289571066.284).toISOString() },
          seven_d: { used_pct: 44, resets_at: new Date(1793728800000).toISOString() } },
        { id: 'seat1', label: 'Claude Team seat 1', vendor: 'claude', status: 'missing', today_pts: null,
          five_h: { used_pct: 39, resets_at: new Date(1793425200000).toISOString() }, seven_d: { used_pct: null, resets_at: null } },
        { id: 'codex', label: 'Codex prolite', vendor: 'codex', status: 'ok', today_pts: 4,
          five_h: { used_pct: null, resets_at: null }, seven_d: { used_pct: 19, resets_at: new Date(1793774756000).toISOString() } },
      ]);
      assert.ok(!JSON.stringify(body).includes('@'), 'no email address leaves the route');
    },
  },
  {
    name: 'retired and retire_state pass through, an active seat carries retired false',
    setup: (dir) => script(dir, JSON.stringify(WATCH)),
    check(body) {
      assert.deepEqual([bySeat(body, 'max').retired, bySeat(body, 'max').retire_state], [true, 'retired']);
      assert.deepEqual([bySeat(body, 'seat3').retired, bySeat(body, 'seat3').retire_state], [false, '']);
      assert.equal('retired' in bySeat(body, 'codex'), false);
    },
  },
  {
    name: 'a Team seat with no weekly cap passes the 7d status through, so the meter can say 5h-only',
    setup: (dir) => script(dir, JSON.stringify(WATCH)),
    check(body) {
      assert.equal(bySeat(body, 'seat3').seven_d.status, 'missing');
      assert.equal(bySeat(body, 'max').seven_d.status, 'stale');
    },
  },
  {
    name: 'fable passes through with ISO reset and a null reading kept null',
    setup: (dir) => script(dir, JSON.stringify(WATCH)),
    check(body) {
      assert.deepEqual(bySeat(body, 'max').fable, { used_pct: 44, resets_at: new Date(1793728800000).toISOString(), cap_pct: 100, pace_pct: 52.04, over_cap: false });
      assert.deepEqual(bySeat(body, 'seat3').fable, { used_pct: null, resets_at: null, cap_pct: 70, pace_pct: null, over_cap: false });
      assert.equal('fable' in bySeat(body, 'codex'), false);
    },
  },
  {
    name: 'codex_daily and seat_idle pass through, the cap read from the data',
    setup: (dir) => script(dir, JSON.stringify(WATCH)),
    check(body) {
      assert.deepEqual(bySeat(body, 'codex').codex_daily, { cap_pct: 13, state: 'ok', off: false });
      assert.deepEqual(bySeat(body, 'seat3').seat_idle, { used_pct: 31, hours_left: 2.06, ready_units: 91 });
    },
  },
  {
    name: 'epoch generated_at becomes an ISO string, so the meter can print as-of',
    setup: (dir) => script(dir, JSON.stringify(WATCH)),
    check(body) { assert.equal(body.seats.value.generated_at, new Date(1793438788498.388).toISOString()); },
  },
  { name: 'reader missing: 200 with the error, no rows', setup: (dir) => join(dir, 'nope.py'), error: /^reader missing: / },
  { name: 'reader prints text, not JSON', setup: (dir) => script(dir, 'usage: status [--json]'), error: /printed no JSON document/ },
  { name: 'reader exits non-zero', setup: (dir) => script(dir, '', 3), error: /^exit 3/ },
  { name: 'reader prints JSON with no accounts list', setup: (dir) => script(dir, JSON.stringify({ accounts: 'x' })), error: /printed no accounts list/ },
  {
    name: 'two reads inside the cache window run the reader once',
    setup: (dir) => script(dir, JSON.stringify(ACCOUNTS)),
    reads: 2,
    check(body, dir) { assert.equal(body.seats.value.seats.length, 3); assert.equal(runs(dir), 1); },
  },
];

for (const row of ROWS) {
  test(`GET /api/usage/seats: ${row.name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-seats-'));
    const server = await (async () => {
      const app = express();
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, COMPOSE_USAGE_WATCH: row.setup(dir) };
      attachUsageRoutes(app, { env, now: () => Date.parse('2026-10-31T12:00:00Z') });
      return new Promise((res) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => res(s)); });
    })();
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/usage/seats`;
      let body;
      for (let i = 0; i < (row.reads ?? 1); i += 1) {
        const res = await fetch(url);
        assert.equal(res.status, 200);
        body = await res.json();
      }
      assert.equal(body.v, 1);
      if (row.error) {
        assert.equal(body.seats.value, null);
        assert.match(body.seats.error, row.error);
      } else {
        row.check(body, dir);
      }
    } finally {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
