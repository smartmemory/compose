/**
 * roadmap-graph-canonical-seed.test.js — COMP-ROADMAP-GRAPH-2 S3.
 *
 * The vision seed must absorb collect.js's edge + metadata semantics so a
 * freshly-seeded store renders the same canonical graph the static collector
 * did: deps.yaml dependency edges become typed connections, and track/priority
 * carry into the item. Edges are verified end-to-end through the adapter +
 * buildGraph so the deps.yaml -> connection -> rawEdge round-trip is exact.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanFeatures, seedFeatures } from '../server/feature-scan.js';
import { VisionStore } from '../server/vision-store.js';
import { visionToGraphInputs } from '../lib/roadmap-graph/vision-adapter.js';
import { buildGraph } from '../lib/roadmap-graph/model.js';
import { depsToEdges } from '../lib/roadmap-graph/model.js';

function mkFeatures(specs) {
  const dir = mkdtempSync(join(tmpdir(), 'rg2-seed-'));
  for (const [code, spec] of Object.entries(specs)) {
    const fdir = join(dir, code);
    mkdirSync(fdir, { recursive: true });
    writeFileSync(
      join(fdir, 'feature.json'),
      JSON.stringify({ code, description: spec.description || code, status: spec.status || 'PLANNED', ...(spec.group ? { group: spec.group } : {}) }, null, 2),
    );
    if (spec.deps) writeFileSync(join(fdir, 'deps.yaml'), spec.deps);
    if (spec.design) writeFileSync(join(fdir, 'design.md'), spec.design);
  }
  return dir;
}

function freshStore() {
  return new VisionStore(mkdtempSync(join(tmpdir(), 'rg2-store-')));
}

function codeOf(store, id) {
  const it = store.items.get(id);
  return it?.lifecycle?.featureCode || it?.title;
}

describe('seedFeatures absorbs deps.yaml edges (S3a)', () => {
  test('depends_on becomes a blocks connection (prerequisite -> dependent)', () => {
    const dir = mkFeatures({
      'COMP-A': { deps: 'depends_on:\n  - COMP-B\n' },
      'COMP-B': {},
    });
    const store = freshStore();
    seedFeatures(scanFeatures(dir), store);

    const blocks = [...store.connections.values()].filter((c) => c.type === 'blocks');
    assert.equal(blocks.length, 1);
    // depsToEdges(COMP-A, {depends_on:[COMP-B]}) => {from: COMP-B, to: COMP-A}
    assert.equal(codeOf(store, blocks[0].fromId), 'COMP-B');
    assert.equal(codeOf(store, blocks[0].toId), 'COMP-A');
  });

  test('concurrent_with becomes a supports connection', () => {
    const dir = mkFeatures({
      'COMP-A': { deps: 'concurrent_with:\n  - COMP-B\n' },
      'COMP-B': {},
    });
    const store = freshStore();
    seedFeatures(scanFeatures(dir), store);

    const supports = [...store.connections.values()].filter((c) => c.type === 'supports');
    assert.equal(supports.length, 1);
  });

  test('round-trips through adapter to match depsToEdges output', () => {
    const dir = mkFeatures({
      'COMP-A': { deps: 'depends_on:\n  - COMP-B\nblocks:\n  - COMP-C\n' },
      'COMP-B': {},
      'COMP-C': {},
    });
    const store = freshStore();
    seedFeatures(scanFeatures(dir), store);

    const inputs = visionToGraphInputs(
      [...store.items.values()], [...store.connections.values()], { includeProseEdges: false },
    );
    const got = inputs.rawEdges.map((e) => `${e.from}->${e.to}:${e.type}`).sort();
    const want = depsToEdges('COMP-A', { depends_on: ['COMP-B'], blocks: ['COMP-C'] })
      .map((e) => `${e.from}->${e.to}:${e.type}`).sort();
    assert.deepEqual(got, want);
    assert.doesNotThrow(() => buildGraph(inputs));
  });

  test('deps referencing a missing/external code do not crash the seed', () => {
    const dir = mkFeatures({
      'COMP-A': { deps: 'depends_on:\n  - STRAT-X\n' }, // STRAT-X has no folder
    });
    const store = freshStore();
    assert.doesNotThrow(() => seedFeatures(scanFeatures(dir), store));
    // No connection created (endpoint item absent) — buildGraph would drop it anyway.
    assert.equal([...store.connections.values()].length, 0);
  });

  test('seeding is idempotent — re-seeding creates no duplicate edges', () => {
    const dir = mkFeatures({ 'COMP-A': { deps: 'depends_on:\n  - COMP-B\n' }, 'COMP-B': {} });
    const store = freshStore();
    const features = scanFeatures(dir);
    seedFeatures(features, store);
    seedFeatures(features, store);
    assert.equal([...store.connections.values()].filter((c) => c.type === 'blocks').length, 1);
  });

  test('reconciles: a removed deps.yaml edge drops the stale connection on reseed', () => {
    const dir = mkFeatures({ 'COMP-A': { deps: 'depends_on:\n  - COMP-B\n' }, 'COMP-B': {} });
    const store = freshStore();
    seedFeatures(scanFeatures(dir), store);
    assert.equal([...store.connections.values()].filter((c) => c.type === 'blocks').length, 1);

    // Remove the dep and reseed — the stale blocks edge must be gone.
    rmSync(join(dir, 'COMP-A', 'deps.yaml'));
    seedFeatures(scanFeatures(dir), store);
    assert.equal([...store.connections.values()].filter((c) => c.type === 'blocks').length, 0);
  });
});

describe('feature.json status is authoritative (kills the de-sync)', () => {
  test('feature.json COMPLETE wins over design.md prose status', () => {
    const dir = mkFeatures({
      'COMP-A': {
        status: 'COMPLETE',
        design: '# COMP-A\n\n**Status:** PLANNED — just starting\n',
      },
    });
    const [feat] = scanFeatures(dir);
    assert.equal(feat.status, 'complete');
  });

  test('seeded item reflects feature.json status, and re-seed syncs a drifted item', () => {
    const dir = mkFeatures({ 'COMP-A': { status: 'COMPLETE' } });
    const store = freshStore();
    seedFeatures(scanFeatures(dir), store);
    let item = [...store.items.values()][0];
    assert.equal(item.status, 'complete');

    // Simulate cockpit drift, then re-seed: feature.json wins.
    store.updateItem(item.id, { status: 'planned' });
    seedFeatures(scanFeatures(dir), store);
    item = store.items.get(item.id);
    assert.equal(item.status, 'complete');
  });

  test('falls back to design.md prose when feature.json has no status', () => {
    const dir = mkFeatures({
      'COMP-A': { status: undefined, design: '# COMP-A\n\n**Status:** IN_PROGRESS\n' },
    });
    // mkFeatures always writes a status; overwrite feature.json without one.
    writeFileSync(join(dir, 'COMP-A', 'feature.json'), JSON.stringify({ code: 'COMP-A', description: 'x' }));
    const [feat] = scanFeatures(dir);
    assert.equal(feat.status, 'in_progress');
  });
});

describe('seedFeatures carries track/priority (S3b)', () => {
  test('feature.json group seeds item.group (track carrier)', () => {
    const dir = mkFeatures({ 'COMP-A': { group: 'core' } });
    const store = freshStore();
    seedFeatures(scanFeatures(dir), store);
    const item = [...store.items.values()][0];
    assert.equal(item.group, 'core');
  });

  test('design.md frontmatter track overrides feature.json group', () => {
    const dir = mkFeatures({
      'COMP-A': { group: 'fromjson', design: '---\ntrack: fromfrontmatter\npriority: high\n---\n# COMP-A\n' },
    });
    const store = freshStore();
    seedFeatures(scanFeatures(dir), store);
    const item = [...store.items.values()][0];
    assert.equal(item.group, 'fromfrontmatter');
    assert.equal(item.priority, 'high');
  });

  test('priority updates on reseed (updateItem allowlist includes priority)', () => {
    const dir = mkFeatures({ 'COMP-A': {} });
    const store = freshStore();
    seedFeatures(scanFeatures(dir), store);
    const id = [...store.items.values()][0].id;
    store.updateItem(id, { priority: 'low' });
    // Now add a frontmatter priority and reseed — it must take effect.
    writeFileSync(join(dir, 'COMP-A', 'design.md'), '---\npriority: high\n---\n# COMP-A\n');
    seedFeatures(scanFeatures(dir), store);
    assert.equal(store.items.get(id).priority, 'high');
  });
});
