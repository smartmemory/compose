/**
 * smartmemory-config.js — COMP-SMARTMEMORY-INGEST S01
 *
 * Shared reader + provenance helpers for the optional SmartMemory coupling.
 * Leaf module: no fetch, no compose-state writes → safe to import eagerly at
 * both hook sites (lib/feature-events.js, server/gate-log-store.js).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveId } from './discover-workspaces.js';

/**
 * Read `.compose/compose.json` → `smartmemory` block. Uncached direct read,
 * try/catch → {} on missing/malformed. Returns the raw block; consumers gate
 * on `.enabled === true`. Does NOT resolve the API key.
 * @param {string} cwd
 * @returns {{ enabled?: boolean, baseUrl?: string, apiKeyEnv?: string, timeoutMs?: number }}
 */
export function getSmartmemoryConfig(cwd) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    return cfg.smartmemory ?? {};
  } catch {
    return {};
  }
}

/**
 * Canonical per-project provenance tag. Wraps deriveId: compose.json
 * #workspaceId when valid, else basename(cwd). Same value for emitters, sync,
 * and RECALL → exact string-equality badge comparison end-to-end.
 * @param {string} cwd
 * @returns {string}
 */
export function resolveProjectTag(cwd) {
  return deriveId({ root: cwd }).id;
}

/**
 * Deterministic provenance path: `compose/<project>/<repoRel>`. Used for
 * every source_path (events: provenance only; files: dedupe key). Pure/total.
 * @param {string} projectTag
 * @param {string} repoRel  repo-relative path (forward slashes)
 * @returns {string}
 */
export function sourcePathFor(projectTag, repoRel) {
  return `compose/${projectTag}/${repoRel}`;
}
