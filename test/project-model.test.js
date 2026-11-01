/**
 * COMP-COCKPIT-PROJECT-MODEL-1: the project model reader (server/project-model.js), the Q1 seed rule
 * (server/feature-scan.js seedFeatures never re-adds a code a configured module store owns) and the Q1 cleanup plan.
 * Every row runs on a throwaway world (test/helpers/project-world.js), never the real roots. One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, item } from './helpers/project-world.js';
import { moduleOwnedCodes, planRootPrune, readProjects, readComposeConfig, fleetRootsFromModel } from '../server/project-model.js';
import { seedFeatures } from '../server/feature-scan.js';
import { VisionStore } from '../server/vision-store.js';
import { withProjectContext } from '../server/project-root.js';

const KNOWN = ['main', 'hub', 'forge', 'cadence', 'codegen', 'trader', 'orphan'];
const feature = (name) => ({ name, description: '', status: 'planned', phase: 'planning', confidence: 0, artifacts: [], relatedFeatures: [], predecessors: [], successors: [] });

const ROWS = [
  ['three projects, lanes and modules as configured', (w) => {
    const m = readProjects(w.host, KNOWN);
    assert.equal(m.configured, true);
    assert.deepEqual(m.projects.map((p) => [p.name, p.lanes.length, p.modules.length]), [['smartmemory', 2, 0], ['forge', 4, 4], ['trader', 1, 0]]);
    const forge = m.projects[1];
    assert.deepEqual(forge.modules.map((x) => [x.name, x.hasStore]), [['compose', true], ['stratum', true], ['cadence', true], ['choir', false]]);
    assert.deepEqual(forge.lanes.map((l) => l.opsLane), ['forge', 'forge', 'cadence', 'codegen']);
    assert.equal(m.projects[2].hasStore, false);
    assert.deepEqual(m.projects.flatMap((p) => p.errors), []);
  }],
  ['every known lane maps to one project; an unclaimed one is unassigned', (w) => {
    const m = readProjects(w.host, KNOWN);
    assert.deepEqual(m.laneIndex.forge, { project: 'forge', label: 'Forge', laneIds: ['compose', 'stratum'], modules: ['compose', 'stratum'] });
    assert.equal(m.laneIndex.codegen.project, 'forge');
    assert.deepEqual(m.unassigned, ['orphan']);
  }],
  ['projects.roots absent: not configured, every lane unassigned (legacy fleet path)', (w) => {
    w.cfg(w.host, { version: 2 });
    const m = readProjects(w.host, KNOWN);
    assert.equal(m.configured, false);
    assert.deepEqual(m.unassigned, KNOWN);
  }],
  ['a module realpath claimed twice: the later claim errors visibly and has no store', (w) => {
    const sm = readComposeConfig(w.sm).config;
    sm.project.modules = [{ name: 'cad', path: 'cadence' }]; // the symlink: realpath is forge/cadence
    w.cfg(w.sm, sm);
    w.cfg(w.host, { version: 2, projects: { roots: [w.forge, w.sm] } });
    const m = readProjects(w.host, KNOWN);
    const cad = m.projects[1].modules[0];
    assert.match(cad.error, /already claimed by forge\/cadence/);
    assert.equal(cad.hasStore, false);
    assert.ok(m.projects[1].errors.some((e) => e.includes('already claimed')));
  }],
  ['the cadence symlink inside SmartMemory makes no duplicate module', (w) => {
    const m = readProjects(w.host, KNOWN);
    assert.deepEqual(m.projects.flatMap((p) => p.modules).filter((x) => x.realpath === w.cadence).map((x) => x.name), ['cadence']);
  }],
  ['a module with capabilities.lifecycle:false has no store', (w) => {
    w.cfg(w.cadence, { version: 2, capabilities: { lifecycle: false } });
    const cad = readProjects(w.host, KNOWN).projects[1].modules.find((x) => x.name === 'cadence');
    assert.equal(cad.hasStore, false);
    assert.equal(cad.lifecycle, false);
  }],
  ['an ops lane claimed by two projects errors on the later one', (w) => {
    w.cfg(w.trader, { version: 2, project: { name: 'trader', lanes: [{ id: 'trader' }, { id: 'x', opsLane: 'forge' }], modules: [] } });
    const m = readProjects(w.host, KNOWN);
    assert.equal(m.laneIndex.forge.project, 'forge');
    assert.ok(m.projects[2].errors.some((e) => e.includes('"forge"') && e.includes('already claimed by project forge')));
  }],
  ['a root with no project key shows under its folder name with the error', (w) => {
    w.cfg(w.trader, { version: 2 });
    const t = readProjects(w.host, KNOWN).projects[2];
    assert.equal(t.name, 'trader');
    assert.deepEqual(t.lanes, []);
    assert.match(t.errors[0], /no "project" key/);
  }],
  ['a lane naming a module the project does not list errors', (w) => {
    w.cfg(w.trader, { version: 2, project: { name: 'trader', lanes: [{ id: 'trader', module: 'nope' }], modules: [] } });
    const t = readProjects(w.host, KNOWN).projects[2];
    assert.equal(t.lanes[0].module, null);
    assert.match(t.errors[0], /names module "nope"/);
  }],
  ['fleet roots derived from the model: a lane opens its first module, else the project root', (w) => {
    const r = fleetRootsFromModel(readProjects(w.host, KNOWN), ['forge', 'main', 'orphan']);
    assert.deepEqual(r.forge, { root: w.compose, hasCompose: true });
    assert.deepEqual(r.main, { root: w.sm, hasCompose: true });
    assert.deepEqual(r.orphan, { root: null, hasCompose: false });
  }],
  ['moduleOwnedCodes: every code any module store of the root holds', (w) => {
    assert.deepEqual([...moduleOwnedCodes(w.forge, readComposeConfig(w.forge).config)].sort(), ['CAD-1', 'COMP-2', 'ENG-5', 'SHARED-1']);
    assert.equal(moduleOwnedCodes(w.sm, readComposeConfig(w.sm).config).size, 0);
  }],
  ['Q1: a rescan of the root seeds no module-owned code and leaves a held item untouched', (w) => {
    const dataDir = join(w.forge, '.compose', 'data');
    const before = JSON.parse(readFileSync(join(dataDir, 'vision-state.json'), 'utf8'));
    const store = new VisionStore(dataDir);
    store.deleteItem('r2'); // SHARED-1 pruned; ENG-5 (r3) stays as a held item
    const binding = { targetRoot: w.forge, dataDir, config: readComposeConfig(w.forge).config };
    const seeded = withProjectContext(binding, () => seedFeatures(['ROOT-1', 'SHARED-1', 'ENG-5', 'COMP-2', 'NEW-1'].map(feature), store));
    assert.equal(seeded.moduleOwned, 3);
    assert.equal(seeded.features, 1); // NEW-1 only
    const codes = [...store.items.values()].map((i) => i.lifecycle?.featureCode).filter(Boolean).sort();
    assert.deepEqual(codes, ['ENG-5', 'NEW-1', 'ROOT-1']);
    const r3 = before.items.find((i) => i.id === 'r3');
    assert.equal(store.items.get('r3').status, r3.status);
  }],
  ['Q1 prune plan: a shared code with no unique edge is removed, one with an edge no module has is held', (w) => {
    const read = (dir) => JSON.parse(readFileSync(join(dir, '.compose', 'data', 'vision-state.json'), 'utf8'));
    const root = read(w.forge);
    root.items.push(item('r4', 'COMP-2'));
    root.connections.push({ id: 'rc2', fromId: 'r4', toId: 'r2', type: 'informs' }); // twin of compose cc1 (reversed informs)
    const plan = planRootPrune(root, { compose: read(w.compose), stratum: read(w.stratum), cadence: read(w.cadence) });
    assert.deepEqual(plan.remove.map((r) => r.code).sort(), ['COMP-2', 'ENG-5']);
    assert.deepEqual(plan.hold.map((h) => h.code), ['SHARED-1']);
    assert.match(plan.hold[0].reasons[0], /ROOT-1 -informs-> SHARED-1 has no module twin/);
    assert.equal(plan.rootOnly, 1);
    assert.deepEqual(plan.remove.find((r) => r.code === 'ENG-5').owners, ['compose', 'stratum']);
  }],
  ['the model reads only: no store file changes', (w) => {
    const files = [w.forge, w.compose, w.stratum, w.cadence, w.sm].map((d) => join(d, '.compose', 'data', 'vision-state.json'));
    const before = files.map((f) => statSync(f).mtimeMs);
    readProjects(w.host, KNOWN);
    moduleOwnedCodes(w.forge, readComposeConfig(w.forge).config);
    assert.deepEqual(files.map((f) => statSync(f).mtimeMs), before);
  }],
];

describe('project model (COMP-COCKPIT-PROJECT-MODEL-1)', () => {
  for (const [name, fn] of ROWS) {
    it(name, () => {
      const w = makeWorld();
      try { fn(w); } finally { w.cleanup(); }
    });
  }
});

