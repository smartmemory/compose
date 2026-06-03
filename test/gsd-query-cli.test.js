// test/gsd-query-cli.test.js
//
// COMP-GSD-6 S07: `compose gsd query <feature>` — instant JSON snapshot.
// Spawns the real CLI (no server/LLM) and asserts on parsed stdout + exit code.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');
const DEAD_PID = 999999;
const FEATURE = 'COMP-GSD-6';

let cwd;

function gdir() {
  const d = join(cwd, '.compose', 'gsd', FEATURE);
  mkdirSync(d, { recursive: true });
  return d;
}
function writeState(obj) {
  writeFileSync(join(gdir(), 'state.json'), JSON.stringify({ ...obj, heartbeatAt: new Date().toISOString() }, null, 2));
}
function query() {
  const r = spawnSync(process.execPath, [COMPOSE_BIN, 'gsd', 'query', FEATURE, '--cwd', cwd], {
    encoding: 'utf8', timeout: 15000,
  });
  return r;
}

describe('compose gsd query (CLI)', () => {
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'gsd-query-cli-')); });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test('absent run → status absent, exit 3', () => {
    const r = query();
    assert.equal(r.status, 3);
    assert.equal(JSON.parse(r.stdout).status, 'absent');
  });

  test('running + live pid → running, progress, exit 0', () => {
    writeState({
      feature: FEATURE, pid: process.pid, mode: 'gsd', phase: 'execute', status: 'running',
      resumeReady: true,
      decomposedTasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }],
      completedTaskIds: ['T01'],
    });
    const r = query();
    assert.equal(r.status, 0);
    const snap = JSON.parse(r.stdout);
    assert.equal(snap.status, 'running');
    assert.deepEqual(snap.progress, { completed: 1, total: 3 });
    assert.equal(snap.resumeReady, true);
  });

  test('running + dead pid → crashed, exit 0', () => {
    writeState({
      feature: FEATURE, pid: DEAD_PID, mode: 'gsd', phase: 'execute', status: 'running',
      resumeReady: true, decomposedTasks: [{ id: 'T01' }], completedTaskIds: [],
    });
    const r = query();
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).status, 'crashed');
  });

  test('terminal complete passes through', () => {
    writeState({ feature: FEATURE, pid: DEAD_PID, mode: 'gsd', phase: 'done', status: 'complete' });
    assert.equal(JSON.parse(query().stdout).status, 'complete');
  });

  test('pause.json (no state.json) → its kind', () => {
    writeFileSync(join(gdir(), 'pause.json'), JSON.stringify({
      kind: 'budget', flowId: 'f', stepId: 'execute', decomposedTasks: [{ id: 'T01' }],
      completedTaskIds: [], pid: DEAD_PID, mode: 'gsd', ts: new Date().toISOString(),
      budget: { axis: 'usd', caps: {}, consumed: {} },
    }));
    assert.equal(JSON.parse(query().stdout).status, 'budget');
  });

  test('budget.json cumulative refusal (no state, no pause) → budget, not absent', () => {
    writeFileSync(join(gdir(), 'budget.json'), JSON.stringify({
      feature: FEATURE, kind: 'budget', axis: 'cumulative', reason: 'spent', ts: new Date().toISOString(),
    }));
    const r = query();
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).status, 'budget');
  });
});
