/**
 * COMP-COCKPIT-FLEET-PROJECTS-1: POST /api/fleet/projects writes `fleet.projects` into the active project's
 * `.compose/compose.json`, and GET /api/process reads it back in its `fleet` block. Real route on a loopback ephemeral
 * port over the process fixture tree (known lanes: hub, main) and a tmp project root; never the real compose.json.
 * One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachProcessRoutes, resolveProcessSources } from '../server/process-routes.js';

const FIX = fileURLToPath(new URL('./fixtures/process/', import.meta.url));
const LOCAL = { host: '127.0.0.1' };

function request(port, { method = 'GET', path = '/api/fleet/projects', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: {
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers,
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

async function withApp(initial, fn) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-projects-'));
  cpSync(FIX, join(root, 'fix'), { recursive: true });
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.compose'), { recursive: true });
  const file = join(proj, '.compose', 'compose.json');
  if (initial !== undefined) writeFileSync(file, initial);
  const env = { COMPOSE_OPS_STATUS_DIR: join(root, 'fix', 'out'), COMPOSE_PROCESS_QUEUES_DIR: join(root, 'fix', 'queues'), COMPOSE_PROCESS_EXTRA: '', COMPOSE_PROCESS_KPI_HISTORY: join(root, 'kpi-history.jsonl') };
  const app = express();
  attachProcessRoutes(app, { env, sources: resolveProcessSources(env), warn: () => {}, info: () => {}, projectRoot: () => proj });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const read = () => readFileSync(file, 'utf8');
  try { await fn({ port, read, proj }); } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
}

const cfg = (projects, extra = {}) => `${JSON.stringify({ version: 2, ...extra, ...(projects ? { fleet: { projects } } : {}) }, null, 2)}\n`;

// [name, initial compose.json text (undefined = no file), request, expected status, check]
const ROWS = [
  ['order saved: a reorder is written and GET /api/process reads it back', cfg(null), { body: { projects: ['main', 'hub'] }, headers: LOCAL }, 200,
    async ({ port, read }) => {
      assert.deepEqual(JSON.parse(read()).fleet.projects, ['main', 'hub']);
      const env = await request(port, { path: '/api/process', headers: LOCAL });
      assert.deepEqual(env.json.fleet, { known: ['hub', 'main'], projects: ['main', 'hub'], error: null });
    }],
  ['add: a hidden lane joins the saved list', cfg(['hub']), { body: { projects: ['hub', 'main'] }, headers: LOCAL }, 200,
    ({ read }) => assert.deepEqual(JSON.parse(read()).fleet.projects, ['hub', 'main'])],
  ['remove: a lane leaves the saved list', cfg(['hub', 'main']), { body: { projects: ['main'] }, headers: LOCAL }, 200,
    ({ read }) => assert.deepEqual(JSON.parse(read()).fleet.projects, ['main'])],
  ['unknown name: 400, file untouched', cfg(['hub']), { body: { projects: ['hub', 'nope'] }, headers: LOCAL }, 400,
    ({ read }) => assert.equal(read(), cfg(['hub']))],
  ['path-like name: 400, file untouched', cfg(['hub']), { body: { projects: ['../../etc'] }, headers: LOCAL }, 400,
    ({ read }) => assert.equal(read(), cfg(['hub']))],
  ['duplicate: 400, file untouched', cfg(['hub']), { body: { projects: ['hub', 'hub'] }, headers: LOCAL }, 400,
    ({ read }) => assert.equal(read(), cfg(['hub']))],
  ['bad body (not a list): 400', cfg(['hub']), { body: { projects: 'hub' }, headers: LOCAL }, 400,
    ({ read }) => assert.equal(read(), cfg(['hub']))],
  ['non-loopback Host: 403, file untouched', cfg(['hub']), { body: { projects: ['main'] }, headers: { host: 'evil.example:4001' } }, 403,
    ({ read }) => assert.equal(read(), cfg(['hub']))],
  ['non-loopback Origin: 403, file untouched', cfg(['hub']), { body: { projects: ['main'] }, headers: { ...LOCAL, origin: 'http://evil.example' } }, 403,
    ({ read }) => assert.equal(read(), cfg(['hub']))],
  ['unknown keys preserved: other top-level keys, other fleet keys, 2-space format and trailing newline kept',
    `${JSON.stringify({ version: 2, wiki: { workspace: 'w', tokenEnv: 'X' }, fleet: { other: true, projects: ['hub'] }, z: [1, 2] }, null, 2)}\n`,
    { body: { projects: ['main'] }, headers: LOCAL }, 200,
    ({ read, proj }) => {
      assert.equal(read(), `${JSON.stringify({ version: 2, wiki: { workspace: 'w', tokenEnv: 'X' }, fleet: { other: true, projects: ['main'] }, z: [1, 2] }, null, 2)}\n`);
      assert.deepEqual(readdirSync(join(proj, '.compose')), ['compose.json'], 'no temp file left behind');
    }],
  ['malformed compose.json: 409, never overwritten', '{ not json', { body: { projects: ['main'] }, headers: LOCAL }, 409,
    ({ read }) => assert.equal(read(), '{ not json')],
  ['no key: GET /api/process reports projects null (view behaves as before)', cfg(null), { method: 'GET', path: '/api/process', headers: LOCAL }, 200,
    async ({ port }) => {
      const env = await request(port, { path: '/api/process', headers: LOCAL });
      assert.deepEqual(env.json.fleet, { known: ['hub', 'main'], projects: null, error: null });
    }],
];

describe('COMP-COCKPIT-FLEET-PROJECTS-1 fleet.projects routes', () => {
  for (const [name, initial, req, status, check] of ROWS) {
    it(name, () => withApp(initial, async (ctx) => {
      const res = await request(ctx.port, { method: 'POST', ...req });
      assert.equal(res.status, status, JSON.stringify(res.json));
      await check(ctx);
    }));
  }
});
