/**
 * followup-writer.test.js — coverage for lib/followup-writer.js
 * (COMP-MCP-FOLLOWUP).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { proposeFollowup, _internals } from '../lib/followup-writer.js';
import { addRoadmapEntry } from '../lib/feature-writer.js';
import { readFeature, writeFeature } from '../lib/feature-json.js';
import { readEvents } from '../lib/feature-events.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'followup-writer-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

async function seedParent(cwd, overrides = {}) {
  await addRoadmapEntry(cwd, {
    code: 'PAR-1',
    description: 'parent feature',
    phase: 'Phase 0',
    complexity: 'M',
    ...overrides,
  });
}

describe('proposeFollowup — happy path', () => {
  test('cold-start: first follow-up is parent-1', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);

    const r = await proposeFollowup(cwd, {
      parent_code: 'PAR-1',
      description: 'first follow-up',
      rationale: 'because review surfaced an edge case',
    });

    assert.equal(r.code, 'PAR-1-1');
    assert.equal(r.parent_code, 'PAR-1');
    assert.equal(r.phase, 'Phase 0');
    assert.equal(r.link.kind, 'surfaced_by');
    assert.equal(r.link.from_code, 'PAR-1-1');
    assert.equal(r.link.to_code, 'PAR-1');

    const created = readFeature(cwd, 'PAR-1-1');
    assert.equal(created.parent, 'PAR-1');
    assert.equal(created.phase, 'Phase 0');
    assert.equal(created.status, 'PLANNED');
    assert.deepEqual(created.links, [{ kind: 'surfaced_by', to_code: 'PAR-1' }]);

    const designPath = join(cwd, 'docs', 'features', 'PAR-1-1', 'design.md');
    assert.ok(existsSync(designPath));
    const design = readFileSync(designPath, 'utf-8');
    assert.match(design, /## Why/);
    assert.match(design, /because review surfaced an edge case/);
  });

  test('numbered children: next is N+1', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await proposeFollowup(cwd, {
      parent_code: 'PAR-1',
      description: 'first',
      rationale: 'r1',
    });
    const r2 = await proposeFollowup(cwd, {
      parent_code: 'PAR-1',
      description: 'second',
      rationale: 'r2',
    });
    assert.equal(r2.code, 'PAR-1-2');
  });

  test('skips foreign numbered codes (named children unaffected)', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    // A "named" child that shares the prefix but isn't N-suffixed
    await addRoadmapEntry(cwd, {
      code: 'PAR-1-NAMED',
      description: 'named child',
      phase: 'Phase 0',
      parent: 'PAR-1',
    });
    const r = await proposeFollowup(cwd, {
      parent_code: 'PAR-1',
      description: 'numbered',
      rationale: 'r',
    });
    assert.equal(r.code, 'PAR-1-1');
  });

  test('phase inherits from parent when omitted', async () => {
    const cwd = freshCwd();
    await seedParent(cwd, { phase: 'Phase 9: Custom' });
    const r = await proposeFollowup(cwd, {
      parent_code: 'PAR-1',
      description: 'd',
      rationale: 'r',
    });
    assert.equal(r.phase, 'Phase 9: Custom');
  });

  test('audit event emitted', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await proposeFollowup(cwd, {
      parent_code: 'PAR-1',
      description: 'd',
      rationale: 'r',
    });
    const events = readEvents(cwd, { tool: 'propose_followup' });
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, 'propose_followup');
    assert.equal(events[0].parent_code, 'PAR-1');
    assert.equal(events[0].code, 'PAR-1-1');
    assert.equal(events[0].rationale, 'r');
  });
});

describe('proposeFollowup — validation', () => {
  test('INVALID_INPUT on bad parent_code', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => proposeFollowup(cwd, { parent_code: 'lowercase', description: 'd', rationale: 'r' }),
      err => err.code === 'INVALID_INPUT' && /parent_code/.test(err.message)
    );
  });

  test('INVALID_INPUT on empty rationale', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await assert.rejects(
      () => proposeFollowup(cwd, { parent_code: 'PAR-1', description: 'd', rationale: '   ' }),
      err => err.code === 'INVALID_INPUT' && /rationale/.test(err.message)
    );
  });

  test('INVALID_INPUT on empty description', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await assert.rejects(
      () => proposeFollowup(cwd, { parent_code: 'PAR-1', description: '', rationale: 'r' }),
      err => err.code === 'INVALID_INPUT' && /description/.test(err.message)
    );
  });

  test('INVALID_INPUT on bad complexity', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await assert.rejects(
      () => proposeFollowup(cwd, { parent_code: 'PAR-1', description: 'd', rationale: 'r', complexity: 'XS' }),
      err => err.code === 'INVALID_INPUT' && /complexity/.test(err.message)
    );
  });

  test('INVALID_INPUT on bad status', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await assert.rejects(
      () => proposeFollowup(cwd, { parent_code: 'PAR-1', description: 'd', rationale: 'r', status: 'WIP' }),
      err => err.code === 'INVALID_INPUT' && /status/.test(err.message)
    );
  });

  test('PARENT_NOT_FOUND when parent absent', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => proposeFollowup(cwd, { parent_code: 'NONE-1', description: 'd', rationale: 'r' }),
      err => err.code === 'PARENT_NOT_FOUND'
    );
  });

  test('PARENT_TERMINAL when parent KILLED', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    // Hand-flip status to KILLED via direct write
    const f = readFeature(cwd, 'PAR-1');
    writeFeature(cwd, { ...f, status: 'KILLED' });
    await assert.rejects(
      () => proposeFollowup(cwd, { parent_code: 'PAR-1', description: 'd', rationale: 'r' }),
      err => err.code === 'PARENT_TERMINAL'
    );
  });

  test('PARENT_TERMINAL when parent SUPERSEDED', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    const f = readFeature(cwd, 'PAR-1');
    writeFeature(cwd, { ...f, status: 'SUPERSEDED' });
    await assert.rejects(
      () => proposeFollowup(cwd, { parent_code: 'PAR-1', description: 'd', rationale: 'r' }),
      err => err.code === 'PARENT_TERMINAL'
    );
  });
});

describe('proposeFollowup — idempotency', () => {
  test('same key returns same result without mutating', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    const r1 = await proposeFollowup(cwd, {
      parent_code: 'PAR-1', description: 'd', rationale: 'r',
      idempotency_key: 'k1',
    });
    const r2 = await proposeFollowup(cwd, {
      parent_code: 'PAR-1', description: 'd', rationale: 'r',
      idempotency_key: 'k1',
    });
    assert.deepEqual(r1, r2);
    // Only one feature should exist
    const events = readEvents(cwd, { tool: 'propose_followup' });
    assert.equal(events.length, 1);
  });

  test('cache key namespacing: same key, different parents → distinct codes', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await addRoadmapEntry(cwd, {
      code: 'OTHER-1', description: 'other', phase: 'Phase 0',
    });
    const r1 = await proposeFollowup(cwd, {
      parent_code: 'PAR-1', description: 'd', rationale: 'r', idempotency_key: 'shared',
    });
    const r2 = await proposeFollowup(cwd, {
      parent_code: 'OTHER-1', description: 'd', rationale: 'r', idempotency_key: 'shared',
    });
    assert.equal(r1.code, 'PAR-1-1');
    assert.equal(r2.code, 'OTHER-1-1');
  });

  test('INVALID_INPUT when same key reused with different description', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    // Seed an inflight ledger by interrupting at link stage. Easier path:
    // call once successfully, ledger is gone, so we simulate by calling
    // once successfully then calling again with the same key but different
    // description — the cache should hit and return the *cached* result
    // (no mutation), which actually will silently succeed under the current
    // implementation. To exercise the fingerprint check, we need a
    // *partial* state (ledger present, no cache). We seed by writing a
    // ledger directly.
    const code = 'PAR-1-1';
    const ledgerDir = join(cwd, '.compose', 'inflight-followups');
    mkdirSync(ledgerDir, { recursive: true });
    const fp = _internals.fingerprint({
      parent_code: 'PAR-1',
      description: 'original',
      rationale: 'r',
      phase: 'Phase 0',
      status: 'PLANNED',
    });
    const key = 'replay-key';
    const ledgerPath = _internals.ledgerPath(cwd, key, 'PAR-1');
    mkdirSync(join(ledgerPath, '..'), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({
      idempotency_key: key,
      parent_code: 'PAR-1',
      allocated_code: code,
      stage: 'roadmap_done',
      request_fingerprint: fp,
      ts: new Date().toISOString(),
    }));
    await assert.rejects(
      () => proposeFollowup(cwd, {
        parent_code: 'PAR-1',
        description: 'changed',  // different
        rationale: 'r',
        idempotency_key: key,
      }),
      err => err.code === 'INVALID_INPUT' && /different arguments/.test(err.message)
    );
  });

  test('crash between cache-write and ledger-delete: replay hits cache', async () => {
    // Simulate the crash window by calling once successfully, then
    // re-creating the inflight ledger as if the post-cache delete never
    // happened. The next same-key call must hit the cache and return the
    // same result without re-allocating.
    const cwd = freshCwd();
    await seedParent(cwd);
    const r1 = await proposeFollowup(cwd, {
      parent_code: 'PAR-1', description: 'd', rationale: 'r',
      idempotency_key: 'crash-window',
    });

    // Reseed the inflight ledger (as if delete had failed)
    const fp = _internals.fingerprint({
      parent_code: 'PAR-1', description: 'd', rationale: 'r',
      phase: 'Phase 0', status: 'PLANNED',
    });
    const lp = _internals.ledgerPath(cwd, 'crash-window', 'PAR-1');
    mkdirSync(join(lp, '..'), { recursive: true });
    writeFileSync(lp, JSON.stringify({
      idempotency_key: 'crash-window',
      parent_code: 'PAR-1',
      allocated_code: 'PAR-1-1',
      stage: 'scaffold_done',
      request_fingerprint: fp,
      ts: new Date().toISOString(),
    }));

    const r2 = await proposeFollowup(cwd, {
      parent_code: 'PAR-1', description: 'd', rationale: 'r',
      idempotency_key: 'crash-window',
    });
    // Cache hit returns the same result; no new allocation
    assert.deepEqual(r2, r1);
    // Stale ledger gets cleaned up by the post-cache delete
    assert.equal(existsSync(lp), false);
  });

  test('cross-parent partial state: same key on different parents does NOT collide', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await addRoadmapEntry(cwd, {
      code: 'OTHER-1', description: 'other parent', phase: 'Phase 0',
    });
    // Seed a partial ledger for parent PAR-1, key 'shared'
    const fpA = _internals.fingerprint({
      parent_code: 'PAR-1', description: 'd-a', rationale: 'r-a',
      phase: 'Phase 0', status: 'PLANNED',
    });
    const lpA = _internals.ledgerPath(cwd, 'shared', 'PAR-1');
    mkdirSync(join(lpA, '..'), { recursive: true });
    writeFileSync(lpA, JSON.stringify({
      idempotency_key: 'shared',
      parent_code: 'PAR-1',
      allocated_code: 'PAR-1-1',
      stage: 'roadmap_done',  // pretend roadmap committed but rest pending
      request_fingerprint: fpA,
      ts: new Date().toISOString(),
    }));

    // Now call propose_followup on OTHER-1 with the same key — must NOT
    // see PAR-1's ledger; must succeed and allocate OTHER-1-1.
    const r = await proposeFollowup(cwd, {
      parent_code: 'OTHER-1',
      description: 'd-b',
      rationale: 'r-b',
      idempotency_key: 'shared',
    });
    assert.equal(r.code, 'OTHER-1-1');

    // Parent PAR-1's ledger remains untouched
    assert.ok(existsSync(lpA));
  });

  test('without key, repeated calls allocate new codes', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    const r1 = await proposeFollowup(cwd, {
      parent_code: 'PAR-1', description: 'd', rationale: 'r',
    });
    const r2 = await proposeFollowup(cwd, {
      parent_code: 'PAR-1', description: 'd', rationale: 'r',
    });
    assert.equal(r1.code, 'PAR-1-1');
    assert.equal(r2.code, 'PAR-1-2');
  });
});

describe('proposeFollowup — internals', () => {
  test('sha16 is 16 hex chars and stable', () => {
    const a = _internals.sha16('hello');
    const b = _internals.sha16('hello');
    assert.equal(a, b);
    assert.equal(a.length, 16);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  test('nextNumberedCode handles empty namespace', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    assert.equal(_internals.nextNumberedCode(cwd, 'PAR-1'), 'PAR-1-1');
  });

  test('nextNumberedCode handles gaps (uses max+1 not next-free)', async () => {
    const cwd = freshCwd();
    await seedParent(cwd);
    await addRoadmapEntry(cwd, { code: 'PAR-1-3', description: 'x', phase: 'P', parent: 'PAR-1' });
    assert.equal(_internals.nextNumberedCode(cwd, 'PAR-1'), 'PAR-1-4');
  });

  test('fingerprint is stable on same args', () => {
    const a = _internals.fingerprint({
      parent_code: 'X', description: 'd', rationale: 'r',
    });
    const b = _internals.fingerprint({
      parent_code: 'X', description: 'd', rationale: 'r',
    });
    assert.equal(a, b);
  });

  test('fingerprint differs on description change', () => {
    const a = _internals.fingerprint({
      parent_code: 'X', description: 'd', rationale: 'r',
    });
    const b = _internals.fingerprint({
      parent_code: 'X', description: 'd2', rationale: 'r',
    });
    assert.notEqual(a, b);
  });
});
