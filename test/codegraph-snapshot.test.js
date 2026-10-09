// STRAT-CODEGRAPH-1 snapshot cache: cache validity (HEAD, working-tree state, resolution
// dependencies), single flight, cache hits, timing, the producer log, and one repo's failure not
// discarding another's snapshot.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureSnapshot, loadSnapshots, normalizeBundle, resolveRepos, codegraphDir,
  bundleArgv, cliBundleArgs, prebuildSnapshots, specUsesCodegraph,
} from '../lib/codegraph/snapshot.js';
import { resetAvailabilityCache } from '../lib/codegraph/availability.js';
import { digestMembers, worktreeState } from '../lib/codegraph/cache-validity.js';
import { acquireDirLock } from '../lib/dir-lock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(gunzipSync(readFileSync(join(HERE, 'fixtures', 'codegraph', 'stratum.bundle.json.gz'))).toString('utf8'));
const AVAILABLE = { available: true, mode: 'cli', command: '/fake/smartmemory', version: '1.5.26', reason: null, warnings: [] };

let dir;
let outside;
let originalWarn;
let warnings;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codegraph-snap-'));
  outside = mkdtempSync(join(tmpdir(), 'codegraph-snap-outside-'));
  resetAvailabilityCache();
  originalWarn = console.warn;
  warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
});
afterEach(() => {
  console.warn = originalWarn;
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
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

function headOf(root) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** The recorded fixture, re-stamped as if the producer had just run on `repo`: its HEAD and `deps`. */
function bundleFor(repo, deps = []) {
  return { ...FIXTURE, source: { ...FIXTURE.source, head: headOf(repo.root), resolution_dependencies: deps } };
}

function fixtureProducer(calls, deps = () => []) {
  return async ({ repo, out }) => {
    calls.push(out);
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(out, JSON.stringify(bundleFor(repo, deps())));
  };
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('worktree state: an edit, a re-edit of a dirty file, and a commit outside the subdir all change it', async () => {
  initRepo();
  const sub = join(dir, 'sub');
  const clean = await worktreeState(sub);
  assert.equal(clean.git, true);
  assert.equal(clean.head, headOf(dir));
  assert.deepEqual(await worktreeState(sub), clean, 'stable when nothing changed');

  writeFileSync(join(dir, 'top.js'), 'export const t = 2;\n');
  git(dir, 'commit', '-qam', 'outside sub');
  const moved = await worktreeState(sub);
  assert.notEqual(moved.head, clean.head);
  assert.notEqual(moved.hash, clean.hash, 'accepted over-invalidation: any new HEAD misses');

  writeFileSync(join(sub, 'a.js'), 'export const a = 2;\n');
  const dirty1 = await worktreeState(sub);
  assert.notEqual(dirty1.hash, moved.hash);

  writeFileSync(join(sub, 'a.js'), 'export const a = 3;\n'); // same porcelain line, same size, different content
  const dirty2 = await worktreeState(sub);
  assert.notEqual(dirty2.hash, dirty1.hash);
});

test('worktree state of a non-git root is a stat walk', async () => {
  writeFileSync(join(dir, 'x.ts'), 'export {}\n');
  const one = await worktreeState(dir);
  assert.equal(one.git, false);
  assert.equal(one.head, '');
  writeFileSync(join(dir, 'y.ts'), 'export {}\n');
  assert.notEqual((await worktreeState(dir)).hash, one.hash);
});

test('worktree state covers ignored files (also inside ignored dirs) and files git is told not to look at', async () => {
  initRepo();
  writeFileSync(join(dir, '.gitignore'), 'local.js\n.codex-out/\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-qm', 'ignore');
  writeFileSync(join(dir, 'local.js'), 'export const l = 1;\n');
  mkdirSync(join(dir, '.codex-out'));
  writeFileSync(join(dir, '.codex-out', 'fix2.py'), 'x = 1\n');
  const one = await worktreeState(dir);
  writeFileSync(join(dir, 'local.js'), 'export const l = 12345;\n');
  const two = await worktreeState(dir);
  assert.notEqual(two.hash, one.hash, 'an ignored file core still indexes');
  writeFileSync(join(dir, '.codex-out', 'fix2.py'), 'x = 12345\n');
  const three = await worktreeState(dir);
  assert.notEqual(three.hash, two.hash, 'a file inside an ignored directory');

  git(dir, 'update-index', '--assume-unchanged', 'sub/a.js');
  const four = await worktreeState(dir);
  writeFileSync(join(dir, 'sub', 'a.js'), 'export const a = 9;\n');
  assert.equal(git(dir, 'status', '--porcelain', '--', 'sub').trim(), '', 'git status does not see it');
  assert.notEqual((await worktreeState(dir)).hash, four.hash, 'an assume-unchanged file is content-keyed');
});

test('r2-1: no file name can forge a state record (names with a newline and `=`)', async () => {
  initRepo();
  const text = 'x = 1\n';
  const h = sha256(text);
  // Two untracked files with the same content, versus ONE file whose name holds the other's record.
  writeFileSync(join(dir, 'x.py'), text);
  writeFileSync(join(dir, 'y.py'), text);
  const two = await worktreeState(dir);
  rmSync(join(dir, 'x.py'));
  rmSync(join(dir, 'y.py'));
  writeFileSync(join(dir, `x.py=${h}\n?? y.py`), text);
  const one = await worktreeState(dir);
  assert.notEqual(one.hash, two.hash);
});

/** Rewrite a file at the same size and put its mtime back, so only content (and ctime) differ. */
function sameSizeEdit(path, from, to) {
  const { atime, mtime } = statSync(path);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  utimesSync(path, atime, mtime);
}

// Edits a clean `git status` of the indexed root does not show, each on a root that is a SUBDIRECTORY
// of the git toplevel (index paths are relative to the toplevel there, not to the root).
const HIDDEN_EDITS = [
  ['an assume-unchanged file', () => git(dir, 'update-index', '--assume-unchanged', 'sub/a.js'),
    () => sameSizeEdit(join(dir, 'sub', 'a.js'), '1', '9')],
  ['a skip-worktree file', () => git(dir, 'update-index', '--skip-worktree', 'sub/a.js'),
    () => sameSizeEdit(join(dir, 'sub', 'a.js'), '1', '9')],
  ['the target of a tracked symlink into .compose', () => {
    mkdirSync(join(dir, 'sub', '.compose'));
    writeFileSync(join(dir, 'sub', '.compose', 'source.py'), 'def f():\n    return 1\n');
    symlinkSync('.compose/source.py', join(dir, 'sub', 'link.py'));
    git(dir, 'add', 'sub/link.py');
    git(dir, 'commit', '-qm', 'link');
  }, () => sameSizeEdit(join(dir, 'sub', '.compose', 'source.py'), 'f', 'g')],
  ['the target of a tracked symlink outside the root', () => {
    writeFileSync(join(outside, 'shared.py'), 'def f():\n    return 1\n');
    symlinkSync(join(outside, 'shared.py'), join(dir, 'sub', 'shared.py'));
    git(dir, 'add', 'sub/shared.py');
    git(dir, 'commit', '-qm', 'link');
  }, () => sameSizeEdit(join(outside, 'shared.py'), 'f', 'g')],
  ['an ignored file inside a clean submodule', () => {
    const mod = join(dir, 'sub', 'mod');
    mkdirSync(mod);
    git(mod, 'init', '-q');
    writeFileSync(join(mod, '.gitignore'), 'local.py\n');
    git(mod, 'add', '.');
    git(mod, 'commit', '-qm', 'mod');
    git(dir, '-c', 'advice.addEmbeddedRepo=false', 'add', 'sub/mod'); // a gitlink (mode 160000)
    git(dir, 'commit', '-qm', 'gitlink');
    writeFileSync(join(mod, 'local.py'), 'def f():\n    return 1\n');
  }, () => sameSizeEdit(join(dir, 'sub', 'mod', 'local.py'), 'f', 'g')],
  ['the target of an ignored symlink', () => {
    writeFileSync(join(dir, '.gitignore'), 'sub/ign.py\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-qm', 'ignore');
    writeFileSync(join(outside, 'real.py'), 'def f():\n    return 1\n');
    symlinkSync(join(outside, 'real.py'), join(dir, 'sub', 'ign.py'));
  }, () => sameSizeEdit(join(outside, 'real.py'), 'f', 'g')],
];

test('worktree state sees every edit a clean git status hides (root below the git toplevel)', async (t) => {
  for (const [name, setup, edit] of HIDDEN_EDITS) {
    await t.test(name, async () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      initRepo();
      setup();
      const before = await worktreeState(join(dir, 'sub'));
      assert.equal(before.error, undefined, before.error);
      const status = git(dir, 'status', '--porcelain', '--', 'sub');
      edit();
      assert.equal(git(dir, 'status', '--porcelain', '--', 'sub'), status, 'git status does not show it');
      const after = await worktreeState(join(dir, 'sub'));
      assert.notEqual(after.hash, before.hash);
    });
  }
});

test('a stat-keyed file changed moments ago is racy: such a state is never cached', async () => {
  initRepo();
  writeFileSync(join(dir, '.gitignore'), 'local.js\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-qm', 'ignore');
  writeFileSync(join(dir, 'local.js'), 'export const l = 1;\n');
  assert.equal((await worktreeState(dir)).racy, 1, 'an ignored file written just now');
  assert.equal((await worktreeState(dir, { racyWindowMs: 0 })).racy, 0);
  writeFileSync(join(dir, 'top.js'), 'export const t = 2;\n');
  assert.equal((await worktreeState(dir)).racy, 1, 'content-keyed files are never racy');

  const repo = resolveRepos(dir)[0];
  const calls = [];
  const first = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer: fixtureProducer(calls) });
  assert.equal(first.timing.stored, false);
  assert.ok(warnings.some((w) => /1 file\(s\) changed within 3 s of the run, too recently for their stat keys to be trusted; using it once/.test(w)), warnings.join('\n'));
});

