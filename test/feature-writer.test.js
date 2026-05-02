/**
 * feature-writer.test.js — coverage for lib/feature-writer.js
 * (COMP-MCP-ROADMAP-WRITER T3).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  addRoadmapEntry,
  setFeatureStatus,
  roadmapDiff,
} from '../lib/feature-writer.js';
import { readFeature, writeFeature } from '../lib/feature-json.js';
import { readEvents } from '../lib/feature-events.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'feature-writer-'));
  // ROADMAP regen needs the docs/features dir to exist.
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

function seedFeature(cwd, feature) {
  writeFeature(cwd, {
    created: '2026-05-02',
    updated: '2026-05-02',
    ...feature,
  });
}

// ---------------------------------------------------------------------------
// addRoadmapEntry
// ---------------------------------------------------------------------------

describe('addRoadmapEntry', () => {
  test('creates feature.json and regenerates ROADMAP.md', async () => {
    const cwd = freshCwd();
    const r = await addRoadmapEntry(cwd, {
      code: 'FOO-1',
      description: 'first feature',
      phase: 'Phase 0',
      complexity: 'S',
    });
    assert.equal(r.code, 'FOO-1');
    assert.equal(r.phase, 'Phase 0');

    const feature = readFeature(cwd, 'FOO-1');
    assert.equal(feature.status, 'PLANNED');
    assert.equal(feature.complexity, 'S');
    assert.equal(feature.phase, 'Phase 0');

    assert.ok(existsSync(join(cwd, 'ROADMAP.md')), 'ROADMAP.md regenerated');
    const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /FOO-1/);
    assert.match(roadmap, /first feature/);
  });

  test('rejects duplicate code', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, { code: 'BAR-1', description: 'x', phase: 'P' });
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'BAR-1', description: 'y', phase: 'P' }),
      /already exists/
    );
  });

  test('rejects invalid code format', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'lowercase-1', description: 'x', phase: 'P' }),
      /invalid feature code/
    );
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: '-LEADING-DASH', description: 'x', phase: 'P' }),
      /invalid feature code/
    );
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'TRAILING-', description: 'x', phase: 'P' }),
      /invalid feature code/
    );
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: '', description: 'x', phase: 'P' }),
      /invalid feature code/
    );
  });

  test('rejects missing required fields', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'ABC-1', phase: 'P' }),
      /description is required/
    );
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'ABC-1', description: 'x' }),
      /phase is required/
    );
  });

  test('rejects bad complexity', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'X-1', description: 'd', phase: 'P', complexity: 'huge' }),
      /invalid complexity/
    );
  });

  test('appends an event', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, { code: 'EVT-1', description: 'd', phase: 'P' });
    const events = readEvents(cwd, { tool: 'add_roadmap_entry' });
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'EVT-1');
    assert.equal(events[0].phase, 'P');
  });

  test('idempotency key prevents double-mutation', async () => {
    const cwd = freshCwd();
    const r1 = await addRoadmapEntry(cwd, {
      code: 'IDM-1', description: 'd', phase: 'P',
      idempotency_key: 'add-IDM-1-once',
    });
    const r2 = await addRoadmapEntry(cwd, {
      code: 'IDM-1', description: 'd', phase: 'P',
      idempotency_key: 'add-IDM-1-once',
    });
    assert.deepEqual(r1, r2, 'replay returns cached result');

    // Only one event despite two calls.
    const events = readEvents(cwd, { tool: 'add_roadmap_entry', code: 'IDM-1' });
    assert.equal(events.length, 1);
  });

  test('omitted position defaults to max+1 in same phase', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, { code: 'POS-1', description: 'a', phase: 'P1' });
    await addRoadmapEntry(cwd, { code: 'POS-2', description: 'b', phase: 'P1' });
    await addRoadmapEntry(cwd, { code: 'POS-3', description: 'c', phase: 'P2' });
    assert.equal(readFeature(cwd, 'POS-1').position, 1);
    assert.equal(readFeature(cwd, 'POS-2').position, 2);
    assert.equal(readFeature(cwd, 'POS-3').position, 1, 'new phase starts at 1');
  });

  test('explicit position is preserved and does not shift the next default', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, { code: 'POSE-1', description: 'a', phase: 'P', position: 10 });
    await addRoadmapEntry(cwd, { code: 'POSE-2', description: 'b', phase: 'P' });
    assert.equal(readFeature(cwd, 'POSE-1').position, 10);
    assert.equal(readFeature(cwd, 'POSE-2').position, 11, 'default = max+1');
  });

  test('audit append failure does not roll back the mutation', async () => {
    const cwd = freshCwd();
    // Make the events file unwritable: replace it with a directory of the
    // same name. appendFileSync will throw EISDIR, but the mutation should
    // commit anyway.
    const eventsDir = join(cwd, '.compose', 'data');
    mkdirSync(eventsDir, { recursive: true });
    mkdirSync(join(eventsDir, 'feature-events.jsonl'), { recursive: true });

    const r = await addRoadmapEntry(cwd, { code: 'AUDIT-1', description: 'd', phase: 'P' });
    assert.equal(r.code, 'AUDIT-1');
    assert.ok(readFeature(cwd, 'AUDIT-1'), 'feature.json should still be written');
  });

  test('persists optional fields', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, {
      code: 'OPT-1',
      description: 'd',
      phase: 'P',
      position: 7,
      parent: 'PARENT-1',
      tags: ['mcp', 'writer'],
    });
    const f = readFeature(cwd, 'OPT-1');
    assert.equal(f.position, 7);
    assert.equal(f.parent, 'PARENT-1');
    assert.deepEqual(f.tags, ['mcp', 'writer']);
  });
});

// ---------------------------------------------------------------------------
// setFeatureStatus
// ---------------------------------------------------------------------------

describe('setFeatureStatus', () => {
  test('valid transition flips status, regenerates ROADMAP, appends event', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'STAT-1', description: 'x', phase: 'P', status: 'PLANNED' });

    const r = await setFeatureStatus(cwd, { code: 'STAT-1', status: 'IN_PROGRESS' });
    assert.equal(r.from, 'PLANNED');
    assert.equal(r.to, 'IN_PROGRESS');

    const feature = readFeature(cwd, 'STAT-1');
    assert.equal(feature.status, 'IN_PROGRESS');

    const events = readEvents(cwd, { tool: 'set_feature_status', code: 'STAT-1' });
    assert.equal(events.length, 1);
    assert.equal(events[0].from, 'PLANNED');
    assert.equal(events[0].to, 'IN_PROGRESS');
  });

  test('invalid transition rejects', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'BAD-1', description: 'x', phase: 'P', status: 'PLANNED' });
    await assert.rejects(
      () => setFeatureStatus(cwd, { code: 'BAD-1', status: 'COMPLETE' }),
      /invalid transition/
    );
  });

  test('COMPLETE -> SUPERSEDED requires force', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'SUP-1', description: 'x', phase: 'P', status: 'COMPLETE' });
    await assert.rejects(
      () => setFeatureStatus(cwd, { code: 'SUP-1', status: 'SUPERSEDED' }),
      /invalid transition/
    );
    const r = await setFeatureStatus(cwd, { code: 'SUP-1', status: 'SUPERSEDED', force: true });
    assert.equal(r.to, 'SUPERSEDED');
    const events = readEvents(cwd, { tool: 'set_feature_status', code: 'SUP-1' });
    assert.equal(events[0].forced, true);
  });

  test('force flag bypasses transition policy and records it', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'FRC-1', description: 'x', phase: 'P', status: 'COMPLETE' });
    const r = await setFeatureStatus(cwd, { code: 'FRC-1', status: 'PLANNED', force: true });
    assert.equal(r.to, 'PLANNED');
    const events = readEvents(cwd, { tool: 'set_feature_status', code: 'FRC-1' });
    assert.equal(events[0].forced, true);
  });

  test('reason and commit_sha are persisted in event', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'REA-1', description: 'x', phase: 'P', status: 'IN_PROGRESS' });
    await setFeatureStatus(cwd, {
      code: 'REA-1',
      status: 'COMPLETE',
      reason: 'shipped in commit abc',
      commit_sha: 'abc1234',
    });
    const events = readEvents(cwd, { tool: 'set_feature_status', code: 'REA-1' });
    assert.equal(events[0].reason, 'shipped in commit abc');
    assert.equal(events[0].commit_sha, 'abc1234');
    const feature = readFeature(cwd, 'REA-1');
    assert.equal(feature.commit_sha, 'abc1234');
  });

  test('same-status flip returns noop, no event', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'NOO-1', description: 'x', phase: 'P', status: 'PLANNED' });
    const r = await setFeatureStatus(cwd, { code: 'NOO-1', status: 'PLANNED' });
    assert.equal(r.noop, true);
    const events = readEvents(cwd, { tool: 'set_feature_status', code: 'NOO-1' });
    assert.equal(events.length, 0);
  });

  test('missing feature rejects', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => setFeatureStatus(cwd, { code: 'GHOST-1', status: 'IN_PROGRESS' }),
      /not found/
    );
  });

  test('invalid status rejects', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'BST-1', description: 'x', phase: 'P', status: 'PLANNED' });
    await assert.rejects(
      () => setFeatureStatus(cwd, { code: 'BST-1', status: 'WHATEVER' }),
      /invalid status/
    );
  });

  test('idempotency key prevents double-mutation', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'IDS-1', description: 'x', phase: 'P', status: 'PLANNED' });
    const r1 = await setFeatureStatus(cwd, {
      code: 'IDS-1', status: 'IN_PROGRESS', idempotency_key: 'flip-IDS-1',
    });
    const r2 = await setFeatureStatus(cwd, {
      code: 'IDS-1', status: 'IN_PROGRESS', idempotency_key: 'flip-IDS-1',
    });
    assert.deepEqual(r1, r2);
    const events = readEvents(cwd, { tool: 'set_feature_status', code: 'IDS-1' });
    assert.equal(events.length, 1);
  });
});

// ---------------------------------------------------------------------------
// roadmapDiff
// ---------------------------------------------------------------------------

describe('roadmapDiff', () => {
  test('returns added and status_changed within window', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, { code: 'DIFF-1', description: 'a', phase: 'P' });
    await addRoadmapEntry(cwd, { code: 'DIFF-2', description: 'b', phase: 'P' });
    await setFeatureStatus(cwd, { code: 'DIFF-1', status: 'IN_PROGRESS' });

    const r = roadmapDiff(cwd, { since: '24h' });
    assert.deepEqual(r.added, ['DIFF-1', 'DIFF-2']);
    assert.equal(r.status_changed.length, 1);
    assert.deepEqual(r.status_changed[0], { code: 'DIFF-1', from: 'PLANNED', to: 'IN_PROGRESS' });
    assert.equal(r.events.length, 3);
  });

  test('filters by feature_code', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, { code: 'FLT-1', description: 'a', phase: 'P' });
    await addRoadmapEntry(cwd, { code: 'FLT-2', description: 'b', phase: 'P' });
    const r = roadmapDiff(cwd, { feature_code: 'FLT-1' });
    assert.equal(r.added.length, 1);
    assert.equal(r.added[0], 'FLT-1');
  });

  test('filters by tool', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, { code: 'TOOLF-1', description: 'a', phase: 'P' });
    await setFeatureStatus(cwd, { code: 'TOOLF-1', status: 'IN_PROGRESS' });
    const r = roadmapDiff(cwd, { tool: 'set_feature_status' });
    assert.equal(r.added.length, 0);
    assert.equal(r.status_changed.length, 1);
    assert.equal(r.events.length, 1);
  });

  test('returns empty when no events match', () => {
    const cwd = freshCwd();
    const r = roadmapDiff(cwd, { since: '24h' });
    assert.deepEqual(r, { events: [], added: [], status_changed: [] });
  });
});
