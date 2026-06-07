/**
 * xref-local.js — shared containment guard for `local`-provider external refs.
 *
 * A `local` external link names a sibling repo by a bare directory token
 * (`repo`). Both the Pull resolver (xref-sync) and the Push writer (xref-push)
 * must vet that token resolves to a DIRECT sibling of cwd before touching it —
 * lexically first (no path separators, not `.`/`..`, parent must be cwd's
 * parent), then by realpath to defeat a valid-named sibling symlinked outside
 * the workspace parent. This is the security boundary for cross-repo operations.
 *
 * Scope: this helper covers ONLY the repo-token → siblingRoot containment. The
 * caller still owns `to_code` presence checks and reading the sibling's own
 * feature.json (the sibling may declare its own paths.features).
 */

import { resolve, dirname } from 'path';
import { realpathSync } from 'fs';

/**
 * @param {string} cwd
 * @param {string} repo  bare sibling directory token from the link
 * @returns {{root: string} | {skipped: true, reason: string}}
 */
export function resolveSiblingRoot(cwd, repo) {
  if (!repo) return { skipped: true, reason: 'incomplete local ref' };
  const parentDir = resolve(cwd, '..');
  const citedRoot = resolve(parentDir, String(repo));
  // Lexical guard: a path separator, `.`/`..`, or a token whose parent isn't
  // the workspace parent is not a direct sibling.
  if (/[\\/]/.test(repo) || repo === '.' || repo === '..' || dirname(citedRoot) !== parentDir) {
    return { skipped: true, reason: `local repo token "${repo}" is not a valid sibling` };
  }
  // Realpath guard: defeat a valid-named sibling symlinked outside the parent.
  try {
    if (dirname(realpathSync(citedRoot)) !== realpathSync(parentDir)) {
      return { skipped: true, reason: `local repo "${repo}" escapes the workspace parent` };
    }
  } catch {
    return { skipped: true, reason: `local target ${repo} not found` };
  }
  return { root: citedRoot };
}
