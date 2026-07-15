/**
 * triage.js — Pre-flight feature triage.
 *
 * Analyzes the feature folder contents and assigns a complexity tier.
 * Populates the build profile (needs_prd, needs_architecture, needs_verification,
 * needs_report) in feature.json so subsequent builds can toggle skip_if on
 * pipeline steps without requiring manual intervention.
 *
 * No LLM calls — pure file analysis and heuristics.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFeaturesPath } from './project-paths.js';
import { resolvePathValue } from './paths-core.js';

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------
//
// Tier 0: Config-only — dotfiles, package.json tweaks, no design docs
//         → skip prd, architecture, verification, report
// Tier 1: Single-concern — 1-2 files in plan, no security/core paths
//         → skip prd, architecture, report (keep verification)
// Tier 2: Standard feature — multiple files, design doc present
//         → skip prd, architecture (default — what most features need)
// Tier 3: Cross-component / security-sensitive
//         → enable architecture, skip prd
// Tier 4: Architecture change / shared core code
//         → enable prd and architecture
// ---------------------------------------------------------------------------

const SECURITY_PATTERNS = [
  /\bauth\b/i,
  /\bcrypto\b/i,
  /\bsession\b/i,
  /\bmiddleware\b/i,
  /\btoken\b/i,
  /\bpermission\b/i,
  /\bcredential\b/i,
  /\bjwt\b/i,
  /\boauth\b/i,
  /\bpassword\b/i,
];

const CORE_PATTERNS = [
  /\blib\//,
  /\bserver\/index\b/,
  /connector.*base/i,
  /\bbase.*connector/i,
  /\bcore\//,
  /\bshared\//,
  /stratum-mcp/i,
];

/**
 * Extract file paths mentioned in a markdown string.
 * Matches backtick-quoted paths that look like file paths (contain a dot or slash).
 *
 * @param {string} content
 * @returns {string[]}
 */
