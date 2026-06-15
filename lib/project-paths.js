/**
 * project-paths.js — read .compose/compose.json and resolve artifact paths
 * for lib-side code. All path math is delegated to lib/paths-core.js so the
 * server and lib resolvers can never diverge.
 *
 * Introduced by COMP-MCP-MIGRATION-2; extended to relocatable artifact paths
 * by COMP-PATHS-EXTERNAL (absolute readers + *FromConfig alternate-root form).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_PATHS, resolvePathValue, relForDisplay } from './paths-core.js';

function readConfig(cwd) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(cfgPath)) return {};
  try { return JSON.parse(readFileSync(cfgPath, 'utf-8')); }
  catch { return {}; }
}

/** Resolve one artifact key against the config on disk at `cwd`. Absolute. */
function resolveKey(cwd, key) {
  return resolvePathValue(cwd, readConfig(cwd)?.paths?.[key], key);
}
/** Resolve one artifact key against an already-loaded config + arbitrary root. Absolute. */
function resolveKeyFromConfig(root, config, key) {
  return resolvePathValue(root, config?.paths?.[key], key);
}

export const resolveDocsPath     = (cwd) => resolveKey(cwd, 'docs');
export const resolveRoadmapPath  = (cwd) => resolveKey(cwd, 'roadmap');
export const resolveFeaturesPath = (cwd) => resolveKey(cwd, 'features');
export const resolveJournalPath  = (cwd) => resolveKey(cwd, 'journal');
export const resolveContextPath  = (cwd) => resolveKey(cwd, 'context');
export const resolveIdeaboxPath  = (cwd) => resolveKey(cwd, 'ideabox');

export const resolveDocsPathFromConfig     = (root, config) => resolveKeyFromConfig(root, config, 'docs');
export const resolveRoadmapPathFromConfig  = (root, config) => resolveKeyFromConfig(root, config, 'roadmap');
export const resolveFeaturesPathFromConfig = (root, config) => resolveKeyFromConfig(root, config, 'features');
export const resolveJournalPathFromConfig  = (root, config) => resolveKeyFromConfig(root, config, 'journal');
export const resolveContextPathFromConfig  = (root, config) => resolveKeyFromConfig(root, config, 'context');
export const resolveIdeaboxPathFromConfig  = (root, config) => resolveKeyFromConfig(root, config, 'ideabox');

export { relForDisplay };

/**
 * @deprecated relative form — prefer resolveFeaturesPath (absolute). Kept for
 * any caller that genuinely needs the configured RELATIVE string. Callers that
 * pass the result into feature-json.js should migrate to resolveFeaturesPath,
 * which is absolute-safe (COMP-PATHS-EXTERNAL S2).
 */
export function loadFeaturesDir(cwd) {
  const rel = readConfig(cwd)?.paths?.features;
  return (typeof rel === 'string' && rel.length > 0) ? rel : DEFAULT_PATHS.features;
}

export function loadExternalPrefixes(cwd) {
  const arr = readConfig(cwd)?.externalPrefixes;
  return Array.isArray(arr) ? arr : [];
}

export const _internals = { DEFAULT_FEATURES_DIR: DEFAULT_PATHS.features };
