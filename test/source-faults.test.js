/**
 * COMP-COCKPIT-SOURCE-FAULTS-1, the producer side: each unit-index fault reaches the index (and logs one WARNING),
 * and the ops-status data route turns an index fault into an error, never zero landings (UNIT-INDEX M1-M3, L1,
 * INIT-DATA M1-M3). The route handler is called directly on a fake app; no port, no live source.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { buildUnitIndex } from '../lib/unit-index.js';
import { attachOpsStatusRoutes, createEtaReader, laneFault, estimateWarnings } from '../server/ops-status-routes.js';
import { attachUnitIndexRoutes } from '../server/unit-index-routes.js';

const NOW = Date.parse('2026-11-03T04:00:00Z');
let root;
const logger = () => { const lines = []; const fn = (l) => lines.push(l); fn.lines = lines; return fn; };
const write = (p, body) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)); };

before(() => { root = mkdtempSync(join(tmpdir(), 'source-faults-')); });
after(() => { chmodSync(join(root, 'locked'), 0o755); rmSync(root, { recursive: true, force: true }); });

describe('unit index producer faults', () => {
  test('M1: an unlistable queue dir is an index error, extras still read, one WARNING', async () => {
    const locked = join(root, 'locked');
    mkdirSync(locked);
    write(join(locked, 'f-units.json'), { units: [] });
    chmodSync(locked, 0o000);
    const extra = join(root, 'extra-units.json');
    write(extra, { units: [{ id: 'EXTRA', landed_at: '2026-11-03T03:00:00Z' }] });
    const warn = logger();
    const idx = await buildUnitIndex({ queuesDir: locked, extra: [['forge', extra]], now: NOW, warn });
    assert.equal(idx.error, 'queues dir unreadable (EACCES)');
    assert.deepEqual(idx.units.map((u) => u.id), ['EXTRA']);
    assert.equal(warn.lines.length, 1);
    assert.match(warn.lines[0], /^\[unit-index\] WARNING queues dir unreadable \(EACCES\): lanes in it are missing/);
    await buildUnitIndex({ queuesDir: locked, extra: [['forge', extra]], now: NOW, warn });
    assert.equal(warn.lines.length, 1, 'a fault that persists across rebuilds logs once');
  });

  test('M1: a missing queue dir is a warning, not an error; no queue dir configured is quiet', async () => {
    const warn = logger();
    const idx = await buildUnitIndex({ queuesDir: join(root, 'missing'), now: NOW, warn });
    assert.equal(idx.error, null);
    assert.deepEqual(idx.warnings, ['queues dir not found']);
    assert.equal(warn.lines.length, 1);
    const quiet = logger();
    const none = await buildUnitIndex({ queuesDir: null, now: NOW, warn: quiet });
    assert.deepEqual([none.error, none.warnings, quiet.lines], [null, [], []]);
  });

  test('M2: rows dropped as not objects reach coverage as a lane warning', async () => {
    const q = join(root, 'q2');
    write(join(q, 'f-units.json'), { units: [null, 42, { id: 'A', landed_at: '2026-11-03T03:00:00Z' }] });
    const warn = logger();
    const idx = await buildUnitIndex({ queuesDir: q, now: NOW, warn });
    assert.deepEqual(idx.units.map((u) => u.id), ['A']);
    assert.deepEqual(idx.coverage.f.warnings, ['2 rows skipped (not an object)']);
    assert.deepEqual(warn.lines, ['[unit-index] WARNING f: 2 rows skipped (not an object)']);
  });

  test('M3: a configured glossary that fails is a lane warning; a missing config stays quiet', async () => {
    const q = join(root, 'q3');
    const status = join(root, 'status3');
    write(join(q, 'f-units.json'), { units: [{ id: 'A' }] });
    write(join(q, 'g-units.json'), { units: [{ id: 'B' }] });
    write(join(status, 'configs', 'f.json'), { glossary: 'glossary.json' });
    write(join(status, 'glossary.json'), '{broken');
    const warn = logger();
    const idx = await buildUnitIndex({ queuesDir: q, statusRoot: status, now: NOW, warn });
    assert.deepEqual(idx.coverage.f.warnings, ['glossary not JSON']);
    assert.equal(idx.coverage.g.warnings, undefined, 'lane g has no config: quiet');
    assert.deepEqual(warn.lines, ['[unit-index] WARNING f: glossary not JSON']);
    write(join(status, 'glossary.json'), { A: 'Plain A' });
    const fixed = await buildUnitIndex({ queuesDir: q, statusRoot: status, now: NOW, warn });
    assert.equal(fixed.coverage.f.warnings, undefined);
    assert.equal(fixed.units.find((u) => u.id === 'A').titleSource, 'glossary');
  });

  test('L1: a landing in the future is not a landing in the last 48 h', async () => {
    const q = join(root, 'q4');
    write(join(q, 'f-units.json'), { units: [{ id: 'F', landed_at: '2027-01-01T00:00:00Z' }, { id: 'R', landed_at: '2026-11-03T03:00:00Z' }] });
    const idx = await buildUnitIndex({ queuesDir: q, now: NOW, warn: logger() });
    assert.equal(idx.coverage.f.n, 1);
    assert.equal(idx.coverage.f.pct.landed, 100);
  });

  test('the /api/units/index route passes error and warnings through', async () => {
    const routes = {};
    const app = { get: (p, h) => { routes[p] = h; } };
    attachUnitIndexRoutes(app, { sources: { queuesDir: join(root, 'missing'), extra: [], statusDir: join(root, 'x', 'out') }, env: {}, warn: () => {}, info: () => {} });
    let body;
    await routes['/api/units/index']({ query: {} }, { set() {}, json: (b) => { body = b; }, status() { return this; } });
    assert.deepEqual([body.error, body.warnings], [null, ['queues dir not found']]);
  });
});

describe('ops-status data route (INIT-DATA M1-M3)', () => {
  function mount(loadUnitIndex, eta = async () => ({ p50: '1h', p80: '2h', asOf: 'x' })) {
    const dir = mkdtempSync(join(root, 'ops-'));
    write(join(dir, 'forge', 'data.json'), { as_of: '2026-11-03', units: [{ id: 'A', deps: [] }] });
    write(join(dir, 'forge', 'status.html'), '<p>x</p>');
    const routes = {};
    const app = { get: (p, h) => { routes[p] = h; }, use() {} };
    assert.equal(attachOpsStatusRoutes(app, { dir, deps: { loadUnitIndex, eta } }), true);
    return async () => {
      let body;
      await routes['/api/ops-status/:name/data']({ params: { name: 'forge' } }, { set() {}, json: (b) => { body = b; }, status() { return this; } });
      return body;
    };
  }

  test('M1: a lane coverage error, an unlistable queue dir or no stamp file is a progress error, never zero landed', async () => {
    for (const [index, want] of [
      [{ units: [], coverage: { forge: { error: 'forge: not JSON' } } }, 'stamps unreadable: forge: not JSON'],
      [{ units: [], coverage: {}, error: 'queues dir unreadable (EACCES)' }, 'stamps unreadable: queues dir unreadable (EACCES)'],
      [{ units: [], coverage: {} }, 'stamps unreadable: no stamp file for lane forge'],
    ]) {
      const body = await mount(async () => index)();
      assert.equal(body.progress, null);
      assert.equal(body.progressError, want);
      assert.equal(body.eta, null);
    }
    assert.equal(laneFault({ coverage: { forge: { n: 0, pct: {} } } }, 'forge'), null);
  });

  test('M1: the real loader on a corrupt lane file reaches the route as an error', async () => {
    const q = join(root, 'q5');
    write(join(q, 'forge-units.json'), '{');
    const body = await mount(() => buildUnitIndex({ queuesDir: q, now: NOW, warn: () => {} }))();
    assert.equal(body.progress, null);
    assert.equal(body.progressError, 'stamps unreadable: forge: not JSON');
  });

  test('lane warnings travel as progressWarnings beside a good count', async () => {
    const body = await mount(async () => ({ units: [{ id: 'A', lane: 'forge', landedAt: '2026-11-03T03:00:00Z' }], coverage: { forge: { n: 1, pct: {}, warnings: ['2 rows skipped (not an object)'] } } }))();
    assert.equal(body.progress.landed, 1);
    assert.deepEqual(body.progressWarnings, ['2 rows skipped (not an object)']);
  });

  test('M2: estimator WARNING lines on the success path are returned as eta.warnings and logged', async () => {
    const warn = logger();
    const run = async () => ({ code: 0, stdout: 'ESTIMATE forge P50 2h P80 3h as_of 2026-11-03\n', stderr: `noise\nWARNING SYNTHETIC: author job unavailable in ${homedir()}/x, fell back to stamp\n` });
    const eta = createEtaReader({ script: '/x/estimate.py', run, warn });
    const out = await eta('forge', [{ id: 'A', deps: [] }]);
    assert.equal(out.p50, '2h');
    assert.deepEqual(out.warnings, ['WARNING SYNTHETIC: author job unavailable in ~/x, fell back to stamp']);
    assert.equal(warn.lines.length, 1);
    assert.ok(!warn.lines[0].includes(homedir()));
    assert.deepEqual(estimateWarnings(''), []);
  });

  test('M3: an estimator failure names no home path in eta.error or the log', async () => {
    const warn = logger();
    const run = async () => { throw new Error(`exit 1: can't open file '${homedir()}/.claude/scripts/estimate.py'`); };
    const eta = createEtaReader({ script: '/x/estimate.py', run, warn });
    const out = await eta('forge', [{ id: 'A', deps: [] }]);
    assert.match(out.error, /~\/\.claude\/scripts\/estimate\.py/);
    assert.ok(!out.error.includes(homedir()));
    assert.ok(warn.lines.every((l) => !l.includes(homedir())));
  });
});
