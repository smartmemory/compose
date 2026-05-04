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

const GUARDED_FILES = new Set(['ROADMAP.md', 'CHANGELOG.md']);

const TOOLS_FOR_ROADMAP = ['add_roadmap_entry', 'set_feature_status', 'propose_followup'];
const TOOLS_FOR_CHANGELOG = ['add_changelog_entry'];
const TOOLS_FOR_FEATURE_JSON = [
  'add_roadmap_entry',
  'set_feature_status',
  'link_artifact',
  'link_features',
  'record_completion',
  'propose_followup',
];

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
  if (GUARDED_FILES.has(path)) return true;
  // <featuresDir>/<CODE>/feature.json
  const prefix = featuresDir.replace(/\/$/, '') + '/';
  if (!path.startsWith(prefix)) return false;
  return path.endsWith('/feature.json');
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
  if (path === 'ROADMAP.md') return [...TOOLS_FOR_ROADMAP];
  if (path === 'CHANGELOG.md') return [...TOOLS_FOR_CHANGELOG];
  const prefix = featuresDir.replace(/\/$/, '') + '/';
  if (path.startsWith(prefix) && path.endsWith('/feature.json')) {
    return [...TOOLS_FOR_FEATURE_JSON];
  }
  return [];
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
  const prefix = featuresDir.replace(/\/$/, '') + '/';
  if (!path.startsWith(prefix) || !path.endsWith('/feature.json')) return null;
  const middle = path.slice(prefix.length, -'/feature.json'.length);
  if (!middle || middle.includes('/')) return null;
  return middle;
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

export const _internals = {
  GUARDED_FILES,
  TOOLS_FOR_ROADMAP,
  TOOLS_FOR_CHANGELOG,
  TOOLS_FOR_FEATURE_JSON,
};
