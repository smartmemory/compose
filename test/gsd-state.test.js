// test/gsd-state.test.js
//
// COMP-GSD-6 S01: gsd-state foundation — atomic state.json I/O + reader-side
// run-status derivation (crash detection via dead-pid; heartbeat advisory only).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A pid that cannot exist on darwin (default pid_max ~99998) — guaranteed ESRCH.
const DEAD_PID = 999999;

let mod;
let cwd;
const FEATURE = 'COMP-GSD-6';

describe('gsd-state', () => {
  beforeEach(async () => {
    mod = await import(`${REPO_ROOT}/lib/gsd-state.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-state-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('gsdStatePath points at .compose/gsd/<feature>/state.json', () => {
    assert.equal(
      mod.gsdStatePath(cwd, FEATURE),
      join(cwd, '.compose', 'gsd', FEATURE, 'state.json'),
    );
  });

  test('write then read round-trips and stamps heartbeatAt', () => {
    const written = mod.writeGsdState(cwd, FEATURE, {
      feature: FEATURE,
      flowId: null,
      pid: process.pid,
      mode: 'gsd',
      phase: 'planning',
      status: 'running',
      resumeReady: false,
      decomposedTasks: [],
      completedTaskIds: [],
    });
    assert.ok(written.heartbeatAt, 'write stamps heartbeatAt');
    const read = mod.readGsdState(cwd, FEATURE);
    assert.equal(read.status, 'running');
    assert.equal(read.phase, 'planning');
    assert.equal(read.heartbeatAt, written.heartbeatAt);
  });

  test('write is atomic — no .tmp file left behind', () => {
    mod.writeGsdState(cwd, FEATURE, { feature: FEATURE, status: 'running', pid: process.pid });
    const dir = join(cwd, '.compose', 'gsd', FEATURE);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no temp files remain after atomic write');
  });

  test('readGsdState returns null when absent', () => {
    assert.equal(mod.readGsdState(cwd, FEATURE), null);
  });

  test('readGsdState tolerates corrupt JSON', () => {
    mod.writeGsdState(cwd, FEATURE, { feature: FEATURE, status: 'running', pid: process.pid });
    const p = mod.gsdStatePath(cwd, FEATURE);
    writeFileSync(p, '{ not json');
    assert.equal(mod.readGsdState(cwd, FEATURE), null);
  });

  test('pidAlive: live process true, dead pid false', () => {
    assert.equal(mod.pidAlive(process.pid), true);
    assert.equal(mod.pidAlive(DEAD_PID), false);
    assert.equal(mod.pidAlive(undefined), false);
    assert.equal(mod.pidAlive(0), false);
  });

  describe('deriveRunStatus', () => {
    const now = Date.parse('2026-06-03T12:00:00Z');
    const iso = (ms) => new Date(now - ms).toISOString();

    test('null state → absent', () => {
      assert.deepEqual(mod.deriveRunStatus(null, { now }), { status: 'absent', heartbeatStale: false });
    });

    test('running + live pid + fresh heartbeat → running, not stale', () => {
      const r = mod.deriveRunStatus(
        { status: 'running', pid: process.pid, heartbeatAt: iso(1000) },
        { now, staleMs: 90000 },
      );
      assert.deepEqual(r, { status: 'running', heartbeatStale: false });
    });

    test('running + dead pid → crashed (dead-pid authoritative, ignores heartbeat)', () => {
      const r = mod.deriveRunStatus(
        { status: 'running', pid: DEAD_PID, heartbeatAt: iso(1000) },
        { now, staleMs: 90000 },
      );
      assert.equal(r.status, 'crashed');
    });

    test('running + live pid + STALE heartbeat → still running, heartbeatStale flag (never crashed)', () => {
      const r = mod.deriveRunStatus(
        { status: 'running', pid: process.pid, heartbeatAt: iso(120000) },
        { now, staleMs: 90000 },
      );
      assert.deepEqual(r, { status: 'running', heartbeatStale: true });
    });

    for (const terminal of ['complete', 'stuck', 'budget', 'failed']) {
      test(`terminal status "${terminal}" passes through regardless of pid`, () => {
        const r = mod.deriveRunStatus({ status: terminal, pid: DEAD_PID }, { now });
        assert.deepEqual(r, { status: terminal, heartbeatStale: false });
      });
    }
  });
});
