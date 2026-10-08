// STRAT-CODEGRAPH-1 snapshot cache: fingerprint, single flight, cache hits, timing,
// and one repo's failure not discarding another's snapshot.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeFingerprint, ensureSnapshot, loadSnapshots, normalizeBundle, resolveRepos, codegraphDir,
  bundleArgv, cliBundleArgs, prebuildSnapshots, specUsesCodegraph,
} from '../lib/codegraph/snapshot.js';
import { resetAvailabilityCache } from '../lib/codegraph/availability.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(gunzipSync(readFileSync(join(HERE, 'fixtures', 'codegraph', 'stratum.bundle.json.gz'))).toString('utf8'));
const AVAILABLE = { available: true, mode: 'fallback', python: 'python3', version: 'test', warnings: [] };

let dir;
let originalWarn;
let warnings;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codegraph-snap-'));
  resetAvailabilityCache();
  originalWarn = console.warn;
  warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
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
  assert.equal(b.snapshot, a.snapshot);
  assert.equal(b.joined, true, 'the second caller joined the run in flight');
  assert.equal(a.joined, undefined);
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

// ---- Fix round 1 (scratch/2026-10-08-codegraph/build/fix-r1-brief.md) ----

const fallbackLines = () => warnings.filter((w) => w.includes('private-import fallback'));

test('fix-r1 #1: every snapshot the fallback produces prints a WARNING with the reason', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const calls = [];
  const producer = fixtureProducer(calls);
  const availability = { ...AVAILABLE, fallbackReason: 'no `smartmemory` command on PATH' };
  const first = await ensureSnapshot({ projectRoot: dir, repo, availability, producer });
  assert.equal(first.snapshot.producer, 'fallback');
  writeFileSync(join(dir, 'sub', 'a.js'), 'export const a = 99;\n'); // new key: produced again
  await ensureSnapshot({ projectRoot: dir, repo, availability, producer });
  assert.equal(calls.length, 2);
  assert.equal(fallbackLines().length, 2, 'one line per production, not once per process');
  assert.match(fallbackLines()[0], /^\[codegraph\] WARNING: .*bundle_fallback\.py.*because no `smartmemory` command on PATH$/);

  await ensureSnapshot({ projectRoot: dir, repo, availability: { ...availability, mode: 'cli' }, producer });
  assert.equal(fallbackLines().length, 2, 'the CLI producer does not warn');
});

test('fix-r1 #1: a cached fallback snapshot gets one WARNING line per run', async () => {
  initRepo();
  const calls = [];
  const producer = fixtureProducer(calls);
  await loadSnapshots({ projectRoot: dir, availability: AVAILABLE, producer });
  assert.equal(fallbackLines().length, 1, 'production warns');
  for (let run = 1; run <= 2; run++) {
    warnings.length = 0;
    const loaded = await loadSnapshots({ projectRoot: dir, availability: AVAILABLE, producer });
    assert.equal(loaded.snapshots[0].cached, true);
    assert.equal(fallbackLines().length, 1, `run ${run}: a cache hit still says the snapshot came from the fallback`);
    assert.match(fallbackLines()[0], /\(cached\)/);
  }
  assert.equal(calls.length, 1);
});

test('fix-r1 #7: a build-start prebuild is joined by the gate: one producer run', async () => {
  initRepo();
  const calls = [];
  const producer = fixtureProducer(calls);
  const loader = (args) => loadSnapshots({ ...args, availability: AVAILABLE, producer });
  const pre = prebuildSnapshots({ projectRoot: dir, loader });
  const gate = await loadSnapshots({ projectRoot: dir, availability: AVAILABLE, producer });
  await pre;
  assert.equal(calls.length, 1);
  assert.equal(gate.snapshots[0].joined, true);
  assert.match(fallbackLines().at(-1), /prebuilt this build/);
  await assert.doesNotReject(prebuildSnapshots({ projectRoot: dir, loader: async () => { throw new Error('boom'); } }));
});

