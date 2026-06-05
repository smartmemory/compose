import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backprojectVisionStatus } from '../scripts/backproject-vision-status.mjs';

// COMP-MCP-VALIDATE-3 — one-time back-projection migration.

function newProject(featuresRel) {
  const root = mkdtempSync(join(tmpdir(), 'bpvs-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  const cfg = featuresRel ? { paths: { features: featuresRel } } : { paths: {} };
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify(cfg));
  return root;
}

function writeFeature(root, featuresRel, code, status) {
  const dir = join(root, featuresRel, code);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'feature.json'), JSON.stringify({ code, status, description: 'x' }));
}

function writeVision(root, items) {
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items, connections: [], gates: [] }, null, 2));
}

function readVision(root) {
  return JSON.parse(readFileSync(join(root, '.compose', 'data', 'vision-state.json'), 'utf-8'));
}

function item(code, status) {
  return { id: `id-${code}`, type: 'feature', title: code, status,
    lifecycle: { featureCode: code, currentPhase: 'ship' } };
}

describe('backprojectVisionStatus', () => {
  test('dry-run reports drift without writing', () => {
    const root = newProject();
    writeFeature(root, 'docs/features', 'BP-1', 'COMPLETE');
    writeVision(root, [item('BP-1', 'in_progress')]);

    const res = backprojectVisionStatus({ root, apply: false });
    assert.equal(res.changes.length, 1);
    assert.deepEqual(res.changes[0], { code: 'BP-1', id: 'id-BP-1', from: 'in_progress', to: 'complete' });
    assert.equal(res.applied, false);
    // Not written.
    assert.equal(readVision(root).items[0].status, 'in_progress');
  });

  test('--apply reconciles drift, then is idempotent', () => {
    const root = newProject();
    writeFeature(root, 'docs/features', 'BP-1', 'COMPLETE');     // drift: complete vs in_progress
    writeFeature(root, 'docs/features', 'BP-2', 'SUPERSEDED');   // drift: superseded vs in_progress
    writeFeature(root, 'docs/features', 'BP-3', 'PARTIAL');      // PARTIAL → in_progress (already aligned)
    writeVision(root, [
      item('BP-1', 'in_progress'),
      item('BP-2', 'in_progress'),
      item('BP-3', 'in_progress'),
    ]);

    const res = backprojectVisionStatus({ root, apply: true });
    assert.equal(res.applied, true);
    assert.equal(res.changes.length, 2, 'BP-1 + BP-2 changed; BP-3 already aligned');

    const v = readVision(root);
    const byId = Object.fromEntries(v.items.map(i => [i.id, i.status]));
    assert.equal(byId['id-BP-1'], 'complete');
    assert.equal(byId['id-BP-2'], 'superseded');
    assert.equal(byId['id-BP-3'], 'in_progress');

    // Idempotent: re-run stages zero.
    const again = backprojectVisionStatus({ root, apply: true });
    assert.equal(again.changes.length, 0);
    assert.equal(again.applied, false);
  });

  test('respects paths.features override', () => {
    const root = newProject('specs/feats');
    writeFeature(root, 'specs/feats', 'BP-9', 'COMPLETE');
    writeVision(root, [item('BP-9', 'planned')]);

    const res = backprojectVisionStatus({ root, apply: true });
    assert.equal(res.changes.length, 1);
    assert.equal(readVision(root).items[0].status, 'complete');
  });

  test('skips items with no bound feature.json (UI-only / external)', () => {
    const root = newProject();
    writeVision(root, [
      { id: 'ui-1', type: 'idea', title: 'loose idea', status: 'planned' },
      { id: 'ext-1', type: 'feature', title: 'STRAT-1', status: 'complete',
        lifecycle: { featureCode: 'STRAT-1' } },
    ]);

    const res = backprojectVisionStatus({ root, apply: true });
    assert.equal(res.changes.length, 0);
    assert.equal(res.skipped, 2);
  });
});
