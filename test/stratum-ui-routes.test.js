/** COMPOSE-STRAT-TAB-1: /api/stratum-ui mount (real sibling handler, scratch flows dir, loopback ephemeral port). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachStratumUiRoutes } from '../server/stratum-ui-routes.js';
import { resolveStratumUiDir } from '../lib/stratum-ui-link.js';
import { resolveStratumEngineDist } from '../server/stratum-spec-routes.js';

const uiDir = resolveStratumUiDir();

async function withApp(opts, fn) {
  const app = express();
  const mounted = await attachStratumUiRoutes(app, opts);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`, mounted); } finally { server.close(); }
}

describe('attachStratumUiRoutes', () => {
  it('mounts nothing when the sibling is absent or in remote mode', async () => {
    await withApp({ uiDir: null }, async (base, mounted) => {
      assert.equal(mounted, false);
      assert.equal((await fetch(`${base}/api/stratum-ui/available`)).status, 404);
    });
    if (uiDir) await withApp({ uiDir, remote: true }, async (_b, mounted) => assert.equal(mounted, false));
  });

  it('serves runs, gate refusals and the availability probe', { skip: !uiDir }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-ui-routes-'));
    try {
      await withApp({ uiDir, env: { STRATUM_STATE_ROOT: dir } }, async (base) => {
        assert.deepEqual(await (await fetch(`${base}/api/stratum-ui/available`)).json(), { available: true });
        assert.deepEqual(await (await fetch(`${base}/api/stratum-ui/runs`)).json(), []);
        assert.equal((await fetch(`${base}/api/stratum-ui/runs/nope`)).status, 404);
        const noToken = await fetch(`${base}/api/stratum-ui/gates/r1/s/approve`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        assert.equal(noToken.status, 400);
        assert.equal((await noToken.json()).code, 'BAD_REQUEST');
        // COMP-SUBAPP-STRAT-AUTHOR-1: /specs is not the package's; it falls through (no spec routes attached here).
        // Express's own 404 page (HTML), not the package handler's JSON 404.
        const specs = await fetch(`${base}/api/stratum-ui/specs`);
        assert.equal(specs.status, 404);
        assert.match(specs.headers.get('content-type') ?? '', /text\/html/);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// COMP-SUBAPP-STRAT-AUTHOR-1: with a built engine the builder's validate answers (it was 501 with no engineDist).
describe('attachStratumUiRoutes engineDist', () => {
  const engineDist = resolveStratumEngineDist();
  it('validate answers from the engine, and 501 without one', { skip: !(uiDir && engineDist) }, async () => {
    const dir = mkdtempSync(join(process.env.COMPOSE_TEST_SCRATCH || tmpdir(), 'stratum-ui-routes-engine-'));
    const post = (base) => fetch(`${base}/api/stratum-ui/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: { version: 1 } }) });
    try {
      await withApp({ uiDir, engineDist, env: { STRATUM_STATE_ROOT: dir } }, async (base) => {
        const res = await post(base);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'invalid');
        assert.ok(body.errors.length > 0);
      });
      await withApp({ uiDir, engineDist: null, env: { STRATUM_STATE_ROOT: dir } }, async (base) => assert.equal((await post(base)).status, 501));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