test('.compose edits keep the worktree state; docs edits change it (accepted over-invalidation)', async () => {
  initRepo();
  const base = await worktreeState(dir);
  mkdirSync(join(dir, '.compose', 'codegraph', 'x'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), '{}\n');
  writeFileSync(join(dir, '.compose', 'codegraph', 'x', 'y.json'), '{}\n');
  mkdirSync(join(dir, 'sub', '.compose'));
  writeFileSync(join(dir, 'sub', '.compose', 'z.json'), '{}\n');
  assert.equal((await worktreeState(dir)).hash, base.hash, 'the producer always runs with --exclude .compose');
  mkdirSync(join(dir, 'docs', 'features', 'FX-1'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'features', 'FX-1', 'plan.md'), '# plan\n');
  assert.notEqual((await worktreeState(dir)).hash, base.hash);
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
  assert.equal(a.timing.stored, true);
  assert.ok(existsSync(a.path));
  assert.equal(a.snapshot.producer, 'cli');
  assert.equal(a.snapshot.cache_key.head, headOf(dir));
  assert.equal(a.snapshot.entities.length, normalizeBundle(FIXTURE).entities.length);

  const c = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer });
  assert.equal(calls.length, 1, 'the cache files Compose wrote under .compose do not invalidate it');
  assert.equal(c.cached, true);

  const repoDir = join(codegraphDir(dir), repo.name);
  const timings = readFileSync(join(repoDir, 'timings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(timings.length, 2);
  assert.equal(timings[0].cached, false);
  for (const field of ['keyMs', 'depsMs', 'bundleMs', 'normalizeMs', 'totalMs']) assert.equal(typeof timings[0][field], 'number', field);
  assert.equal(timings[1].cached, true);
  assert.equal(typeof timings[1].keyMs, 'number');
  assert.equal(typeof timings[1].depsMs, 'number');
  assert.deepEqual(readdirSync(repoDir).filter((f) => f.includes('.tmp')), [], 'no temp bundle left behind');
  assert.equal(calls[0].startsWith(repoDir), true, 'raw bundle is written inside the repo cache dir');
});

