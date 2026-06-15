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
import { resolveFeaturesPath } from './project-paths.js';
import { resolveSiblingRoot } from './xref-local.js';

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
    // Normalize labels to a string[] of names — GitHub returns label OBJECTS
    // ({name}); a labels-only link needs the names to compute the additive union.
    const labels = (r.body && r.body.labels ? r.body.labels : []).map((l) => (l && l.name != null ? l.name : l));
    return { state, labels };
  } catch (e) {
    return { skipped: true, reason: e && e.rateLimit ? 'rate limit' : (e && e.message) || 'resolution error' };
  }
}

/**
 * Apply a `patch` (`{state?, labels?}`) to a github issue. Uses updateIssueResult
 * (status-returning) so a non-2xx response degrades to a skip rather than a false
 * success. A github PATCH replaces the whole label set, so `patch.labels` MUST be
 * the full intended set (the additive union), never just the missing subset.
 * Returns { ok: true } or { skipped, reason }.
 */
export async function defaultWrite(link, patch, opts = {}) {
  if (!link.repo || link.issue == null) return { skipped: true, reason: 'incomplete github ref' };
  const c = await makeClient(link, opts);
  if (c.skipped) return c;
  try {
    const r = await c.gh.updateIssueResult(link.issue, patch);
    if (r.status < 200 || r.status >= 300) return { skipped: true, reason: `write HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { skipped: true, reason: e && e.rateLimit ? 'rate limit' : (e && e.message) || 'write error' };
  }
}

/**
 * Pure additive label plan: which of `expectLabels` are missing from
 * `currentNames`, and the full union to PATCH. Case-sensitive (GitHub label
 * names are case-sensitive); never removes a label not in `expectLabels`.
 *
 * @param {string[]} currentNames
 * @param {string[]} expectLabels
 * @returns {{action: 'none'} | {action: 'add', add: string[], to: string[]}}
 */
export function planLabels(currentNames, expectLabels) {
  if (!Array.isArray(expectLabels) || expectLabels.length === 0) return { action: 'none' };
  const have = new Set(currentNames);
  const missing = [...new Set(expectLabels)].filter((l) => !have.has(l));
  if (missing.length === 0) return { action: 'none' };
  return { action: 'add', add: missing, to: [...new Set([...currentNames, ...expectLabels])] };
}

/**
 * Default local-status writer: delegate to the SIBLING repo's own
 * setFeatureStatus so its transition policy + ROADMAP roundtrip apply. Never
 * force/derived (the sibling's TRANSITIONS table governs). Throws on rejection;
 * the caller degrade-skips.
 */
async function defaultSetStatus(siblingRoot, code, status) {
  const { setFeatureStatus } = await import('./feature-writer.js');
  return setFeatureStatus(siblingRoot, { code, status });
}

/**
 * Resolve a local link's sibling current status, via the shared containment
 * guard. Returns { state, root } or { skipped, reason }.
 */
function localResolve(link, cwd) {
  if (!link.to_code) return { skipped: true, reason: 'incomplete local ref (no to_code)' };
  const sib = resolveSiblingRoot(cwd, link.repo);
  if (sib.skipped) return sib;
  try {
    const fjPath = join(resolveFeaturesPath(sib.root), link.to_code, 'feature.json');
    if (!existsSync(fjPath)) return { skipped: true, reason: `local target ${link.repo}/${link.to_code} not found` };
    return { state: JSON.parse(readFileSync(fjPath, 'utf8')).status || null, root: sib.root };
  } catch (e) { return { skipped: true, reason: `unreadable local target: ${e.message}` }; }
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
 * @param {(link: object) => Promise<{state?: string, labels?: string[], skipped?: boolean, reason?: string}>} [opts.resolve]
 *   github resolve override (tests)
 * @param {(link: object, patch: object) => Promise<{ok?: boolean, skipped?: boolean, reason?: string}>} [opts.write]
 *   github write override (tests); patch is `{state?, labels?}`
 * @param {object} [opts.githubTransport]  injectable transport for the default github resolve/write (tests)
 * @param {object} [opts.githubAuth]       injectable auth for the default github resolve/write (tests)
 * @param {(siblingRoot: string, code: string, status: string) => Promise<any>} [opts.setStatus]
 *   local-status writer override (tests); default delegates to the sibling's setFeatureStatus
 * @returns {Promise<{pushed: Array, skipped: Array, unchanged: number, scanned: number}>}
 */
export async function pushExternalRefs(cwd, opts = {}) {
  const featuresDir = opts.featuresDir ?? resolveFeaturesPath(cwd);
  const clientOpts = { transport: opts.githubTransport ?? null, auth: opts.githubAuth };
  const ghResolve = opts.resolve ?? ((link) => defaultResolve(link, clientOpts));
  const ghWrite = opts.write ?? ((link, patch) => defaultWrite(link, patch, clientOpts));
  const setStatus = opts.setStatus ?? defaultSetStatus;
  const apply = opts.apply === true;
  const dir = featuresDir;

  const pushed = [];
  const skipped = [];
  let unchanged = 0;
  let scanned = 0;
  const skip = (fj, link, reason) => skipped.push({ code: fj.code, provider: link.provider, target: targetLabel(link), reason });

  if (!existsSync(dir)) return { pushed, skipped, unchanged, scanned };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fjPath = join(dir, entry.name, 'feature.json');
    if (!existsSync(fjPath)) continue;
    let fj;
    try { fj = JSON.parse(readFileSync(fjPath, 'utf8')); } catch { continue; }
    if (!Array.isArray(fj.links)) continue;

    for (const link of fj.links) {
      if (!link || link.kind !== 'external' || link.push !== true) continue;
      if (link.provider === 'github') {
        // Eligible if it declares ANY intent (state and/or labels).
        if (link.expect == null && link.expect_labels == null) continue;
        scanned++;
        // Malformed-state skip fires ONLY when a state intent is present —
        // a labels-only link is still eligible.
        if (link.expect != null && !isGithubState(link.expect)) {
          skip(fj, link, `malformed expect "${link.expect}" (want open|closed)`);
          continue;
        }
        const r = await ghResolve(link);
        if (r.skipped) { skip(fj, link, r.reason); continue; }

        const statePlan = link.expect != null ? planPush(link, r.state ?? null) : { action: 'none' };
        const labelsPlan = link.expect_labels != null ? planLabels(r.labels ?? [], link.expect_labels) : { action: 'none' };
        if (statePlan.action !== 'write' && labelsPlan.action !== 'add') { unchanged++; continue; }

        const patch = {};
        if (statePlan.action === 'write') patch.state = statePlan.to;
        if (labelsPlan.action === 'add') patch.labels = labelsPlan.to; // FULL union, not the subset

        if (apply) {
          const w = await ghWrite(link, patch);
          if (w.skipped) { skip(fj, link, w.reason); continue; }
        }
        pushed.push(githubRow(fj, link, statePlan, labelsPlan));
      } else if (link.provider === 'local') {
        if (link.expect == null) continue; // local has only the state aspect
        scanned++;
        const r = localResolve(link, cwd);
        if (r.skipped) { skip(fj, link, r.reason); continue; }

        const verdict = planPush(link, r.state ?? null);
        if (verdict.action !== 'write') { unchanged++; continue; }

        if (apply) {
          try { await setStatus(r.root, link.to_code, link.expect); }
          catch (e) { skip(fj, link, (e && e.message) || 'sibling write rejected'); continue; }
        }
        pushed.push({
          code: fj.code, provider: 'local', target: targetLabel(link),
          from: verdict.from, to: verdict.to,
          state: { from: verdict.from, to: verdict.to },
          summary: `status ${verdict.from} → ${verdict.to}`,
        });
      }
      // other providers (url/reserved): not pushable, silently ignored.
    }
  }

  return { pushed, skipped, unchanged, scanned };
}

// Build a github result row. Keeps flat from/to (back-compat with -PUSH) for a
// state change, plus structured state/labels aspects and a display summary.
function githubRow(fj, link, statePlan, labelsPlan) {
  const row = { code: fj.code, provider: 'github', target: targetLabel(link) };
  const parts = [];
  if (statePlan.action === 'write') {
    row.from = statePlan.from;
    row.to = statePlan.to;
    row.state = { from: statePlan.from, to: statePlan.to };
    parts.push(`state ${statePlan.from} → ${statePlan.to}`);
  }
  if (labelsPlan.action === 'add') {
    row.labels = { added: labelsPlan.add };
    parts.push(`labels +${labelsPlan.add.join(',')}`);
  }
  row.summary = parts.join('; ');
  return row;
}

function targetLabel(link) {
  if (link.provider === 'local') return `${link.repo}/${link.to_code}`;
  return `${link.repo}#${link.issue}`;
}
