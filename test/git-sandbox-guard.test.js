/**
 * COMPOSE-GOLDEN-LEAK-1 guard: git-calling tests must not be able to write to the real repo.
 * Rows: (1) one per repo-locating env var, (2) one per path class the sandbox must reject or accept,
 * (3) one per test file/helper that writes `git config user.*`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_LOCATING_ENV, assertOutsideRealRepo, commonDirOf, initSandboxRepo, isolatedGitEnv,
  makeSandboxDir, realRepoCommonDir, removeWorktree,
} from './helpers/git-sandbox.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('isolatedGitEnv drops every repo-locating variable and disables global/system config', () => {
  const saved = {};
  for (const k of REPO_LOCATING_ENV) { saved[k] = process.env[k]; process.env[k] = '/nonexistent'; }
  try {
    const env = isolatedGitEnv();
    for (const k of REPO_LOCATING_ENV) assert.equal(env[k], undefined, k);
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  } finally {
    for (const k of REPO_LOCATING_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('the test preload scrubbed repo-locating env and redirected global git config', () => {
  for (const k of REPO_LOCATING_ENV) assert.equal(process.env[k], undefined, k);
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.match(process.env.GIT_CONFIG_GLOBAL ?? '', /compose-test-gitconfig-/);
});

const PATH_ROWS = [
  ['the repo root itself', () => ROOT, true],
  ['a subdirectory of the repo', () => join(ROOT, 'test'), true],
  ['a fresh tmp dir', () => makeSandboxDir('compose-guard-row-'), false],
];
for (const [name, dir, rejected] of PATH_ROWS) {
  test(`assertOutsideRealRepo: ${name} is ${rejected ? 'rejected' : 'accepted'}`, () => {
    const d = dir();
    try {
      if (rejected) assert.throws(() => assertOutsideRealRepo(d), /real repo/);
      else assert.doesNotThrow(() => assertOutsideRealRepo(d));
    } finally { if (!rejected) rmSync(d, { recursive: true, force: true }); }
  });
}

test('a linked worktree shares its repo common dir and is rejected when that repo is "real"; removeWorktree cleans it up', () => {
  // Never touch the real repo's worktree list here: parallel test processes gate on it.
  const { dir: stand, git } = initSandboxRepo();
  const wt = join(makeSandboxDir('compose-guard-wt-'), 'linked');
  try {
    git('commit', '-q', '--allow-empty', '-m', 'base');
    git('worktree', 'add', '-q', '--detach', wt, 'HEAD');
    const standIn = commonDirOf(stand);
    assert.equal(commonDirOf(wt), standIn);
    assert.throws(() => assertOutsideRealRepo(wt, standIn), /real repo/);
    assert.doesNotThrow(() => assertOutsideRealRepo(wt), 'against the actual real repo it is outside');
  } finally {
    removeWorktree(stand, wt);
    rmSync(dirname(wt), { recursive: true, force: true });
    rmSync(stand, { recursive: true, force: true });
  }
  assert.doesNotMatch(execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', env: isolatedGitEnv() }), /compose-guard-wt-/);
});

test('initSandboxRepo writes identity only into the repo it created; the real repo config is untouched', () => {
  const local = (cwd) => { try { return execFileSync('git', ['-C', cwd, 'config', '--local', '--get', 'user.name'], { encoding: 'utf8', env: isolatedGitEnv(), stdio: 'pipe' }).trim(); } catch { return ''; } };
  const before = local(ROOT);
  const { dir, git } = initSandboxRepo();
  try {
    assert.equal(git('config', '--local', 'user.name'), 'Compose Test');
    assert.equal(local(ROOT), before);
    assert.notEqual(local(ROOT), 'Compose Test');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// One row per file that writes `git config user.*`: it must create its own repo first, and only ever
// write the local config of that repo (never --global/--system, never a bare config against process.cwd()).
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}
const CONFIG_WRITER = /user\.(name|email)/;
const SELF = relative(ROOT, fileURLToPath(import.meta.url));
// lib/ only reads identity (`git config user.name`) or owns its sandbox, and the preload mentions it in prose.
const writers = walk(join(ROOT, 'test'))
  .map((p) => relative(ROOT, p))
  .filter((rel) => rel !== SELF && rel !== 'test/suppress-expected-drift.js' && rel !== 'test/helpers/git-sandbox.js' && CONFIG_WRITER.test(readFileSync(join(ROOT, rel), 'utf8')));

test('the config-writer table is not empty (the walk found the known writers)', () => {
  assert.ok(writers.length >= 40, `found only ${writers.length}`);
  assert.ok(writers.includes('test/ts-cutover-consumer-fanout-golden.test.js'));
});

for (const rel of writers) {
  test(`config writer ${rel}: inits or asserts its repo before writing identity, never --global/--system`, () => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /--global|--system/, 'identity must be local to a repo the file created');
    const firstWrite = src.search(CONFIG_WRITER);
    const guardAt = src.search(/'init'|"init"|git init|initSandboxRepo|assertOutsideRealRepo/);
    assert.ok(guardAt !== -1 && guardAt < firstWrite, `${rel}: no git init or assertOutsideRealRepo before the first identity write`);
  });
}
