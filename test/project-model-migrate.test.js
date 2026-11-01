/**
 * COMP-COCKPIT-PROJECT-MODEL-1: the config migration (scripts/project-model-migrate.mjs). Throwaway host, roots and
 * backup dir; never the real configs. One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigration, planMigration, rollbackMigration } from '../scripts/project-model-migrate.mjs';

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pm-migrate-')));
  const d = { base, host: join(base, 'host'), a: join(base, 'a'), b: join(base, 'b'), backup: join(base, 'backup') };
  const put = (dir, text) => { mkdirSync(join(dir, '.compose'), { recursive: true }); writeFileSync(join(dir, '.compose', 'compose.json'), text); };
  // Odd spacing on purpose: rollback must restore the bytes, not a re-serialisation.
  put(d.host, '{"version": 2,  "fleet": {"projects": ["lb", "la1", "la2"]}, "keep": {"x": 1}}');
  put(d.a, '{\n  "version": 2,\n  "paths": {"docs": "docs"}\n}\n');
  mkdirSync(d.b, { recursive: true }); // no .compose: the migration creates it from the skeleton
  const seed = [
    { root: d.a, project: { name: 'pa', label: 'A', lanes: [{ id: 'la1' }, { id: 'la2' }], modules: [] } },
    { root: d.b, project: { name: 'pb', label: 'B', lanes: [{ id: 'lb' }], modules: [] }, skeleton: { version: 2, paths: { features: 'docs/features' } } },
  ];
  return { ...d, seed, read: (dir) => readFileSync(join(dir, '.compose', 'compose.json'), 'utf8'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ROWS = [
  ['dry run plans every file and writes none', (w) => {
    const before = w.read(w.host);
    const steps = planMigration({ host: w.host, seed: w.seed });
    assert.deepEqual(steps.map((s) => s.changed), [true, true, true]);
    assert.equal(w.read(w.host), before);
    assert.equal(existsSync(join(w.b, '.compose')), false);
  }],
  ['--write: projects.roots ordered by first lane in fleet.projects, unknown keys kept, missing config created', (w) => {
    applyMigration({ host: w.host, seed: w.seed, backupDir: w.backup, date: 'D' });
    const host = JSON.parse(w.read(w.host));
    assert.deepEqual(host.projects.roots, [w.b, w.a]);
    assert.deepEqual(host.keep, { x: 1 });
    assert.deepEqual(host.fleet.projects, ['lb', 'la1', 'la2']);
    assert.deepEqual(JSON.parse(w.read(w.a)).project.lanes.map((l) => l.id), ['la1', 'la2']);
    assert.deepEqual(JSON.parse(w.read(w.a)).paths, { docs: 'docs' });
    const b = JSON.parse(w.read(w.b));
    assert.equal(b.project.name, 'pb');
    assert.deepEqual(b.paths, { features: 'docs/features' });
  }],
  ['a second --write plans 0 files and writes nothing', (w) => {
    applyMigration({ host: w.host, seed: w.seed, backupDir: w.backup, date: 'D' });
    const snap = [w.read(w.host), w.read(w.a), w.read(w.b)];
    assert.equal(planMigration({ host: w.host, seed: w.seed }).filter((s) => s.changed).length, 0);
    assert.deepEqual(applyMigration({ host: w.host, seed: w.seed, backupDir: w.backup, date: 'D' }), { written: [] });
    assert.deepEqual([w.read(w.host), w.read(w.a), w.read(w.b)], snap);
  }],
  ['--rollback restores byte-identical files and removes the one it created', (w) => {
    const before = [w.read(w.host), w.read(w.a)];
    applyMigration({ host: w.host, seed: w.seed, backupDir: w.backup, date: 'D' });
    assert.ok(existsSync(join(w.backup, 'host.compose.json.D')));
    rollbackMigration({ backupDir: w.backup });
    assert.deepEqual([w.read(w.host), w.read(w.a)], before);
    assert.equal(existsSync(join(w.b, '.compose', 'compose.json')), false);
  }],
];

describe('project model migration (COMP-COCKPIT-PROJECT-MODEL-1)', () => {
  for (const [name, fn] of ROWS) {
    it(name, () => {
      const w = world();
      try { fn(w); } finally { w.cleanup(); }
    });
  }
});
