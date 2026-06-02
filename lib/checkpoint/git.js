/**
 * COMP-RESUME S2 — thin git wrapper for environment fingerprinting.
 *
 * A deliberately small spawnSync wrapper (pattern: lib/bug-bisect.js `git()`).
 * Every helper returns trimmed stdout or null on failure, so callers outside a
 * git repo (or with git unavailable) degrade gracefully rather than throwing.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Run a git command, return trimmed stdout. Returns null on any non-zero exit
 * or other failure (e.g. not a git repo, git missing).
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null}
 */
export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout ?? '').trim();
}

/** Current HEAD sha, or null outside a repo. */
export function head(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** Current branch name (or 'HEAD' when detached), null outside a repo. */
export function branch(cwd) {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * Working-tree status in porcelain form. '' when the tree is clean, null when
 * not a git repo. (Note: empty string is "clean", null is "no repo" — callers
 * must distinguish the two.)
 */
export function porcelain(cwd) {
  return git(cwd, ['status', '--porcelain']);
}

/**
 * Deterministic hash of the working-tree state: sha256 of
 * `git status --porcelain` concatenated with `git diff`.
 *
 * Returns null when (a) not a git repo, or (b) the tree is clean (porcelain is
 * the empty string) — there is no drift to fingerprint.
 * @returns {string|null}
 */
export function dirtyHash(cwd) {
  const status = porcelain(cwd);
  // null → not a repo; '' → clean tree. Either way, no dirty hash.
  if (status === null || status === '') return null;
  const diff = git(cwd, ['diff']) ?? '';
  return createHash('sha256').update(status).update(diff).digest('hex');
}
