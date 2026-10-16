/**
 * COMPOSE-GOLDEN-LEAK-1: scrub inherited git redirection from THIS process, on import.
 *
 * Importing this module is the protection: it works under `node --test file`, `npm run test:*` and Vitest alike,
 * with or without the `--import ./test/suppress-expected-drift.js` preload (which imports it too).
 * Source of the variable list: `man git` ENVIRONMENT VARIABLES and `man git-config` ENVIRONMENT
 * (git 2.54.0, 2026-10-17), plus GIT_CONFIG_PARAMETERS (git's internal carrier for `-c`).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Variables that point git at a repository, work tree, object store or index other than the one at `cwd`.
export const REPO_LOCATING_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];

// Variables that redirect or inject git CONFIG (`git config user.name x` lands in GIT_CONFIG's file, whatever the cwd).
export const CONFIG_REDIRECT_ENV = ['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_SYSTEM'];
const CONFIG_PAIR = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

export const isGitRedirectVar = (key) => REPO_LOCATING_ENV.includes(key) || CONFIG_REDIRECT_ENV.includes(key) || CONFIG_PAIR.test(key);

/** A copy of `env` without any repo- or config-redirecting GIT_* variable. */
export function scrubGitEnv(env = process.env) {
  const out = { ...env };
  for (const key of Object.keys(out)) if (isGitRedirectVar(key)) delete out[key];
  return out;
}

/** The fallback-identity gitconfig that replaces the developer's global config for this run (created once, shared by children). */
function throwawayGitConfig() {
  if (process.env.COMPOSE_TEST_GITCONFIG) return process.env.COMPOSE_TEST_GITCONFIG;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compose-test-gitconfig-')));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Compose Test\n\temail = compose-test@example.test\n');
  return (process.env.COMPOSE_TEST_GITCONFIG = join(dir, 'gitconfig'));
}

/** Idempotent: scrub process.env in place and point global/system config at the throwaway file. */
export function installGitEnvScrub() {
  for (const key of Object.keys(process.env)) if (isGitRedirectVar(key)) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = throwawayGitConfig();
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}

installGitEnvScrub();