test('fix-r1 #7: under NODE_ENV=test the prebuild runs no producer', async () => {
  initRepo();
  const calls = [];
  const producer = fixtureProducer(calls);
  const loaded = await prebuildSnapshots({
    projectRoot: dir, env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    loader: (args) => loadSnapshots({ ...args, producer }),
  });
  assert.match(loaded.skipped, /NODE_ENV=test/);
  assert.equal(calls.length, 0);
});

test('fix-r1 #7: docs and feature.json edits keep the fingerprint; source and tsconfig edits change it', async () => {
  initRepo();
  const base = await computeFingerprint(dir);
  mkdirSync(join(dir, 'docs', 'features', 'FX-1'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'features', 'FX-1', 'plan.md'), '# plan\n');
  writeFileSync(join(dir, 'docs', 'features', 'FX-1', 'feature.json'), '{}\n');
  const docs = await computeFingerprint(dir);
  assert.equal(docs.fingerprint, base.fingerprint, 'what a build writes before plan_gate does not miss the prebuild');
  assert.equal(docs.dirty, true);
  writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
  const ts = await computeFingerprint(dir);
  assert.notEqual(ts.fingerprint, base.fingerprint);
  writeFileSync(join(dir, 'sub', 'b.js'), 'export const b = 1;\n');
  assert.notEqual((await computeFingerprint(dir)).fingerprint, ts.fingerprint);
});

