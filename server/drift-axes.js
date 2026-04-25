/**
 * drift-axes.js — COMP-OBS-DRIFT axis computation.
 *
 * `computeDriftAxes(item, projectRoot, now)` returns DriftAxis[3] conforming to
 * the COMP-OBS-CONTRACT schema v0.2.4. All three axes always present; individual
 * axes fall back to `threshold: null` (disabled) when source is unavailable.
 *
 * Thresholds (Decision 2):
 *   path_drift        0.30  (30% of touched files outside the plan)
 *   contract_drift    0.20  (20% field churn since plan anchor)
 *   review_debt_drift 0.40  (40% unresolved STRAT-REV findings)
 *
 * Git invocations are synchronous / shell-out (mirrors BRANCH's inline pattern).
 * No shared git-utils.js exists in the shipped tree. All errors are caught; the
 * axis returns threshold:null rather than throwing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { diffContracts } from './contract-diff.js';

// ── Threshold constants (Decision 2) ─────────────────────────────────────────

const THRESHOLD_PATH_DRIFT = 0.30;
const THRESHOLD_CONTRACT_DRIFT = 0.20;
const THRESHOLD_REVIEW_DEBT_DRIFT = 0.40;

// ── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve an ISO timestamp to the nearest commit before that point.
 * Returns null on any error (no git, no repo, timestamp before first commit).
 *
 * @param {string} projectRoot
 * @param {string} isoTimestamp
 * @returns {string|null} commit sha1
 */
