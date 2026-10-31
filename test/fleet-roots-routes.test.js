/**
 * COMP-COCKPIT-FLEET-PROJECTS-2: the PROJECTS list lives in the compose.json of the project the server STARTED on
 * (captured at mount), so a later project switch never moves it; GET /api/fleet/roots maps each known lane to its
 * Compose project root (defaults, overridden per lane by `fleet.roots`; a root counts only with a `.compose` dir).
 * Real routes on a loopback ephemeral port over the process fixture tree (known lanes: hub, main) and tmp project
 * roots; the switch is the server's own per-request binding (`withProjectContext`). Never the real compose.json.
 * One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachProcessRoutes, resolveProcessSources } from '../server/process-routes.js';
import { withProjectContext } from '../server/project-root.js';

const FIX = fileURLToPath(new URL('./fixtures/process/', import.meta.url));
const LOCAL = { host: '127.0.0.1' };

function request(port, { method = 'GET', path, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: {
      ...LOCAL, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const cfg = (fleet) => `${JSON.stringify({ version: 2, ...(fleet ? { fleet } : {}) }, null, 2)}\n`;

/**
 * Mounts the routes while `boot` is the bound project (no projectRoot injected: the production default), then serves
 * every request inside `other`'s binding, as the workspace runtime does after a switch.
 */
async function withApp({ boot, other, defaultRoots }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-roots-'));
  try {
    cpSync(FIX, join(root, 'fix'), { recursive: true });
    const dirs = {};
    for (const [name, text] of Object.entries({ boot, other })) {
      dirs[name] = join(root, name);
      mkdirSync(join(dirs[name], '.compose'), { recursive: true });
      if (text !== undefined) writeFileSync(join(dirs[name], '.compose', 'compose.json'), text);
    }
    dirs.withCompose = join(root, 'with-compose');
    mkdirSync(join(dirs.withCompose, '.compose'), { recursive: true });
    dirs.noCompose = join(root, 'no-compose');
    mkdirSync(dirs.noCompose, { recursive: true });
    const sub = (v) => (typeof v === 'string' ? v.replace(/^<(\w+)>/, (_, k) => dirs[k]) : v);
    const env = { COMPOSE_OPS_STATUS_DIR: join(root, 'fix', 'out'), COMPOSE_PROCESS_QUEUES_DIR: join(root, 'fix', 'queues'), COMPOSE_PROCESS_EXTRA: '', COMPOSE_PROCESS_KPI_HISTORY: join(root, 'kpi-history.jsonl') };
    for (const name of ['boot', 'other']) {
      const file = join(dirs[name], '.compose', 'compose.json');
      try { writeFileSync(file, readFileSync(file, 'utf8').replace(/"<(\w+)>/g, (_, k) => `"${dirs[k]}`)); } catch { /* no file */ }
    }
    const app = express();
    const bootBinding = { targetRoot: dirs.boot, dataDir: join(dirs.boot, '.compose', 'data') };
    const otherBinding = { targetRoot: dirs.other, dataDir: join(dirs.other, '.compose', 'data') };
    app.use((_req, _res, next) => withProjectContext(otherBinding, next));
    withProjectContext(bootBinding, () => attachProcessRoutes(app, {
      env, sources: resolveProcessSources(env), warn: () => {}, info: () => {},
      defaultRoots: Object.fromEntries(Object.entries(defaultRoots ?? {}).map(([k, v]) => [k, sub(v)])),
    }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const read = (name) => { try { return JSON.parse(readFileSync(join(dirs[name], '.compose', 'compose.json'), 'utf8')); } catch { return null; } };
    try { await fn({ port: server.address().port, read, dirs }); } finally { server.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// [name, setup, check]
const ROWS = [
  ['the saved order is read from the boot project after a switch (the old key, migrated in place)',
    { boot: cfg({ projects: ['main', 'hub'] }), other: cfg({ projects: ['hub'] }) },
    async ({ port }) => {
      const env = await request(port, { path: '/api/process' });
      assert.deepEqual(env.json.fleet, { known: ['hub', 'main'], projects: ['main', 'hub'], error: null });
    }],
  ['a save after a switch writes the boot project and leaves the active one untouched',
    { boot: cfg(null), other: cfg(null) },
    async ({ port, read }) => {
      const res = await request(port, { method: 'POST', path: '/api/fleet/projects', body: { projects: ['main', 'hub'] } });
      assert.equal(res.status, 200);
      assert.deepEqual([read('boot').fleet.projects, read('other').fleet], [['main', 'hub'], undefined]);
    }],
  ['roots: a default counts only while its .compose is a directory; a lane with no default has none',
    { boot: cfg(null), defaultRoots: { hub: '<withCompose>' } },
    async ({ port, dirs }) => {
      const res = await request(port, { path: '/api/fleet/roots' });
      assert.deepEqual(res.json, { roots: { hub: { root: dirs.withCompose, hasCompose: true }, main: { root: null, hasCompose: false } }, error: null });
    }],
  ['roots: fleet.roots in the boot project overrides per lane (a path, or null for none), not the active project',
    { boot: cfg({ roots: { hub: null, main: '<noCompose>' } }), other: cfg({ roots: { hub: '<withCompose>' } }), defaultRoots: { hub: '<withCompose>' } },
    async ({ port, dirs }) => {
      const res = await request(port, { path: '/api/fleet/roots' });
      assert.deepEqual(res.json, { roots: { hub: { root: null, hasCompose: false }, main: { root: dirs.noCompose, hasCompose: false } }, error: null });
    }],
  ['roots: a malformed fleet.roots is ignored whole and named in error; defaults still apply',
    { boot: cfg({ roots: ['hub'] }), defaultRoots: { hub: '<withCompose>' } },
    async ({ port, dirs }) => {
      const res = await request(port, { path: '/api/fleet/roots' });
      assert.deepEqual(res.json, { roots: { hub: { root: dirs.withCompose, hasCompose: true }, main: { root: null, hasCompose: false } }, error: 'fleet.roots must map lane names to a path or null' });
    }],
  ['a saved order keeps fleet.roots beside it (one-level merge)',
    { boot: cfg({ roots: { main: '<withCompose>' } }) },
    async ({ port, read, dirs }) => {
      await request(port, { method: 'POST', path: '/api/fleet/projects', body: { projects: ['hub'] } });
      assert.deepEqual(read('boot').fleet, { roots: { main: dirs.withCompose }, projects: ['hub'] });
    }],
];

describe('COMP-COCKPIT-FLEET-PROJECTS-2 pinned list and lane roots', () => {
  for (const [name, setup, check] of ROWS) it(name, () => withApp(setup, check));
});
