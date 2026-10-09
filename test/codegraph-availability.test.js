// STRAT-CODEGRAPH-1: SmartMemory is optional. Without a capable `smartmemory` CLI every codegraph
// check is a no-op that warns ONCE per process and never throws or fails a build.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectCodegraph, locateCli, resetAvailabilityCache } from '../lib/codegraph/availability.js';
import { planGateRealityCheck } from '../lib/codegraph/reality-check.js';
import { priorArtForDesign } from '../lib/codegraph/prior-art.js';
import { loadSnapshots } from '../lib/codegraph/snapshot.js';

let dir;
let warnings;
let originalWarn;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codegraph-avail-'));
  resetAvailabilityCache();
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
});

afterEach(() => {
  console.warn = originalWarn;
  resetAvailabilityCache();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `smartmemory` CLI in `<dir>/<where>/smartmemory` that prints `version` for --version,
 * exits `helpExit` for `code bundle --help`, and fails any real bundle run.
 */
function fakeCli(version, { helpExit = 0, where = 'bin' } = {}) {
  const bin = join(dir, where);
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, 'smartmemory');
  writeFileSync(cli, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "smartmemory, version ${version}"; exit 0; fi`,
    `if [ "$1" = "code" ] && [ "$3" = "--help" ]; then echo "Usage: smartmemory code bundle"; exit ${helpExit}; fi`,
    'echo "ERROR: cannot bundle in a test" >&2',
    'exit 4',
    '',
  ].join('\n'));
  chmodSync(cli, 0o755);
  return cli;
}

const envFor = (bin = join(dir, 'bin')) => ({ PATH: bin, COMPOSE_CODEGRAPH: '1', NODE_ENV: 'test' });

function writePlan() {
  const featureDir = join(dir, 'docs', 'features', 'FX-1');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'plan.md'), '# Plan\n- call `runGsd` from `lib/missing.js`\n');
  return featureDir;
}

test('no smartmemory CLI: plan gate, prior art and snapshots are skips with exactly one warn line', async () => {
  const env = envFor(join(dir, 'empty'));
  const featureDir = writePlan();
  const a = await planGateRealityCheck({ cwd: dir, artifact: 'docs/features/FX-1/plan.md', featureCode: 'FX-1', featureDir, env });
  const b = await planGateRealityCheck({ cwd: dir, artifact: null, featureCode: 'FX-1', featureDir, env });
  const c = await priorArtForDesign({ cwd: dir, featureCode: 'FX-1', description: 'gsd task runner', env });
  const d = await loadSnapshots({ projectRoot: dir, env });
  for (const out of [a, b, c]) assert.match(out.skipped, /no SmartMemory CLI: `smartmemory` \(from PATH\) is not an executable/);
  assert.equal(d.snapshots.length, 0);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^\[codegraph\] code graph checks skipped: no SmartMemory CLI: .*pip install 'smartmemory>=1\.5\.26'$/);
});

test('smartmemory 1.5.26 with `code bundle` is available in cli mode', async () => {
  const cli = fakeCli('1.5.26');
  const avail = await detectCodegraph({ cwd: dir, env: envFor() });
  assert.deepEqual(avail, { available: true, mode: 'cli', command: cli, version: '1.5.26', reason: null, warnings: [] });
  resetAvailabilityCache();
  fakeCli('1.6.0');
  assert.equal((await detectCodegraph({ cwd: dir, env: envFor() })).available, true);
});

test('smartmemory 1.5.25 is unavailable: known segfault on TypeScript repos, with the upgrade line', async () => {
  fakeCli('1.5.25');
  const avail = await detectCodegraph({ cwd: dir, env: envFor() });
  assert.equal(avail.available, false);
  assert.match(avail.reason, /smartmemory 1\.5\.25 at .* has a known segfault on TypeScript repos; upgrade: pip install 'smartmemory>=1\.5\.26'/);
});

test('an older smartmemory, one without `code bundle`, or one with no version is unavailable', async () => {
  fakeCli('1.5.24');
  assert.match((await detectCodegraph({ cwd: dir, env: envFor() })).reason, /smartmemory 1\.5\.24 at .* is older than 1\.5\.26/);
  resetAvailabilityCache();
  fakeCli('1.5.26', { helpExit: 2 });
  const noBundle = await detectCodegraph({ cwd: dir, env: envFor() });
  assert.equal(noBundle.available, false);
  assert.match(noBundle.reason, /`.*smartmemory code bundle --help` failed \(exit 2\)/);
  resetAvailabilityCache();
  fakeCli('dev');
  assert.match((await detectCodegraph({ cwd: dir, env: envFor() })).reason, /--version` gave no version/);
});

