/**
 * lib/land-sha.js — the sha rule of complete_feature (COMP-DOGFOOD-LAND-1,
 * row D of COMP-DOGFOOD-1). A feature is marked complete only on a real
 * commit: the caller names one, or names its branch, or the branch is found by
 * the feature code (the ops lander's `unit_code_tips` rule, OPS-LAND-AUTO-
 * PAPERWORK-1 (a)). Independent of capabilities.guard: the fleet workspace has
 * no guard, and a commit-less completion there is exactly the gap.
 */
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readEvidence } from './evidence.js';

export const LAND_SHA_CODES = Object.freeze({
  REQUIRED: 'SHA_REQUIRED',                    // nothing names a commit
  AMBIGUOUS: 'SHA_AMBIGUOUS',                  // several branches end with the feature code
  NOT_ON_BRANCH: 'SHA_NOT_ON_BRANCH',          // commit_sha is not the branch tip or an ancestor of it
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',        // `branch` resolves to no commit
  SHA_UNKNOWN: 'SHA_UNKNOWN',                  // commit_sha is not a commit in the repo
  EVIDENCE_MISMATCH: 'EVIDENCE_SHA_MISMATCH',  // a `sha` receipt for another commit or repo
});

const _warned = new Set();

function refuse(code, reasons) {
  const e = new Error(`complete_feature: ${code}: ${reasons.join('; ')}`);
  e.code = code;
  e.reasons = reasons;
  return e;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

const commitOf = (cwd, ref) => {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok && r.out ? r.out : null;
};

/** Local and origin/ branch names ending with `code` (case-insensitive) -> Map(name -> tip). Local wins over origin/ for one name. */
function branchesEndingWith(cwd, code) {
  const want = code.toLowerCase();
  const found = new Map();
  const r = git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
  for (const ref of r.out.split('\n').filter(Boolean)) {
    const local = ref.startsWith('refs/heads/');
    const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
    if (name === 'HEAD' || !name.toLowerCase().endsWith(want)) continue;
    if (!local && found.has(name)) continue;
    const tip = commitOf(cwd, ref);
    if (tip) found.set(name, tip);
  }
  return found;
}

const sameDir = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/**
 * @param {{code: string, commit_sha?: string, branch?: string, repo?: string, evidence?: any}} args
 * @param {{root: string}} o the workspace root
 * @returns {{commit_sha?: string, sha_source: 'given'|'branch-tip'|'feature-branch'|'none', repo?: string, branch?: string}}
 */
export function resolveLandSha(args, { root }) {
  const { code, commit_sha, branch } = args;
  const top = git(args.repo || root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    if (args.repo) throw refuse(LAND_SHA_CODES.REQUIRED, [`repo ${args.repo} is not a git repository`]);
    if (!_warned.has(root)) {
      _warned.add(root);
      console.warn(`[land-sha] WARNING: workspace ${root} is not a git repository; complete_feature keeps the commit-less path (no commit to verify)`);
    }
    return { commit_sha, sha_source: 'none' };
  }
  const repo = top.out;
  let sha;
  let source;
  let onBranch = branch;

  if (commit_sha) {
    sha = commitOf(repo, String(commit_sha).trim());
    if (!sha) throw refuse(LAND_SHA_CODES.SHA_UNKNOWN, [`commit ${commit_sha} is not a commit in ${repo}`]);
    source = 'given';
    if (branch) {
      const tip = commitOf(repo, branch);
      if (!tip) throw refuse(LAND_SHA_CODES.BRANCH_NOT_FOUND, [`branch ${branch} resolves to no commit in ${repo}`]);
      if (!git(repo, ['merge-base', '--is-ancestor', sha, tip]).ok) {
        throw refuse(LAND_SHA_CODES.NOT_ON_BRANCH, [`commit ${sha} is neither the tip of ${branch} (${tip}) nor an ancestor of it`]);
      }
    }
  } else if (branch) {
    sha = commitOf(repo, branch);
    if (!sha) throw refuse(LAND_SHA_CODES.BRANCH_NOT_FOUND, [`branch ${branch} resolves to no commit in ${repo}`]);
    source = 'branch-tip';
  } else {
    const found = branchesEndingWith(repo, code || '');
    if (found.size === 0) throw refuse(LAND_SHA_CODES.REQUIRED, [`name commit_sha or branch: no local or origin/ branch in ${repo} ends with ${code}`]);
    if (found.size > 1) throw refuse(LAND_SHA_CODES.AMBIGUOUS, [`${found.size} branches end with ${code}: ${[...found.keys()].join(', ')}; name commit_sha or branch`]);
    [[onBranch, sha]] = [...found];
    source = 'feature-branch';
  }

  let ev = args.evidence;
  if (typeof ev === 'string') ev = readEvidence(ev)?.evidence;
  if (ev && typeof ev === 'object' && ev.kind === 'sha') {
    const a = String(ev.sha).toLowerCase();
    const short = a.length <= sha.length ? a : sha;
    const long = a.length <= sha.length ? sha : a;
    const reasons = [];
    if (!long.startsWith(short)) reasons.push(`the sha receipt is for ${ev.sha}, the completion resolves to ${sha}`);
    if (!sameDir(ev.repo, repo)) reasons.push(`the sha receipt is for repo ${ev.repo}, the completion is in ${repo}`);
    if (reasons.length) throw refuse(LAND_SHA_CODES.EVIDENCE_MISMATCH, reasons);
  }
  return { commit_sha: sha, sha_source: source, repo, branch: onBranch };
}
