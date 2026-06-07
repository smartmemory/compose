/**
 * xref-push.js — COMP-ROADMAP-XREF-PUSH v1 (PUSH reconciliation).
 *
 * The write-side counterpart to xref-sync.js (PULL). Pull rewrites the LOCAL
 * citation's `expect=` to match EXTERNAL reality; Push does the inverse — it
 * writes the EXTERNAL tracker (a GitHub issue's open/closed state) to match the
 * locally-declared `expect=` intent. Because this mutates a system outside the
 * repo it is dry-run by default, opt-in per ref (`push: true` on the link), and
 * degrades (never writes, never guesses) on any resolution or write failure —
 * exactly mirroring xref-sync's degrade posture.
 *
 * Operates on the structured `links[].kind === 'external'` carrier and NEVER
 * mutates feature.json: `expect` is the unchanged source of intent. Resolution
 * and the external write are both injectable for testability (no network in
 * tests). github provider only in v1.
 */

import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadFeaturesDir } from './project-paths.js';

const GITHUB_STATES = new Set(['open', 'closed']);

/** Is `s` a writable GitHub issue state? */
export function isGithubState(s) {
  return GITHUB_STATES.has(s);
}

/**
 * Pure mirror of reconcileExpect (xref-sync.js): should the external be written
 * to match `ref.expect`, given its current `liveState`?
 *
 * @param {{expect: string|null}} ref
 * @param {string|null} liveState  resolved current external state, or null if unresolved
 * @returns {{action: 'none'|'write', from?: string, to?: string}}
 */
export function planPush(ref, liveState) {
  if (!ref.expect) return { action: 'none' };          // no declared intent
  if (liveState == null) return { action: 'none' };    // unresolved → leave alone
  if (ref.expect === liveState) return { action: 'none' }; // idempotent
  return { action: 'write', from: liveState, to: ref.expect };
}

/**
 * Build a GitHubApi for `link`, or return a degrade reason. `transport`/`auth`
 * are injectable (mirrors feature-validator's githubTransport/githubAuth) so the
 * real resolve/write degrade paths are testable without network.
 * @returns {{gh}|{skipped: true, reason: string}}
 */
async function makeClient(link, { transport = null, auth } = {}) {
  let GitHubApi;
  try { ({ GitHubApi } = await import('./tracker/github-api.js')); }
  catch (e) { return { skipped: true, reason: `github client unavailable: ${e.message}` }; }
  const a = auth ?? { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN };
  try {
    return { gh: new GitHubApi({ repo: link.repo, auth: a }, transport) };
  } catch (e) {
    return { skipped: true, reason: (e && e.message) || 'no GitHub auth' };
  }
}

/**
 * Resolve a github link to its current state. Mirrors xref-sync's defaultResolve
 * degrade semantics AND additionally rejects pull-request-backed refs (a state
 * PATCH would close/reopen a PR — GitHub's Issues API treats PRs as issues).
 * Returns { state } on success, or { skipped, reason } on any degrade.
 */
export async function defaultResolve(link, opts = {}) {
  if (!link.repo || link.issue == null) return { skipped: true, reason: 'incomplete github ref' };
  const c = await makeClient(link, opts);
  if (c.skipped) return c;
  try {
    const r = await c.gh.getIssueResult(link.issue);
    if (r.status === 404) return { skipped: true, reason: `target ${link.repo}#${link.issue} missing (404)` };
    if (r.status < 200 || r.status >= 300) return { skipped: true, reason: `HTTP ${r.status}` };
    if (r.body && r.body.pull_request) {
      return { skipped: true, reason: `${link.repo}#${link.issue} is a pull request, not an issue` };
    }
    const state = r.body && r.body.state;
    if (!isGithubState(state)) return { skipped: true, reason: 'no parseable issue state' };
    return { state };
  } catch (e) {
    return { skipped: true, reason: e && e.rateLimit ? 'rate limit' : (e && e.message) || 'resolution error' };
  }
}

