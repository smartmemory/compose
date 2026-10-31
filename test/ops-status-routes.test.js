/**
 * COMPOSE-OPS-TAB-1: /ops-status static mount + /api/ops-status/index.
 * Route table: existing page / missing page / traversal / dir absent / non-GET.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachOpsStatusRoutes, listOpsPages } = await import(`${ROOT}/server/ops-status-routes.js`);

let base, srv, absentBase, absentSrv, tmp;

const listen = (app) => new Promise((ok) => {
  const s = createServer(app).listen(0, '127.0.0.1', () => ok([s, `http://127.0.0.1:${s.address().port}`]));
});
const get = (url, method = 'GET') => fetch(url, { method, redirect: 'manual' });

describe('ops-status routes', () => {
  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-status-'));
    const out = join(tmp, 'out');
    for (const n of ['wiki', 'forge']) { mkdirSync(join(out, n), { recursive: true }); writeFileSync(join(out, n, 'status.html'), `<h1>${n}</h1>`); }
    mkdirSync(join(out, 'empty'));                       // no status.html: not listed
    writeFileSync(join(tmp, 'secret.txt'), 'SECRET');     // outside the dir
    const app = express();
    assert.equal(attachOpsStatusRoutes(app, { dir: out }), true);
    [srv, base] = await listen(app);
    const app2 = express();
    assert.equal(attachOpsStatusRoutes(app2, { dir: join(tmp, 'nope') }), false);
    [absentSrv, absentBase] = await listen(app2);
  });
  after(() => { srv.close(); absentSrv.close(); rmSync(tmp, { recursive: true, force: true }); });

  test('index lists only subdirs holding status.html', async () => {
    const r = await get(`${base}/api/ops-status/index`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { pages: ['forge', 'wiki'] });
  });

  test('route table', async () => {
    const rows = [
      ['existing page', `${base}/ops-status/wiki/status.html`, 'GET', 200],
      ['missing page', `${base}/ops-status/nope/status.html`, 'GET', 404],
      ['directory listing off', `${base}/ops-status/wiki/`, 'GET', 404],
      ['traversal raw', `${base}/ops-status/../secret.txt`, 'GET', 404],
      ['traversal encoded', `${base}/ops-status/%2e%2e/secret.txt`, 'GET', 404],
      ['traversal double-encoded', `${base}/ops-status/..%2fsecret.txt`, 'GET', 404],
      ['non-GET refused', `${base}/ops-status/wiki/status.html`, 'POST', 405],
      ['dir absent: page', `${absentBase}/ops-status/wiki/status.html`, 'GET', 404],
      ['dir absent: index route absent', `${absentBase}/api/ops-status/index`, 'GET', 404],
    ];
    for (const [label, url, method, want] of rows) {
      const r = await get(url, method);
      assert.equal(r.status, want, label);
      if (want !== 200) assert.ok(!(await r.text()).includes('SECRET'), `${label}: no leak`);
    }
    assert.equal(await (await get(`${base}/ops-status/wiki/status.html`)).text(), '<h1>wiki</h1>');
  });

  test('remote mode mounts nothing', () => {
    assert.equal(attachOpsStatusRoutes(express(), { dir: tmp, remote: true }), false);
    assert.deepEqual(listOpsPages(join(tmp, 'nope')), []);
  });
});

// ---- COMP-COCKPIT-INIT-DATA-1: GET /api/ops-status/:name/data --------------------------------------------------------
import { existsSync, readFileSync, readdirSync } from 'node:fs';
const { createEtaReader, parseEstimate, ESTIMATE_PROFILES } = await import(`${ROOT}/server/ops-status-routes.js`);

const EST_OK = 'chain 1 units, 2 rounds at width 12\nagent-hours 0.6h\nESTIMATE forge P50 2h P80 3h chain 1 units 2 width 12 basis forge n=82 as_of 2026-10-31T18:26\n';
// builder units: A landed per the stamps, B only the builder's note says landed (no stamp row), C stamped but not landed, D waits on A and C
const builderDoc = (extra = {}) => ({
  as_of: '2026-10-31 18:00',
  notices: ['Unit B has an unknown stage "filed".', 'Unit C has an unknown stage "filed".'],
  units: [
    { id: 'A', goal: 'from the builder', deps: [], status: 'planned', note: '' },
    { id: 'B', goal: '', deps: [], status: 'planned', note: '; landed 10-30 22:31; sha 245c8c29' },
    { id: 'C', goal: 'Unit C', deps: [], status: 'planned', note: 'author running' },
    { id: 'D', goal: 'Unit D', deps: ['A', 'C'], status: 'planned', note: '' },
  ],
  ...extra,
});
const STAMP_ROWS = [
  { id: 'A', title: 'A from the stamp', titleSource: 'stamp', landedAt: '2026-10-30T10:00:00Z' },
  { id: 'C', title: null, titleSource: 'none', landedAt: null },
];
// every page sees the same two stamp rows, plus a decoy in a lane no page is named after
const STAMP_UNITS = [...['forge', '2.0', 'hub', 'trader', 'maya', 'wiki'].flatMap((lane) => STAMP_ROWS.map((r) => ({ ...r, lane }))),
  { id: 'Z', lane: 'other', title: 'not this lane', titleSource: 'stamp', landedAt: '2026-10-30T11:00:00Z' }];

describe('ops-status data route', () => {
  let dtmp, dsrv, dbase, rsrv, rbase, bsrv, bbase;
  const state = { stdout: EST_OK, fail: null, calls: [], inputs: [], leftover: [] };
  const run = async (argv) => {
    const file = argv[argv.indexOf('plan') + 1];
    state.calls.push(argv);
    state.inputs.push(JSON.parse(readFileSync(file, 'utf8')));
    state.leftover.push(file);
    if (state.fail) throw new Error(state.fail);
    return { code: 0, stdout: state.stdout, stderr: '' };
  };

  before(async () => {
    dtmp = mkdtempSync(join(tmpdir(), 'ops-status-data-'));
    const out = join(dtmp, 'out');
    for (const n of ['forge', '2.0', 'hub', 'custom', 'trader', 'maya', 'wiki']) {
      mkdirSync(join(out, n), { recursive: true });
      writeFileSync(join(out, n, 'status.html'), `<h1>${n}</h1>`);
      writeFileSync(join(out, n, 'data.json'), JSON.stringify(builderDoc()));
    }
    mkdirSync(join(out, 'nodata'), { recursive: true });
    writeFileSync(join(out, 'nodata', 'status.html'), '<h1>x</h1>');
    mkdirSync(join(out, 'broken'), { recursive: true });
    writeFileSync(join(out, 'broken', 'data.json'), '{"as_of": ');
    const app = express();
    const eta = createEtaReader({ script: '/x/estimate.py', run, warn: () => {} });
    attachOpsStatusRoutes(app, { dir: out, deps: { eta, loadUnitIndex: async () => ({ units: STAMP_UNITS }) } });
    [dsrv, dbase] = await listen(app);
    // the real unit index over a tmp stamps dir: forge has three rows, one landed
    const queues = join(dtmp, 'queues');
    mkdirSync(queues);
    writeFileSync(join(queues, 'forge-units.json'), JSON.stringify({ units: [
      { id: 'A', title: 'A stamped', landed_at: '2026-10-30T10:00:00Z' }, { id: 'C' }, { id: 'D', landed_at: '2026-10-31T09:00:00Z' },
    ] }));
    const realApp = express();
    attachOpsStatusRoutes(realApp, {
      dir: out,
      env: { COMPOSE_PROCESS_QUEUES_DIR: queues, COMPOSE_PROCESS_EXTRA: '', COMPOSE_OPS_STATUS_DIR: out },
      deps: { eta: async () => ({ noData: true, raw: 'stub' }) },
    });
    [rsrv, rbase] = await listen(realApp);
    const badApp = express();
    attachOpsStatusRoutes(badApp, { dir: out, deps: { eta: async () => ({}), loadUnitIndex: async () => { throw new Error('queues dir not found'); } } });
    [bsrv, bbase] = await listen(badApp);
  });
  after(() => { dsrv.close(); rsrv.close(); bsrv.close(); rmSync(dtmp, { recursive: true, force: true }); });

  const json = async (url) => { const r = await get(url); return [r.status, await r.json()]; };
  const reset = (o = {}) => Object.assign(state, { stdout: EST_OK, fail: null, calls: [], inputs: [], leftover: [] }, o);

  // [name, setup, check]: setup moves the stubbed estimate.py, check calls the route and asserts
  const DATA_ROWS = [
    ['data present: counts, notices, age', () => reset(), async () => {
      const [s, b] = await json(`${dbase}/api/ops-status/forge/data`);
      assert.equal(s, 200);
      assert.deepEqual([b.name, b.asOf, b.notices], ['forge', '2026-10-31 18:00', 2]);
      assert.ok(Number.isInteger(b.ageS) && b.ageS >= 0 && b.ageS < 60);
      assert.deepEqual({ ...b.progress, nodes: undefined }, { planned: 4, landed: 1, builderOnly: 1, notRecorded: 2, nodes: undefined });
      const a = b.progress.nodes.find((n) => n.id === 'A');
      assert.deepEqual(a, { id: 'A', title: 'A from the stamp', titleSource: 'stamp', landedAt: '2026-10-30T10:00:00Z', builderStatus: 'planned', deps: [] });
      assert.equal(b.progress.nodes.find((n) => n.id === 'B').title, null); // no title anywhere: null, not an invented one
    }],
    ['data.json missing: 404 says next tick', () => reset(), async () => {
      const [s, b] = await json(`${dbase}/api/ops-status/nodata/data`);
      assert.equal(s, 404);
      assert.match(b.error, /next tick/);
      assert.equal((await get(`${dbase}/api/ops-status/ghost/data`)).status, 404);
    }],
    ['data.json not JSON: 500', () => reset(), async () => {
      const [s, b] = await json(`${dbase}/api/ops-status/broken/data`);
      assert.equal(s, 500);
      assert.match(b.error, /unreadable/);
    }],
    ['bad name: 400', () => reset(), async () => {
      for (const n of ['..%2Fx', '.hidden', 'a%20b', '%2e%2e%2fsecret']) assert.equal((await get(`${dbase}/api/ops-status/${n}/data`)).status, 400, n);
      assert.equal(state.calls.length, 0);
    }],
    ['ETA parsed, input is the remaining nodes only', () => reset(), async () => {
      const [, b] = await json(`${dbase}/api/ops-status/2.0/data`);
      assert.deepEqual(b.eta, { p50: '2h', p80: '3h', asOf: '2026-10-31T18:26', raw: EST_OK.split('\n')[2] });
      assert.deepEqual(state.inputs, [[{ id: 'B', deps: [] }, { id: 'C', deps: [] }, { id: 'D', deps: ['C'] }]]); // A landed, so D's dep on A is dropped
      const argv = state.calls[0];
      assert.deepEqual([argv[0], argv[1], argv[2], ...argv.slice(4)], ['python3', '/x/estimate.py', 'plan', '--like', '2.0', '--name', '2.0']);
      assert.equal(existsSync(dirname(state.leftover[0])), false, 'tmp input removed');
    }],
    ['NO DATA line becomes noData with the raw line', () => reset({ stdout: 'chain 1 units\nNO DATA (n=3)\n' }), async () => {
      const [, b] = await json(`${dbase}/api/ops-status/hub/data`);
      assert.deepEqual(b.eta, { noData: true, raw: 'NO DATA (n=3)' });
    }],
    ['no profile: noData without running', () => reset(), async () => {
      const [, b] = await json(`${dbase}/api/ops-status/custom/data`);
      assert.deepEqual(b.eta, { noData: true, raw: 'no estimate profile for custom' });
      assert.equal(state.calls.length, 0);
      assert.equal(ESTIMATE_PROFILES.includes('custom'), false);
    }],
    ['cache hit: the second call within 15 min does not re-run', () => reset(), async () => {
      const first = (await json(`${dbase}/api/ops-status/trader/data`))[1].eta;
      const second = (await json(`${dbase}/api/ops-status/trader/data`))[1].eta;
      assert.deepEqual(second, first);
      assert.equal(state.calls.length, 1);
    }],
    ['runner fails: eta carries the error, tmp input removed, page still 200', () => reset({ fail: 'timed out after 30000 ms' }), async () => {
      const [s, b] = await json(`${dbase}/api/ops-status/maya/data`);
      assert.equal(s, 200);
      assert.deepEqual(b.eta, { error: 'timed out after 30000 ms' });
      assert.equal(b.progress.planned, 4);
      assert.equal(existsSync(dirname(state.leftover[0])), false);
    }],
    ['unparseable estimate output is an eta error, not a crash', () => reset({ stdout: 'Traceback (most recent call last)\n' }), async () => {
      const [s, b] = await json(`${dbase}/api/ops-status/wiki/data`);
      assert.equal(s, 200);
      assert.match(b.eta.error, /no ESTIMATE or NO DATA/);
      assert.throws(() => parseEstimate(''), /no ESTIMATE/);
    }],
    ['progress counts from a real stamps dir', () => reset(), async () => {
      const [s, b] = await json(`${rbase}/api/ops-status/forge/data`);
      assert.equal(s, 200);
      assert.deepEqual({ ...b.progress, nodes: undefined }, { planned: 4, landed: 2, builderOnly: 1, notRecorded: 1, nodes: undefined });
      assert.deepEqual(b.progress.nodes.filter((n) => n.landedAt).map((n) => n.id), ['A', 'D']);
      assert.deepEqual(b.eta, { noData: true, raw: 'stub' });
    }],
    ['unit index unavailable: progress null, never zero landed', () => reset(), async () => {
      const [s, b] = await json(`${bbase}/api/ops-status/forge/data`);
      assert.equal(s, 200);
      assert.equal(b.progress, null);
      assert.match(b.progressError, /queues dir not found/);
      assert.equal(b.notices, 2);
    }],
    ['page and index unchanged', () => reset(), async () => {
      assert.equal((await get(`${dbase}/ops-status/forge/status.html`)).status, 200);
      const [, b] = await json(`${dbase}/api/ops-status/index`);
      assert.deepEqual(b.pages, ['2.0', 'custom', 'forge', 'hub', 'maya', 'nodata', 'trader', 'wiki']); // 'broken' has no status.html
      assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('compose-eta-')).length, 0, 'no tmp dir left behind');
    }],
  ];
  for (const [name, setup, check] of DATA_ROWS) test(name, async () => { setup(); await check(); });
});
