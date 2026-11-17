/**
 * roadmap-writer-drift.test.js — COMP-ROADMAP-WRITER-DRIFT-1.
 * addRoadmapEntry regenerates ROADMAP.md from feature.json, so a row that was
 * hand-edited while its feature.json was left behind got silently rewritten.
 * The writer must refuse (naming the row) instead of changing a row nobody touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { addRoadmapEntry } from '../lib/feature-writer.js';
import { readFeature } from '../lib/feature-json.js';

async function seeded() {
  const cwd = mkdtempSync(join(tmpdir(), 'roadmap-drift-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  await addRoadmapEntry(cwd, { code: 'OLD-1', description: 'old row', phase: 'Phase 0', complexity: 'S' });
  await addRoadmapEntry(cwd, { code: 'OLD-2', description: 'second row', phase: 'Phase 0', complexity: 'S' });
  return cwd;
}
const add = (cwd, extra = {}) =>
  addRoadmapEntry(cwd, { code: 'NEW-1', description: 'new row', phase: 'Phase 0', complexity: 'S', ...extra });

test('a hand-edited row (status) is refused, row named, nothing written', async () => {
  const cwd = await seeded();
  const p = join(cwd, 'ROADMAP.md');
  const edited = readFileSync(p, 'utf-8').replace(/(\| OLD-1 \|[^\n]*\|) PLANNED \|/, '$1 COMPLETE |');
  assert.notEqual(edited, readFileSync(p, 'utf-8'), 'fixture edit applied');
  writeFileSync(p, edited);

  await assert.rejects(add(cwd), (e) => {
    assert.equal(e.code, 'ROADMAP_ROW_DRIFT');
    assert.match(e.message, /OLD-1/);
    assert.doesNotMatch(e.message, /OLD-2/);
    return true;
  });
  assert.equal(readFileSync(p, 'utf-8'), edited, 'ROADMAP.md untouched');
  assert.equal(existsSync(join(cwd, 'docs', 'features', 'NEW-1')), false, 'no feature.json written');
});

test('a hand-edited row (description) is refused', async () => {
  const cwd = await seeded();
  const p = join(cwd, 'ROADMAP.md');
  writeFileSync(p, readFileSync(p, 'utf-8').replace('second row', 'second row. Added sentence.'));
  await assert.rejects(add(cwd), (e) => e.code === 'ROADMAP_ROW_DRIFT' && /OLD-2/.test(e.message));
});

test('no drift: the add changes only the new row', async () => {
  const cwd = await seeded();
  const p = join(cwd, 'ROADMAP.md');
  const before = readFileSync(p, 'utf-8').split('\n');
  await add(cwd);
  const after = readFileSync(p, 'utf-8').split('\n');
  const added = after.filter((l) => !before.includes(l));
  assert.equal(added.length, 1);
  assert.match(added[0], /NEW-1/);
  assert.equal(before.filter((l) => !after.includes(l)).length, 0);
  assert.equal(readFeature(cwd, 'NEW-1').status, 'PLANNED');
});

test('force: true is the explicit override', async () => {
  const cwd = await seeded();
  const p = join(cwd, 'ROADMAP.md');
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/(\| OLD-1 \|[^\n]*\|) PLANNED \|/, '$1 COMPLETE |'));
  await add(cwd, { force: true });
  assert.equal(readFeature(cwd, 'NEW-1').code, 'NEW-1');
});
