/**
 * project-paths.js — read .compose/compose.json `paths.features` override
 * for lib-side writers.
 *
 * Server-side code uses `server/project-root.js`'s cached `loadProjectConfig`,
 * but lib code may run outside the server process (CLI, tests, MCP stdio)
 * and shouldn't share that cache. This is a tiny per-call read; the file is
 * a few hundred bytes.
 *
 * Introduced by COMP-MCP-MIGRATION-2.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DEFAULT_FEATURES_DIR = 'docs/features';

/**
 * Resolve the project's features directory, respecting `.compose/compose.json`'s
 * `paths.features` override. Returns the relative path (joined onto cwd by callers).
 *
 * @param {string} cwd
 * @returns {string} Relative features dir, e.g. 'docs/features' or 'specs/features'.
 */
export function loadFeaturesDir(cwd) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(cfgPath)) return DEFAULT_FEATURES_DIR;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const rel = cfg?.paths?.features;
    return (typeof rel === 'string' && rel.length > 0) ? rel : DEFAULT_FEATURES_DIR;
  } catch {
    return DEFAULT_FEATURES_DIR;
  }
}

export const _internals = { DEFAULT_FEATURES_DIR };