test('r2-6: a caller joining a run in flight gets its own repo (prefix), not the first caller\'s', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const calls = [];
  const producer = fixtureProducer(calls);
  const other = { ...repo, prefix: 'elsewhere/' };
  const [a, b] = await Promise.all([
    ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer }),
    ensureSnapshot({ projectRoot: dir, repo: other, availability: AVAILABLE, producer }),
  ]);
  assert.equal(calls.length, 1, 'the prefix is not part of the run');
  assert.equal(b.joined, true);
  assert.equal(a.repo, repo);
  assert.equal(b.repo, other);
});

test('an edit under the root re-produces; reverting it is a cache hit again', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const calls = [];
  const producer = fixtureProducer(calls);
  await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer });
  writeFileSync(join(dir, 'sub', 'new.js'), 'export const n = 1;\n');
  assert.equal((await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer })).cached, false);
  rmSync(join(dir, 'sub', 'new.js'));
  assert.equal((await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer })).cached, true);
  assert.equal(calls.length, 2);
});

test('everything besides the tree that changes the output re-produces; the parse-cache location does not', async () => {
  initRepo();
  mkdirSync(join(dir, 'other'));
  writeFileSync(join(dir, 'other', 'b.js'), 'export const b = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'other');
  const repo = { name: 'x', root: join(dir, 'sub'), prefix: '', exclude: ['fixtures', 'src'] };
  const env = { PATH: process.env.PATH, SMARTMEMORY_CODE_MAX_RUN_ENTITIES: '1000' };
  const calls = [];
  const producer = fixtureProducer(calls);
  const run = (over = {}) => ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer, env, ...over });
  assert.equal((await run()).timing.stored, true);
  assert.equal((await run()).cached, true);
  assert.equal((await run({ env: { ...env, SMARTMEMORY_CODE_CHECKPOINT_DIR: join(outside, 'pc') } })).cached, true, 'parse-cache dir');
  const changes = [
    ['CLI version', { availability: { ...AVAILABLE, version: '1.5.27' } }],
    ['CLI command', { availability: { ...AVAILABLE, command: '/other/smartmemory' } }],
    ['indexed root (same name, clean, same HEAD)', { repo: { ...repo, root: join(dir, 'other') } }],
    ['exclude list boundaries', { repo: { ...repo, exclude: ['fixtures,src'] } }],
    ['code policy env', { env: { ...env, SMARTMEMORY_CODE_MAX_RUN_ENTITIES: '5' } }],
    ['a new code policy env', { env: { ...env, SMARTMEMORY_CODE_GENERATED_PATTERNS: '*.gen.ts' } }],
  ];
  for (const [name, over] of changes) assert.equal((await run(over)).cached, false, name);
  assert.equal(calls.length, 1 + changes.length);
  assert.ok(!readFileSync(join(codegraphDir(dir), 'x', readdirSync(join(codegraphDir(dir), 'x')).find((f) => f.endsWith('.json') && f.length === 69)), 'utf8').includes('1000'),
    'policy values are hashed, not stored');
});

