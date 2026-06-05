/**
 * feature-json.js — Read, write, and list feature.json files.
 *
 * Each feature lives at docs/features/<CODE>/feature.json.
 * feature.json is the machine-readable source of truth.
 * ROADMAP.md is generated from these files.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { readdirSync } from 'fs';
import { assertValidLinkShape, assertLinkTargetsExist } from './feature-write-guard.js';

/**
 * @typedef {object} FeatureJson
 * @property {string} code
 * @property {string} description
 * @property {string} status - PLANNED | IN_PROGRESS | PARTIAL | COMPLETE | SUPERSEDED | PARKED
 * @property {string} [parent] - Parent feature/phase code (e.g., "STRAT-1", "Phase 6")
 * @property {string} [phase] - Phase heading for ROADMAP grouping
 * @property {number} [position] - Sort order within phase
 * @property {string} [complexity] - low | medium | high (from scope step)
 * @property {object} [profile] - BuildProfile from scope step
 * @property {string} [created] - ISO date
 * @property {string} [updated] - ISO date
 */

/**
 * Read a single feature.json.
 *
 * @param {string} cwd - Project root
 * @param {string} code - Feature code
 * @param {string} [featuresDir] - Relative path to features dir (default: docs/features)
 * @returns {FeatureJson|null}
 */
export function readFeature(cwd, code, featuresDir = 'docs/features') {
  const path = join(cwd, featuresDir, code, 'feature.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write a feature.json, creating the directory if needed.
 *
 * @param {string} cwd - Project root
 * @param {FeatureJson} feature
 * @param {string} [featuresDir]
 * @param {{validate?: boolean, allowForwardRefs?: boolean}} [opts] - Write-time
 *   validation (COMP-MCP-VALIDATE-1). Validates by default; `validate: false`
 *   skips all guarding (migration/back-fill tooling only); `allowForwardRefs`
 *   permits a known-good forward-reference link target.
 */
export function writeFeature(cwd, feature, featuresDir = 'docs/features', opts = {}) {
  if (opts.validate !== false) {
    assertValidLinkShape(feature);
    assertLinkTargetsExist(cwd, feature, { allowForwardRefs: opts.allowForwardRefs });
  }
  const dir = join(cwd, featuresDir, feature.code);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'feature.json');
  feature.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(path, JSON.stringify(feature, null, 2) + '\n');
}

// Sentinel for absent / non-numeric positions: sorts them after any real
// position while keeping the comparator total (tie-broken by code).
const POSITION_SENTINEL = Number.MAX_SAFE_INTEGER;

/**
 * Numeric sort key for a feature/item position. Tolerant of ranged strings
 * (`"141–144"` → 141) and absent/garbage values (→ sentinel). Never returns NaN.
 *
 * @param {number|string|null|undefined} position
 * @returns {number}
 */
export function positionSortKey(position) {
  if (typeof position === 'number') {
    return Number.isFinite(position) ? position : POSITION_SENTINEL;
  }
  if (position == null) return POSITION_SENTINEL;
  // Leading integer only: ranged positions ("92–95") begin with their start
  // value; anything not starting with digits (after optional whitespace) is
  // malformed and sorts to the sentinel rather than being coerced to a digit
  // run from the middle of the string.
  const m = String(position).match(/^\s*(\d+)/);
  return m ? parseInt(m[1], 10) : POSITION_SENTINEL;
}

/**
 * List all feature.json files in the features directory.
 *
 * @param {string} cwd - Project root
 * @param {string} [featuresDir]
 * @returns {FeatureJson[]}
 */
export function listFeatures(cwd, featuresDir = 'docs/features') {
  const dir = join(cwd, featuresDir);
  if (!existsSync(dir)) return [];

  const features = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fjPath = join(dir, entry.name, 'feature.json');
    if (!existsSync(fjPath)) continue;
    try {
      features.push(JSON.parse(readFileSync(fjPath, 'utf-8')));
    } catch { /* skip malformed */ }
  }

  // Sort by phase, then position, then code. The position key is range-tolerant:
  // ranged positions like "141–144" (from the historical-row migration) parse to
  // their leading integer; non-numeric / absent positions fall to a sentinel and
  // tie-break by code. This guarantees a deterministic total order — a NaN return
  // from subtracting string positions would make the sort (and therefore regen
  // order) non-deterministic and break the roundtrip fixed point.
  features.sort((a, b) => {
    if (a.phase !== b.phase) return (a.phase ?? '').localeCompare(b.phase ?? '');
    const pa = positionSortKey(a.position);
    const pb = positionSortKey(b.position);
    if (pa !== pb) return pa - pb;
    return a.code.localeCompare(b.code);
  });

  return features;
}

/**
 * Update a feature's status (and optionally other fields).
 *
 * @param {string} cwd
 * @param {string} code
 * @param {Partial<FeatureJson>} updates
 * @param {string} [featuresDir]
 * @returns {FeatureJson|null} - Updated feature, or null if not found
 */
export function updateFeature(cwd, code, updates, featuresDir = 'docs/features') {
  const feature = readFeature(cwd, code, featuresDir);
  if (!feature) return null;
  Object.assign(feature, updates);
  writeFeature(cwd, feature, featuresDir);
  return feature;
}
