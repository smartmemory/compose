// test/gsd-crash-recovery.test.js
//
// COMP-GSD-6 S04: crash-recovery primitives in lib/gsd.js —
//   - the run.lock live-run exclusion + dead-owner takeover
//   - loadResumeTaskGraph's state.json crash-bridge (a hard crash never wrote
//     pause.json; recover from the last running+dead-pid checkpoint)

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEAD_PID = 999999;
const FEATURE = 'COMP-GSD-6';

let gsd, state;
let cwd;

function gdir() {
  return join(cwd, '.compose', 'gsd', FEATURE);
}
function seedState(patch) {
  return state.writeGsdState(cwd, FEATURE, {
    feature: FEATURE, pid: DEAD_PID, mode: 'gsd', phase: 'execute',
    status: 'running', resumeReady: true,
    decomposedTasks: [{ id: 'T01', depends_on: [], description: 'a' },
                      { id: 'T02', depends_on: ['T01'], description: 'b' }],
    completedTaskIds: ['T01'],
    ...patch,
  });
}

describe('gsd crash-recovery', () => {
  beforeEach(async () => {
    gsd = await import(`${REPO_ROOT}/lib/gsd.js`);
    state = await import(`${REPO_ROOT}/lib/gsd-state.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-crash-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  describe('run.lock exclusion + takeover', () => {
    test('fresh claim creates run.lock + owner.json with our pid', () => {
      gsd.claimRunLock(cwd, FEATURE);
      assert.ok(existsSync(join(gdir(), 'run.lock')), 'run.lock dir created');
      assert.ok(existsSync(join(gdir(), 'run.lock', 'owner.json')), 'owner.json written');
      gsd.releaseRunLock(cwd, FEATURE);
      assert.ok(!existsSync(join(gdir(), 'run.lock')), 'release removes the lock');
    });

    test('a second claim refuses while a LIVE owner holds the lock', () => {
      gsd.claimRunLock(cwd, FEATURE); // owner = this (alive) process
      assert.throws(
        () => gsd.claimRunLock(cwd, FEATURE),
        /another gsd run owns|alive/i,
        'live-owner lock must not be taken over',
      );
    });

    test('takes over a stale run.lock whose owner pid is dead', () => {
      mkdirSync(join(gdir(), 'run.lock'), { recursive: true });
      writeFileSync(join(gdir(), 'run.lock', 'owner.json'),
        JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }));
      // Dead owner → takeover succeeds, owner.json now ours.
      assert.doesNotThrow(() => gsd.claimRunLock(cwd, FEATURE));
      const owner = JSON.parse(
        readFileSync(join(gdir(), 'run.lock', 'owner.json'), 'utf-8'),
      );
      assert.equal(owner.pid, process.pid, 'takeover rewrote owner to our pid');
    });
  });

  describe('fresh run clears stale state (fix: prior-run misclassification)', () => {
    test('a fresh run clears a prior run\'s stale state.json before preconditions', async () => {
      // A prior run left a 'complete' checkpoint.
      seedState({ status: 'complete', phase: 'done' });
      // This fresh run fails a precondition (no blueprint) — but only AFTER the
      // up-front clear, so no stale 'complete' survives to mislead the supervisor.
      await assert.rejects(() => gsd.runGsd(FEATURE, { cwd }), /blueprint missing/i);
      assert.equal(state.readGsdState(cwd, FEATURE), null, 'stale state.json was cleared on the fresh run');
    });

    test('a resume run does NOT clear state.json (the crash-bridge may need it)', async () => {
      seedState({}); // running + dead pid + task graph, no pause.json
      // Resume with no blueprint still throws on the precondition, but the state
      // must survive so a subsequent attempt can still recover.
      await assert.rejects(() => gsd.runGsd(FEATURE, { cwd, resume: true }), /blueprint missing/i);
      assert.ok(state.readGsdState(cwd, FEATURE), 'resume preserved state.json for recovery');
    });
  });

  describe('loadResumeTaskGraph crash-bridge (no pause.json)', () => {
    test('synthesizes resume from a running+dead-pid state.json with a task graph', () => {
      seedState({});
      assert.ok(!existsSync(join(gdir(), 'pause.json')), 'precondition: no pause.json');
      const { tasks } = gsd.loadResumeTaskGraph(cwd, FEATURE, { claim: false });
      assert.deepEqual(tasks.map((t) => t.id), ['T02'], 'only the uncompleted task is re-dispatched');
      // T02 depended on the completed T01 — that dep is stripped.
      assert.deepEqual(tasks[0].depends_on, [], 'completed dep removed from the resumed task');
    });

    test('refuses (throws) when state.json has an EMPTY task graph (crashed pre-decompose)', () => {
      seedState({ resumeReady: false, decomposedTasks: [], completedTaskIds: [] });
      assert.throws(
        () => gsd.loadResumeTaskGraph(cwd, FEATURE, { claim: false }),
        /no pause\.json to resume/i,
        'an early crash with no task graph is not resumable here (supervisor restarts fresh)',
      );
    });

    test('refuses when the state.json pid is still ALIVE (not a crash)', () => {
      seedState({ pid: process.pid });
      assert.throws(
        () => gsd.loadResumeTaskGraph(cwd, FEATURE, { claim: false }),
        /no pause\.json to resume/i,
        'a live pid means the run is not crashed — no bridge',
      );
    });

    test('pause.json still takes precedence over the state.json bridge', () => {
      seedState({});
      // A real pause.json (dead original pid) should be used directly.
      writeFileSync(join(gdir(), 'pause.json'), JSON.stringify({
        flowId: 'f1', stepId: 'execute', stuckTaskId: 'T02', signal: 'no_progress', detail: 'x',
        decomposedTasks: [{ id: 'T02', depends_on: [], description: 'from pause' }],
        completedTaskIds: [], pid: DEAD_PID, mode: 'gsd', ts: new Date().toISOString(),
      }));
      const { tasks } = gsd.loadResumeTaskGraph(cwd, FEATURE, { claim: false });
      assert.deepEqual(tasks.map((t) => t.id), ['T02']);
      assert.equal(tasks[0].description, 'from pause', 'used pause.json, not state.json');
    });
  });
});
