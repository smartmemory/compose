/**
 * Why `--test-timeout` is 900000 and not 300000.
 *
 * `--test-timeout` applies to EVERY test, including the implicit file-level test
 * node wraps around a test file. So it is not a per-test guard: it caps a file's
 * TOTAL wall time. Compose's two slowest files (ts-cutover-consumer-fanout-golden,
 * lifecycle-backfill) run 40-80s idle but 120-300s on a loaded machine, so at 300s
 * they were killed while perfectly healthy — measured 5/42 under load on
 * 2026-09-07, 0/67 isolated.
 *
 * The kill is near-silent, which is why it went unexplained twice: a file-level
 * timeout emits ONLY a file-level `not ok` with `# fail 0` and no subtest message,
 * so a log tail shows a failing file and no failing test. Both earlier sightings
 * left exactly that trace and were nearly written off as flakes.
 *
 * The first test below pins the SEMANTICS (with a real subprocess, so node itself
 * produces the evidence) and the second pins the CONSEQUENCE for our config. If a
 * future node makes the file-level test exempt, the first test fails and the
 * ceiling can safely come back down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('--test-timeout caps a FILE\'s total wall time, not each test (the whole reason for 900s)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-budget-'));
  const file = join(dir, 'fixture.test.js');
  // Four 300ms tests: no single test exceeds 500ms, the file's total does.
  writeFileSync(file, [
    "import { test } from 'node:test';",
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
    'for (const i of [1, 2, 3, 4]) test(`sub ${i}`, async () => { await sleep(300); });',
  ].join('\n'));

  // NODE_TEST_CONTEXT is inherited from our own runner; leaving it set makes the
  // child refuse to run files ("run() is being called recursively").
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=500', file], { encoding: 'utf8', env });
  const out = `${r.stdout}${r.stderr}`;

  assert.match(out, /failureType: 'testTimeoutFailure'/, `expected a timeout kill:\n${out}`);
  assert.match(out, /not ok 1 - .*fixture\.test\.js/, 'the FILE is what fails, not a test');
  assert.match(out, /^# fail 0$/m,
    'and it reports ZERO failing tests — which is why this kill reads as an unexplained flake');
});

test('every --test-timeout in package.json clears the slowest file\'s loaded wall time', () => {
  const pkg = JSON.parse(spawnSync(process.execPath,
    ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(REPO_ROOT, 'package.json'))}, 'utf8'))`],
    { encoding: 'utf8' }).stdout);
  const found = Object.entries(pkg.scripts)
    .flatMap(([name, cmd]) => [...String(cmd).matchAll(/--test-timeout=(\d+)/g)].map((m) => [name, Number(m[1])]));

  assert.ok(found.length >= 3, `expected the node-test scripts to set a timeout, found ${found.length}`);
  // 301s was the measured clip point; 900s leaves ~3x headroom over the worst
  // loaded run. Lower it only with a measurement that says the files got faster.
  for (const [name, ms] of found) {
    assert.ok(ms >= 900_000,
      `scripts.${name} sets --test-timeout=${ms}; under load the slowest file has taken 301s, so this kills healthy files`);
  }
});