test('an upgrade or downgrade at the same path is re-probed, not served from the memo', async () => {
  const env = envFor();
  fakeCli('1.5.25');
  assert.equal((await detectCodegraph({ cwd: dir, env })).available, false);
  fakeCli('1.5.26'); // pip rewrites the console script on (re)install
  assert.equal((await detectCodegraph({ cwd: dir, env })).available, true, 'upgrade seen without a reset');
  fakeCli('1.5.25');
  assert.equal((await detectCodegraph({ cwd: dir, env })).available, false, 'downgrade to a refused version seen');
});

test('discovery order: codegraph.smartmemory in compose.json, then $COMPOSE_CODEGRAPH_SMARTMEMORY, then PATH', async () => {
  const onPath = fakeCli('1.5.26', { where: 'bin' });
  const fromEnv = fakeCli('1.5.26', { where: 'env-bin' });
  const fromConfig = fakeCli('1.5.26', { where: 'config-bin' });
  const env = envFor();
  assert.equal((await detectCodegraph({ cwd: dir, env })).command, onPath);
  const withEnv = { ...env, COMPOSE_CODEGRAPH_SMARTMEMORY: fromEnv };
  assert.equal((await detectCodegraph({ cwd: dir, env: withEnv })).command, fromEnv);
  mkdirSync(join(dir, '.compose'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ codegraph: { smartmemory: 'config-bin/smartmemory' } }));
  assert.equal((await detectCodegraph({ cwd: dir, env: withEnv })).command, fromConfig, 'a relative path resolves against the project');

  // A configured path that is not executable does not fall through to the next source.
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ codegraph: { smartmemory: '/no/such/smartmemory' } }));
  const missing = await detectCodegraph({ cwd: dir, env: withEnv });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /`\/no\/such\/smartmemory` \(from codegraph\.smartmemory in \.compose\/compose\.json\) is not an executable/);
  // A bare name is looked up on PATH.
  assert.equal(locateCli({ cwd: dir, env: { PATH: join(dir, 'env-bin') }, config: { smartmemory: 'smartmemory' } }).command, fromEnv);
});

test('NODE_ENV=test without opt-in, COMPOSE_CODEGRAPH=0 and codegraph.enabled:false all disable', async () => {
  fakeCli('1.5.26');
  const capable = envFor();
  const inTest = await detectCodegraph({ cwd: dir, env: { ...capable, COMPOSE_CODEGRAPH: undefined } });
  assert.match(inTest.reason, /NODE_ENV=test/);
  const off = await detectCodegraph({ cwd: dir, env: { ...capable, COMPOSE_CODEGRAPH: '0' } });
  assert.match(off.reason, /disabled by configuration/);
  mkdirSync(join(dir, '.compose'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ codegraph: { enabled: false } }));
  const configOff = await detectCodegraph({ cwd: dir, env: capable });
  assert.match(configOff.reason, /disabled by configuration/);
});

test('a producer failure is a warning and an empty result, never a throw', async () => {
  fakeCli('1.5.26');
  const featureDir = writePlan();
  // The fake CLI passes the probe but exits 4 on a real bundle run.
  const out = await planGateRealityCheck({ cwd: dir, artifact: null, featureCode: 'FX-1', featureDir, env: envFor() });
  assert.ok(out.skipped, JSON.stringify(out));
  assert.ok(warnings.some((w) => /snapshot failed: bundle producer exited 4: ERROR: cannot bundle in a test/.test(w)), warnings.join('\n'));
});
