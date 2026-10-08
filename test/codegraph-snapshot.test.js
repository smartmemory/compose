// STRAT-CODEGRAPH-1 snapshot cache: fingerprint, single flight, cache hits, timing,
// and one repo's failure not discarding another's snapshot.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeFingerprint, ensureSnapshot, loadSnapshots, normalizeBundle, resolveRepos, codegraphDir,
} from '../lib/codegraph/snapshot.js';
import { resetAvailabilityCache } from '../lib/codegraph/availability.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(gunzipSync(readFileSync(join(HERE, 'fixtures', 'codegraph', 'stratum.bundle.json.gz'))).toString('utf8'));
const AVAILABLE = { available: true, mode: 'fallback', python: 'python3', version: 'test', warnings: [] };

let dir;
let originalWarn;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codegraph-snap-'));
  resetAvailabilityCache();
  originalWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = originalWarn;
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function initRepo() {
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'top.js'), 'export const t = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
}

function fixtureProducer(calls) {
  return async ({ out }) => {
    calls.push(out);
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(out, JSON.stringify(FIXTURE));
  };
}

test('fingerprint changes on edit, on re-edit of an already-dirty file, and ignores commits outside the subdir', async () => {
  initRepo();
  const sub = join(dir, 'sub');
  const clean = await computeFingerprint(sub);
  assert.equal(clean.git, true);
  assert.equal(clean.dirty, false);

  writeFileSync(join(dir, 'top.js'), 'export const t = 2;\n');
  git(dir, 'commit', '-qam', 'outside sub');
  assert.equal((await computeFingerprint(sub)).fingerprint, clean.fingerprint, 'commit outside sub keeps the subdir key');

  writeFileSync(join(sub, 'a.js'), 'export const a = 2;\n');
  const dirty1 = await computeFingerprint(sub);
  assert.equal(dirty1.dirty, true);
  assert.notEqual(dirty1.fingerprint, clean.fingerprint);

  writeFileSync(join(sub, 'a.js'), 'export const a = 22222;\n'); // same porcelain line, different content
  const dirty2 = await computeFingerprint(sub);
  assert.notEqual(dirty2.fingerprint, dirty1.fingerprint);

  assert.notEqual((await computeFingerprint(sub, 'other-producer')).fingerprint, dirty2.fingerprint, 'salt is part of the key');
});

test('non-git roots fingerprint by a stat walk', async () => {
  writeFileSync(join(dir, 'x.ts'), 'export {}\n');
  const one = await computeFingerprint(dir);
  assert.equal(one.git, false);
  writeFileSync(join(dir, 'y.ts'), 'export {}\n');
  assert.notEqual((await computeFingerprint(dir)).fingerprint, one.fingerprint);
});

test('concurrent ensureSnapshot calls run the producer once; the next call is a cache hit', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const calls = [];
  const producer = fixtureProducer(calls);
  const [a, b] = await Promise.all([
    ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer }),
    ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  assert.equal(a.cached, false);
  assert.ok(existsSync(a.path));
  assert.equal(a.snapshot.entities.length, normalizeBundle(FIXTURE).entities.length);

  const c = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer });
  assert.equal(calls.length, 1);
  assert.equal(c.cached, true);

  const repoDir = join(codegraphDir(dir), repo.name);
  const timings = readFileSync(join(repoDir, 'timings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(timings.length, 2);
  assert.equal(timings[0].cached, false);
  assert.equal(typeof timings[0].bundleMs, 'number');
  assert.equal(timings[1].cached, true);
  assert.deepEqual(readdirSync(repoDir).filter((f) => f.includes('.tmp')), [], 'no temp bundle left behind');
  assert.equal(calls[0].startsWith(repoDir), true, 'raw bundle is written inside the repo cache dir');
});

test('the producer gets SmartMemory\'s parse cache under .compose/codegraph/<repo>/parse-cache', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  let seen = null;
  await ensureSnapshot({
    projectRoot: dir, repo, availability: AVAILABLE, env: { PATH: process.env.PATH },
    producer: async ({ out, env }) => { seen = env.SMARTMEMORY_CODE_CHECKPOINT_DIR; writeFileSync(out, JSON.stringify(FIXTURE)); },
  });
  assert.equal(seen, join(codegraphDir(dir), repo.name, 'parse-cache'));
});

