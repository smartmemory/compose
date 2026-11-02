/**
 * COMP-SUBAPP-STRAT-AUTHOR-1: `/api/stratum-ui/specs`, the flow builder's Save / Open. Real engine
 * (`resolveStratumEngineDist`), a throwaway workspace root (`COMPOSE_TEST_SCRATCH`, else the OS temp dir),
 * never the real `pipelines/`. Loopback port `COMPOSE_TEST_PORT` (a `port_check.py --reserve-test` port), else ephemeral.
 */
import { after, before, describe, it } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachStratumSpecRoutes, MARKER, resolveStratumEngineDist } from '../server/stratum-spec-routes.js';

const started = Date.now();
after(() => console.log(`# stratum-spec-routes wall ${Date.now() - started} ms`));

const engineDist = resolveStratumEngineDist();
const scratch = process.env.COMPOSE_TEST_SCRATCH || tmpdir();

/** A spec the engine accepts: one `set` step whose output feeds the flow output. */
const validSpec = () => ({
  version: 1,
  contracts: { Result: { summary: 'string' } },
  flows: {
    entry: 'main',
    main: {
      input: {},
      output: { from: '${set_1.output}', contract: 'Result' },
      steps: [{ id: 'set_1', set: { summary: 'yes' }, out: 'Result' }],
    },
  },
});

// One server for the file, the app behind it swapped per test: with a fixed port, a fresh server per test
// would meet fetch's pooled keep-alive socket to the previous (closed) one.
let current = (_req, res) => res.status(503).end();
let server;
before(async () => {
  server = await new Promise((r) => { const s = createServer((req, res) => current(req, res)).listen(Number(process.env.COMPOSE_TEST_PORT) || 0, '127.0.0.1', () => r(s)); });
});
after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

async function withApp(root, fn, opts = {}) {
  const app = express();
  app.use(express.json());
  assert.equal(attachStratumSpecRoutes(app, { engineDist, rootFor: () => root, ...opts }), true);
  current = app;
  await fn(`http://127.0.0.1:${server.address().port}/api/stratum-ui/specs`);
}

const post = (url, body, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });

