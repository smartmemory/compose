/**
 * feature-reconciler.js — COMP-MCP-VALIDATE-2 `compose validate --fix`.
 *
 * Turns the detect-only validator into a closed loop. Reuses the validator's
 * context builders (loadValidationContext / loadFeatureContext) and its emitted
 * findings, derives the canonical fix for the mechanical drift classes, and —
 * on apply — executes each fix through a typed writer (rewriteLinks,
 * resyncRoadmap, setFeatureStatus, VisionWriter).
 *
 * Design decisions (see docs/features/COMP-MCP-VALIDATE-2/blueprint.md):
 *  - Validator stays detect-only; this is a sibling pass, not a mutation hook.
 *  - Status/ROADMAP classes dispatch on the validator's findings (post-projection,
 *    narrative-suppressed); link + partial classes derive from ctx (no clean
 *    finding exists). This honors the validator's exact semantics.
 *  - v1 is local-provider only: GitHubProvider's putFeature/renderRoadmap skip the
 *    local existence + narrative-no-op guarantees the fixes rely on.
 *  - Dry-run by default; per-class opt-in; destructive/heuristic classes off by
 *    default.
 */

import { readFileSync } from 'fs';

import {
  loadValidationContext,
  loadFeatureContext,
  validateProject,
} from './feature-validator.js';
import {
  getProvider,
  isLocalProvider,
  rewriteLinks,
  setRoadmapRowStatus,
  setFeatureStatus,
  _internals,
} from './feature-writer.js';
import { featureStatusToVisionStatus } from './status-projection.js';

const VALID_LINK_KINDS = new Set([..._internals.LINK_KINDS, 'external']);
const CANONICAL_DOCS = new Set([
  'design.md', 'prd.md', 'architecture.md', 'blueprint.md', 'plan.md', 'report.md',
]);

// Class registry. `default` = enabled by a bare --fix; opt-in classes require
// explicit selection. `mutatesFeatureJson` classes are dropped when
// featureJsonMode is false (feature.json is not canonical in legacy mode).
export const FIX_CLASSES = {
  dangling_link:          { default: true,  mutatesFeatureJson: true,  group: 'link' },
  invalid_link_kind:      { default: true,  mutatesFeatureJson: true,  group: 'link' },
  // Modifier on invalid_link_kind: repair to nearest allowed instead of dropping.
  invalid_link_kind_repair: { default: false, mutatesFeatureJson: true, group: 'link' },
  status_fj_vision:       { default: true,  mutatesFeatureJson: false, group: 'status_vision' },
  partial_age:            { default: false, mutatesFeatureJson: true,  group: 'partial' },
  roadmap_status_rewrite: { default: false, mutatesFeatureJson: false, group: 'roadmap' },
};

export function defaultClasses() {
  return Object.entries(FIX_CLASSES).filter(([, v]) => v.default).map(([k]) => k);
}

// ---------------------------------------------------------------------------
// nearestLinkKind — edit-distance repair for an invalid link kind
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * Nearest allowed link kind to `bad`, or null if ambiguous / too far.
 * Conservative: distance must be ≤ 2 and the minimum must be unique.
 * Never targets 'external' (a structural kind, not a typo of the rest).
 */
export function nearestLinkKind(bad) {
  if (typeof bad !== 'string' || !bad) return null;
  let best = null, bestD = Infinity, tie = false;
  for (const k of _internals.LINK_KINDS) {
    const d = levenshtein(bad.toLowerCase(), k);
    if (d < bestD) { bestD = d; best = k; tie = false; }
    else if (d === bestD) { tie = true; }
  }
  if (bestD <= 2 && !tie) return best;
  return null;
}

// ---------------------------------------------------------------------------
// Derive — build the dry-run fix plan from ctx + findings
// ---------------------------------------------------------------------------

function changelogMentions(ctx, code) {
  let text = '';
  try { text = readFileSync(ctx.paths.changelog, 'utf8'); } catch { return false; }
  const re = new RegExp(`^###\\s+${code}(?:\\s|$)`, 'm');
  return re.test(text);
}

