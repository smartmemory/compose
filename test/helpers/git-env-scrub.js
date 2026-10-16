/**
 * COMPOSE-GOLDEN-LEAK-1: strip inherited git environment from THIS process, on import.
 *
 * Importing this module is the protection: it works under `node --test file`, `npm run test:*` and Vitest alike,
 * with or without the `--import ./test/suppress-expected-drift.js` preload (which imports it too).
 *
 * ALLOWLIST, not denylist (fix2). Two review rounds each found a redirector the man-page list missed (GIT_CONFIG,
 * then GIT_REFERENCE_BACKEND), so every GIT_* variable is removed and only the names below survive. None of them can
 * point git at another repository, ref store, object store, index or config file. A new git release that adds a
 * redirecting variable is stripped by default.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// Inherited GIT_* names that survive the scrub: commit identity/dates (tests set them per call) and interactive-UI knobs.
export const INHERITABLE_GIT_ENV = [
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
  'GIT_TERMINAL_PROMPT', 'GIT_PAGER', 'GIT_EDITOR',
];
// Names the scrub SETS itself after stripping (never taken from the caller): global config = throwaway, no system config.
export const SCRUB_SET_GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];

export const isStrippedGitVar = (key) => key.startsWith('GIT_') && !INHERITABLE_GIT_ENV.includes(key);

/** A copy of `env` with every GIT_* variable removed except INHERITABLE_GIT_ENV. Pure: sets nothing. */
export function scrubGitEnv(env = process.env) {
  const out = { ...env };
  for (const key of Object.keys(out)) if (isStrippedGitVar(key)) delete out[key];
  return out;
}

/**
 * The fallback-identity gitconfig that replaces the developer's global config for this run (created once, shared by
 * children through COMPOSE_TEST_GITCONFIG). An inherited value is reused only when it is one of ours: a `gitconfig`
 * file in a `compose-test-gitconfig-*` dir directly under tmpdir(). Anything else (e.g. a real repo's .git/config)
 * would turn `git config --global` into a write there, so it is replaced.
 */
function isOurGitConfig(path) {
  try {
    return basename(path) === 'gitconfig' && /^compose-test-gitconfig-/.test(basename(dirname(path)))
      && realpathSync(dirname(dirname(path))) === realpathSync(tmpdir());
  } catch { return false; }
}

function throwawayGitConfig() {
  const inherited = process.env.COMPOSE_TEST_GITCONFIG;
  if (inherited && isOurGitConfig(inherited)) return inherited;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compose-test-gitconfig-')));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Compose Test\n\temail = compose-test@example.test\n');
  return (process.env.COMPOSE_TEST_GITCONFIG = join(dir, 'gitconfig'));
}

let configHome = null;
/** The sandbox dir this process uses as XDG_CONFIG_HOME (holds the throwaway gitconfig). */
export const sandboxConfigHome = () => configHome;

/** Idempotent: strip process.env to the allowlist, then point global config at the throwaway and disable system config. */
export function installGitEnvScrub() {
  for (const key of Object.keys(process.env)) if (isStrippedGitVar(key)) delete process.env[key];
  const gitconfig = throwawayGitConfig();
  configHome = dirname(gitconfig);
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  // Belt and braces: GIT_CONFIG_GLOBAL already stops git reading $XDG_CONFIG_HOME/git/config (`git help git`).
  process.env.XDG_CONFIG_HOME = configHome;
}

installGitEnvScrub();
