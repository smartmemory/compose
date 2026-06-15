/**
 * paths-core.js — PURE artifact-path resolution. No fs, no config reading.
 * Single source of truth for default artifact locations (COMP-PATHS-EXTERNAL).
 *
 * `resolvePathValue` uses path.resolve (NOT path.join) so an absolute or
 * ../-escaping `paths.*` override resolves correctly instead of being
 * silently re-rooted under cwd.
 */
import path from 'node:path';

export const DEFAULT_PATHS = Object.freeze({
  docs: 'docs',
  roadmap: 'ROADMAP.md',
  features: 'docs/features',
  journal: 'docs/journal',
  context: 'docs/context',
  ideabox: 'docs/product/ideabox.md',
});

/**
 * Resolve a configured `paths[key]` value to an absolute, normalized path.
 *
 * @param {string} root  Absolute workspace root.
 * @param {*} value      The configured paths[key] value (any type).
 * @param {string} key   Fallback key into DEFAULT_PATHS when value is unusable.
 * @returns {string}     Absolute, normalized path.
 */
export function resolvePathValue(root, value, key) {
  const v = (typeof value === 'string' && value.trim().length > 0)
    ? value
    : DEFAULT_PATHS[key];
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(root, v);
}

/**
 * Display-safe relativization: a clean root-relative string when `abs` is
 * inside `root`, else the absolute path (never a `../`-prefixed string).
 *
 * @param {string} root  Absolute workspace root.
 * @param {string} abs   Absolute path to relativize for display.
 * @returns {string}
 */
export function relForDisplay(root, abs) {
  const rel = path.relative(root, abs);
  if (rel === '') return '.';
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
}