test('r2-2: a parser package installed beside the same CLI re-produces (the runtime is in the cache salt)', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const site = join(outside, 'venv', 'lib', 'python3.12', 'site-packages');
  mkdirSync(site, { recursive: true });
  mkdirSync(join(outside, 'venv', 'bin'));
  symlinkSync('/bin/sh', join(outside, 'venv', 'bin', 'python3'));
  const cli = join(outside, 'smartmemory');
  writeFileSync(cli, `#!${join(outside, 'venv', 'bin', 'python3')}\nexit 0\n`);
  chmodSync(cli, 0o755);
  const calls = [];
  const run = () => ensureSnapshot({ projectRoot: dir, repo, availability: { ...AVAILABLE, command: cli }, producer: fixtureProducer(calls) });
  assert.equal((await run()).timing.stored, true);
  assert.equal((await run()).cached, true);
  mkdirSync(join(site, 'tree_sitter_typescript-0.23.2.dist-info'));
  assert.equal((await run()).cached, false);
  assert.equal(calls.length, 2);
});

test('a caller that waited for the lock re-reads the tree: a snapshot published meanwhile for the old tree is not served', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const calls = [];
  const producer = fixtureProducer(calls);
  const first = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer });
  const parked = `${first.path}.parked`;
  renameSync(first.path, parked);
  const release = await acquireDirLock(join(codegraphDir(dir), repo.name, '.lock'));
  const waiting = ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer }); // reads S0, misses, waits
  await new Promise((r) => setTimeout(r, 300));
  renameSync(parked, first.path); // another process publishes the S0 snapshot...
  writeFileSync(join(dir, 'sub', 'a.js'), 'export const a = 2;\n'); // ...and the tree moves to S1
  release();
  const result = await waiting;
  assert.equal(result.cached, false);
  assert.equal(calls.length, 2);
});

