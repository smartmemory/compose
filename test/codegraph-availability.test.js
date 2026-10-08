// STRAT-CODEGRAPH-1: SmartMemory is optional. Without a capable one every codegraph
// check is a no-op that warns ONCE per process and never throws or fails a build.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectCodegraph, resetAvailabilityCache } from '../lib/codegraph/availability.js';
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

/** A fake `python` that answers the probe with `report` (or fails). No smartmemory CLI on PATH. */
function fakeEnv(report) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const python = join(bin, 'fake-python');
  writeFileSync(python, report === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho '${JSON.stringify(report)}'\n`);
  chmodSync(python, 0o755);
  return { PATH: bin, COMPOSE_CODEGRAPH: '1', COMPOSE_CODEGRAPH_PYTHON: python, NODE_ENV: 'test' };
}

function writePlan() {
  const featureDir = join(dir, 'docs', 'features', 'FX-1');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'plan.md'), '# Plan\n- call `runGsd` from `lib/missing.js`\n');
  return featureDir;
}

test('no smartmemory: plan gate, prior art and snapshots are skips with exactly one warn line', async () => {
  const env = fakeEnv({ python: '3.12', smartmemory: false });
  const featureDir = writePlan();
  const a = await planGateRealityCheck({ cwd: dir, artifact: 'docs/features/FX-1/plan.md', featureCode: 'FX-1', featureDir, env });
  const b = await planGateRealityCheck({ cwd: dir, artifact: null, featureCode: 'FX-1', featureDir, env });
  const c = await priorArtForDesign({ cwd: dir, featureCode: 'FX-1', description: 'gsd task runner', env });
  const d = await loadSnapshots({ projectRoot: dir, env });
  for (const out of [a, b, c]) assert.match(out.skipped, /smartmemory is not importable/);
  assert.equal(d.snapshots.length, 0);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^\[codegraph\] code graph checks skipped: smartmemory is not importable/);
});

test('no python at all: unavailable, one warn, no throw', async () => {
  const env = { PATH: join(dir, 'empty'), COMPOSE_CODEGRAPH: '1', COMPOSE_CODEGRAPH_PYTHON: join(dir, 'no-such-python') };
  const out = await priorArtForDesign({ cwd: dir, featureCode: 'FX-1', description: 'anything at all', env });
  assert.match(out.skipped, /no Python/);
  assert.equal(warnings.length, 1);
});

test('released smartmemory without store-free parse (PyPI 1.5.23) is unavailable with the reason', async () => {
  const env = fakeEnv({ smartmemory: true, version: '1.5.23', store_free_parse: false, typescript_grammar: true });
  const avail = await detectCodegraph({ cwd: dir, env });
  assert.equal(avail.available, false);
  assert.match(avail.reason, /1\.5\.23 has no store-free CodeIndexer\.parse/);
});

test('capable smartmemory without TS grammars is available with a warning', async () => {
  const env = fakeEnv({ smartmemory: true, version: '1.5.24', store_free_parse: true, typescript_grammar: false });
  const avail = await detectCodegraph({ cwd: dir, env });
  assert.equal(avail.available, true);
  assert.equal(avail.mode, 'fallback');
  assert.match(avail.warnings[0], /JS\/TS files will not be parsed/);
});

test('NODE_ENV=test without opt-in, COMPOSE_CODEGRAPH=0 and codegraph.enabled:false all disable', async () => {
  const capable = fakeEnv({ smartmemory: true, version: 'x', store_free_parse: true, typescript_grammar: true });
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
  const env = fakeEnv({ smartmemory: true, version: 'x', store_free_parse: true, typescript_grammar: true });
  const featureDir = writePlan();
  // The fake python passes the probe but cannot produce a bundle (it only echoes the probe JSON).
  const out = await planGateRealityCheck({ cwd: dir, artifact: null, featureCode: 'FX-1', featureDir, env });
  assert.ok(out.skipped, JSON.stringify(out));
  assert.ok(warnings.some((w) => /snapshot failed/.test(w)), warnings.join('\n'));
});