test('fix-r1 R1-1: every file core reads changes the key, however it is named; build prose and feature.json do not', async () => {
  // Core follows a tsconfig `extends` chain to a file of any name and folder, even outside the indexed root
  // (ts_resolve.py:153-166), so the chain is followed and hashed. The repo root here is a subdirectory (pkg/), the
  // way stratum/ts is indexed. Chain: pkg/tsconfig.json -> config/shared(.json, JSONC) -> base.txt
  // -> docs/features/CFG/base.json -> ../tsconfig.base.json (outside pkg/) -> local/override.json (gitignored dir).
  const files = {
    '.gitignore': '*.log\nlocal/\npkg/tsconfig.local.json\nnode_modules/\ndist/\n',  // local/ also ignores pkg/local/
    'tsconfig.base.json': '{ "extends": "./local/override" }\n',
    'local/override.json': '{}\n',
    'pkg/top.js': 'export const t = 1;\n',
    'pkg/tsconfig.json': '{ "extends": "./config/shared" }\n',
    'pkg/tsconfig.local.json': '{}\n',
    'pkg/config/shared.json': '{\n  // JSONC, as core accepts\n  "extends": "./base.txt",\n}\n',
    'pkg/config/base.txt': '{ "extends": "../docs/features/CFG/base.json" }\n',
    'pkg/docs/features/CFG/base.json': '{ "extends": "../../../../tsconfig.base.json" }\n',
    'pkg/features/FX/feature.json': '{ "status": "PLANNED" }\n',
    // Review round 3: a 33-link chain, a trailing-dot target (core appends .json: base..json), a symlinked tsconfig
    // (extends resolves from the real file's folder), a gitignored directory core still indexes, an ancestor manifest.
    'package.json': '{ "type": "module" }\n',
    'pkg/deep/tsconfig.json': '{ "extends": "../config/c1.txt" }\n',
    ...Object.fromEntries(Array.from({ length: 33 }, (_, i) => [
      `pkg/config/c${i + 1}.txt`, i < 32 ? `{ "extends": "./c${i + 2}.txt" }\n` : '{ "compilerOptions": { "baseUrl": "../src-a" } }\n',
    ])),
    'pkg/dot/tsconfig.json': '{ "extends": "./base." }\n',
    'pkg/dot/base..json': '{}\n',
    'pkg/config/real/shared.json': '{ "extends": "./base2.txt" }\n',
    'pkg/config/real/base2.txt': '{}\n',
    'pkg/local/main.ts': 'export const m = 1;\n',
    'pkg/local/tsconfig.json': '{ "extends": "../config/lbase.txt" }\n',
    'pkg/config/lbase.txt': '{}\n',
    // Directories core prunes (collection.py:11-29): node_modules always, dist/build unless a Python package.
    'pkg/node_modules/dep/index.js': 'module.exports = 1;\n',
    'pkg/dist/bundle.js': 'export const b = 1;\n',
    'pkg/py/build/__init__.py': '',
    'pkg/py/build/mod.py': 'X = 1\n',
    // fix-r1 R1-1 (Codex review of 15870294): config seeds under a pruned directory are not inputs.
    'pkg/.compose/tsconfig.json': '{}\n',
    'pkg/build/tsconfig.json': '{}\n',
  };
  const links = [['pkg/sym/tsconfig.json', '../config/real/shared.json']];
  const edit = (path) => (r) => writeFileSync(join(r, path), `${readFileSync(join(r, path), 'utf8').trimEnd()} \n\n`);
  const cases = [
    // [what, mutate(repo dir), key changes (git and no git); git-only cases are marked]
    ['an extensionless extends spelling (config/shared -> .json)', edit('pkg/config/shared.json'), true],
    ['a .txt extends target', edit('pkg/config/base.txt'), true],
    ['an extends target inside docs/features/', edit('pkg/docs/features/CFG/base.json'), true],
    ['an extends target outside the indexed root', edit('tsconfig.base.json'), true],
    ['an extends target inside a gitignored directory', edit('local/override.json'), true],
    ['a gitignored tsconfig.local.json', edit('pkg/tsconfig.local.json'), true],
    ['tsconfig.json itself', edit('pkg/tsconfig.json'), true],
    ['source', edit('pkg/top.js'), true],
    ['the 33rd link of an extends chain', edit('pkg/config/c33.txt'), true],
    ['a trailing-dot extends target (base. -> base..json)', edit('pkg/dot/base..json'), true],
    ['the real file behind a symlinked tsconfig', edit('pkg/config/real/shared.json'), true],
    ['an extends target of a symlinked tsconfig (resolved from the real folder)', edit('pkg/config/real/base2.txt'), true],
    ['source inside a gitignored directory core indexes', edit('pkg/local/main.ts'), true],
    ['an extends target of a tsconfig inside a gitignored directory', edit('pkg/config/lbase.txt'), true],
    ['a package.json above the indexed root', (r) => writeFileSync(join(r, 'package.json'), '{ "type": "commonjs" }\n'), true],
    ['source in a build/ folder that is a Python package', edit('pkg/py/build/mod.py'), true],
    // Deleting the marker prunes build/, which drops mod.py from the producer's input; the deletion must stay in the key.
    ['deleting the __init__.py that makes build/ a package', (r) => rmSync(join(r, 'pkg/py/build/__init__.py')), true],
    ['an unignored .compose/tsconfig.json seed', edit('pkg/.compose/tsconfig.json'), false],
    ['a tsconfig.json seed inside a pruned build/ folder', edit('pkg/build/tsconfig.json'), false],
    ['a node_modules file core prunes', edit('pkg/node_modules/dep/index.js'), false],
    ['a dist/ artifact core prunes', edit('pkg/dist/bundle.js'), false],
    ['a feature folder (plan.md, feature.json)', (r) => {
      mkdirSync(join(r, 'pkg', 'docs', 'features', 'FX-1'), { recursive: true });
      writeFileSync(join(r, 'pkg', 'docs', 'features', 'FX-1', 'plan.md'), '# plan\n');
      writeFileSync(join(r, 'pkg', 'docs', 'features', 'FX-1', 'feature.json'), '{}\n');
    }, false],
    ['a feature.json under a configured features path', edit('pkg/features/FX/feature.json'), false],
    ['a design doc', (r) => writeFileSync(join(r, 'pkg', 'docs', 'design.md'), '# d\n'), false],
    ['a log file', (r) => writeFileSync(join(r, 'pkg', 'run.log'), 'x\n'), false],
  ];
  const wrong = [];
  for (const useGit of [true, false]) {
    for (const [what, mutate, changes] of cases) {
      const repo = mkdtempSync(join(dir, 'fp-'));
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), body);
      }
      for (const [path, target] of links) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        symlinkSync(target, join(repo, path));
      }
      if (useGit) {
        git(repo, 'init', '-q');
        git(repo, 'add', '.');
        git(repo, 'commit', '-qm', 'init');
      }
      const root = join(repo, 'pkg');
      const before = await computeFingerprint(root);
      assert.equal(before.git, useGit);
      mutate(repo);
      const after = await computeFingerprint(root);
      if ((after.fingerprint !== before.fingerprint) !== changes) wrong.push(`${useGit ? 'git' : 'no git'}: ${what}`);
    }
  }
  assert.deepEqual(wrong, [], 'cases whose key change did not match core');
});

