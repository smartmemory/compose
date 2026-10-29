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
