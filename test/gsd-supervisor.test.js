// test/gsd-supervisor.test.js
//
// COMP-GSD-6 S06: the --headless supervisor — classification + auto-resume loop.
// The child is mocked via an injected spawnRun that seeds state.json to simulate
// each attempt's outcome; sleep is a no-op so backoff doesn't slow the suite.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEAD_PID = 999999;
const FEATURE = 'COMP-GSD-6';

let sup, state, cfgMod, cwd;

const base = (over) => ({
  feature: FEATURE, pid: DEAD_PID, mode: 'gsd', phase: 'execute',
  status: 'running', resumeReady: true,
  decomposedTasks: [{ id: 'T01', depends_on: [], description: 'a' }],
  completedTaskIds: [], ...over,
});

// Build an injected spawnRun that, on each call, writes the next scripted
// state.json and returns its exit code. Records the resume flag per attempt.
function scripted(states, calls) {
  let i = 0;
  return async ({ resume }) => {
    const s = states[Math.min(i, states.length - 1)];
    calls.push({ resume });
    i += 1;
    if (s === null) {
      // simulate a pre-checkpoint failure: remove any state, exit non-zero
      rmSync(join(cwd, '.compose', 'gsd', FEATURE, 'state.json'), { force: true });
      return { code: 1, signal: null };
    }
    state.writeGsdState(cwd, FEATURE, s);
    const code = s.status === 'complete' ? 0 : s.status === 'failed' ? 1 : 2;
    return { code, signal: null };
  };
}

async function run(states, opts = {}) {
  const calls = [];
  const result = await sup.runGsdHeadless(FEATURE, {
    cwd,
    spawnRun: scripted(states, calls),
    sleep: async () => {},
    log: () => {},
    ...opts,
  });
  return { result, calls };
}

describe('gsd-supervisor', () => {
  beforeEach(async () => {
    sup = await import(`${REPO_ROOT}/lib/gsd-supervisor.js`);
    state = await import(`${REPO_ROOT}/lib/gsd-state.js`);
    cfgMod = await import(`${REPO_ROOT}/lib/gsd-headless-config.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-sup-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test('completes on first attempt', async () => {
    const { result, calls } = await run([base({ status: 'complete', phase: 'done' })]);
    assert.equal(result.status, 'complete');
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(calls[0].resume, false, 'first attempt is fresh');
  });

  test('crash then complete → resumes (resumeReady true) and finishes', async () => {
    const { result, calls } = await run([
      base({ status: 'running', resumeReady: true }), // attempt 1: crashed (dead pid)
      base({ status: 'complete', phase: 'done' }),    // attempt 2: done
    ]);
    assert.equal(result.status, 'complete');
    assert.equal(result.attempts, 2);
    assert.equal(calls[1].resume, true, 'crash with resumeReady → --resume');
  });

  test('crash before decompose (resumeReady false) → restarts FRESH', async () => {
    const { result, calls } = await run([
      base({ status: 'running', resumeReady: false, phase: 'planning', decomposedTasks: [] }),
      base({ status: 'complete', phase: 'done' }),
    ]);
    assert.equal(result.status, 'complete');
    assert.equal(calls[1].resume, false, 'crash pre-decompose → fresh restart, not --resume');
  });

  test('budget halt does NOT auto-resume by default', async () => {
    const { result, calls } = await run([base({ status: 'budget' })]);
    assert.equal(result.status, 'budget');
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1, 'no retry — budget ceiling protected');
    assert.equal(calls.length, 1);
  });

  test('budget auto-resumes when explicitly opted in', async () => {
    const config = cfgMod.resolveHeadlessConfig({ autoResume: { budget: { enabled: true, maxAttempts: 2 } } });
    const { result, calls } = await run([
      base({ status: 'budget' }),
      base({ status: 'complete', phase: 'done' }),
    ], { config });
    assert.equal(result.status, 'complete');
    assert.equal(calls[1].resume, true);
  });

  test('stuck retries up to maxAttempts then stops', async () => {
    const config = cfgMod.resolveHeadlessConfig({ autoResume: { stuck: { enabled: true, maxAttempts: 2 } } });
    // Always stuck → 1 initial + 2 retries = 3 attempts, then capped.
    const { result, calls } = await run([base({ status: 'stuck' })], { config });
    assert.equal(result.status, 'stuck');
    assert.equal(result.ok, false);
    assert.equal(calls.length, 3, '1 initial run + 2 retries');
  });

  test('failed is non-recoverable (no retry)', async () => {
    const { result, calls } = await run([base({ status: 'failed' })]);
    assert.equal(result.status, 'failed');
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });

  test('no-state (pre-checkpoint failure) → fatal, non-recoverable', async () => {
    const { result, calls } = await run([null]);
    assert.equal(result.status, 'fatal');
    assert.equal(calls.length, 1);
  });

  test('a prior run\'s stale "complete" does NOT yield false success when the fresh child fails pre-checkpoint', async () => {
    // Emulate the Codex-flagged repro: a prior run left status:complete.
    state.writeGsdState(cwd, FEATURE, base({ status: 'complete', phase: 'done' }));
    // The fresh child clears stale state and fails before its checkpoint
    // (scripted `null` removes state.json + exits non-zero) → absent → fatal.
    const { result } = await run([null]);
    assert.equal(result.status, 'fatal', 'must not report the prior run\'s stale complete');
    assert.notEqual(result.status, 'complete');
  });

  test('pre-dispatch cumulative-budget refusal (budget.json, no state.json) → budget, not absent', async () => {
    const calls = [];
    const spawnRun = async () => {
      calls.push({});
      const dir = join(cwd, '.compose', 'gsd', FEATURE);
      mkdirSync(dir, { recursive: true });
      // refusal writes budget.json and NO state.json, exits 2
      writeFileSync(join(dir, 'budget.json'), JSON.stringify({
        feature: FEATURE, kind: 'budget', axis: 'cumulative', reason: 'spent',
      }));
      return { code: 2, signal: null };
    };
    const result = await sup.runGsdHeadless(FEATURE, { cwd, spawnRun, sleep: async () => {}, log: () => {} });
    assert.equal(result.status, 'budget', 'cumulative refusal classified as budget, not absent');
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1, 'budget not auto-resumed by default');
  });

  describe('classifyOutcome (pure)', () => {
    const cfg = () => cfgMod.resolveHeadlessConfig({});
    test('complete → terminal ok', () => {
      assert.deepEqual(
        sup.classifyOutcome('complete', null, cfg(), { crash: 0, stuck: 0, budget: 0 }),
        { terminal: true, status: 'complete', ok: true },
      );
    });
    test('crashed + resumeReady → resume; not ready → fresh', () => {
      const a = sup.classifyOutcome('crashed', { resumeReady: true }, cfg(), { crash: 0, stuck: 0, budget: 0 });
      assert.deepEqual({ kind: a.kind, mode: a.mode, terminal: a.terminal }, { kind: 'crash', mode: 'resume', terminal: false });
      const b = sup.classifyOutcome('crashed', { resumeReady: false }, cfg(), { crash: 0, stuck: 0, budget: 0 });
      assert.equal(b.mode, 'fresh');
    });
    test('budget terminal by default', () => {
      const r = sup.classifyOutcome('budget', null, cfg(), { crash: 0, stuck: 0, budget: 0 });
      assert.equal(r.terminal, true);
      assert.equal(r.ok, false);
    });
  });
});