test('(c): a resolution dependency outside the root invalidates the cache when it changes', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const config = join(outside, 'tsconfig.base.json');
  writeFileSync(config, '{"compilerOptions":{}}\n');
  const deps = () => [
    { kind: 'content', path: config, sha256: sha256(readFileSync(config)) },
    { kind: 'exists', path: join(outside, 'missing.ts'), exists: existsSync(join(outside, 'missing.ts')) },
  ];
  const calls = [];
  const producer = fixtureProducer(calls, deps);
  // racyWindowMs 0: the outside files were written just before; only a change during the run is distrusted.
  const run = () => ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer, racyWindowMs: 0 });

  assert.equal((await run()).timing.stored, true);
  assert.equal((await run()).cached, true);
  writeFileSync(config, '{"compilerOptions":{"paths":{}}}\n');
  assert.equal((await run()).cached, false, 'content changed');
  assert.equal((await run()).cached, true);
  writeFileSync(join(outside, 'missing.ts'), 'export {}\n');
  assert.equal((await run()).cached, false, 'a path that did not exist appeared');
  assert.equal((await run()).cached, true);
  assert.equal(calls.length, 3);
});

test('r2-4: an outside dependency changed while the producer ran is not cached (core hashes it after parsing)', async (t) => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const config = join(outside, 'tsconfig.base.json');
  writeFileSync(config, '{"compilerOptions":{}}\n');
  mkdirSync(join(dir, '.compose', 'shared'), { recursive: true });
  const composeDep = join(dir, '.compose', 'shared', 'paths.json');
  writeFileSync(composeDep, '{}\n');
  const old = new Date(Date.now() - 60000);
  for (const p of [config, composeDep]) utimesSync(p, old, old);
  const content = (path) => ({ kind: 'content', path, sha256: sha256(readFileSync(path)) });
  // Each row: what the producer does mid-run, then the dependency it records (state read after the change).
  const rows = [
    ['an outside content file rewritten', () => writeFileSync(config, '{"compilerOptions":{"x":1}}\n'), () => [content(config)]],
    ['an outside path created (recorded exists:true)', () => writeFileSync(join(outside, 'new.ts'), 'export {}\n'),
      () => [{ kind: 'exists', path: join(outside, 'new.ts'), exists: true }]],
    ['a .compose dependency rewritten ((b) leaves .compose out)', () => writeFileSync(composeDep, '{"a":1}\n'), () => [content(composeDep)]],
  ];
  for (const [name, change, deps] of rows) {
    await t.test(name, async () => {
      warnings.length = 0;
      const producer = async ({ out }) => {
        change();
        writeFileSync(out, JSON.stringify(bundleFor(repo, deps())));
      };
      const result = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer, racyWindowMs: 0 });
      assert.equal(result.timing.stored, false, name);
      assert.ok(warnings.some((w) => /changed while the producer ran/.test(w)), warnings.join('\n'));
    });
  }
  // Control: the same dependencies untouched during the run are cached.
  const still = await ensureSnapshot({
    projectRoot: dir, repo, availability: AVAILABLE, racyWindowMs: 0,
    producer: async ({ out }) => writeFileSync(out, JSON.stringify(bundleFor(repo, [content(config), content(composeDep)]))),
  });
  assert.equal(still.timing.stored, true);
});

