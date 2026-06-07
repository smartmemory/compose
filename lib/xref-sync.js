/**
 * xref-sync.js — COMP-ROADMAP-XREF-SYNC v1 (PULL reconciliation).
 *
 * Turns the read-only XREF_DRIFT warning (COMP-MCP-XREF-VALIDATE #16) into an
 * applied fix: for every feature.json external link that carries an `expect=`,
 * resolve the live target and rewrite `expect` to match reality. This is a
 * PULL — it reconciles the LOCAL citation to the EXTERNAL truth and NEVER writes
 * to an external system (closing a GitHub issue etc. is a separate, deliberate
 * capability — see docs/features/COMP-ROADMAP-XREF-SYNC/design.md).
 *
 * Operates on the structured `links[].kind === 'external'` carrier (the
 * post-migration source of truth), so it never rewrites markdown or perturbs the
 * ROADMAP roundtrip fixed point. Resolution is injectable for testability.
 */

import { readdirSync, existsSync, readFileSync, realpathSync } from 'fs';
import { join, resolve as resolvePath, dirname } from 'path';
import { writeFeature } from './feature-json.js';
import { loadFeaturesDir } from './project-paths.js';

const RESOLVABLE = new Set(['github', 'local']);

/**
 * Pure reconciliation: should `ref.expect` be rewritten to `liveState`?
 *
 * @param {{expect: string|null}} ref
 * @param {string|null} liveState  resolved live state, or null if unresolved
 * @returns {{changed: boolean, from?: string, to?: string}}
 */
export function reconcileExpect(ref, liveState) {
  if (!ref.expect) return { changed: false };        // nothing to pull
  if (liveState == null) return { changed: false };  // unresolved → leave as-is
  if (ref.expect === liveState) return { changed: false };
  return { changed: true, from: ref.expect, to: liveState };
}

/**
 * Resolve a single external link to its live state using the same primitives as
 * the validator. Returns { state } on success, { skipped, reason } on a degrade
 * (offline / no-token / rate-limit / missing target), mirroring the read-only
 * checker's per-ref degrade semantics — never guesses a state.
 *
 * @param {object} link   feature.json external link
 * @param {string} cwd
 * @param {string} featuresDir
 */
async function defaultResolve(link, cwd, featuresDir) {
  if (link.provider === 'github') {
    if (!link.repo || link.issue == null) return { skipped: true, reason: 'incomplete github ref' };
    let GitHubApi;
    try { ({ GitHubApi } = await import('./tracker/github-api.js')); }
    catch (e) { return { skipped: true, reason: `github client unavailable: ${e.message}` }; }
    let gh;
    try {
      // auth.token from env if present, else the client falls back to `gh auth token`.
      gh = new GitHubApi({ repo: link.repo, auth: { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN } });
    } catch (e) {
      return { skipped: true, reason: (e && e.message) || 'no GitHub auth' };
    }
    try {
      const r = await gh.getIssueResult(link.issue);
      if (r.status === 404) return { skipped: true, reason: `target ${link.repo}#${link.issue} missing (404)` };
      if (r.status < 200 || r.status >= 300) return { skipped: true, reason: `HTTP ${r.status}` };
      const state = r.body && r.body.state;
      if (state !== 'open' && state !== 'closed') return { skipped: true, reason: 'no parseable issue state' };
      return { state };
    } catch (e) {
      return { skipped: true, reason: e && e.rateLimit ? 'rate limit' : (e && e.message) || 'resolution error' };
    }
  }
  if (link.provider === 'local') {
    // The target feature lives in a sibling repo; its status is the live state.
    if (!link.repo || !link.to_code) return { skipped: true, reason: 'incomplete local ref' };
    // Containment guard (parity with feature-validator resolveLocalRef): the
    // repo token must resolve to a DIRECT sibling of cwd — lexical check first,
    // then realpath to defeat a valid-named sibling symlinked outside the parent.
    const parentDir = resolvePath(cwd, '..');
    const citedRoot = resolvePath(parentDir, String(link.repo));
    if (/[\\/]/.test(link.repo) || link.repo === '.' || link.repo === '..'
        || dirname(citedRoot) !== parentDir) {
      return { skipped: true, reason: `local repo token "${link.repo}" is not a valid sibling` };
    }
    try {
      if (dirname(realpathSync(citedRoot)) !== realpathSync(parentDir)) {
        return { skipped: true, reason: `local repo "${link.repo}" escapes the workspace parent` };
      }
    } catch { return { skipped: true, reason: `local target ${link.repo} not found` }; }
    // Resolve the SIBLING's own features dir (it may have its own paths.features).
    try {
      const fjPath = join(citedRoot, loadFeaturesDir(citedRoot), link.to_code, 'feature.json');
      if (!existsSync(fjPath)) return { skipped: true, reason: `local target ${link.repo}/${link.to_code} not found` };
      return { state: JSON.parse(readFileSync(fjPath, 'utf8')).status || null };
    } catch (e) { return { skipped: true, reason: `unreadable local target: ${e.message}` }; }
  }
  return { skipped: true, reason: `unresolvable provider: ${link.provider}` };
}

