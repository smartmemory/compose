/**
 * lib/backfill-evidence.js — COMP-LIFECYCLE-BACKFILL blueprint §4.3.
 *
 * Resolve a caller's `EvidenceRef` into the `ResolvedEvidence` the merge orders
 * on. Two kinds, two confidences, and one place both are written down.
 *
 *  - `commit` — the AUTHOR date (Decision 3). `git show -s --format=%aI` carries
 *    the committer's UTC OFFSET, so the epoch form is computed ONCE here and
 *    every downstream comparison uses it (BP-8). A string comparison of two
 *    author dates from different timezones is silently wrong.
 *  - `path` — `validateRepoPath`'s eight steps (lib/feature-writer.js:610-641),
 *    with `realpathCanonicalize` substituted for the bare `realpathSync` calls
 *    (C19). That substitution is the macOS firmlink landmine: /System/Volumes/Data
 *    mirrors /, realpath does NOT collapse it, so the cwd and the resolved path
 *    can carry different roots and the containment check compares mismatched
 *    prefixes — refusing a path that is plainly inside the repo.
 *
 * `confidence` is derived HERE and nowhere else. The request schema has no
 * `confidence` field, so a caller-supplied value is rejected by
 * `additionalProperties:false` before any of this runs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { normalize, resolve, sep } from 'node:path';

import { realpathCanonicalize } from './canon-guard.js';

/** A commit's author date is exact; a file's mtime is only an upper bound. */
export const CONFIDENCE_BY_KIND = Object.freeze({ commit: 0.9, path: 0.6 });

export function deriveConfidence(kind) {
  const c = CONFIDENCE_BY_KIND[kind];
  if (c === undefined) throw new Error(`backfill-evidence: unknown evidence kind "${kind}"`);
  return c;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** validateRepoPath's eight steps, canonicalising instead of bare-realpathing. */
function resolveRepoPath(cwd, p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('backfill-evidence: path must be a non-empty string');
  }
  if (p.startsWith('/') || p.startsWith('~')) {
    throw new Error(`backfill-evidence: path must be repo-relative, got "${p}"`);
  }
  const normalized = normalize(p);
  if (normalized.split(sep).includes('..')) {
    throw new Error(`backfill-evidence: path must not contain ".." after normalization, got "${p}"`);
  }
  const realCwd = realpathCanonicalize(cwd);
  const resolved = resolve(realCwd, normalized);
  if (!resolved.startsWith(realCwd + sep) && resolved !== realCwd) {
    throw new Error(`backfill-evidence: path "${p}" resolves outside cwd`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`backfill-evidence: path "${p}" does not exist`);
  }
  // Resolve symlinks AFTER the existence check: this is what blocks a
  // repo-internal symlink whose target escapes.
  const realResolved = realpathCanonicalize(resolved);
  if (!realResolved.startsWith(realCwd + sep) && realResolved !== realCwd) {
    throw new Error(`backfill-evidence: path "${p}" symlinks outside cwd`);
  }
  if (!statSync(realResolved).isFile()) {
    throw new Error(`backfill-evidence: path "${p}" must point at a file (got directory or other)`);
  }
  return realResolved;
}

/**
 * @param {string} cwd  the EVIDENCE root (a real git repo for `commit`)
 * @param {{kind:'commit'|'path', ref:string}} evidence
 * @returns {{kind:string, ref:string, verifiedAt:string, observedTime:string, observedEpochMs:number}}
 */
export function resolveEvidenceRef(cwd, evidence) {
  const kind = evidence?.kind;
  const ref = evidence?.ref;
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('backfill-evidence: evidence.ref must be a non-empty string');
  }
  deriveConfidence(kind);   // throws on an unknown kind, before any I/O

  const verifiedAt = new Date().toISOString();
  let observedTime;

  if (kind === 'commit') {
    const sha = ref.trim();
    try {
      git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    } catch {
      throw new Error(`backfill-evidence: commit ${sha} not found in repository (server-read git verification)`);
    }
    // The AUTHOR date, %aI — it carries an offset, which is exactly why the
    // epoch form below is computed once and used for every comparison.
    observedTime = git(cwd, ['show', '-s', '--format=%aI', sha]);
  } else {
    observedTime = statSync(resolveRepoPath(cwd, ref)).mtime.toISOString();
  }

  const observedEpochMs = Date.parse(observedTime);
  if (!Number.isFinite(observedEpochMs)) {
    throw new Error(`backfill-evidence: "${observedTime}" is not a parseable instant`);
  }
  return { kind, ref, verifiedAt, observedTime, observedEpochMs };
}