test('(c): a listing outside the checkout is unverifiable (core records no digest for it), so never cached', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  mkdirSync(join(outside, 'pkgs'));
  writeFileSync(join(outside, 'pkgs', 'a.ts'), 'export {}\n');
  // Even with the digest its members would have: core 1.5.26 emits null here, so this record is not one core makes.
  const deps = () => [{ kind: 'listing', path: join(outside, 'pkgs'), members_sha256: digestMembers([['a.ts', 'file', null]]) }];
  const first = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer: fixtureProducer([], deps) });
  assert.equal(first.timing.stored, false);
  assert.ok(warnings.some((w) => /resolves outside the checkout\); using it once/.test(w)), warnings.join('\n'));
});

test('(c): a dependency core could not digest (null members_sha256) is never cached', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const deps = () => [{ kind: 'listing', path: join(outside, 'gone'), members_sha256: null, members_error: 'FileNotFoundError' }];
  const calls = [];
  const producer = fixtureProducer(calls, deps);
  const first = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer });
  assert.equal(first.timing.stored, false);
  assert.equal(first.path, null);
  assert.ok(first.snapshot.entities.length > 0, 'the snapshot is still used once');
  assert.equal((await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer })).cached, false);
  assert.equal(calls.length, 2);
  assert.ok(warnings.some((w) => /could not digest its members \(FileNotFoundError\)\); using it once without caching/.test(w)), warnings.join('\n'));
});

test('a snapshot whose producer saw another HEAD is not cached', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const first = await ensureSnapshot({
    projectRoot: dir, repo, availability: AVAILABLE,
    producer: async ({ out }) => writeFileSync(out, JSON.stringify({ ...bundleFor(repo), source: { ...bundleFor(repo).source, head: '0'.repeat(40) } })),
  });
  assert.equal(first.timing.stored, false);
  assert.ok(warnings.some((w) => /the producer saw HEAD 0{40}, not [0-9a-f]{40}; using it once/.test(w)), warnings.join('\n'));
});

test('the producer gets SmartMemory\'s parse cache under .compose/codegraph/<repo>/parse-cache', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  let seen = null;
  await ensureSnapshot({
    projectRoot: dir, repo, availability: AVAILABLE, env: { PATH: process.env.PATH },
    producer: async ({ out, env }) => { seen = env.SMARTMEMORY_CODE_CHECKPOINT_DIR; writeFileSync(out, JSON.stringify(bundleFor(repo))); },
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
    writeFileSync(out, JSON.stringify(bundleFor(repo)));
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
    producer: async ({ repo, out }) => writeFileSync(out, JSON.stringify({ ...bundleFor(repo), schema_version: '9' })),
  });
  assert.equal(loaded.snapshots.length, 0);
  assert.match(loaded.errors[0].message, /unsupported schema_version "9"/);
});

test('R1-3: output produced while the source changed is used once and not cached', async () => {
  initRepo();
  const repo = resolveRepos(dir)[0];
  const calls = [];
  const producer = async ({ out }) => {
    calls.push(out);
    writeFileSync(join(dir, 'sub', 'a.js'), `export const a = ${calls.length * 1000};\n`); // edit mid-run
    writeFileSync(out, JSON.stringify(bundleFor(repo)));
  };
  const first = await ensureSnapshot({ projectRoot: dir, repo, availability: AVAILABLE, producer });
  assert.equal(first.timing.stored, false);
  assert.equal(first.path, null);
  const repoDir = join(codegraphDir(dir), repo.name);
  assert.deepEqual(readdirSync(repoDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)), []);
  assert.ok(warnings.some((w) => /source changed while the snapshot was built; using it once without caching/.test(w)));
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

/** A fake `smartmemory` that records its argv, logs WARNING lines and a totals line, and copies $BUNDLE_SRC to --out. */
function fakeCli(exitCode = 0) {
  const bin = join(dir, '..', `${dir.split('/').pop()}-bin`);
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, 'smartmemory');
  writeFileSync(cli, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "$ARGV_OUT"',
    'out=""',
    'while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; shift; fi; shift; done',
    'echo "WARNING: grammar missing for x.rb" >&2',
    'echo "WARNING: unresolved import y" >&2',
    `if [ ${exitCode} -ne 0 ]; then echo "ERROR: boom" >&2; exit ${exitCode}; fi`,
    'echo "[code:bundle] files=3 entities=821 out=$out" >&2',
    'cat "$BUNDLE_SRC" > "$out"',
    '',
  ].join('\n'));
  chmodSync(cli, 0o755);
  return { cli, cleanup: () => rmSync(bin, { recursive: true, force: true }) };
}

