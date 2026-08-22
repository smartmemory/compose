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

/**
 * GOV-COMPOSE-SEAM-1 step 0 (`plumbing`).
 *
 * Translate the `smartmemory` config block into the three env vars Stratum's
 * policy client reads, so Compose's ingest events and Stratum's enforcement
 * events land in ONE workspace instead of two (or, today, one and nowhere).
 *
 * Two traps this function exists to close:
 *
 * 1. `workspaceId` is two different things. Top-level `compose.json#workspaceId`
 *    is a Compose PROJECT SLUG (`^[a-z][a-z0-9-]{1,63}$`, see
 *    discover-workspaces.js) used for provenance tagging. The SmartMemory
 *    workspace id lives at `smartmemory.workspaceId` and looks like
 *    `team_26f0bbe60a4c`. Sending the slug as `X-Workspace-Id` scopes every
 *    event to a workspace that does not exist, and the API answers 200, so the
 *    failure is silent. This reads the block, never the top level.
 * 2. Stratum's `SmartMemoryClient` reads `process.env` ONCE at construction
 *    (policy/smartmemory_client.ts). Setting these after the MCP subprocess
 *    starts is a no-op — they must be in the spawn env, which is why this
 *    returns a plain object for `connect()` to merge rather than mutating
 *    `process.env`.
 *
 * Fail-quiet by design, matching the existing fail-open ingest contract: an
 * unconfigured, disabled, or half-configured workspace returns `{}` and Stratum
 * simply runs without policy delivery (it warns once on its own). A partial env
 * would be worse than none — it produces events addressed to nowhere.
 *
 * @param {string} cwd
 * @returns {{SMARTMEMORY_API_URL?: string, SMARTMEMORY_API_KEY?: string, SMARTMEMORY_WORKSPACE_ID?: string}}
 */
export function resolveStratumPolicyEnv(cwd) {
  let cfg;
  try {
    cfg = getSmartmemoryConfig(cwd);
  } catch {
    return {};
  }
  if (cfg.enabled !== true) return {};

  const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : '';
  // NEVER cfg.workspaceId's top-level namesake — see trap 1 above.
  const workspaceId = typeof cfg.workspaceId === 'string' ? cfg.workspaceId.trim() : '';
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;

  // All three or nothing.
  if (!baseUrl || !workspaceId || !apiKey) return {};

  return {
    SMARTMEMORY_API_URL: baseUrl,
    SMARTMEMORY_API_KEY: apiKey,
    SMARTMEMORY_WORKSPACE_ID: workspaceId,
  };
}
