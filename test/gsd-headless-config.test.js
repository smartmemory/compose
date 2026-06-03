// test/gsd-headless-config.test.js
//
// COMP-GSD-6 S05: headless auto-resume policy resolution + backoff.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod, cwd;

function writeConfig(obj) {
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify(obj, null, 2));
}

describe('gsd-headless-config', () => {
  beforeEach(async () => {
    mod = await import(`${REPO_ROOT}/lib/gsd-headless-config.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-hcfg-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test('defaults: crash+stuck auto-resume, budget does NOT', () => {
    const c = mod.readHeadlessConfig(cwd); // no config file
    assert.equal(c.autoResume.crash.enabled, true);
    assert.equal(c.autoResume.crash.maxAttempts, 5);
    assert.equal(c.autoResume.stuck.enabled, true);
    assert.equal(c.autoResume.stuck.maxAttempts, 2);
    assert.equal(c.autoResume.budget.enabled, false, 'budget never auto-resumes by default (protects GSD-4 ceiling)');
    assert.equal(c.heartbeatStaleMs, 90000);
  });

  test('every pause kind is overridable — budget can be opted in', () => {
    writeConfig({ gsd: { headless: { autoResume: { budget: { enabled: true, maxAttempts: 3 } } } } });
    const c = mod.readHeadlessConfig(cwd);
    assert.deepEqual(c.autoResume.budget, { enabled: true, maxAttempts: 3 });
    // unspecified kinds keep defaults
    assert.equal(c.autoResume.crash.enabled, true);
    assert.equal(c.autoResume.stuck.maxAttempts, 2);
  });

  test('partial overrides merge; malformed fields fall back (never throw)', () => {
    writeConfig({ gsd: { headless: {
      autoResume: { crash: { maxAttempts: 'lots' } }, // bad type → default 5
      backoff: { baseMs: 500 },
      heartbeatStaleMs: -1, // invalid (<0) → default
    } } });
    const c = mod.readHeadlessConfig(cwd);
    assert.equal(c.autoResume.crash.maxAttempts, 5, 'bad maxAttempts → default');
    assert.equal(c.autoResume.crash.enabled, true);
    assert.equal(c.backoff.baseMs, 500, 'valid override applied');
    assert.equal(c.backoff.factor, 2, 'unspecified backoff field → default');
    assert.equal(c.heartbeatStaleMs, 90000, 'negative stale → default');
  });

  test('malformed compose.json → all defaults', () => {
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), '{ not json');
    const c = mod.readHeadlessConfig(cwd);
    assert.deepEqual(c, mod.resolveHeadlessConfig({}));
  });

  test('COMP-GSD-6-WATCHDOG: hung auto-resumes by default + watchdog timings', () => {
    const c = mod.readHeadlessConfig(cwd); // no config
    assert.deepEqual(c.autoResume.hung, { enabled: true, maxAttempts: 3 });
    assert.equal(c.watchdogPollMs, 15000);
    assert.equal(c.watchdogKillGraceMs, 5000);
    assert.equal(c.watchdogHeartbeatMs, 30000);
  });

  test('COMP-GSD-6-WATCHDOG: hung policy + watchdog timings are overridable; bad types → default', () => {
    writeConfig({ gsd: { headless: {
      autoResume: { hung: { enabled: false, maxAttempts: 1 } },
      watchdogPollMs: 5000,
      watchdogKillGraceMs: 'soon', // bad → default 5000
      watchdogHeartbeatMs: 10000,
    } } });
    const c = mod.readHeadlessConfig(cwd);
    assert.deepEqual(c.autoResume.hung, { enabled: false, maxAttempts: 1 });
    assert.equal(c.watchdogPollMs, 5000, 'valid override');
    assert.equal(c.watchdogKillGraceMs, 5000, 'bad type → default');
    assert.equal(c.watchdogHeartbeatMs, 10000);
    // unspecified kinds keep defaults
    assert.equal(c.autoResume.crash.enabled, true);
  });

  test('backoffMs: exponential, capped at maxMs', () => {
    const c = mod.resolveHeadlessConfig({ backoff: { baseMs: 1000, factor: 2, maxMs: 5000 } });
    assert.equal(mod.backoffMs(c, 1), 1000); // 1000 * 2^0
    assert.equal(mod.backoffMs(c, 2), 2000); // 2^1
    assert.equal(mod.backoffMs(c, 3), 4000); // 2^2
    assert.equal(mod.backoffMs(c, 4), 5000); // 8000 capped → 5000
    assert.equal(mod.backoffMs(c, 10), 5000); // capped
  });
});