/**
 * Pull-reconcile every feature.json external link's `expect` to live target state.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]      report changes without writing
 * @param {string}  [opts.featuresDir]
 * @param {(link: object, cwd: string, featuresDir: string) => Promise<{state?: string|null, skipped?: boolean, reason?: string}>} [opts.resolve]
 *   injectable resolver (defaults to github-api + local feature.json)
 * @returns {Promise<{synced: Array, skipped: Array, unchanged: number, scanned: number}>}
 */
export async function syncExternalRefs(cwd, opts = {}) {
  const featuresDir = opts.featuresDir ?? loadFeaturesDir(cwd);
  const resolve = opts.resolve ?? defaultResolve;
  const dir = join(cwd, featuresDir);

  const synced = [];
  const skipped = [];
  let unchanged = 0;
  let scanned = 0;

  if (!existsSync(dir)) return { synced, skipped, unchanged, scanned };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fjPath = join(dir, entry.name, 'feature.json');
    if (!existsSync(fjPath)) continue;
    let fj;
    try { fj = JSON.parse(readFileSync(fjPath, 'utf8')); } catch { continue; }
    if (!Array.isArray(fj.links)) continue;

    let mutated = false;
    for (const link of fj.links) {
      if (!link || link.kind !== 'external') continue;
      // Only resolvable providers that carry an explicit expectation can drift.
      // Push-managed links (push:true, COMP-ROADMAP-XREF-PUSH) are owned by the
      // write side — pulling them would clobber the declared intent before push
      // runs, so a link is either pull-managed or push-managed, never both.
      if (!RESOLVABLE.has(link.provider) || !link.expect || link.push === true) continue;
      scanned++;

      const r = await resolve(link, cwd, featuresDir);
      if (r.skipped) {
        skipped.push({ code: fj.code, provider: link.provider, target: targetLabel(link), reason: r.reason });
        continue;
      }
      const verdict = reconcileExpect(link, r.state ?? null);
      if (!verdict.changed) { unchanged++; continue; }

      synced.push({ code: fj.code, provider: link.provider, target: targetLabel(link), from: verdict.from, to: verdict.to });
      if (!dryRun(opts)) { link.expect = verdict.to; mutated = true; }
    }

    if (mutated && !dryRun(opts)) writeFeature(cwd, fj, featuresDir);
  }

  return { synced, skipped, unchanged, scanned };
}

function dryRun(opts) { return opts.dryRun === true; }

function targetLabel(link) {
  if (link.provider === 'github') return `${link.repo}#${link.issue}`;
  if (link.provider === 'local') return `${link.repo}/${link.to_code}`;
  return link.url || '';
}