test('repos come from codegraph.repos with derived prefixes; one failing repo keeps the other', async () => {
  initRepo();
  mkdirSync(join(dir, '.compose'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
    codegraph: { repos: [{ name: 'top', root: '.' }, { name: 'sub', root: 'sub', exclude: ['fixtures'] }] },
  }));
  const repos = resolveRepos(dir);
  assert.deepEqual(repos.map((r) => [r.name, r.prefix, r.exclude]), [['top', '', []], ['sub', 'sub/', ['fixtures']]]);

  const producer = async ({ repo, out }) => {
    if (repo.name === 'sub') throw new Error('boom');
    writeFileSync(out, JSON.stringify(FIXTURE));
  };
  const loaded = await loadSnapshots({ projectRoot: dir, availability: AVAILABLE, producer });
  assert.deepEqual(loaded.snapshots.map((s) => s.repo.name), ['top']);
  assert.deepEqual(loaded.errors.map((e) => e.repo), ['sub']);
  assert.equal(loaded.skipped, null);
});

test('a bundle with an unsupported schema_version fails that repo, not the process', async () => {
  initRepo();
  const loaded = await loadSnapshots({
    projectRoot: dir, availability: AVAILABLE,
    producer: async ({ out }) => writeFileSync(out, JSON.stringify({ ...FIXTURE, schema_version: '9' })),
  });
  assert.equal(loaded.snapshots.length, 0);
  assert.match(loaded.errors[0].message, /unsupported schema_version "9"/);
});

// ---- Review round 1 regressions ----

test('R1-1: an edit to a gitignored source file changes the fingerprint', async () => {
  initRepo();
  writeFileSync(join(dir, '.gitignore'), 'local.js\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-qm', 'ignore');
  writeFileSync(join(dir, 'local.js'), 'export const l = 1;\n');
  const one = await computeFingerprint(dir);
  assert.equal(one.dirty, false, 'ignored files do not make the tree dirty');
  writeFileSync(join(dir, 'local.js'), 'export const l = 12345;\n');
  assert.notEqual((await computeFingerprint(dir)).fingerprint, one.fingerprint);
});

test('R1-2: installing the TS grammars (or another Python) invalidates the snapshot', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const calls = [];
  const producer = fixtureProducer(calls);
  await ensureSnapshot({ projectRoot: dir, repo, availability: { ...AVAILABLE, typescriptGrammar: false }, producer });
  await ensureSnapshot({ projectRoot: dir, repo, availability: { ...AVAILABLE, typescriptGrammar: true }, producer });
  await ensureSnapshot({ projectRoot: dir, repo, availability: { ...AVAILABLE, typescriptGrammar: true, python: '/other/python' }, producer });
  assert.equal(calls.length, 3);
});

test('R1-3: output produced while the source changed is used once and not cached', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const calls = [];
  const producer = async ({ out }) => {
    calls.push(out);
    writeFileSync(join(dir, 'sub', 'a.js'), `export const a = ${calls.length * 1000};\n`); // edit mid-run
    writeFileSync(out, JSON.stringify(FIXTURE));
  };
  const first = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer });
  assert.equal(first.timing.stored, false);
  assert.equal(first.path, null);
  const repoDir = join(codegraphDir(dir), repo.name);
  assert.deepEqual(readdirSync(repoDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)), []);
});

test('R1-4: a producer that dies mid-write leaves no temp files', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const loaded = await loadSnapshots({
    projectRoot: dir, availability: AVAILABLE,
    producer: async ({ out }) => { writeFileSync(`${out}.tmp.4242`, '{"partial'); throw new Error('killed'); },
  });
  assert.equal(loaded.errors.length, 1);
  const repoDir = join(codegraphDir(dir), repo.name);
  assert.deepEqual(readdirSync(repoDir).filter((f) => f.includes('.tmp')), []);
});
