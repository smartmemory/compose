// test/gsd-events.test.js
//
// COMP-GSD-7-EVENTLOG: append-only run-event log I/O.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEATURE = 'COMP-GSD-7-EVENTLOG';

let mod, cwd;

describe('gsd-events', () => {
  beforeEach(async () => {
    mod = await import(`${REPO_ROOT}/lib/gsd-events.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-events-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test('eventsPath points at .compose/gsd/<f>/events.jsonl', () => {
    assert.equal(mod.gsdEventsPath(cwd, FEATURE), join(cwd, '.compose', 'gsd', FEATURE, 'events.jsonl'));
  });

  test('append then read round-trips, in order', () => {
    mod.appendGsdEvent(cwd, FEATURE, 'run_started', { mode: 'fresh', attempt: 1 });
    mod.appendGsdEvent(cwd, FEATURE, 'task_completed', { taskId: 'T01' });
    mod.appendGsdEvent(cwd, FEATURE, 'completed');
    const ev = mod.readGsdEvents(cwd, FEATURE);
    assert.equal(ev.length, 3);
    assert.equal(ev[0].kind, 'run_started');
    assert.equal(ev[0].mode, 'fresh');
    assert.equal(ev[1].kind, 'task_completed');
    assert.equal(ev[1].taskId, 'T01');
    assert.equal(ev[2].kind, 'completed');
    assert.ok(ev[0].ts, 'stamps ts');
  });

  test('detail cannot clobber the event kind (paused → pauseKind)', () => {
    mod.appendGsdEvent(cwd, FEATURE, 'paused', { pauseKind: 'stuck', taskId: 'T02' });
    const [e] = mod.readGsdEvents(cwd, FEATURE);
    assert.equal(e.kind, 'paused', 'event kind preserved');
    assert.equal(e.pauseKind, 'stuck');
  });

  test('read skips torn/corrupt lines but keeps valid ones', () => {
    mod.appendGsdEvent(cwd, FEATURE, 'run_started', { mode: 'fresh' });
    appendFileSync(mod.gsdEventsPath(cwd, FEATURE), '{ this is not json\n');
    mod.appendGsdEvent(cwd, FEATURE, 'completed');
    const ev = mod.readGsdEvents(cwd, FEATURE);
    assert.equal(ev.length, 2, 'two valid events, corrupt line skipped');
    assert.deepEqual(ev.map((e) => e.kind), ['run_started', 'completed']);
  });

  test('read on absent file → []', () => {
    assert.deepEqual(mod.readGsdEvents(cwd, FEATURE), []);
  });

  test('clear truncates to zero events (file may remain empty)', () => {
    mod.appendGsdEvent(cwd, FEATURE, 'run_started', { mode: 'fresh' });
    mod.clearGsdEvents(cwd, FEATURE);
    assert.deepEqual(mod.readGsdEvents(cwd, FEATURE), []);
  });

  test('append after clear starts a new log', () => {
    mod.appendGsdEvent(cwd, FEATURE, 'failed', { reason: 'old run' });
    mod.clearGsdEvents(cwd, FEATURE);
    mod.appendGsdEvent(cwd, FEATURE, 'run_started', { mode: 'fresh' });
    const ev = mod.readGsdEvents(cwd, FEATURE);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'run_started');
  });

  test('append is best-effort: a bad cwd does not throw', () => {
    // an un-creatable path should be swallowed, not thrown
    mod.appendGsdEvent('\0/nope', FEATURE, 'run_started', {});
    assert.ok(true);
  });
});