function resolveAnchorCommit(projectRoot, isoTimestamp) {
  try {
    const sha = execSync(
      `git rev-list -1 --before="${isoTimestamp}" HEAD`,
      { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Return the UNION of three git file sets (committed changes since anchor,
 * uncommitted modifications, untracked new files). Deduplicates paths.
 *
 * @param {string} projectRoot
 * @param {string} anchorCommit
 * @returns {Set<string>} relative paths
 */
function touchedFilesSince(projectRoot, anchorCommit) {
  const paths = new Set();
  const run = (cmd) => {
    try {
      const out = execSync(cmd, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      for (const line of out.split('\n')) {
        const p = line.trim();
        if (p) paths.add(p);
      }
    } catch {
      // silent — partial results preferred over complete failure
    }
  };

  run(`git diff --name-only ${anchorCommit}..HEAD`);
  run('git diff --name-only HEAD');
  run('git ls-files --others --exclude-standard');
  return paths;
}

/**
 * Extract backtick-quoted paths from a text file (plan.md / blueprint.md).
 * Returns empty Set on missing/unparseable file.
 *
 * @param {string} filePath — absolute path
 * @returns {Set<string>}
 */
function extractDeclaredPaths(filePath) {
  const paths = new Set();
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Match backtick-quoted strings that look like file paths (contain / or .)
    const regex = /`([^`]+)`/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
      const candidate = m[1].trim();
      // Include if it looks like a file path (has / or extension)
      if (candidate.includes('/') || /\.\w+$/.test(candidate)) {
        paths.add(candidate);
      }
    }
  } catch {
    // Missing file — return empty set; caller handles threshold:null
  }
  return paths;
}

// ── Anchor resolution ─────────────────────────────────────────────────────────

/**
 * Find the MOST RECENT phaseHistory entry where to === 'plan'.
 * Returns { timestamp } or null if no such entry exists.
 *
 * Design notes:
 *   - We intentionally do NOT require outcome === 'approved' because the shipped
 *     lifecycle writer frequently stores outcome: null on plain advances.
 *   - We use the LAST plan entry, not the first, because the lifecycle allows
 *     returning from verification back to plan (a replan). Drift should be
 *     measured against the freshest plan baseline, not a stale one — otherwise
 *     stale alerts persist across replans.
 *
 * @param {object} item
 * @returns {{ timestamp: string }|null}
 */
function findPlanAnchor(item) {
  const history = item?.lifecycle?.phaseHistory;
  if (!Array.isArray(history)) return null;
  let lastPlan = null;
  for (const entry of history) {
    if (entry.to === 'plan') lastPlan = entry;
  }
  return lastPlan ? { timestamp: lastPlan.timestamp } : null;
}

// ── Axis computation ──────────────────────────────────────────────────────────

function buildAxis(axis_id, name, numerator, denominator, threshold, computed_at, explanation) {
  const ratio = denominator > 0 ? numerator / denominator : 0;
  const breached = threshold != null && ratio >= threshold;
  return {
    axis_id,
    name,
    numerator,
    denominator,
    ratio,
    threshold,
    breached,
    computed_at,
    explanation,
    breach_started_at: null,
    breach_event_id: null,
  };
}

/**
 * Compute path_drift.
 *
 * @param {object} item
 * @param {string} projectRoot
 * @param {string} featurePath — absolute path to docs/features/<FC>/
 * @param {string} now — ISO timestamp
 * @returns {DriftAxis}
 */
function computePathDrift(item, projectRoot, featurePath, now) {
  const axis_id = 'path_drift';
  const name = 'Path drift';
  const explanation = 'Ratio of files touched since plan-approval that are not declared in plan.md or blueprint.md.';

  const anchor = findPlanAnchor(item);
  if (!anchor) {
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  const anchorCommit = resolveAnchorCommit(projectRoot, anchor.timestamp);
  if (!anchorCommit) {
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  const touched = touchedFilesSince(projectRoot, anchorCommit);
  if (touched.size === 0) {
    return buildAxis(axis_id, name, 0, 0, THRESHOLD_PATH_DRIFT, now, explanation);
  }

  // Collect declared paths from plan.md and blueprint.md
  const declared = new Set();
  for (const fname of ['plan.md', 'blueprint.md']) {
    const filePath = path.join(featurePath, fname);
    for (const p of extractDeclaredPaths(filePath)) {
      declared.add(p);
    }
  }

  // Count touched files NOT in declared set
  let undeclared = 0;
  for (const t of touched) {
    // Normalize: strip leading ./ if present
    const norm = t.replace(/^\.\//, '');
    // Check whether any declared path matches as a suffix (last segment or subpath)
    const isDeclared = [...declared].some(d => {
      const dn = d.replace(/^\.\//, '');
      return norm === dn || norm.endsWith('/' + dn) || norm.endsWith(dn);
    });
    if (!isDeclared) undeclared++;
  }

  return buildAxis(axis_id, name, undeclared, touched.size, THRESHOLD_PATH_DRIFT, now, explanation);
}

/**
 * Compute contract_drift.
 *
 * @param {object} item
 * @param {string} projectRoot
 * @param {string} featurePath — absolute path to docs/features/<FC>/
 * @param {string} now
 * @returns {DriftAxis}
 */
function computeContractDrift(item, projectRoot, featurePath, now) {
  const axis_id = 'contract_drift';
  const name = 'Contract drift';
  const explanation = 'Ratio of JSON schema fields added, removed, or retyped since plan-approval vs. total current fields.';

  const anchor = findPlanAnchor(item);
  if (!anchor) {
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  const anchorCommit = resolveAnchorCommit(projectRoot, anchor.timestamp);
  if (!anchorCommit) {
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  // Locate JSON schema files in featurePath
  let headPaths = [];
  try {
    headPaths = fs.readdirSync(featurePath)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(featurePath, f));
  } catch {
    // Feature folder missing — axis disabled
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  if (headPaths.length === 0) {
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  const { added, removed, retyped, total } = diffContracts(anchorCommit, headPaths, projectRoot);
  const numerator = added + removed + retyped;

  if (total === 0) {
    return buildAxis(axis_id, name, numerator, total, THRESHOLD_CONTRACT_DRIFT, now, explanation);
  }

  return buildAxis(axis_id, name, numerator, total, THRESHOLD_CONTRACT_DRIFT, now, explanation);
}

/**
 * Compute review_debt_drift.
 *
 * Reads docs/features/<FC>/review*.json (or strat-rev/*.json as fallback).
 * Missing / unparseable files → threshold: null (not ratio: 0 — to avoid
 * marking unreviewed features as "clean").
 *
 * @param {string} featurePath
 * @param {string} now
 * @returns {DriftAxis}
 */
function computeReviewDebtDrift(featurePath, now) {
  const axis_id = 'review_debt_drift';
  const name = 'Review debt drift';
  const explanation = 'Ratio of unresolved STRAT-REV findings to total findings for this feature.';

  const RESOLVED_STATUSES = new Set(['resolved', 'closed', 'fixed']);

  // Scan for review JSON files
  let reviewFiles = [];
  try {
    reviewFiles = fs.readdirSync(featurePath)
      .filter(f => f.startsWith('review') && f.endsWith('.json'))
      .map(f => path.join(featurePath, f));
  } catch {
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  // Fallback: strat-rev/ subfolder
  if (reviewFiles.length === 0) {
    try {
      const stratRevDir = path.join(featurePath, 'strat-rev');
      const subFiles = fs.readdirSync(stratRevDir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(stratRevDir, f));
      reviewFiles = subFiles;
    } catch {
      // No strat-rev/ either
    }
  }

  if (reviewFiles.length === 0) {
    // No review files — axis disabled (not "clean")
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  let totalFindings = 0;
  let unresolvedFindings = 0;
  let parsedAny = false;

  for (const filePath of reviewFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!content || typeof content !== 'object') continue;
      const findings = Array.isArray(content.findings) ? content.findings : [];
      // Mark as parsed at file level — an empty findings array IS a valid review
      parsedAny = true;
      for (const f of findings) {
        totalFindings++;
        if (!RESOLVED_STATUSES.has(f.status)) {
          unresolvedFindings++;
        }
      }
    } catch {
      // Skip unparseable files
    }
  }

  if (!parsedAny) {
    // All files were unparseable — axis disabled
    return buildAxis(axis_id, name, 0, 0, null, now, explanation);
  }

  return buildAxis(axis_id, name, unresolvedFindings, totalFindings, THRESHOLD_REVIEW_DEBT_DRIFT, now, explanation);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute all three drift axes for the given item.
 *
 * @param {object} item — vision item with item.lifecycle.featureCode and phaseHistory
 * @param {string} projectRoot — absolute path to the project root (used for git)
 * @param {string} now — ISO timestamp for computed_at
 * @returns {DriftAxis[3]} always returns exactly 3 axes (path / contract / review_debt)
 */
export function computeDriftAxes(item, projectRoot, now) {
  const featureCode = item?.lifecycle?.featureCode;
  if (!featureCode) {
    // No feature code — all axes disabled
    const ts = now || new Date().toISOString();
    return [
      buildAxis('path_drift', 'Path drift', 0, 0, null, ts, 'No feature code on item.'),
      buildAxis('contract_drift', 'Contract drift', 0, 0, null, ts, 'No feature code on item.'),
      buildAxis('review_debt_drift', 'Review debt drift', 0, 0, null, ts, 'No feature code on item.'),
    ];
  }

  const ts = now || new Date().toISOString();

  // Resolve the docs/features/<FC> directory
  // projectRoot/docs/features/<FC>
  const featurePath = path.join(projectRoot, 'docs', 'features', featureCode);

  const pathAxis = computePathDrift(item, projectRoot, featurePath, ts);
  const contractAxis = computeContractDrift(item, projectRoot, featurePath, ts);
  const reviewAxis = computeReviewDebtDrift(featurePath, ts);

  return [pathAxis, contractAxis, reviewAxis];
}
