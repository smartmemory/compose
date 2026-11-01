/**
 * COMP-COCKPIT-PROJECT-MODEL-1: the read-time project graph merge (server/project-graph.js) and its routes
 * (`GET /api/projects`, `/api/projects/:name/graph`, `/api/projects/:name/doc`, and `/api/fleet/roots` + `/api/process`
 * `fleet` with and without `projects.roots`). Real routes on a loopback ephemeral port over the process fixture tree
 * (known lanes: hub, main) and a throwaway world (test/helpers/project-world.js). One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { item, makeWorld } from './helpers/project-world.js';
import { readProjects } from '../server/project-model.js';
import { buildProjectGraph, readProjectDoc } from '../server/project-graph.js';
import { attachProcessRoutes, resolveProcessSources } from '../server/process-routes.js';

const FIX = fileURLToPath(new URL('./fixtures/process/', import.meta.url));
const forgeOf = (w) => readProjects(w.host, []).projects.find((p) => p.name === 'forge');
const byCode = (g) => Object.fromEntries(g.items.filter((i) => i.lifecycle?.featureCode).map((i) => [i.lifecycle.featureCode, i]));

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    }).on('error', reject);
  });
}

async function withApp(w, fn) {
  const fix = mkdtempSync(join(tmpdir(), 'project-graph-fix-'));
  cpSync(FIX, fix, { recursive: true });
  const env = { COMPOSE_OPS_STATUS_DIR: join(fix, 'out'), COMPOSE_PROCESS_QUEUES_DIR: join(fix, 'queues'), COMPOSE_PROCESS_EXTRA: '', COMPOSE_PROCESS_KPI_HISTORY: join(fix, 'kpi.jsonl') };
  const app = express();
  attachProcessRoutes(app, { env, sources: resolveProcessSources(env), warn: () => {}, info: () => {}, projectRoot: () => w.host, defaultRoots: { main: w.sm } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { await fn(server.address().port); } finally { server.close(); rmSync(fix, { recursive: true, force: true }); }
}

const ROWS = [
  ['a shared code appears once, from its module; the root copy is dropped', (w) => {
    const g = buildProjectGraph(forgeOf(w));
    const c = byCode(g);
    assert.equal(c['SHARED-1'].module, 'compose');
    assert.equal(c['SHARED-1'].id, 'compose:c1');
    assert.equal(g.items.filter((i) => i.lifecycle?.featureCode === 'SHARED-1').length, 1);
    assert.equal(c['ROOT-1'].module, 'forge');
  }],
  ['between modules the one with the feature folder on disk wins (ENG-5 from stratum)', (w) => {
    const g = buildProjectGraph(forgeOf(w));
    assert.equal(byCode(g)['ENG-5'].module, 'stratum');
    assert.deepEqual(g.dropped.filter((d) => d.code === 'ENG-5').map((d) => d.from).sort(), ['compose', 'forge']);
  }],
  ['a dropped copy\'s edges re-point to the winner', (w) => {
    const g = buildProjectGraph(forgeOf(w));
    const ids = g.connections.map((c) => [c.fromId, c.toId, c.type]);
    assert.ok(ids.some(([f, t]) => f === 'forge:r1' && t === 'compose:c1'), 'root edge ROOT-1 -> SHARED-1 lands on the compose copy');
    assert.ok(ids.some(([f, t, ty]) => f === 'stratum:x1' && t === 'compose:c3' && ty === 'blocks'), 'compose ENG-5 edge lands on the stratum copy');
    assert.ok(g.connections.some((c) => c.type === 'informs'), 'informs edges survive the merge (GRAPH-EDGES dashed style)');
  }],
  ['a link names its far end by feature code: root -> module-only code, module -> root-only code, unknown code dropped', (w) => {
    w.store(w.forge, {
      items: [item('r1', 'ROOT-1'), { id: 't1', type: 'track', title: 'compose', status: 'in_progress' }],
      connections: [{ id: 'rx1', fromId: 'r1', toId: 'c3', toCode: 'COMP-2', type: 'informs' }, { id: 'rx2', fromId: 'r1', toId: 'zz', toCode: 'NOPE-9', type: 'informs' }],
    });
    w.store(w.compose, {
      items: [item('c3', 'COMP-2')],
      connections: [{ id: 'cx1', fromId: 'c3', toId: 'zz', toCode: 'ROOT-1', type: 'informs' }],
    });
    const g = buildProjectGraph(forgeOf(w));
    const ids = g.connections.map((c) => `${c.fromId}>${c.toId}`);
    assert.ok(ids.includes('forge:r1>compose:c3'), 'root link to a code only compose holds lands on the compose item');
    assert.ok(ids.includes('compose:c3>forge:r1'), 'compose link to a root-only code lands on the root item');
    assert.equal(g.connections.length, 2, 'the NOPE-9 link is dropped');
  }],
  ['a root track titled like a module is dropped; a module with no store contributes nothing', (w) => {
    const g = buildProjectGraph(forgeOf(w));
    assert.equal(g.items.some((i) => i.type === 'track' && i.title === 'compose'), false);
    assert.deepEqual(g.members.find((m) => m.name === 'choir'), { name: 'choir', root: w.choir, items: 0, skipped: 'no store' });
  }],
  ['a member with capabilities.lifecycle:false contributes no items', (w) => {
    w.cfg(w.cadence, { version: 2, capabilities: { lifecycle: false } });
    const g = buildProjectGraph(forgeOf(w));
    assert.equal(g.items.some((i) => i.module === 'cadence'), false);
    assert.equal(g.members.find((m) => m.name === 'cadence').skipped, 'lifecycle:false');
  }],
  ['lane focus: a lane with a module focuses it, an unknown lane focuses nothing', (w) => {
    assert.deepEqual(buildProjectGraph(forgeOf(w), { lane: 'stratum' }).focus, { lane: 'stratum', modules: ['stratum'] });
    assert.deepEqual(buildProjectGraph(forgeOf(w), { lane: 'nope' }).focus, { lane: null, modules: [] });
  }],
  ['DOC-LINKS: the doc is read from the owning module; an escaping path is refused', (w) => {
    const ok = readProjectDoc(forgeOf(w), 'compose:c1');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.path, join(w.compose, 'docs', 'features', 'SHARED-1', 'design.md'));
    assert.match(ok.body.text, /compose copy/);
    w.store(w.compose, { items: [{ id: 'c1', type: 'feature', title: 'SHARED-1', lifecycle: { featureCode: 'SHARED-1' }, files: ['../stratum/docs/features/ENG-5/design.md'] }] });
    assert.equal(readProjectDoc(forgeOf(w), 'compose:c1').status, 404);
  }],
  ['the merge reads only: every member store mtime is unchanged', (w) => {
    const files = [w.forge, w.compose, w.stratum, w.cadence].map((d) => join(d, '.compose', 'data', 'vision-state.json'));
    const before = files.map((f) => statSync(f).mtimeMs);
    buildProjectGraph(forgeOf(w), { lane: 'compose' });
    readProjectDoc(forgeOf(w), 'compose:c1');
    assert.deepEqual(files.map((f) => statSync(f).mtimeMs), before);
  }],
  ['GET /api/projects and /graph serve the model; a workspace header changes nothing; unknown is 404', async (w) => withApp(w, async (port) => {
    const list = await get(port, '/api/projects', { 'x-compose-workspace-id': 'bogus' });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.projects.map((p) => p.name), ['smartmemory', 'forge', 'trader']);
    assert.deepEqual(list.json.unassigned, []);
    const g = await get(port, '/api/projects/forge/graph?lane=compose');
    assert.equal(g.status, 200);
    assert.equal(byCode(g.json)['ENG-5'].module, 'stratum');
    assert.deepEqual(g.json.focus.modules, ['compose']);
    assert.equal((await get(port, '/api/projects/nope/graph')).status, 404);
    const doc = await get(port, `/api/projects/forge/doc?id=${encodeURIComponent('stratum:x1')}`);
    assert.equal(doc.json.module, 'stratum');
  })],
  ['with projects.roots: /api/fleet/roots comes from the model and /api/process fleet gains laneIndex', async (w) => withApp(w, async (port) => {
    const roots = await get(port, '/api/fleet/roots');
    assert.deepEqual(roots.json.roots.main, { root: w.sm, hasCompose: true });
    const proc = await get(port, '/api/process');
    assert.equal(proc.json.fleet.laneIndex.main.project, 'smartmemory');
    assert.equal(proc.json.fleet.laneIndex.main.label, 'SmartMemory', 'the Process chip label rides on laneIndex: no second read');
  })],
  ['without projects.roots: today\'s fleet payload, no laneIndex', async (w) => {
    w.cfg(w.host, { version: 2 });
    await withApp(w, async (port) => {
      const roots = await get(port, '/api/fleet/roots');
      assert.deepEqual(roots.json, { roots: { hub: { root: null, hasCompose: false }, main: { root: w.sm, hasCompose: true } }, error: null });
      const proc = await get(port, '/api/process');
      assert.equal('laneIndex' in proc.json.fleet, false);
      assert.deepEqual((await get(port, '/api/projects')).json.projects, []);
    });
  }],
];

describe('project graph (COMP-COCKPIT-PROJECT-MODEL-1)', () => {
  for (const [name, fn] of ROWS) {
    it(name, async () => {
      const w = makeWorld();
      try { await fn(w); } finally { w.cleanup(); }
    });
  }
});
