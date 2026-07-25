import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(ROOT, 'bin', 'compose.js');

/** A cache pre-seeded fresh, so the CLI never reaches the network. */
function seedCache(t, doc) {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'version-cache.json');
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-ws-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.compose'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ version: 1, workspaceId: 'nudge-ws' }));
  return dir;
}

function runCompose(args, { cwd, cacheFile }) {
  return spawnSync(process.execPath, [COMPOSE_BIN, ...args], {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: join(cwd, '.home'), COMPOSE_VERSION_CACHE: cacheFile },
  });
}

const AHEAD = { fetchedAt: Date.now(), latest: '999.0.0' };
const behindCache = () => ({ '@smartmemory/compose': AHEAD, '@smartmemory/stratum': AHEAD });

test('compose init prints the nudge when behind', (t) => {
  const r = runCompose(['init'], { cwd: workspace(t), cacheFile: seedCache(t, behindCache()) });
  assert.match(`${r.stdout}${r.stderr}`, /update available: .*999\.0\.0.*run: compose update/);
});

test('compose plan prints the nudge when behind', (t) => {
  const r = runCompose(['plan'], { cwd: workspace(t), cacheFile: seedCache(t, behindCache()) });
  assert.match(`${r.stdout}${r.stderr}`, /update available: .*run: compose update/);
});

// The nudge is the FIRST statement in the dispatch block, ahead of argument
// parsing, so `build` with no feature code prints it and then errors out. That
// is exactly what we want to assert: the nudge does not depend on the command
// succeeding, and no real build is started here.
test('compose build prints the nudge when behind', (t) => {
  const r = runCompose(['build'], { cwd: workspace(t), cacheFile: seedCache(t, behindCache()) });
  assert.match(`${r.stdout}${r.stderr}`, /update available: .*run: compose update/);
});

// Current on both ends: the nudge must be absent, not merely different.
test('no nudge when both are current', (t) => {
  const current = { fetchedAt: Date.now(), latest: '0.0.1' };  // below anything installed
  const cacheFile = seedCache(t, {
    '@smartmemory/compose': current, '@smartmemory/stratum': current,
  });
  const r = runCompose(['init'], { cwd: workspace(t), cacheFile });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /update available/);
});

test('non-entry-point commands stay silent even when behind', (t) => {
  const cacheFile = seedCache(t, behindCache());
  const r = runCompose(['roadmap'], { cwd: workspace(t), cacheFile });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /update available/);
});

test('an unusable cache never breaks the command', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'version-cache.json');
  writeFileSync(cacheFile, 'garbage{{{');
  const r = runCompose(['init'], { cwd: workspace(t), cacheFile });
  assert.equal(r.status, 0, `init must still succeed: ${r.stderr}`);
});