// Per-feature link rewrite covering dangling_link + invalid_link_kind. Returns a
// single plan entry per feature whose links[] needs changes, or null.
function deriveLinkFix(ctx, code, active) {
  const fctx = loadFeatureContext(ctx.cwd, code, ctx);
  const links = fctx.featureJson?.links;
  if (!Array.isArray(links) || links.length === 0) return null;

  const dropDangling = active.has('dangling_link');
  const fixKind = active.has('invalid_link_kind');
  const repair = active.has('invalid_link_kind_repair');
  if (!dropDangling && !fixKind) return null;

  const next = [];
  const changes = [];
  for (const link of links) {
    // Dangling: a to_code that resolves in no source. Mirrors the validator's
    // cross-feature check EXACTLY (feature-validator.js:593-601) — including that
    // it does not special-case kind:"external". A well-formed external link
    // carries no to_code (provider/repo/issue/url instead), so this guard skips
    // it; only a malformed external link with an unresolved to_code is dropped,
    // which is precisely what the validator flags. Matching the validator
    // guarantees --fix converges on every DANGLING_LINK_FEATURES_TARGET it emits.
    const isDangling = dropDangling && link.to_code
      && !ctx.foldersByCode.has(link.to_code)
      && !ctx.roadmapByCode.has(link.to_code)
      && !ctx.visionByCode.has(link.to_code);
    if (isDangling) {
      changes.push({ op: 'drop', reason: 'dangling', kind: link.kind, to_code: link.to_code });
      continue;
    }
    // Invalid kind.
    if (fixKind && !VALID_LINK_KINDS.has(link.kind)) {
      const repaired = repair ? nearestLinkKind(link.kind) : null;
      if (repaired) {
        changes.push({ op: 'repair', from_kind: link.kind, to_kind: repaired, to_code: link.to_code });
        next.push({ ...link, kind: repaired });
      } else {
        changes.push({ op: 'drop', reason: 'invalid_kind', kind: link.kind, to_code: link.to_code });
      }
      continue;
    }
    next.push(link);
  }
  if (changes.length === 0) return null;
  return {
    feature_code: code,
    group: 'link',
    classes: [...new Set(changes.map((c) => c.reason === 'invalid_kind' || c.op === 'repair' ? 'invalid_link_kind' : 'dangling_link'))],
    action: 'rewrite_links',
    before: links.map((l) => `${l.kind}→${l.to_code ?? '(external)'}`),
    after: next.map((l) => `${l.kind}→${l.to_code ?? '(external)'}`),
    changes,
    _links: next,
  };
}

function deriveStatusVisionFix(ctx, finding) {
  const code = finding.feature_code;
  if (!code) return null;
  const fctx = loadFeatureContext(ctx.cwd, code, ctx);
  const fjStatus = fctx.featureJson?.status;
  const visStatus = featureStatusToVisionStatus(fjStatus);
  if (!visStatus) return null;
  const vision = ctx.visionByCode.get(code);
  return {
    feature_code: code,
    group: 'status_vision',
    classes: ['status_fj_vision'],
    action: 'update_vision_status',
    before: vision?.status ?? null,
    after: visStatus,
    _visStatus: visStatus,
  };
}

function deriveRoadmapFix(ctx, finding) {
  const code = finding.feature_code;
  if (!code) return null;
  const fctx = loadFeatureContext(ctx.cwd, code, ctx);
  const canonical = fctx.featureJson?.status;
  if (!canonical) return null;
  return {
    feature_code: code,
    group: 'roadmap',
    classes: ['roadmap_status_rewrite'],
    action: 'set_roadmap_row_status',
    before: ctx.roadmapByCode.get(code)?.status ?? null,
    after: canonical,
    _status: canonical,
  };
}

function derivePartialFix(ctx, code) {
  const fctx = loadFeatureContext(ctx.cwd, code, ctx);
  const status = (fctx.featureJson?.status || '').toUpperCase();
  if (status !== 'PARTIAL') return null;
  const folder = fctx.folder;
  if (!folder) return null;
  const hasCanonicalDoc = [...folder.files].some((f) => CANONICAL_DOCS.has(f));
  const hasArtifacts = Array.isArray(fctx.featureJson?.artifacts) && fctx.featureJson.artifacts.length > 0;
  if (hasCanonicalDoc || hasArtifacts || changelogMentions(ctx, code)) return null;
  return {
    feature_code: code,
    group: 'partial',
    classes: ['partial_age'],
    action: 'set_status',
    before: 'PARTIAL',
    after: 'PLANNED',
  };
}

// ---------------------------------------------------------------------------
// Apply — execute a single plan entry through a typed writer
// ---------------------------------------------------------------------------

