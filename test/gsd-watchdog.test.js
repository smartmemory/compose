// test/gsd-watchdog.test.js
//
// COMP-GSD-6-WATCHDOG: the watchdog primitives — defaultWatch (confirm-poll),
// defaultKillChild (SIGTERM→grace→SIGKILL), and clearGsdPause.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEATURE = 'COMP-GSD-6-WATCHDOG';

let sup, state, cfgMod, cwd, cfg;

const running = (hbAt) => ({ feature: FEATURE, status: 'running', pid: 4242, resumeReady: true, heartbeatStale: true, heartbeatAt: hbAt });

// Drive defaultWatch with a scripted sequence of query snapshots. After the
// sequence is consumed, abort the loop (returns a benign non-stale snap).
function watchHarness(snaps) {
  const ac = new AbortController();
  let i = 0;
  const query = () => {
    const s = snaps[i]; i += 1;
    if (s === undefined) { ac.abort(); return { status: 'running', heartbeatStale: false }; }
    return s;
  };
  return { signal: ac.signal, buildQuery: query, sleep: async () => {} };
}

describe('gsd-watchdog', () => {
  beforeEach(async () => {
    sup = await import(`${REPO_ROOT}/lib/gsd-supervisor.js`);
    state = await import(`${REPO_ROOT}/lib/gsd-state.js`);
    cfgMod = await import(`${REPO_ROOT}/lib/gsd-headless-config.js`);
    cfg = cfgMod.resolveHeadlessConfig({});
    cwd = mkdtempSync(join(tmpdir(), 'gsd-wd-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  describe('defaultWatch (confirm-poll)', () => {
    test('heartbeat frozen across two stale polls → hung', async () => {
      const h = watchHarness([running('A'), running('A')]);
      const r = await sup.defaultWatch({ feature: FEATURE, cwd, cfg, ...h });
      assert.ok(r, 'declared hung');
      assert.equal(r.heartbeatAt, 'A');
      assert.equal(r.pid, 4242);
    });

    test('heartbeat ADVANCES between stale polls → never hung (suspend/clock-jump)', async () => {
      // Each poll is stale but heartbeatAt keeps advancing — a just-woken healthy
      // child re-stamping. Must NOT be killed.
      const h = watchHarness([running('A'), running('B'), running('C')]);
      const r = await sup.defaultWatch({ feature: FEATURE, cwd, cfg, ...h });
      assert.equal(r, null, 'advancing heartbeat resets the confirmation');
    });

    test('a non-running poll resets the confirmation', async () => {
      const h = watchHarness([running('A'), { status: 'complete', heartbeatStale: false }, running('A')]);
      const r = await sup.defaultWatch({ feature: FEATURE, cwd, cfg, ...h });
      assert.equal(r, null, 'intervening healthy poll prevents a stale-but-same hbAt from firing');
    });

    test('fresh heartbeat (not stale) never declares hung', async () => {
      const h = watchHarness([
        { status: 'running', heartbeatStale: false, heartbeatAt: 'A' },
        { status: 'running', heartbeatStale: false, heartbeatAt: 'A' },
      ]);
      const r = await sup.defaultWatch({ feature: FEATURE, cwd, cfg, ...h });
      assert.equal(r, null);
    });

    test('already-aborted signal → immediate null', async () => {
      const ac = new AbortController();
      ac.abort();
      const r = await sup.defaultWatch({ feature: FEATURE, cwd, cfg, signal: ac.signal, sleep: async () => {}, buildQuery: () => running('A') });
      assert.equal(r, null);
    });
  });

  describe('defaultKillChild', () => {
    test('SIGTERM, then SIGKILL after grace when still alive', async () => {
      const sent = [];
      await sup.defaultKillChild(4242, cfg, {
        kill: (pid, sig) => sent.push([pid, sig]),
        sleep: async () => {},
        isAlive: () => true, // survives SIGTERM
      });
      assert.deepEqual(sent, [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
    });

    test('SIGTERM only when the child dies within the grace window', async () => {
      const sent = [];
      await sup.defaultKillChild(4242, cfg, {
        kill: (pid, sig) => sent.push([pid, sig]),
        sleep: async () => {},
        isAlive: () => false, // gone after SIGTERM
      });
      assert.deepEqual(sent, [[4242, 'SIGTERM']]);
    });

    test('no pid → no-op (no signals)', async () => {
      const sent = [];
      await sup.defaultKillChild(null, cfg, { kill: (p, s) => sent.push([p, s]), sleep: async () => {}, isAlive: () => true });
      assert.equal(sent.length, 0);
    });

    test('SIGTERM on an already-dead pid (ESRCH) does not throw', async () => {
      await sup.defaultKillChild(4242, cfg, {
        kill: () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; },
        sleep: async () => {},
        isAlive: () => false,
      });
      // reaching here without throwing is the assertion
      assert.ok(true);
    });
  });

  describe('clearGsdPause', () => {
    test('removes an existing pause.json', () => {
      const dir = join(cwd, '.compose', 'gsd', FEATURE);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'pause.json'), '{}');
      state.clearGsdPause(cwd, FEATURE);
      assert.ok(!existsSync(join(dir, 'pause.json')));
    });

    test('no-throw when pause.json is absent', () => {
      state.clearGsdPause(cwd, FEATURE); // dir doesn't even exist
      assert.ok(true);
    });
  });
});
