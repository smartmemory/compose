/**
 * migrate-roadmap.js — One-time migration from ROADMAP.md to feature.json files.
 *
 * Reads the existing ROADMAP.md, extracts feature entries using roadmap-parser,
 * and creates feature.json files for each real (non-anonymous) feature.
 */

import { readFileSync, existsSync } from 'fs';
import { parseRoadmap } from './roadmap-parser.js';
import { readFeature, writeFeature } from './feature-json.js';
import { loadFeaturesDir, resolveRoadmapPath } from './project-paths.js';

/**
 * Migrate ROADMAP.md entries to feature.json files.
 *
 * @param {string} cwd - Project root
 * @param {object} [opts]
 * @param {string} [opts.featuresDir] - Relative features path
 * @param {boolean} [opts.dryRun] - Print what would be created without writing
 * @param {boolean} [opts.overwrite] - Overwrite existing feature.json files
 * @param {string[]} [opts.externalPrefixes] - Code prefixes for features owned by
 *   OTHER projects (cross-project references). Entries whose code matches any
 *   prefix are skipped entirely — no feature.json is created — and recorded in
 *   the returned `skippedExternal` array.
 * @returns {{ created: string[], skipped: string[], updated: string[], skippedExternal: string[] }}
 */
export function migrateRoadmap(cwd, opts = {}) {
  // COMP-MCP-MIGRATION-2-1: honor `paths.features` override so backfill
  // writes under the configured root rather than the hardcoded default.
  const featuresDir = opts.featuresDir ?? loadFeaturesDir(cwd);
  const externalPrefixes = opts.externalPrefixes ?? [];
  const isExternal = (code) => externalPrefixes.some((p) => code.startsWith(p));
  const roadmapPath = resolveRoadmapPath(cwd);

  if (!existsSync(roadmapPath)) {
    throw new Error(`No ROADMAP.md found at ${roadmapPath}`);
  }

  const text = readFileSync(roadmapPath, 'utf-8');
  const entries = parseRoadmap(text);

  const created = [];
  const skipped = [];
  const updated = [];
  const skippedExternal = [];

  for (const entry of entries) {
    // Skip anonymous entries
    if (entry.code.startsWith('_anon_')) continue;

    // Skip cross-project references — owned by another project, present here
    // only as a roadmap reference. Never create a feature.json for these.
    if (isExternal(entry.code)) {
      skippedExternal.push(entry.code);
      continue;
    }

    const existing = readFeature(cwd, entry.code, featuresDir);

    if (existing && !opts.overwrite) {
      skipped.push(entry.code);
      continue;
    }

    // Extract phase name (strip milestone nesting for clean grouping)
    const phase = extractPhase(entry.phaseId);

    const feature = {
      code: entry.code,
      description: entry.description,
      status: entry.status,
      phase,
      position: entry.position,
      ...(existing ?? {}),
      // Always update status from ROADMAP (source of truth during migration)
      status: entry.status,
    };

    // Set created date if new
    if (!feature.created) {
      feature.created = new Date().toISOString().slice(0, 10);
    }

    if (opts.dryRun) {
      console.log(`${existing ? 'update' : 'create'}: ${featuresDir}/${entry.code}/feature.json`);
    } else {
      writeFeature(cwd, feature, featuresDir);
    }

    if (existing) {
      updated.push(entry.code);
    } else {
      created.push(entry.code);
    }
  }

  return { created, skipped, updated, skippedExternal };
}

/**
 * Clean up phase ID from the parser (strip milestone nesting).
 * "STRAT-1: Stratum Process Engine + Compose MVP > Milestone 2: Headless Compose Runner"
 *  → "STRAT-1: Stratum Process Engine + Compose MVP"
 */
function extractPhase(phaseId) {
  if (!phaseId) return null;
  // Use the top-level phase, not the milestone
  const parts = phaseId.split(' > ');
  return parts[0].trim();
}