function extractFilePaths(content) {
  const matches = [];
  // Match backtick-quoted strings that look like paths
  const backtickRe = /`([^`]+)`/g;
  let m;
  while ((m = backtickRe.exec(content)) !== null) {
    const val = m[1];
    if (val.includes('/') || (val.includes('.') && !val.includes(' '))) {
      matches.push(val);
    }
  }
  return matches;
}

/**
 * Count markdown checkbox items in content.
 *
 * @param {string} content
 * @returns {number}
 */
function countTasks(content) {
  const re = /^\s*-\s*\[[ xX]\]/gm;
  return (content.match(re) ?? []).length;
}

/**
 * Check whether any path in a list matches the given patterns.
 *
 * @param {string[]} paths
 * @param {RegExp[]} patterns
 * @returns {boolean}
 */
function anyMatch(paths, patterns) {
  return paths.some(p => patterns.some(re => re.test(p)));
}

/**
 * Derive tier and profile from signal values.
 *
 * @param {{ fileCount: number, securityPaths: boolean, corePaths: boolean, taskCount: number, hasDesignDoc: boolean }} signals
 * @returns {{ tier: number, profile: object, rationale: string }}
 */
function deriveProfile(signals) {
  const { fileCount, securityPaths, corePaths, taskCount, hasDesignDoc } = signals;

  // Tier 4: core/shared code changes → needs full design review
  if (corePaths) {
    return {
      tier: 4,
      profile: {
        needs_prd: true,
        needs_architecture: true,
        needs_verification: true,
        needs_report: true,
      },
      rationale: 'Touches core/shared code — full design review required',
    };
  }

  // Tier 3: security-sensitive → architecture required
  if (securityPaths) {
    return {
      tier: 3,
      profile: {
        needs_prd: false,
        needs_architecture: true,
        needs_verification: true,
        needs_report: false,
      },
      rationale: 'References security-sensitive paths — architecture review required',
    };
  }

  // Tier 0: config-only — no design docs, at most 1 file path, very few tasks
  if (!hasDesignDoc && fileCount <= 1 && taskCount <= 5) {
    return {
      tier: 0,
      profile: {
        needs_prd: false,
        needs_architecture: false,
        needs_verification: false,
        needs_report: false,
      },
      rationale: 'Config-only change — minimal scope, no design docs',
    };
  }

  // Tier 1: single-concern — few files, no special paths
  if (fileCount <= 2 && taskCount <= 10) {
    return {
      tier: 1,
      profile: {
        needs_prd: false,
        needs_architecture: false,
        needs_verification: true,
        needs_report: false,
      },
      rationale: 'Single-concern change — verification sufficient',
    };
  }

  // Tier 2: standard feature (default)
  return {
    tier: 2,
    profile: {
      needs_prd: false,
      needs_architecture: false,
      needs_verification: true,
      needs_report: false,
    },
    rationale: 'Standard feature — default build profile',
  };
}

// ---------------------------------------------------------------------------
// Front-seam scope estimation (doc-free)
// ---------------------------------------------------------------------------

// Lane order, smaller index = smaller scope / more conservative.
const LANE_ORDER = { trivial: 0, standard: 1, complex: 2 };

// Verbs that denote a single, well-defined action. Presence (+ an explicit
// file path) is what earns 'high' confidence; absence (+ no path) is what
// earns 'low' confidence and triggers the safety clamp.
const UNAMBIGUOUS_VERB_RE =
  /\b(fix(?:e[ds]|ing)?|renam(?:e[ds]?|ing)|add(?:ed|s|ing)?|remov(?:e[ds]?|ing)|delet(?:e[ds]?|ing)|updat(?:e[ds]?|ing)|creat(?:e[ds]?|ing)|implement(?:ed|s|ing)?|refactor(?:ed|s|ing)?|bump(?:ed|s|ing)?|patch(?:ed|es|ing)?|mov(?:e[ds]?|ing)|extract(?:ed|s|ing)?|replac(?:e[ds]?|ing)|revert(?:ed|s|ing)?|rewrit(?:e|es|ing)|rewrote)\b/i;

/**
 * Map a triage tier (0-4) to a coarse lane.
 *
 * @param {number} tier
 * @returns {'trivial'|'standard'|'complex'}
 */
function tierToLane(tier) {
  if (tier <= 1) return 'trivial';
  if (tier === 2) return 'standard';
  return 'complex';
}

/**
 * Clamp a lane up to at least `minimum` (never narrows).
 *
 * @param {string} lane
 * @param {string} minimum
 * @returns {string}
 */
function clampLaneMin(lane, minimum) {
  return LANE_ORDER[lane] < LANE_ORDER[minimum] ? minimum : lane;
}

/**
 * Estimate scope from request text alone — the DOC-FREE front seam.
 *
 * Unlike `runTriage`, this never reads plan.md/blueprint.md/design.md (or
 * any file at all). It derives the same `signals` shape `deriveProfile`
 * expects purely from the request text and caller-supplied repo-signal
 * hints, so it can run before any design doc exists — before the genesis
 * phase, at feature-creation time.
 *
 * @param {string} request - Free-text feature/bug request description.
 * @param {{ files?: string[] }} [repoSignals] - Candidate file paths the
 *   request plausibly touches (caller-supplied, e.g. from a git-diff or
 *   grep hint). Minimal shape: `{ files: string[] }`.
 * @returns {{ tier: number, profile: object, lane: 'trivial'|'standard'|'complex', confidence: 'high'|'medium'|'low', rationale: string }}
 */
// Reconcile the tier-derived profile with the (possibly clamped) lane so the two
// never disagree. The safety clamp raises the LANE, but skip_if is driven by the
// PROFILE — without this floor a clamped-to-standard lane would still skip
// verification, defeating the clamp. Standard keeps verification; complex keeps
// every phase; trivial is left as deriveProfile set it.
export function floorProfileToLane(profile, lane) {
  if (lane === 'complex') {
    return { needs_prd: true, needs_architecture: true, needs_verification: true, needs_report: true };
  }
  if (lane === 'standard') {
    return { ...profile, needs_verification: true };
  }
  return { ...profile };
}

export function estimateScope(request, repoSignals = {}) {
  const text = request ?? '';
  const hintedFiles = Array.isArray(repoSignals?.files) ? repoSignals.files : [];

  const textPaths = extractFilePaths(text);
  const uniquePaths = new Set([...textPaths, ...hintedFiles]);
  const pathList = [...uniquePaths];

  const taskCount = countTasks(text);
  const securityPaths = anyMatch(pathList, SECURITY_PATTERNS);
  const corePaths = anyMatch(pathList, CORE_PATTERNS);

  const signals = {
    fileCount: uniquePaths.size,
    securityPaths,
    corePaths,
    taskCount,
    hasDesignDoc: false,
  };

  const { tier, profile, rationale } = deriveProfile(signals);

  let lane = tierToLane(tier);
  // Belt-and-suspenders: a security/core path hit must never resolve below
  // 'standard', independent of how deriveProfile's own tier logic evolves.
  if (securityPaths || corePaths) {
    lane = clampLaneMin(lane, 'standard');
  }

  const hasPaths = uniquePaths.size > 0;
  const hasUnambiguousVerb = UNAMBIGUOUS_VERB_RE.test(text);
  let confidence;
  if (hasPaths && hasUnambiguousVerb) {
    confidence = 'high';
  } else if (!hasPaths && !hasUnambiguousVerb) {
    confidence = 'low';
  } else {
    confidence = 'medium';
  }

  // Safety clamp: under-scoping is the only dangerous error. Low confidence
  // (no named paths, no clear verb) can never resolve to 'trivial'.
  if (confidence === 'low') {
    lane = clampLaneMin(lane, 'standard');
  }

  return { tier, profile: floorProfileToLane(profile, lane), lane, confidence, rationale };
}

/**
 * Map a triage tier to a persisted complexity label.
 *
 * @param {number} tier - 0-4
 * @returns {'S'|'M'|'L'|'XL'}
 */
export function tierToComplexity(tier) {
  if (tier <= 1) return 'S';
  if (tier === 2) return 'M';
  if (tier === 3) return 'L';
  return 'XL';
}

/**
 * Return the more conservative (smaller-scope) of two lanes.
 * Order: trivial < standard < complex.
 *
 * Used by refinement/escalation call sites to enforce "narrow-only" — a
 * later pass may only shrink scope, never widen it (widening is
 * escalation's job, via `lib/escalation.js`, not refinement's).
 *
 * @param {'trivial'|'standard'|'complex'} a
 * @param {'trivial'|'standard'|'complex'} b
 * @returns {'trivial'|'standard'|'complex'}
 */
export function narrowerLane(a, b) {
  return LANE_ORDER[a] <= LANE_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run triage on a feature folder.
 *
 * @param {string} featureCode - Feature code (e.g. 'FEAT-1')
 * @param {{ cwd: string }} opts
 * @returns {Promise<{ tier: number, profile: object, rationale: string, signals: object }>}
 */
export async function runTriage(featureCode, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const featuresDir = opts.featuresDir ?? resolveFeaturesPath(cwd);
  const featureDir = join(resolvePathValue(cwd, featuresDir, 'features'), featureCode);

  // Collect content from key files
  const candidateFiles = ['plan.md', 'blueprint.md', 'design.md', 'prd.md', 'architecture.md'];
  let combinedContent = '';
  let hasDesignDoc = false;

  for (const fname of candidateFiles) {
    const fpath = join(featureDir, fname);
    if (existsSync(fpath)) {
      if (['design.md', 'prd.md', 'architecture.md'].includes(fname)) {
        hasDesignDoc = true;
      }
      try {
        combinedContent += readFileSync(fpath, 'utf-8') + '\n';
      } catch { /* skip unreadable */ }
    }
  }

  const filePaths = extractFilePaths(combinedContent);
  const taskCount = countTasks(combinedContent);
  const securityPaths = anyMatch(filePaths, SECURITY_PATTERNS);
  const corePaths = anyMatch(filePaths, CORE_PATTERNS);

  // Deduplicate file paths for count
  const uniquePaths = new Set(filePaths);
  const fileCount = uniquePaths.size;

  const signals = { fileCount, securityPaths, corePaths, taskCount, hasDesignDoc };
  const { tier, profile, rationale } = deriveProfile(signals);

  return {
    tier,
    profile,
    rationale,
    signals: { fileCount, securityPaths, corePaths, taskCount },
  };
}

/**
 * Check whether cached triage results are stale.
 *
 * Returns true if:
 *   - feature.json has no triageTimestamp
 *   - any file in the feature folder (EXCEPT feature.json itself) has an mtime
 *     newer than triageTimestamp. feature.json is excluded because the stamp it
 *     is compared against lives inside it, so its own mtime would self-stale.
 *
 * @param {string} cwd - Project root
 * @param {string} featureCode - Feature code
 * @param {string} [featuresDir] - Path to features dir (absolute or relative; default: resolved features path)
 * @returns {boolean}
 */
export function isTriageStale(cwd, featureCode, featuresDir = resolveFeaturesPath(cwd)) {
  const featureDir = join(resolvePathValue(cwd, featuresDir, 'features'), featureCode);
  const featureJsonPath = join(featureDir, 'feature.json');

  if (!existsSync(featureJsonPath)) return true;

  let feature;
  try {
    feature = JSON.parse(readFileSync(featureJsonPath, 'utf-8'));
  } catch {
    return true;
  }

  if (!feature.triageTimestamp) return true;

  const triageTime = new Date(feature.triageTimestamp).getTime();
  if (isNaN(triageTime)) return true;

  // Check all files in the feature folder
  if (!existsSync(featureDir)) return true;
  try {
    const entries = readdirSync(featureDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // feature.json holds the triageTimestamp we compare against — counting its
      // own mtime is circular: writing the stamp would self-invalidate the cache
      // (COMP-ROADMAP-PLAN C14). Exclude it from the staleness scan.
      if (entry.name === 'feature.json') continue;
      const filePath = join(featureDir, entry.name);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs > triageTime) return true;
      } catch { /* skip */ }
    }
  } catch {
    return true;
  }

  return false;
}
