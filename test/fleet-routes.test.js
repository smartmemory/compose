/**
 * COMP-COCKPIT-12: GET /api/fleet over the three readers. Real route on a loopback ephemeral port, fixture
 * readers selected by the COMPOSE_FLEET_* path overrides (test/fixtures/fleet), the real Cadence handler on
 * the sibling package's own fixture roots when the sibling exists. One row table: each row is a sequence of
 * requests on one app, with a controllable clock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachFleetRoutes, resolveFleetReaders } from '../server/fleet-routes.js';
import { attachCadenceUiRoutes } from '../server/cadence-ui-routes.js';
import { resolveCadenceUiDir } from '../lib/cadence-ui-link.js';

const FIX = fileURLToPath(new URL('./fixtures/fleet/', import.meta.url));
const uiDir = resolveCadenceUiDir();
const CADENCE_FIX = uiDir ? join(uiDir, 'tests', 'fixtures') : null;
const BASE_ENV = {
  PATH: process.env.PATH,
  COMPOSE_FLEET_PYTHON: process.execPath,
  COMPOSE_FLEET_SM_STATUS: join(FIX, 'sm-status.mjs'),
  COMPOSE_FLEET_STRATUM_BIN: join(FIX, 'stratum.mjs'),
  COMPOSE_FLEET_CADENCE_SHADOW: join(FIX, 'shadow.jsonl'),
};
const TTL = { stratum: 10_000, sm_status: 30_000, cadence: 60_000 };

async function withApp({ env, cadence = true, timeoutMs = { stratum: 5_000, sm_status: 5_000 } }, fn) {
  const app = express();
  if (cadence && uiDir) {
    await attachCadenceUiRoutes(app, { uiDir, opsRoot: join(CADENCE_FIX, 'ops'), stateDir: join(CADENCE_FIX, 'state'), scriptsDir: '/none', run: async () => '{}' });
  }
  const clock = { t: 1_000_000 };
  const warns = [];
  const infos = [];
  attachFleetRoutes(app, {
    env, readers: resolveFleetReaders(env), now: () => clock.t, ttlMs: TTL, timeoutMs,
    warn: (m) => warns.push(m), info: (m) => infos.push(m),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/fleet`);
    assert.equal(res.status, 200);
    return res.json();
  };
  try { await fn({ get, clock, warns, infos }); } finally { server.close(); }
}

const spawns = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const ok = (src) => assert.equal(src.error, null, `expected ok, got ${src.error}`);
const down = (src, re) => { assert.equal(src.value, null); assert.match(src.error, re); };

// [name, env overrides, options, check({get, clock, warns, infos, count})]
const ROWS = [
  ['fixture JSON per source, panel subset, Stratum wins on liveness', {}, {}, async ({ get, warns, count }) => {
    const body = await get();
    const { stratum, sm_status: sm, cadence } = body.sources;
    ok(stratum);
    assert.deepEqual(stratum.value, { count: 1, max: 16, jobs: [{ session: 'lane-a-main', label: 'claude:opus', pid: 4242 }] });
    ok(sm);
    assert.deepEqual(Object.keys(sm.value).sort(), ['ceiling', 'df', 'generated', 'jobs', 'ledger', 'queue', 'sessions', 'spend']);
    assert.equal(JSON.stringify(body).includes('must not leak'), false, 'quota panel is not passed through');
    assert.equal(sm.value.sessions.value[0].ctx, 262000);
    assert.equal(sm.value.spend.value, null);
    assert.match(sm.value.spend.error, /attribute script missing/, 'a failing inner source keeps its own error');
    const jobs = Object.fromEntries(sm.value.jobs.value.map((j) => [j.id, [j.alive, j.aliveFrom]]));
    assert.deepEqual(jobs, { 'job-alive': [true, 'stratum'], 'job-dead': [false, 'stratum'], 'job-nopid': [null, 'sm_status'] });
    if (uiDir) {
      ok(cadence);
      assert.ok(Array.isArray(cadence.value.ready));
      assert.ok(cadence.value.ready.every((u) => u.column === 'ready' && !('rawState' in u)));
      assert.deepEqual(cadence.value.wouldLaunch.value.units, ['forge/FIXTURE-1'], 'the LAST would_launch line');
      assert.equal('accounts' in cadence.value.wouldLaunch.value, false);
      assert.equal(JSON.stringify(cadence).match(/agree_rate|hand_coverage/), null, 'no F33-affected numbers');
    } else {
      down(cadence, /not mounted/);
    }
    assert.deepEqual(count().sort(), ['sm', 'stratum']);
    assert.equal(warns.length, uiDir ? 0 : 1);
  }],
  ['cache: one spawn per window, single flight, stale served while one refresh runs', { FLEET_FIXTURE_DELAY_MS: '300' }, {}, async ({ get, clock, count }) => {
    const first = await Promise.all([get(), get(), get(), get()]);
    assert.equal(count().filter((s) => s === 'sm').length, 1, 'four concurrent clients, one spawn');
    assert.ok(first.every((b) => b.sources.sm_status.stale === false));
    clock.t += 5_000;
    await get();
    assert.equal(count().filter((s) => s === 'sm').length, 1, 'inside the window: cached');
    clock.t += TTL.sm_status;
    const [a, b] = await Promise.all([get(), get()]);
    assert.equal(a.sources.sm_status.stale, true, 'past the window: last value served at once');
    assert.equal(b.sources.sm_status.stale, true);
    assert.ok(a.sources.sm_status.value.sessions, 'stale value is the previous data');
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(count().filter((s) => s === 'sm').length, 2, 'exactly one refresh for the expired window');
    assert.equal(count().filter((s) => s === 'stratum').length, 2, 'stratum refreshed on its own window');
  }],
  ['spawn failure: outage, one warn per outage, recovery logged', { FLEET_FIXTURE_SM: 'fail' }, {}, async ({ get, clock, warns, infos }) => {
    down((await get()).sources.sm_status, /^exit 1: Traceback: fixture failure/);
    clock.t += TTL.sm_status;
    await get();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(warns.filter((w) => w.startsWith('[fleet] sm_status')).length, 1, 'still the same outage');
    assert.equal(infos.length, 0);
  }],
  ['timeout: the reader is killed and named', { FLEET_FIXTURE_SM: 'slow', FLEET_FIXTURE_STRATUM: 'slow' }, { timeoutMs: { stratum: 300, sm_status: 300 } }, async ({ get, warns }) => {
    const { sources } = await get();
    down(sources.sm_status, /^timed out after 300 ms/);
    down(sources.stratum, /^timed out/);
    assert.equal(warns.filter((w) => /timed out/.test(w)).length, 2);
  }],
  ['unparsable output is an outage, not data', { FLEET_FIXTURE_SM: 'garbage' }, {}, async ({ get }) => {
    down((await get()).sources.sm_status, /printed no JSON/);
  }],
  ['missing python hides only sm_status', { COMPOSE_FLEET_PYTHON: '/nonexistent/python3' }, {}, async ({ get }) => {
    const { sources } = await get();
    down(sources.sm_status, /cannot start .*ENOENT/);
    ok(sources.stratum);
  }],
  ['missing script hides only sm_status', { COMPOSE_FLEET_SM_STATUS: '/nonexistent/sm_status.py' }, {}, async ({ get, count }) => {
    down((await get()).sources.sm_status, /reader missing/);
    assert.deepEqual(count(), ['stratum'], 'no spawn for a missing script');
  }],
  ['missing stratum binary hides only stratum; jobs keep sm_status liveness', { COMPOSE_FLEET_STRATUM_BIN: '/nonexistent/stratum' }, {}, async ({ get }) => {
    const { sources } = await get();
    down(sources.stratum, /cannot start .*ENOENT/);
    ok(sources.sm_status);
    assert.ok(sources.sm_status.value.jobs.value.every((j) => j.aliveFrom === 'sm_status'));
    assert.equal(sources.sm_status.value.jobs.value.find((j) => j.id === 'job-dead').alive, true);
  }],
  ['stratum refusal (backend unconfigured) is an outage with its code', { FLEET_FIXTURE_STRATUM: 'refused' }, {}, async ({ get }) => {
    down((await get()).sources.stratum, /^backend-unconfigured: session backend not configured/);
  }],
  ['cadence not mounted hides only cadence', {}, { cadence: false }, async ({ get, warns }) => {
    const { sources } = await get();
    down(sources.cadence, /cadence-ui handler not mounted/);
    ok(sources.sm_status);
    assert.deepEqual(warns, ['[fleet] cadence unavailable: cadence-ui handler not mounted']);
  }],
  ['missing shadow log keeps the belt, names the shadow error', { COMPOSE_FLEET_CADENCE_SHADOW: '/nonexistent/shadow.jsonl' }, {}, async ({ get }) => {
    const { cadence } = (await get()).sources;
    if (!uiDir) return down(cadence, /not mounted/);
    ok(cadence);
    assert.equal(cadence.value.wouldLaunch.value, null);
    assert.match(cadence.value.wouldLaunch.error, /ENOENT/);
  }],
];

describe('GET /api/fleet', () => {
  it('serves the three readers with caching, spawn safety and outage hiding', async () => {
    for (const [name, envOverrides, opts, check] of ROWS) {
      const dir = mkdtempSync(join(tmpdir(), 'fleet-route-'));
      const countFile = join(dir, 'spawns');
      writeFileSync(countFile, '');
      try {
        const env = { ...BASE_ENV, FLEET_FIXTURE_COUNT: countFile, ...envOverrides };
        await withApp({ env, ...opts }, (ctx) => check({ ...ctx, count: () => spawns(countFile) }));
      } catch (error) {
        error.message = `${name}: ${error.message}`;
        throw error;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