test('spawnProducer: stderr goes to producer.log, one summary line is printed, argv excludes .compose', async () => {
  initRepo();
  const repo = { ...resolveRepos(dir)[0], exclude: ['fixtures'] };
  const { cli, cleanup } = fakeCli(0);
  try {
    writeFileSync(join(outside, 'bundle.json'), JSON.stringify(bundleFor(repo)));
    const env = { PATH: process.env.PATH, BUNDLE_SRC: join(outside, 'bundle.json'), ARGV_OUT: join(outside, 'argv.txt') };
    const result = await ensureSnapshot({ projectRoot: dir, repo, availability: { ...AVAILABLE, command: cli }, env });
    assert.equal(result.timing.stored, true);
    const log = join(codegraphDir(dir), repo.name, 'producer.log');
    assert.match(readFileSync(log, 'utf8'), /WARNING: grammar missing for x\.rb\nWARNING: unresolved import y\n\[code:bundle\]/);
    const lines = warnings.filter((w) => w.includes('producer exit'));
    assert.equal(lines.length, 1);
    assert.equal(lines[0], `[codegraph] ${repo.name}: producer exit 0, 2 WARNING line(s), [code:bundle] files=3 entities=821 (log: ${log})`);
    const argv = readFileSync(join(outside, 'argv.txt'), 'utf8').trim().split('\n');
    assert.deepEqual(argv.slice(0, 8), ['code', 'bundle', repo.root, '--repo', repo.name, '--exclude', 'fixtures', '--exclude']);
    assert.equal(argv[8], '.compose');
  } finally {
    cleanup();
  }
});

test('spawnProducer: a failing CLI rejects with its ERROR line and loadSnapshots turns it into a warning', async () => {
  initRepo();
  const { cli, cleanup } = fakeCli(3);
  try {
    const env = { PATH: process.env.PATH, ARGV_OUT: join(outside, 'argv.txt') };
    const loaded = await loadSnapshots({ projectRoot: dir, availability: { ...AVAILABLE, command: cli }, env });
    assert.equal(loaded.snapshots.length, 0);
    assert.match(loaded.errors[0].message, /bundle producer exited 3: ERROR: boom/);
    assert.ok(warnings.some((w) => /producer exit 3, 2 WARNING line\(s\) \(log: .*producer\.log\); ERROR: ERROR: boom$/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some((w) => /snapshot failed: bundle producer exited 3/.test(w)));
  } finally {
    cleanup();
  }
});

// ---- Fix round 1 (scratch/2026-10-08-codegraph/build/fix-r1-brief.md) ----

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

test('fix-r1 #5: the producer takes the contract argv (positional path, --fields minimal, .compose excluded)', () => {
  const argv = bundleArgv({ root: '/r', repo: 'compose', out: '/o.json', exclude: ['fixtures', 'vendor'] });
  assert.deepEqual(argv, [
    '/r', '--repo', 'compose', '--exclude', 'fixtures', '--exclude', 'vendor', '--exclude', '.compose',
    '--out', '/o.json', '--allow-partial', '--fields', 'minimal',
  ]);
  assert.deepEqual(bundleArgv({ root: '/r', repo: 'r', out: '/o', exclude: ['.compose'] }).filter((a) => a === '.compose'), ['.compose'], 'deduped');
  assert.deepEqual(cliBundleArgs({ root: '/r', repo: 'compose', out: '/o.json' }).slice(0, 3), ['code', 'bundle', '/r']);
  assert.ok(!argv.includes('--slim') && !argv.includes('--repo-root'));
});