test('fix-r1 R1-1: pruning starts below the indexed root, never at the root or its ancestors', async () => {
  // Root = packages/dist (committed, no __init__.py): core traverses the root it was given, and prunes only below it.
  const files = {
    'packages/dist/a.js': 'export const a = 1;\n',
    'packages/dist/sub/b.js': 'export const b = 1;\n',
    'packages/dist/node_modules/dep/index.js': 'module.exports = 1;\n',
    'packages/dist/build/c.js': 'export const c = 1;\n',
  };
  const edit = (path) => (r) => writeFileSync(join(r, path), `${readFileSync(join(r, path), 'utf8').trimEnd()} \n\n`);
  const cases = [
    ['source directly in a root named dist', edit('packages/dist/a.js'), true],
    ['source in a subfolder of a root named dist', edit('packages/dist/sub/b.js'), true],
    ['an untracked source file in a root named dist', (r) => writeFileSync(join(r, 'packages/dist/new.js'), 'x\n'), true],
    ['node_modules below the root', edit('packages/dist/node_modules/dep/index.js'), false],
    ['build/ below the root', edit('packages/dist/build/c.js'), false],
  ];
  const wrong = [];
  for (const [what, mutate, changes] of cases) {
    const repo = mkdtempSync(join(dir, 'fp-'));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    const root = join(repo, 'packages', 'dist');
    const before = await computeFingerprint(root);
    mutate(repo);
    const after = await computeFingerprint(root);
    if ((after.fingerprint !== before.fingerprint) !== changes) wrong.push(what);
  }
  assert.deepEqual(wrong, [], 'cases whose key change did not match core');
});

test('fix-r1 #7: stale bundle temp files from a dead producer are swept under the lock', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const repoDir = join(codegraphDir(dir), repo.name);
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, 'bundle.999999.deadbeef.tmp.json'), '{"partial');
  writeFileSync(join(repoDir, 'bundle.999999.deadbeef.tmp.json.tmp.12'), '{"partial');
  await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer: fixtureProducer([]) });
  assert.deepEqual(readdirSync(repoDir).filter((f) => f.includes('.tmp')), []);
});

test('fix-r1 #7: specUsesCodegraph finds plan_gate or explore_design at any depth', () => {
  assert.equal(specUsesCodegraph({ flows: { build: { steps: [{ id: 'explore_design' }] } } }), true);
  assert.equal(specUsesCodegraph({ flows: { build: { steps: [{ id: 'plan' }, { id: 'plan_gate', function: 'x' }] } } }), true);
  assert.equal(specUsesCodegraph({ flows: { quick: { steps: [{ id: 'execute' }, { id: 'ship' }] } } }), false);
  assert.equal(specUsesCodegraph(null), false);
});

test('fix-r1 #5: both producers take the contract argv (positional path, --fields minimal)', () => {
  const argv = bundleArgv({ root: '/r', repo: 'compose', out: '/o.json', exclude: ['fixtures', 'vendor'] });
  assert.deepEqual(argv, ['/r', '--repo', 'compose', '--exclude', 'fixtures', '--exclude', 'vendor', '--out', '/o.json', '--allow-partial', '--fields', 'minimal']);
  assert.deepEqual(cliBundleArgs({ root: '/r', repo: 'compose', out: '/o.json' }).slice(0, 3), ['code', 'bundle', '/r']);
  assert.ok(!argv.includes('--slim') && !argv.includes('--repo-root'));
});
