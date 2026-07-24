/**
 * mcp-enforcement.js — helpers for COMP-MCP-MIGRATION-1 build-time
 * enforcement of typed MCP writers against `ROADMAP.md`, `CHANGELOG.md`,
 * and `feature.json` files.
 *
 * Mode parsing: `enforcement.mcpForFeatureMgmt` in `.compose/data/settings.json`
 *   true     → 'block' (prompt + scan rejects unauthorized edits)
 *   'log'    → 'log'   (prompt + scan emits decision events but proceeds)
 *   anything else → 'off' (no prompt, no scan)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  isGuarded as registryIsGuarded,
  toolsForPath as registryToolsForPath,
  featureCodeForPath as registryFeatureCodeForPath,
} from './canon-registry.js';

// COMP-CANON-GUARD S1: the guarded-path/tool declarations that used to live here
// as literal sets now live in lib/canon-registry.js — the single source of truth
// shared with the write-time hook. This module is the 'ship' enforcement point;
// it consumes ONLY the registry's ship subset, so its behavior is unchanged
// (docs/judgment/** is a hook-only path and is invisible here, exactly as before
// this refactor, when it was not declared at all). The contract test
// (test/canon-registry-contract.test.js) pins that equivalence.
const ENFORCEMENT_POINT = 'ship';

/**
 * Read `enforcement.mcpForFeatureMgmt` and normalize to 'block' | 'log' | 'off'.
 *
 * @param {string} dataDir - The .compose/data directory containing settings.json.
 * @returns {'block'|'log'|'off'}
 */
export function readEnforcementMode(dataDir) {
  const settingsPath = join(dataDir, 'settings.json');
  if (!existsSync(settingsPath)) return 'off';
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const v = s?.enforcement?.mcpForFeatureMgmt;
    if (v === true) return 'block';
    if (v === 'log') return 'log';
    return 'off';
  } catch {
    return 'off';
  }
}

/**
 * Filter a list of dirty repo-relative file paths down to the ones under
 * MCP-enforcement governance.
 *
 * @param {string[]} dirtyFiles
 * @param {string} featuresDir - Resolved features dir (e.g. 'docs/features').
 * @returns {string[]}
 */
export function filterGuarded(dirtyFiles, featuresDir) {
  return dirtyFiles.filter(p => isGuardedPath(p, featuresDir));
}

/**
 * @param {string} path
 * @param {string} featuresDir
 */
export function isGuardedPath(path, featuresDir) {
  if (typeof path !== 'string') return false;
  return registryIsGuarded(path, { featuresDir, point: ENFORCEMENT_POINT });
}

/**
 * Return the typed MCP tool names that could legitimately produce the given
 * guarded path. The pre-stage scan requires at least one event from this set
 * to be present (with matching build_id) for the path to pass.
 *
 * @param {string} path
 * @param {string} featuresDir
 * @returns {string[]}
 */
export function expectedToolsForPath(path, featuresDir) {
  return registryToolsForPath(path, { featuresDir, point: ENFORCEMENT_POINT });
}

/**
 * Extract the feature code from a feature.json path under featuresDir, or
 * null if the path doesn't fit that shape.
 *
 * @param {string} path
 * @param {string} featuresDir
 * @returns {string|null}
 */
export function featureCodeFromPath(path, featuresDir) {
  return registryFeatureCodeForPath(path, { featuresDir });
}

/**
 * Run the pre-stage scan: for every guarded path in dirtyFiles, verify at
 * least one matching audit event with the current build_id exists in the
 * provided event window. For feature.json paths, the event must also be
 * scoped to the same feature code (so an event for feature A can't bless a
 * dirty edit to feature B's feature.json).
 *
 * @param {object} args
 * @param {string[]} args.dirtyFiles
 * @param {string}   args.featuresDir
 * @param {string}   args.buildId       - current build's UUID
 * @param {Array<object>} args.events   - events from feature-events.jsonl filtered to the build window
 * @returns {{violations: Array<{path: string, expected: string[]}>}}
 */
export function scanGuarded({ dirtyFiles, featuresDir, buildId, events }) {
  const guarded = filterGuarded(dirtyFiles, featuresDir);
  const eventsForBuild = events.filter(e => e.build_id === buildId);
  const violations = [];
  for (const path of guarded) {
    const expected = expectedToolsForPath(path, featuresDir);
    if (expected.length === 0) continue;  // unknown guarded shape — skip

    // For feature.json paths, require code-level correlation so a typed
    // event for feature A can't bless a manual edit to feature B's
    // feature.json. ROADMAP.md and CHANGELOG.md are project-scoped, so
    // tool-name-only matching is sufficient.
    const requiredCode = featureCodeFromPath(path, featuresDir);
    const matched = eventsForBuild.some(e => {
      if (!expected.includes(e.tool)) return false;
      if (requiredCode === null) return true;
      // Writers all stamp `code` with the feature being mutated. propose_followup
      // stamps the new code (which is also the feature.json being scaffolded),
      // and link_features stamps the from_code (the source feature).
      return e.code === requiredCode;
    });
    if (!matched) violations.push({ path, expected });
  }
  return { violations };
}

/**
 * Construct the typed error thrown by the build runner when block-mode enforcement fires.
 *
 * @param {Array<{path: string, expected: string[]}>} violations
 */
export function enforcementError(violations) {
  const lines = violations.map(v =>
    `  ${v.path} — required typed tool from: ${v.expected.join(', ')}`
  ).join('\n');
  const err = new Error(
    `MCP enforcement violation (enforcement.mcpForFeatureMgmt: true). ` +
    `The following dirty paths have no matching typed-tool event in this build:\n${lines}\n` +
    `Either re-run the failing edits via the typed MCP tools, or set ` +
    `enforcement.mcpForFeatureMgmt to false / 'log' to bypass.`
  );
  err.code = 'MCP_ENFORCEMENT_VIOLATION';
  err.violations = violations;
  return err;
}

// NOTE: the `_internals` export (guarded-file set + tool sets) was removed in
// COMP-CANON-GUARD S1. Those declarations now live in lib/canon-registry.js —
// the single source of truth — with no in-repo consumer of the old shim. Import
// from canon-registry.js if you need the raw sets, so there is exactly ONE
// declaration, not a copy here that can drift.
