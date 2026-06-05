import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFeatureStatus } from '../lib/feature-writer.js';

// COMP-MCP-VALIDATE-3 — write-time projection of feature.json status onto
// vision-state. These exercise the server-DOWN path (no Compose server running
// in the test), i.e. VisionWriter's direct atomic file write.

function newProject() {
  const root = mkdtempSync(join(tmpdir(), 'fwvp-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  // Minimal compose.json so path resolution uses defaults.
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ paths: {} }));
  return root;
}

function writeFeature(root, code, status, extra = {}) {
  const dir = join(root, 'docs', 'features', code);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'feature.json'),
    JSON.stringify({ code, status, description: 'x', ...extra }, null, 2));
  writeFileSync(join(dir, 'design.md'), '# d\n');
}

function writeRoadmap(root, rows) {
  // rows: [[code, status], ...]
  const body = rows.map((r, i) => `| ${i + 1} | ${r[0]} | x | ${r[1]} |`).join('\n');
  writeFileSync(join(root, 'ROADMAP.md'),
    `# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n${body}\n`);
}

function writeVision(root, items) {
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items, connections: [], gates: [] }, null, 2));
}

function readVision(root) {
  return JSON.parse(readFileSync(join(root, '.compose', 'data', 'vision-state.json'), 'utf-8'));
}

function visionItem(code, status) {
  return {
    id: `id-${code}`,
    type: 'feature',
    title: code,
    status,
    lifecycle: { featureCode: code, currentPhase: 'explore_design' },
  };
}

describe('setFeatureStatus → vision-state projection', () => {
  test('projects PLANNED→IN_PROGRESS as in_progress', async () => {
    const root = newProject();
    writeFeature(root, 'FWVP-1', 'PLANNED');
    writeRoadmap(root, [['FWVP-1', 'PLANNED']]);
    writeVision(root, [visionItem('FWVP-1', 'planned')]);

    await setFeatureStatus(root, { code: 'FWVP-1', status: 'IN_PROGRESS' });

    const item = readVision(root).items.find(i => i.lifecycle?.featureCode === 'FWVP-1');
    assert.equal(item.status, 'in_progress');
  });

  test('projects PARTIAL as in_progress (vision has no "partial")', async () => {
    const root = newProject();
    writeFeature(root, 'FWVP-2', 'IN_PROGRESS');
    writeRoadmap(root, [['FWVP-2', 'IN_PROGRESS']]);
    writeVision(root, [visionItem('FWVP-2', 'in_progress')]);

    await setFeatureStatus(root, { code: 'FWVP-2', status: 'PARTIAL' });

    const item = readVision(root).items.find(i => i.lifecycle?.featureCode === 'FWVP-2');
    assert.equal(item.status, 'in_progress');
  });

  test('projects COMPLETE as complete', async () => {
    const root = newProject();
    writeFeature(root, 'FWVP-3', 'IN_PROGRESS');
    writeRoadmap(root, [['FWVP-3', 'IN_PROGRESS']]);
    writeVision(root, [visionItem('FWVP-3', 'in_progress')]);

    await setFeatureStatus(root, { code: 'FWVP-3', status: 'COMPLETE' });

    const item = readVision(root).items.find(i => i.lifecycle?.featureCode === 'FWVP-3');
    assert.equal(item.status, 'complete');
  });

  test('matches the item bound by lifecycle.featureCode, not a colliding id', async () => {
    const root = newProject();
    writeFeature(root, 'FWVP-4', 'PLANNED');
    writeRoadmap(root, [['FWVP-4', 'PLANNED']]);
    // A decoy item whose id equals the code, plus the real lifecycle-bound item.
    writeVision(root, [
      { id: 'FWVP-4', type: 'task', title: 'decoy', status: 'planned' },
      visionItem('FWVP-4', 'planned'),
    ]);

    await setFeatureStatus(root, { code: 'FWVP-4', status: 'IN_PROGRESS' });

    const v = readVision(root);
    const real = v.items.find(i => i.lifecycle?.featureCode === 'FWVP-4');
    const decoy = v.items.find(i => i.id === 'FWVP-4' && i.type === 'task');
    assert.equal(real.status, 'in_progress', 'lifecycle-bound item updated');
    assert.equal(decoy.status, 'planned', 'decoy id-match left untouched');
  });

  test('from===to noop does not touch vision-state', async () => {
    const root = newProject();
    writeFeature(root, 'FWVP-5', 'COMPLETE');
    writeRoadmap(root, [['FWVP-5', 'COMPLETE']]);
    // Deliberately drifted vision status — a noop must NOT reconcile it (that is
    // the migration's job); it must stay as-is.
    writeVision(root, [visionItem('FWVP-5', 'in_progress')]);

    const res = await setFeatureStatus(root, { code: 'FWVP-5', status: 'COMPLETE' });
    assert.equal(res.noop, true);

    const item = readVision(root).items.find(i => i.lifecycle?.featureCode === 'FWVP-5');
    assert.equal(item.status, 'in_progress', 'noop left vision untouched');
  });

  test('vision-state failure does not fail the feature.json write (best-effort)', async () => {
    const root = newProject();
    writeFeature(root, 'FWVP-6', 'PLANNED');
    writeRoadmap(root, [['FWVP-6', 'PLANNED']]);
    // Corrupt vision-state so the writer's _load returns empty and findFeatureItem
    // returns null (no throw) — and even a parse failure must not bubble.
    writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), '{ not json');

    const res = await setFeatureStatus(root, { code: 'FWVP-6', status: 'IN_PROGRESS' });

    assert.equal(res.to, 'IN_PROGRESS');
    // Canonical write still landed.
    const fj = JSON.parse(readFileSync(join(root, 'docs', 'features', 'FWVP-6', 'feature.json'), 'utf-8'));
    assert.equal(fj.status, 'IN_PROGRESS');
    assert.ok(existsSync(join(root, 'ROADMAP.md')));
  });
});
