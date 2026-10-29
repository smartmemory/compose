/** COMPOSE-STRAT-TAB-1: /api/stratum-ui mount (real sibling handler, scratch flows dir, loopback ephemeral port). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachStratumUiRoutes } from '../server/stratum-ui-routes.js';
import { resolveStratumUiDir } from '../lib/stratum-ui-link.js';

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
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
