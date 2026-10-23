/**
 * COMP-TEST-WAIT-POLL-1 guard: tests that wait on async delivery (fs.watch / FSEvents,
 * SSE or WebSocket frames, child-process startup) poll their CONDITION against a long
 * deadline through test/helpers/poll-until.js. A hand-rolled `for (let n = 0; n < N; n++)
 * ... await sleep()` loop is a fixed deadline in disguise: N x step is 3 s here, 500 ms
 * there, and it holds on an idle machine and fails under load (compose pre-push gate
 * 2026-10-24: build-stream-smoke, ideabox-cockpit-refresh-e2e, workspace-switch-runtime).
 *
 * Two tables. CONVERTED: one row per file this unit converted, each must import the shared
 * helper (or, for the SSE smoke, its `until` collector) and must not regress to the old
 * shape. SCAN: the whole test/ tree is scanned for the hand-rolled wait loop; a NEW site
 * fails unless it is added to ALLOWED with a reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { POLL_DEADLINE_MS } from './helpers/poll-until.js';

const TEST_DIR = import.meta.dirname;
const read = (rel) => readFileSync(join(TEST_DIR, rel), 'utf8');

// file | must contain | must NOT contain (the old fixed-deadline shape)
const CONVERTED = [
  ['build-stream-smoke.test.js', 'pollUntil', 'collectSSE(port, 1500)'],
  ['build-stream-smoke.test.js', 'pollIntervalMs: 50', 'setTimeout(r, 200));\n      let seq'],
  ['ideabox-cockpit-refresh-e2e.test.js', 'pollUntil', 'i < 50 && seen.length === 0'],
  ['ideabox-cockpit-refresh-e2e.test.js', 'server startup', 'i < 150 && !srvDied'],
  ['workspace-switch-runtime.test.js', 'pollUntil', 'n < 120'],
  ['routing-calls.test.js', 'pollUntil', 'n < 100 &&'],
  ['helpers/build-wave-golden-fixture.js', 'pollUntil', 'n < 1000 &&'],
  ['smartmemory-hooks.test.js', 'pollUntil', 'timeoutMs = 2000'],
  ['ideabox-projection-watch.test.js', 'budgetMs = 30_000', 'budgetMs = 4000'],
  ['settings-e2e.test.js', 'timeoutMs = 30_000', 'timeoutMs = 3000'],
  ['learn-summary-golden.test.js', 'waited < 30_000', 'waited < 10_000'],
];

// Wait loops that ARE deadline-based by design (condition + >= 30 s budget), kept by hand.
const ALLOWED = new Map([
  ['learn-summary-golden.test.js', '30 s deadline on the sidecar row, returns on the condition'],
  ['coalescing-buffer.test.js', 'a producer loop followed by one in-process coalescing-window timer, not a wait on delivery'],
  ['build-stream-bridge.test.js', '15 s deadline loop, returns on the condition'],
]);

// `for (let n = 0; n < N ...)` whose next few lines wait on a timer: a bounded wait loop.
const WAIT_LOOP = /for \(let (\w+) = 0;[^\n]*\b\1 <\s*[\d_]+[^\n]*(?:\n[^\n]*){0,3}?(?:await (?:sleep|pause|delay)\(|setTimeout\()/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'fixtures') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(test\.)?(js|mjs)$/.test(name) && name !== 'wait-poll-guard.test.js') yield full;
  }
}

test('the shared deadline is at least 30 s', () => {
  assert.ok(POLL_DEADLINE_MS >= 30_000);
});

for (const [file, must, mustNot] of CONVERTED) {
  test(`converted: ${file} has \`${must}\` and not \`${mustNot.slice(0, 30)}\``, () => {
    const src = read(file);
    assert.ok(src.includes(must), `${file} should contain ${must}`);
    assert.ok(!src.includes(mustNot), `${file} regressed to ${mustNot}`);
  });
}

test('scan: no hand-rolled fixed-deadline wait loop outside ALLOWED', () => {
  const offenders = [];
  for (const full of walk(TEST_DIR)) {
    const rel = relative(TEST_DIR, full);
    if (ALLOWED.has(rel)) continue;
    const m = WAIT_LOOP.exec(readFileSync(full, 'utf8'));
    if (m) offenders.push(`${rel}: ${m[0].split('\n')[0].trim().slice(0, 100)}`);
  }
  assert.deepEqual(offenders, [], 'use pollUntil from test/helpers/poll-until.js (30 s deadline, returns on the condition)');
});

test('scan: the detector fires on the three shapes this unit removed', () => {
  for (const shape of [
    "for (let n = 0; n < 120; n++) { const v = await check(); if (v) return v; await pause(25); }",
    "for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(100);",
    "for (let n = 0; n < 100 && !releases.has(key); n++) await new Promise(r => setTimeout(r, 5));",
  ]) assert.ok(WAIT_LOOP.test(shape), shape);
});
