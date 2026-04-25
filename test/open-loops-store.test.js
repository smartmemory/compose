/**
 * open-loops-store.test.js — Unit tests for server/open-loops-store.js
 *
 * Covers:
 *   - addOpenLoop: UUID v4 format, server-fills id/created_at/parent_feature
 *   - 400 guard when item has no featureCode
 *   - resolveOpenLoop: in-place resolution, not delete; loop.resolution set
 *   - 404 when loopId not found
 *   - 400 when already resolved
 *   - listOpenLoops: default unresolved-only, includeResolved option
 *   - isStaleLoop: TTL predicate
 *   - append-only invariant: resolving leaves original index intact
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { addOpenLoop, resolveOpenLoop, listOpenLoops, isStaleLoop } = await import(`${REPO_ROOT}/server/open-loops-store.js`);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeItem(featureCode = 'COMP-LOOPS-TEST', loops = []) {
  return {
    id: randomUUID(),
    lifecycle: {
      featureCode,
      lifecycle_ext: { open_loops: loops },
    },
  };
}

function makeFeaturelessItem() {
  return { id: randomUUID(), lifecycle: {} };
}

// ── isStaleLoop ────────────────────────────────────────────────────────────

describe('isStaleLoop', () => {
  const NOW = Date.now();

  test('resolved loop is never stale', () => {
    const loop = {
      id: randomUUID(), kind: 'deferred', summary: 'x', created_at: new Date(NOW - 200 * 86400000).toISOString(),
      parent_feature: 'FC', ttl_days: 90,
      resolution: { resolved_at: new Date().toISOString(), resolved_by: 'ruze' },
    };
    assert.equal(isStaleLoop(loop, NOW), false);
  });

  test('unresolved loop past TTL is stale', () => {
    const loop = {
      id: randomUUID(), kind: 'deferred', summary: 'x',
      created_at: new Date(NOW - 100 * 86400000).toISOString(),
      parent_feature: 'FC', ttl_days: 90, resolution: null,
    };
    assert.equal(isStaleLoop(loop, NOW), true);
  });

  test('unresolved loop within TTL is not stale', () => {
    const loop = {
      id: randomUUID(), kind: 'deferred', summary: 'x',
      created_at: new Date(NOW - 10 * 86400000).toISOString(),
      parent_feature: 'FC', ttl_days: 90, resolution: null,
    };
    assert.equal(isStaleLoop(loop, NOW), false);
  });

  test('defaults to ttl_days=90 when field absent', () => {
    const loop = {
      id: randomUUID(), kind: 'deferred', summary: 'x',
      created_at: new Date(NOW - 91 * 86400000).toISOString(),
      parent_feature: 'FC', resolution: null,
    };
    assert.equal(isStaleLoop(loop, NOW), true);
  });
});

// ── addOpenLoop ────────────────────────────────────────────────────────────

describe('addOpenLoop', () => {
  test('returns new loop with UUID v4 id', () => {
    const item = makeItem();
    const { loop } = addOpenLoop(item, { kind: 'deferred', summary: 'verify X before merge' });
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(loop.id, UUID_RE, 'id must be UUID v4');
  });

  test('server fills created_at as ISO date', () => {
    const item = makeItem();
    const { loop } = addOpenLoop(item, { kind: 'deferred', summary: 'test' });
    assert.ok(!isNaN(Date.parse(loop.created_at)), 'created_at must be valid ISO date');
  });

  test('server fills parent_feature from item.lifecycle.featureCode', () => {
    const item = makeItem('COMP-LOOPS-TEST');
    const { loop } = addOpenLoop(item, { kind: 'blocked', summary: 'dep waiting' });
    assert.equal(loop.parent_feature, 'COMP-LOOPS-TEST');
  });

  test('kind and summary are preserved', () => {
    const item = makeItem();
    const { loop } = addOpenLoop(item, { kind: 'open_question', summary: 'should we do X?' });
    assert.equal(loop.kind, 'open_question');
    assert.equal(loop.summary, 'should we do X?');
  });

  test('resolution is null on creation', () => {
    const item = makeItem();
    const { loop } = addOpenLoop(item, { kind: 'deferred', summary: 'test' });
    assert.equal(loop.resolution, null);
  });

  test('ttl_days defaults to 90', () => {
    const item = makeItem();
    const { loop } = addOpenLoop(item, { kind: 'deferred', summary: 'test' });
    assert.equal(loop.ttl_days, 90);
  });

  test('ttl_days can be overridden', () => {
    const item = makeItem();
    const { loop } = addOpenLoop(item, { kind: 'deferred', summary: 'test', ttl_days: 30 });
    assert.equal(loop.ttl_days, 30);
  });

  test('nextLoops contains the new loop appended to existing', () => {
    const existing = [{ id: 'old-1', kind: 'deferred', summary: 'old', created_at: new Date().toISOString(), parent_feature: 'FC', resolution: null, ttl_days: 90 }];
    const item = makeItem('FC', existing);
    const { nextLoops } = addOpenLoop(item, { kind: 'blocked', summary: 'new' });
    assert.equal(nextLoops.length, 2);
    assert.equal(nextLoops[0].id, 'old-1');
  });

  test('400 error when item has no featureCode', () => {
    const item = makeFeaturelessItem();
    assert.throws(
      () => addOpenLoop(item, { kind: 'deferred', summary: 'test' }),
      (err) => {
        assert.ok(err.message.includes('featureCode'), `expected featureCode in error: ${err.message}`);
        assert.equal(err.status, 400);
        return true;
      },
    );
  });
});

// ── resolveOpenLoop ────────────────────────────────────────────────────────

describe('resolveOpenLoop', () => {
  function makeLoop(id, resolved = false) {
    return {
      id,
      kind: 'deferred',
      summary: 'test loop',
      created_at: new Date().toISOString(),
      parent_feature: 'COMP-LOOPS-TEST',
      resolution: resolved ? { resolved_at: new Date().toISOString(), resolved_by: 'ruze' } : null,
      ttl_days: 90,
    };
  }

  test('sets resolution in-place on the correct loop', () => {
    const loopId = randomUUID();
    const item = makeItem('FC', [makeLoop(loopId)]);
    const { loop, nextLoops } = resolveOpenLoop(item, loopId, { note: 'done', resolved_by: 'ruze' });
    assert.ok(loop.resolution, 'resolution must be set');
    assert.equal(loop.resolution.resolved_by, 'ruze');
    assert.equal(loop.resolution.note, 'done');
    assert.ok(!isNaN(Date.parse(loop.resolution.resolved_at)), 'resolved_at must be valid ISO date');
    assert.equal(nextLoops.length, 1, 'append-only: length unchanged');
    assert.ok(nextLoops[0].resolution, 'loop in nextLoops is resolved');
  });

  test('404 error when loopId not found', () => {
    const item = makeItem('FC', [makeLoop(randomUUID())]);
    assert.throws(
      () => resolveOpenLoop(item, 'nonexistent-id', { note: '' }),
      (err) => {
        assert.ok(err.message.includes('not found'));
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  test('400 error when loop already resolved', () => {
    const loopId = randomUUID();
    const item = makeItem('FC', [makeLoop(loopId, true)]);
    assert.throws(
      () => resolveOpenLoop(item, loopId, { note: '' }),
      (err) => {
        assert.ok(err.message.includes('already resolved'));
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  test('other loops in nextLoops are untouched (append-only invariant)', () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    const item = makeItem('FC', [makeLoop(id1), makeLoop(id2)]);
    const { nextLoops } = resolveOpenLoop(item, id1, { note: '', resolved_by: 'ruze' });
    assert.equal(nextLoops.length, 2, 'must retain both loops');
    const unchanged = nextLoops.find(l => l.id === id2);
    assert.ok(unchanged, 'second loop must still be present');
    assert.equal(unchanged.resolution, null, 'second loop must remain unresolved');
  });

  test('defaults resolved_by to "unknown" when not provided', () => {
    const loopId = randomUUID();
    const item = makeItem('FC', [makeLoop(loopId)]);
    const { loop } = resolveOpenLoop(item, loopId, {});
    assert.equal(loop.resolution.resolved_by, 'unknown');
  });
});

// ── listOpenLoops ──────────────────────────────────────────────────────────

describe('listOpenLoops', () => {
  function makeLoop(resolved = false) {
    return {
      id: randomUUID(),
      kind: 'deferred',
      summary: 'test',
      created_at: new Date().toISOString(),
      parent_feature: 'FC',
      resolution: resolved ? { resolved_at: new Date().toISOString(), resolved_by: 'ruze' } : null,
      ttl_days: 90,
    };
  }

  test('default: returns only unresolved loops', () => {
    const item = makeItem('FC', [makeLoop(false), makeLoop(true), makeLoop(false)]);
    const loops = listOpenLoops(item);
    assert.equal(loops.length, 2);
    for (const l of loops) assert.equal(l.resolution, null);
  });

  test('includeResolved: returns all loops', () => {
    const item = makeItem('FC', [makeLoop(false), makeLoop(true)]);
    const loops = listOpenLoops(item, { includeResolved: true });
    assert.equal(loops.length, 2);
  });

  test('returns empty array when item has no open_loops', () => {
    const item = { id: randomUUID(), lifecycle: { featureCode: 'FC', lifecycle_ext: {} } };
    const loops = listOpenLoops(item);
    assert.deepEqual(loops, []);
  });

  test('returns empty array when item has no lifecycle', () => {
    const item = { id: randomUUID() };
    const loops = listOpenLoops(item);
    assert.deepEqual(loops, []);
  });
});
