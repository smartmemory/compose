/**
 * fleet-paused-routes.test.js — COMP-DAYVIEW-SPLIT-2: `fleet.paused` in `.compose/compose.json` marks the lanes the owner
 * deliberately paused. `readFleetPaused` reads it the way `fleet.projects` is read; `/api/ribbon` stamps `paused` on every
 * lane, fresh per request (a cache hit included), and a malformed value pauses nothing and warns once.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFleetPaused } from '../server/process-routes.js';
import { attachRibbonRoutes } from '../server/ribbon-routes.js';

const roots = [];
/** A project root whose compose.json is `cfg` (a string is written verbatim; undefined writes no file). */
function rootWith(cfg) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-paused-'));
  roots.push(root);
  if (cfg !== undefined) {
    mkdirSync(join(root, '.compose'));
    writeFileSync(join(root, '.compose', 'compose.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  }
  return root;
}
const setCfg = (root, cfg) => writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify(cfg));
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe('readFleetPaused', () => {
  const ROWS = [
    ['the list as written', { fleet: { paused: ['hub', 'setup', 'trader'], projects: ['hub'] } }, { paused: ['hub', 'setup', 'trader'], error: null }],
    ['no key pauses nothing, silently', { fleet: { projects: ['hub'] } }, { paused: [], error: null }],
    ['no file pauses nothing, silently', undefined, { paused: [], error: null }],
    ['duplicates collapse', { fleet: { paused: ['hub', 'hub'] } }, { paused: ['hub'], error: null }],
  ];
  for (const [name, cfg, want] of ROWS) it(name, async () => assert.deepEqual(await readFleetPaused(rootWith(cfg)), want));

  const BAD = [
    ['a string, not a list', { fleet: { paused: 'hub' } }, /fleet\.paused must be an array of lane names, got "hub"/],
    ['a list holding a non-string', { fleet: { paused: ['hub', 3] } }, /fleet\.paused must be an array of lane names/],
    ['compose.json that is not JSON', '{ not json', /compose\.json is not JSON/],
  ];
  for (const [name, cfg, why] of BAD) {
    it(`malformed (${name}): pauses nothing and names the problem`, async () => {
      const r = await readFleetPaused(rootWith(cfg));
      assert.deepEqual(r.paused, []);
      assert.match(r.error, why);
    });
  }
});

const D = (s) => Date.parse(`2026-10-31T${s}:00Z`);
const T = (s) => `2026-10-31T${s}:00.000Z`;
const NOW = D('12:00');
const events = (o = {}) => ({ owner_waits: [], reviews: [], fix_runs: [], gates: [], deploys: [], fixes: [], ready_at: null, dispatched_at: null, author_done_at: null, landed_at: null, account: null, ...o });
const unit = (id, lane, ev) => ({ id, lane, title: `Title ${id}`, titleSource: 'stamp', state: 'authoring', landedAt: null, deployedAt: null, events: events(ev) });

/** One in-process `/api/ribbon` handler over `root`; `get()` answers one GET's body. */
function ribbonRoute(root) {
  let handler = null;
  const warnings = [];
  attachRibbonRoutes({ get: (_p, h) => { handler = h; }, locals: {} }, { deps: {
    now: () => NOW, warn: (m) => warnings.push(m), info: () => {}, dataDir: () => join(root, 'data'), projectRoot: () => root,
    loadSnapshots: async () => [], loadGateLog: async () => [], loadLaunchEvents: async () => [], loadSeats: async () => ({ seats: [] }),
    ledger: { get: async () => ({ value: [] }), rows: () => [] }, loadOutage: async () => ({ state: 'ok', since: null }),
    eta: async () => ({ p50: '2h', p80: '3h', asOf: 'a', raw: 'r' }),
    loadOwnerQueue: async () => [],
    loadUnits: async () => ({ units: [
      unit('U1', 'hub', { ready_at: T('07:50'), dispatched_at: T('08:00') }),
      unit('U2', 'forge', { ready_at: T('07:50'), dispatched_at: T('08:00') }),
    ], coverage: {}, asOf: new Date(NOW).toISOString() }),
  } });
  const get = () => new Promise((resolve, reject) => {
    const res = { set() {}, status() { return this; }, json: resolve };
    handler({ query: { from: T('00:00'), to: T('23:00') }, socket: { localPort: 1 } }, res).catch(reject);
  });
  return { get, warnings };
}
const pausedMap = (body) => Object.fromEntries(body.lanes.map((l) => [l.lane, l.paused]));

describe('/api/ribbon stamps paused on each lane', () => {
  it('a listed lane is paused, the rest are not', async () => {
    const { get } = ribbonRoute(rootWith({ fleet: { paused: ['hub'] } }));
    assert.deepEqual(pausedMap(await get()), { hub: true, forge: false });
  });
  it('read fresh per request: the cached body follows an edit to compose.json at once', async () => {
    const root = rootWith({ fleet: { paused: ['hub'] } });
    const { get } = ribbonRoute(root);
    assert.deepEqual(pausedMap(await get()), { hub: true, forge: false });
    setCfg(root, { fleet: { paused: ['forge'] } });
    assert.deepEqual(pausedMap(await get()), { hub: false, forge: true }); // same minute key: this is the response cache's hit path
  });
  it('a missing key pauses nothing and warns nothing', async () => {
    const { get, warnings } = ribbonRoute(rootWith({ fleet: { projects: ['hub', 'forge'] } }));
    assert.deepEqual(pausedMap(await get()), { hub: false, forge: false });
    assert.deepEqual(warnings.filter((w) => /no lane is paused/.test(w)), []);
  });
  it('a malformed value pauses nothing and warns ONCE across polls, naming the problem', async () => {
    const { get, warnings } = ribbonRoute(rootWith({ fleet: { paused: 'hub' } }));
    assert.deepEqual(pausedMap(await get()), { hub: false, forge: false });
    assert.deepEqual(pausedMap(await get()), { hub: false, forge: false });
    const w = warnings.filter((m) => /no lane is paused/.test(m));
    assert.equal(w.length, 1);
    assert.match(w[0], /fleet\.paused must be an array of lane names, got "hub"; no lane is paused/);
  });
});