/**
 * Write a github link's issue to `toState`. Uses updateIssueResult (status-
 * returning) so a non-2xx response degrades to a skip rather than a false
 * success. Returns { ok: true } or { skipped, reason }.
 */
export async function defaultWrite(link, toState, opts = {}) {
  if (!link.repo || link.issue == null) return { skipped: true, reason: 'incomplete github ref' };
  const c = await makeClient(link, opts);
  if (c.skipped) return c;
  try {
    const r = await c.gh.updateIssueResult(link.issue, { state: toState });
    if (r.status < 200 || r.status >= 300) return { skipped: true, reason: `write HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { skipped: true, reason: e && e.rateLimit ? 'rate limit' : (e && e.message) || 'write error' };
  }
}

/**
 * Push-write every eligible feature.json external link's target to match its
 * declared `expect`. Eligibility: github provider, `push === true`, and a valid
 * github `expect` state. Dry-run unless `apply` is true. NEVER mutates feature.json.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {boolean} [opts.apply]       perform writes (default false = dry-run)
 * @param {string}  [opts.featuresDir]
 * @param {(link: object) => Promise<{state?: string, skipped?: boolean, reason?: string}>} [opts.resolve]
 * @param {(link: object, toState: string) => Promise<{ok?: boolean, skipped?: boolean, reason?: string}>} [opts.write]
 * @param {object} [opts.githubTransport]  injectable transport for the default resolve/write (tests)
 * @param {object} [opts.githubAuth]       injectable auth for the default resolve/write (tests)
 * @returns {Promise<{pushed: Array, skipped: Array, unchanged: number, scanned: number}>}
 */
export async function pushExternalRefs(cwd, opts = {}) {
  const featuresDir = opts.featuresDir ?? loadFeaturesDir(cwd);
  const clientOpts = { transport: opts.githubTransport ?? null, auth: opts.githubAuth };
  const resolve = opts.resolve ?? ((link) => defaultResolve(link, clientOpts));
  const write = opts.write ?? ((link, toState) => defaultWrite(link, toState, clientOpts));
  const apply = opts.apply === true;
  const dir = join(cwd, featuresDir);

  const pushed = [];
  const skipped = [];
  let unchanged = 0;
  let scanned = 0;

  if (!existsSync(dir)) return { pushed, skipped, unchanged, scanned };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fjPath = join(dir, entry.name, 'feature.json');
    if (!existsSync(fjPath)) continue;
    let fj;
    try { fj = JSON.parse(readFileSync(fjPath, 'utf8')); } catch { continue; }
    if (!Array.isArray(fj.links)) continue;

    for (const link of fj.links) {
      if (!link || link.kind !== 'external') continue;
      // v1: github only, opt-in only, valid target state only.
      if (link.provider !== 'github' || link.push !== true) continue;
      scanned++;
      if (!isGithubState(link.expect)) {
        skipped.push({ code: fj.code, target: targetLabel(link), reason: `malformed expect "${link.expect}" (want open|closed)` });
        continue;
      }

      const r = await resolve(link);
      if (r.skipped) {
        skipped.push({ code: fj.code, target: targetLabel(link), reason: r.reason });
        continue;
      }
      const verdict = planPush(link, r.state ?? null);
      if (verdict.action !== 'write') { unchanged++; continue; }

      if (!apply) {
        pushed.push({ code: fj.code, target: targetLabel(link), from: verdict.from, to: verdict.to });
        continue;
      }
      const w = await write(link, verdict.to);
      if (w.skipped) {
        skipped.push({ code: fj.code, target: targetLabel(link), reason: w.reason });
        continue;
      }
      pushed.push({ code: fj.code, target: targetLabel(link), from: verdict.from, to: verdict.to });
    }
  }

  return { pushed, skipped, unchanged, scanned };
}

function targetLabel(link) {
  return `${link.repo}#${link.issue}`;
}
