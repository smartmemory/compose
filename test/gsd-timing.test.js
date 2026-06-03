// test/gsd-timing.test.js
//
// COMP-GSD-7 S1: per-task timing sidecar (.compose/gsd/<f>/timing.json) —
// atomic I/O + the pure recordTaskStates poll accumulator.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEATURE = 'COMP-GSD-7';

let mod;
let cwd;

describe('gsd-timing', () => {
  beforeEach(async () => {
    mod = await import(`${REPO_ROOT}/lib/gsd-timing.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-timing-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('timingSidecarPath points at .compose/gsd/<feature>/timing.json', () => {
    assert.equal(
      mod.timingSidecarPath(cwd, FEATURE),
      join(cwd, '.compose', 'gsd', FEATURE, 'timing.json'),
    );
  });

  test('write then read round-trips the map', () => {
    const map = { 'task-a': { startedAt: '2026-06-03T00:00:00.000Z', completedAt: '2026-06-03T00:00:05.000Z', durationMs: 5000 } };
    mod.writeTimingSidecar(cwd, FEATURE, map);
    assert.ok(existsSync(mod.timingSidecarPath(cwd, FEATURE)));
    assert.deepEqual(mod.readTimingSidecar(cwd, FEATURE), map);
  });

  test('read returns {} when absent', () => {
    assert.deepEqual(mod.readTimingSidecar(cwd, FEATURE), {});
  });

  test('read returns {} on unreadable/corrupt JSON', () => {
    const p = mod.timingSidecarPath(cwd, FEATURE);
    mod.writeTimingSidecar(cwd, FEATURE, {}); // ensures dir exists
    // corrupt it
    writeFileSync(p, '{ not json');
    assert.deepEqual(mod.readTimingSidecar(cwd, FEATURE), {});
  });

  test('write leaves no .tmp sibling behind', () => {
    mod.writeTimingSidecar(cwd, FEATURE, { x: { startedAt: 't' } });
    assert.ok(!existsSync(`${mod.timingSidecarPath(cwd, FEATURE)}.tmp`));
  });

  describe('recordTaskStates', () => {
    test('first sight stamps startedAt; terminal stamps completedAt + durationMs', () => {
      const m = {};
      mod.recordTaskStates(m, { a: { state: 'running' } }, '2026-06-03T00:00:00.000Z');
      assert.equal(m.a.startedAt, '2026-06-03T00:00:00.000Z');
      assert.equal(m.a.completedAt, undefined);

      mod.recordTaskStates(m, { a: { state: 'complete' } }, '2026-06-03T00:00:03.000Z');
      assert.equal(m.a.startedAt, '2026-06-03T00:00:00.000Z'); // unchanged
      assert.equal(m.a.completedAt, '2026-06-03T00:00:03.000Z');
      assert.equal(m.a.durationMs, 3000);
    });

    test('does not overwrite an existing startedAt or completedAt', () => {
      const m = {};
      mod.recordTaskStates(m, { a: { state: 'running' } }, '2026-06-03T00:00:00.000Z');
      mod.recordTaskStates(m, { a: { state: 'running' } }, '2026-06-03T00:00:09.000Z');
      assert.equal(m.a.startedAt, '2026-06-03T00:00:00.000Z'); // first sight wins
      mod.recordTaskStates(m, { a: { state: 'complete' } }, '2026-06-03T00:00:04.000Z');
      mod.recordTaskStates(m, { a: { state: 'complete' } }, '2026-06-03T00:00:20.000Z');
      assert.equal(m.a.completedAt, '2026-06-03T00:00:04.000Z'); // first terminal wins
      assert.equal(m.a.durationMs, 4000);
    });

    test('terminal states failed and cancelled also stamp completion', () => {
      for (const st of ['failed', 'cancelled']) {
        const m = {};
        mod.recordTaskStates(m, { a: { state: 'running' } }, '2026-06-03T00:00:00.000Z');
        mod.recordTaskStates(m, { a: { state: st } }, '2026-06-03T00:00:02.000Z');
        assert.equal(m.a.completedAt, '2026-06-03T00:00:02.000Z', st);
        assert.equal(m.a.durationMs, 2000, st);
      }
    });

    test('a task first seen already terminal still gets startedAt==completedAt, duration 0', () => {
      const m = {};
      mod.recordTaskStates(m, { a: { state: 'complete' } }, '2026-06-03T00:00:00.000Z');
      assert.equal(m.a.startedAt, '2026-06-03T00:00:00.000Z');
      assert.equal(m.a.completedAt, '2026-06-03T00:00:00.000Z');
      assert.equal(m.a.durationMs, 0);
    });

    test('null/empty pollTasks is a no-op', () => {
      const m = { a: { startedAt: 't' } };
      mod.recordTaskStates(m, null, '2026-06-03T00:00:00.000Z');
      mod.recordTaskStates(m, {}, '2026-06-03T00:00:00.000Z');
      assert.deepEqual(m, { a: { startedAt: 't' } });
    });

    test('returns the same map reference (mutates in place)', () => {
      const m = {};
      assert.equal(mod.recordTaskStates(m, { a: { state: 'running' } }, 't'), m);
    });
  });
});