describe('stratum spec routes', { skip: !engineDist && 'no built Stratum engine' }, () => {
  const root = mkdtempSync(join(scratch, 'stratum-spec-routes-'));
  const pipelines = join(root, 'pipelines');
  const listPipelines = () => { try { return readdirSync(pipelines); } catch { return []; } };
  after(() => rmSync(root, { recursive: true, force: true }));

  it('the engine accepts the fixture spec (precondition)', async () => {
    const { validateSpec } = await import(new URL(`file://${join(engineDist, 'ir', 'validate.js')}`).href);
    assert.deepEqual(validateSpec(validSpec()).errors ?? [], []);
  });

  it('saves a new name, lists it, and reopens the same spec', async () => {
    await withApp(root, async (base) => {
      assert.deepEqual(await (await fetch(base)).json(), []);
      const res = await post(`${base}/smoke-one`, { spec: validSpec() });
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { ok: true, name: 'smoke-one', created: true });
      const text = readFileSync(join(pipelines, 'smoke-one.stratum.yaml'), 'utf8');
      assert.equal(text.split('\n')[0], MARKER);
      assert.deepEqual(await (await fetch(`${base}/smoke-one`)).json(), validSpec());
      const list = await (await fetch(base)).json();
      assert.deepEqual(list.map((r) => r.name), ['smoke-one']);
      // A second save of a builder file overwrites it.
      const again = validSpec();
      again.flows.main.steps[0].set.summary = 'no';
      const res2 = await post(`${base}/smoke-one`, { spec: again });
      assert.equal(res2.status, 200);
      assert.equal((await res2.json()).created, false);
      assert.deepEqual(await (await fetch(`${base}/smoke-one`)).json(), again);
      assert.deepEqual(readdirSync(pipelines).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
    });
  });

  it('refuses a bad name with 400', async () => {
    await withApp(root, async (base) => {
      for (const bad of ['Upper', '-lead', 'a_b', 'a'.repeat(65), 'a.b']) {
        const res = await post(`${base}/${encodeURIComponent(bad)}`, { spec: validSpec() });
        assert.equal(res.status, 400, bad);
        assert.equal((await res.json()).code, 'BAD_NAME');
      }
      assert.equal((await fetch(`${base}/Upper`)).status, 400);
    });
  });

  it('never overwrites a file the builder did not write: 409, bytes unchanged, not listed or read', async () => {
    mkdirSync(pipelines, { recursive: true });
    const handFile = join(pipelines, 'build.stratum.yaml');
    const original = 'version: 1\n# hand-written\nflows: {entry: main}\n';
    writeFileSync(handFile, original);
    await withApp(root, async (base) => {
      const res = await post(`${base}/build`, { spec: validSpec() });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.code, 'NOT_BUILDER_FILE');
      assert.match(body.message, /not written by the pipeline builder/);
      assert.equal(readFileSync(handFile, 'utf8'), original);
      assert.equal((await fetch(`${base}/build`)).status, 409);
      assert.ok(!(await (await fetch(base)).json()).some((r) => r.name === 'build'));
    });
  });

  it('refuses a NEW name a shipped pipeline owns (bundled, preset, init-provisioned) with 409 RESERVED_NAME, writing nothing', async () => {
    const fresh = mkdtempSync(join(scratch, 'stratum-spec-reserved-'));
    try {
      await withApp(fresh, async (base) => {
        for (const [name, kind] of [['research', 'bundled'], ['team-feature', 'preset'], ['build', 'init-provisioned']]) {
          const res = await post(`${base}/${name}`, { spec: validSpec() });
          assert.equal(res.status, 409, name);
          const body = await res.json();
          assert.equal(body.code, 'RESERVED_NAME', name);
          assert.match(body.message, new RegExp(`^${name} is the ${kind} pipeline at .*; pick another name$`), name);
          assert.equal(body.error, body.message);
        }
        assert.throws(() => readdirSync(join(fresh, 'pipelines')), /ENOENT/); // nothing created, not even the folder
        assert.equal((await post(`${base}/my-own-flow`, { spec: validSpec() })).status, 201); // an unowned name still saves
      });
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  });

  it('a marker file already under pipelines/ with a reserved name keeps saving', async () => {
    const fresh = mkdtempSync(join(scratch, 'stratum-spec-reserved-'));
    try {
      mkdirSync(join(fresh, 'pipelines'));
      writeFileSync(join(fresh, 'pipelines', 'research.stratum.yaml'), `${MARKER}\nversion: 1\n`);
      await withApp(fresh, async (base) => {
        const res = await post(`${base}/research`, { spec: validSpec() });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, name: 'research', created: false });
      });
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  });

  it('refuses an invalid spec with 422 and the engine errors, writing nothing', async () => {
    await withApp(root, async (base) => {
      const bad = validSpec();
      bad.flows.main.steps[0] = { id: 'do_1', do: '', agent: 'claude', after: ['nope'] };
      const res = await post(`${base}/smoke-bad`, { spec: bad });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.code, 'INVALID');
      assert.ok(body.errors.length > 0 && body.errors.every((e) => e.path && e.message));
      assert.ok(!listPipelines().some((f) => f.includes('smoke-bad')));
    });
  });

  it('refuses a non-JSON post (415) and a missing spec (400)', async () => {
    await withApp(root, async (base) => {
      assert.equal((await post(`${base}/smoke-x`, { spec: validSpec() }, 'text/plain')).status, 415);
      assert.equal((await post(`${base}/smoke-x`, {})).status, 400);
    });
  });

  it('without an engine, save is refused (501) and nothing is written', async () => {
    await withApp(root, async (base) => {
      const res = await post(`${base}/smoke-noengine`, { spec: validSpec() });
      assert.equal(res.status, 501);
      assert.equal((await res.json()).code, 'NO_ENGINE');
      assert.ok(!listPipelines().some((f) => f.includes('smoke-noengine')));
    }, { engineDist: null });
  });

  it('mounts nothing in remote mode', async () => {
    const app = express();
    assert.equal(attachStratumSpecRoutes(app, { remote: true, engineDist }), false);
  });
});

describe('resolveStratumEngineDist', () => {
  const root = mkdtempSync(join(scratch, 'stratum-engine-dist-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const touch = (dir) => { mkdirSync(join(dir, 'ir'), { recursive: true }); writeFileSync(join(dir, 'ir', 'validate.js'), ''); return dir; };
  const installed = join(root, 'installed');
  touch(join(installed, 'dist'));
  const sibling = touch(join(root, 'sibling', 'dist'));
  const missing = join(root, 'missing');
  const notInstalled = () => { const e = new Error('nope'); e.code = 'MODULE_NOT_FOUND'; throw e; };

  it('installed package first (the engine that runs builds)', () => {
    assert.equal(resolveStratumEngineDist({ requireResolve: () => join(installed, 'package.json'), siblingDirs: [sibling] }), join(installed, 'dist'));
  });
  it('else the sibling checkout', () => {
    assert.equal(resolveStratumEngineDist({ requireResolve: notInstalled, siblingDirs: [missing, sibling] }), sibling);
  });
  it('else null (validate/plan stay 501, save refused)', () => {
    assert.equal(resolveStratumEngineDist({ requireResolve: notInstalled, siblingDirs: [missing] }), null);
  });
});
