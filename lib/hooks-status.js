/**
 * hooks-status.js — Shared git-hook status logic.
 *
 * Single source of truth for hook drift detection, consumed by:
 *   - `compose hooks status` (bin/compose.js) — prints lines via formatHookStatusLines
 *   - `GET /api/environment-health` (server/health-routes.js) — maps raw facts to API states
 *
 * Extracted verbatim from the historical inline `statusOne` (bin/compose.js) so
 * the CLI output stays byte-identical. The ONLY addition is the non-state
 * `wsVerified` flag: when the expected workspace id is unknown (null), the CLI
 * stays lenient (reports "current") but the flag lets the API surface
 * `workspace-unverified` instead of a false "current".
 *
 * Pure: no console output, no process exit. Reads only the hook files on disk.
 *
 * Roadmap: COMP-PARITY-3.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Marker comment baked into each Compose-installed hook (identifies "ours"). */
export const HOOK_MARKERS = {
  'post-commit': '# Compose post-commit hook —',
  'pre-push': '# Compose pre-push hook —',
};

/** The hook types Compose manages, in display order. */
export const HOOK_TYPE_LIST = Object.keys(HOOK_MARKERS);

/** Pull the baked COMPOSE_WORKSPACE_ID="..." value out of hook content, or null. */
export function extractBakedWorkspaceId(content) {
  const m = content.match(/^COMPOSE_WORKSPACE_ID="([^"]*)"$/m);
  return m ? m[1] : null;
}

/**
 * Compute the raw status facts for every managed hook type.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot — repo root (hooks live at <root>/.git/hooks)
 * @param {string|null} [opts.expectedWsId] — workspace id to compare against; null
 *   means "unknown" (lenient match, wsVerified=false)
 * @param {string} opts.composeNode — expected COMPOSE_NODE (process.execPath)
 * @param {string} opts.composeBin — expected COMPOSE_BIN (path to compose.js)
 * @returns {Record<string, HookStatusRaw>} keyed by hook type
 */
export function computeHooksStatus({ projectRoot, expectedWsId = null, composeNode, composeBin }) {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  const out = {};
  for (const type of HOOK_TYPE_LIST) {
    out[type] = computeOne({ type, hooksDir, expectedWsId, composeNode, composeBin });
  }
  return out;
}

function computeOne({ type, hooksDir, expectedWsId, composeNode, composeBin }) {
  const marker = HOOK_MARKERS[type];
  const dest = join(hooksDir, type);

  const empty = {
    reason: null,
    bakedWorkspace: null,
    expectedWorkspace: expectedWsId ?? null,
    wsVerified: false,
    nodeMatch: false,
    binMatch: false,
  };

  if (!existsSync(dest)) return { state: 'absent', ...empty };

  const content = readFileSync(dest, 'utf-8');
  if (!content.includes(marker)) return { state: 'foreign', ...empty };

  const nodeMatch = content.includes(`COMPOSE_NODE="${composeNode}"`);
  const binMatch = content.includes(`COMPOSE_BIN="${composeBin}"`);
  const hasRawToken = content.includes('__COMPOSE_WORKSPACE_ID__');
  const bakedWorkspace = extractBakedWorkspaceId(content);
  // Mirror of statusOne: raw token never matches; a known expected id must match
  // the baked value; an unknown (null) expected id is treated leniently as a match.
  const wsMatch = hasRawToken ? false : expectedWsId ? content.includes(`COMPOSE_WORKSPACE_ID="${expectedWsId}"`) : true;

  const base = {
    bakedWorkspace,
    expectedWorkspace: expectedWsId ?? null,
    wsVerified: expectedWsId != null,
    nodeMatch,
    binMatch,
  };

  if (nodeMatch && binMatch && wsMatch && !hasRawToken) {
    return { state: 'installed-current', reason: null, ...base };
  }
  const reason = hasRawToken
    ? 'MISSING_WORKSPACE_ID'
    : expectedWsId && !wsMatch
      ? 'STALE_WORKSPACE_ID'
      : 'stale paths';
  return { state: 'installed-stale', reason, ...base };
}

/**
 * Reproduce the exact lines `compose hooks status` printed for one hook type.
 * Returns an array of strings (callers print each with console.log).
 *
 * @param {string} type — hook type ('post-commit' | 'pre-push')
 * @param {HookStatusRaw} s — a single entry from computeHooksStatus
 * @param {{composeNode: string, composeBin: string}} opts — current env values for the "expected" lines
 * @returns {string[]}
 */
export function formatHookStatusLines(type, s, { composeNode, composeBin }) {
  if (s.state === 'absent') return [`${type}: absent — no hook installed`];
  if (s.state === 'foreign') return [`${type}: foreign — hook exists but is not a Compose hook`];
  if (s.state === 'installed-current') {
    const lines = [`${type}: installed (current)`];
    if (s.bakedWorkspace) lines.push(`  workspace: ${s.bakedWorkspace}`);
    return lines;
  }
  // installed-stale
  const lines = [`${type}: installed (${s.reason} — re-run install)`];
  if (s.reason === 'STALE_WORKSPACE_ID') lines.push(`  expected COMPOSE_WORKSPACE_ID="${s.expectedWorkspace}"`);
  if (!s.nodeMatch) lines.push(`  expected COMPOSE_NODE="${composeNode}"`);
  if (!s.binMatch) lines.push(`  expected COMPOSE_BIN="${composeBin}"`);
  return lines;
}

/**
 * @typedef {object} HookStatusRaw
 * @property {'absent'|'foreign'|'installed-current'|'installed-stale'} state
 * @property {null|'MISSING_WORKSPACE_ID'|'STALE_WORKSPACE_ID'|'stale paths'} reason
 * @property {string|null} bakedWorkspace
 * @property {string|null} expectedWorkspace
 * @property {boolean} wsVerified
 * @property {boolean} nodeMatch
 * @property {boolean} binMatch
 */