// Returns { changed } — changed:false means the writer made no change (e.g. a
// guarded refusal or already-correct), so callers don't report it as applied.
async function applyEntry(cwd, entry) {
  switch (entry.action) {
    case 'rewrite_links':
      await rewriteLinks(cwd, { from_code: entry.feature_code, links: entry._links });
      return { changed: true };
    case 'update_vision_status': {
      const { VisionWriter } = await import('./vision-writer.js');
      const { join } = await import('path');
      const writer = new VisionWriter(join(cwd, '.compose', 'data'));
      const item = await writer.findFeatureItem(entry.feature_code);
      if (!item) return { changed: false };
      await writer.updateItemStatus(item.id, entry._visStatus);
      return { changed: true };
    }
    case 'set_status':
      await setFeatureStatus(cwd, { code: entry.feature_code, status: entry.after, derived: true });
      return { changed: true };
    case 'set_roadmap_row_status': {
      const r = await setRoadmapRowStatus(cwd, { code: entry.feature_code, status: entry._status });
      return { changed: r.changed !== false };
    }
    default:
      throw new Error(`feature-reconciler: unknown action "${entry.action}"`);
  }
}

// ---------------------------------------------------------------------------
// reconcileProject — the public entry point
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false]      Write fixes (default: dry-run).
 * @param {string[]} [opts.classes]         Enabled class keys (default: defaultClasses()).
 * @param {string} [opts.scope='project']   'project' | 'feature'.
 * @param {string} [opts.code]              Required when scope='feature'.
 * @param {boolean} [opts.featureJsonMode]  Forwarded to the validator/context.
 * @param {string[]} [opts.externalPrefixes]
 * @param {boolean} [opts.external]
 * @returns {Promise<object>} { scope, plan, counts, applied?, refused?, skipped_classes? }
 */
export async function reconcileProject(cwd, opts = {}) {
  const apply = opts.apply === true;
  const scope = opts.scope === 'feature' ? 'feature' : 'project';

  // Provider guard (C8): v1 reconcile is local-provider only.
  const provider = await getProvider(cwd);
  if (!isLocalProvider(provider)) {
    return { scope, refused: 'non_local_provider', plan: [], counts: {} };
  }

  const valOpts = {
    featureJsonMode: opts.featureJsonMode,
    externalPrefixes: opts.externalPrefixes,
    external: opts.external === true,
  };
  const { findings } = await validateProject(cwd, valOpts);
  const ctx = loadValidationContext(cwd, valOpts);

  // Active class set, with mode guard (C7).
  let active = new Set(
    (opts.classes && opts.classes.length ? opts.classes : defaultClasses())
      .filter((k) => FIX_CLASSES[k]),
  );
  const skipped_classes = [];
  if (ctx.featureJsonMode === false) {
    for (const k of [...active]) {
      if (FIX_CLASSES[k].mutatesFeatureJson) {
        active.delete(k);
        skipped_classes.push({ class: k, reason: 'feature_json_mode_off' });
      }
    }
  }

  const codeFilter = (c) => scope === 'feature' ? c === opts.code : true;
  const codes = [...ctx.foldersByCode.keys()].filter(codeFilter);
  const plan = [];

  // Link classes (ctx-derived, per-feature single rewrite).
  if (active.has('dangling_link') || active.has('invalid_link_kind')) {
    for (const code of codes) {
      const entry = deriveLinkFix(ctx, code, active);
      if (entry) plan.push(entry);
    }
  }
  // partial_age (ctx-derived).
  if (active.has('partial_age')) {
    for (const code of codes) {
      const entry = derivePartialFix(ctx, code);
      if (entry) plan.push(entry);
    }
  }
  // Finding-sourced classes.
  for (const f of findings) {
    if (!codeFilter(f.feature_code)) continue;
    if (active.has('status_fj_vision') && f.kind === 'STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE') {
      const e = deriveStatusVisionFix(ctx, f);
      if (e) plan.push(e);
    }
    if (active.has('roadmap_status_rewrite') && f.kind === 'STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON') {
      const e = deriveRoadmapFix(ctx, f);
      if (e) plan.push(e);
    }
  }

  const counts = {};
  for (const e of plan) for (const c of e.classes) counts[c] = (counts[c] || 0) + 1;

  if (!apply) {
    return { scope, dry_run: true, plan, counts, skipped_classes };
  }

  const applied = [];
  for (const entry of plan) {
    try {
      const { changed } = await applyEntry(cwd, entry);
      // ok = "did not error"; noop = "made no change" (a guarded refusal, e.g. a
      // malformed/escaped-pipe ROADMAP row the surgical writer declined). Surfacing
      // noop honestly means --fix never claims a repair it didn't make; the caller
      // re-validates to confirm actual convergence.
      applied.push({ feature_code: entry.feature_code, action: entry.action, ok: true, noop: changed === false });
    } catch (err) {
      applied.push({ feature_code: entry.feature_code, action: entry.action, ok: false, error: err.message });
    }
  }
  return { scope, dry_run: false, plan, counts, applied, skipped_classes };
}
