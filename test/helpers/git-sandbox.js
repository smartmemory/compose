/**
 * COMPOSE-GOLDEN-LEAK-1: the one place tests get a safe git environment.
 *
 * Bug class: a test runs `git config` / `git commit` against a path that resolves to the REAL repo
 * (an inherited GIT_DIR/GIT_WORK_TREE, or a linked worktree that shares the real `.git/config`).
 * 2026-10-16 evidence: the real `.git/config` carried user.name "Compose Golden" and a worktree
 * received 354 "consumer golden baseline" commits. Every git-calling helper goes through here.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// Importing git-env-scrub scrubs this process's env, so every importer is safe even under a bare `node --test file`.
import { scrubGitEnv } from './git-env-scrub.js';

export { CONFIG_REDIRECT_ENV, REPO_LOCATING_ENV, scrubGitEnv } from './git-env-scrub.js';

export const TEST_IDENTITY = { name: 'Compose Test', email: 'compose-test@example.test' };

/** process.env minus every repo- and config-redirecting GIT_* variable, with global/system config disabled. */
export function isolatedGitEnv(extra = {}) {
  const env = scrubGitEnv();
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return { ...env, ...extra };
}

/** The real compose repo's common git dir, resolved from this file (never from cwd or env). */
export function realRepoCommonDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = execFileSync('git', ['-C', here, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8', env: isolatedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return realpathSync(out);
}

/** The common git dir `dir` resolves to, or null when it is not inside any repository. */
export function commonDirOf(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', env: isolatedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return realpathSync(out);
  } catch { return null; }
}

/** Throws when `dir` would write to the real repo's .git (same common dir, or inside its work tree). */
export function assertOutsideRealRepo(dir, real = realRepoCommonDir()) {
  const common = commonDirOf(dir);
  if (common === real) throw new Error(`git sandbox: ${dir} resolves to the real repo (${real})`);
  const realTop = dirname(real);
  const abs = resolve(dir);
  if (abs === realTop || abs.startsWith(realTop + sep)) throw new Error(`git sandbox: ${dir} is inside the real repo work tree`);
}

/** A new empty directory under tmpdir() that is guaranteed outside the real repo. */
export function makeSandboxDir(prefix = 'compose-git-sandbox-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  assertOutsideRealRepo(dir);
  return dir;
}

/** `git init` in a fresh directory under the sandbox rule, identity set locally on the repo it created. */
export function initSandboxRepo(dir = makeSandboxDir(), identity = TEST_IDENTITY) {
  assertOutsideRealRepo(dir);
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: isolatedGitEnv(), stdio: 'pipe' }).trim();
  run('init', '-q');
  run('config', '--local', 'user.name', identity.name);
  run('config', '--local', 'user.email', identity.email);
  return { dir, git: run };
}

/** Best-effort `git worktree remove` for use in `finally`; never throws. */
export function removeWorktree(repoDir, path) {
  try { execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', path], { env: isolatedGitEnv(), stdio: 'pipe' }); } catch { /* already gone */ }
  try { execFileSync('git', ['-C', repoDir, 'worktree', 'prune'], { env: isolatedGitEnv(), stdio: 'pipe' }); } catch { /* not a repo */ }
}

/** execFileSync('git', args) with the isolated env: the one door fixtures use to run git, whatever the caller's env. */
export function gitSync(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', ...opts, env: isolatedGitEnv(opts.env) }).trim();
}
