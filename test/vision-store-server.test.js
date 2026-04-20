import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VisionStore } from '../server/vision-store.js';

let dataDir;
let store;
let id;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-store-test-'));
  store = new VisionStore(dataDir);
  const item = store.createItem({ title: 'T', type: 'feature' });
  id = item.id;
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

describe('VisionStore.updateLifecycle — lifecycle_ext preservation', () => {
  it('preserves prior lifecycle_ext when caller omits the key', () => {
    store.updateLifecycle(id, {
      currentPhase: 'design',
      featureCode: 'X',
      lifecycle_ext: { branch_lineage: { feature_code: 'X', branches: [] } },
    });
    store.updateLifecycle(id, { currentPhase: 'plan', featureCode: 'X' });
    const lc = store.items.get(id).lifecycle;
    assert.equal(lc.currentPhase, 'plan');
    assert.ok(lc.lifecycle_ext);
    assert.equal(lc.lifecycle_ext.branch_lineage.feature_code, 'X');
  });

  it('preserves lifecycle_ext across multiple partial updates', () => {
    store.updateLifecycle(id, {
      currentPhase: 'design',
      featureCode: 'X',
      lifecycle_ext: { branch_lineage: { feature_code: 'X' }, open_loops: [] },
    });
    store.updateLifecycle(id, { currentPhase: 'plan', featureCode: 'X' });
    store.updateLifecycle(id, { currentPhase: 'implement', featureCode: 'X' });
    const ext = store.items.get(id).lifecycle.lifecycle_ext;
    assert.ok(ext);
    assert.ok(ext.branch_lineage);
    assert.deepEqual(ext.open_loops, []);
  });

  it('replaces lifecycle_ext when caller passes it explicitly', () => {
    store.updateLifecycle(id, {
      currentPhase: 'design',
      featureCode: 'X',
      lifecycle_ext: { branch_lineage: { feature_code: 'X', branches: [{ id: 'b1' }] } },
    });
    store.updateLifecycle(id, {
      currentPhase: 'plan',
      featureCode: 'X',
      lifecycle_ext: { branch_lineage: { feature_code: 'X', branches: [] } },
    });
    const branches = store.items.get(id).lifecycle.lifecycle_ext.branch_lineage.branches;
    assert.equal(branches.length, 0);
  });

  it('passing lifecycle_ext: null explicitly clears it', () => {
    store.updateLifecycle(id, {
      currentPhase: 'design',
      featureCode: 'X',
      lifecycle_ext: { branch_lineage: { feature_code: 'X' } },
    });
    store.updateLifecycle(id, { currentPhase: 'plan', featureCode: 'X', lifecycle_ext: null });
    assert.equal(store.items.get(id).lifecycle.lifecycle_ext, null);
  });

  it('works when prior lifecycle had no lifecycle_ext', () => {
    store.updateLifecycle(id, { currentPhase: 'design', featureCode: 'X' });
    store.updateLifecycle(id, { currentPhase: 'plan', featureCode: 'X' });
    const lc = store.items.get(id).lifecycle;
    assert.equal(lc.lifecycle_ext, undefined);
  });
});

describe('VisionStore.updateLifecycleExt', () => {
  beforeEach(() => {
    store.updateLifecycle(id, { currentPhase: 'design', featureCode: 'X' });
  });

  it('sets a new key on empty lifecycle_ext', () => {
    store.updateLifecycleExt(id, 'branch_lineage', { feature_code: 'X', branches: [] });
    assert.deepEqual(
      store.items.get(id).lifecycle.lifecycle_ext,
      { branch_lineage: { feature_code: 'X', branches: [] } }
    );
  });

  it('merges multiple keys without touching each other', () => {
    store.updateLifecycleExt(id, 'branch_lineage', { feature_code: 'X' });
    store.updateLifecycleExt(id, 'open_loops', []);
    const ext = store.items.get(id).lifecycle.lifecycle_ext;
    assert.deepEqual(ext.branch_lineage, { feature_code: 'X' });
    assert.deepEqual(ext.open_loops, []);
  });

  it('overwrites the same key on repeated calls', () => {
    store.updateLifecycleExt(id, 'branch_lineage', { feature_code: 'X', branches: [{ id: 'a' }] });
    store.updateLifecycleExt(id, 'branch_lineage', { feature_code: 'X', branches: [{ id: 'b' }] });
    assert.deepEqual(
      store.items.get(id).lifecycle.lifecycle_ext.branch_lineage.branches,
      [{ id: 'b' }]
    );
  });

  it('persists to disk across store reloads', () => {
    store.updateLifecycleExt(id, 'branch_lineage', { feature_code: 'X' });
    const store2 = new VisionStore(dataDir);
    assert.deepEqual(
      store2.items.get(id).lifecycle.lifecycle_ext.branch_lineage,
      { feature_code: 'X' }
    );
  });

  it('survives a subsequent partial updateLifecycle that omits lifecycle_ext', () => {
    store.updateLifecycleExt(id, 'branch_lineage', { feature_code: 'X' });
    store.updateLifecycle(id, { currentPhase: 'plan', featureCode: 'X' });
    const ext = store.items.get(id).lifecycle.lifecycle_ext;
    assert.ok(ext);
    assert.deepEqual(ext.branch_lineage, { feature_code: 'X' });
  });

  it('throws when item does not exist', () => {
    assert.throws(() => store.updateLifecycleExt('nope', 'branch_lineage', {}), /not found/i);
  });
});
