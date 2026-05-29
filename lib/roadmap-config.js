/**
 * roadmap-config.js — Workspace-level roadmap policy (issue #39).
 *
 * A workspace is "narrative-owned" when its ROADMAP.md is hand-authored and
 * must NOT be machine-regenerated from feature.json. It is signalled by
 * `roadmap.narrative: true` in `.compose/compose.json`. The typed writer
 * (generateRoadmap / writeRoadmap / add_roadmap_entry) refuses to engage such a
 * workspace — otherwise regen flattens curated reconciliation prose into
 * rendered tables (the forge-top "Wave 6" duplication, root cause of #39).
 *
 * feature.json files may still exist in a narrative-owned workspace — they are
 * structured link carriers (xref-sync) and cross-references; they simply do not
 * DRIVE ROADMAP.md. The guard stops the writer, it does not delete data.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * @param {string} cwd - Workspace root
 * @returns {boolean} true if `.compose/compose.json` declares roadmap.narrative
 */
export function isNarrativeOwned(cwd) {
  const p = join(cwd, '.compose/compose.json');
  if (!existsSync(p)) return false;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed?.roadmap?.narrative === true;
  } catch {
    // Malformed config: don't claim narrative-owned. The tracker factory
    // (loadTrackerConfig) is the loud validator for malformed compose.json;
    // this gate stays quiet so a parse error there doesn't double-report here.
    return false;
  }
}

/**
 * Actionable message explaining why a typed-writer operation was refused.
 * @param {string} cwd
 * @returns {string}
 */
export function narrativeOwnedMessage(cwd) {
  return (
    `compose: ${cwd} is narrative-owned (roadmap.narrative=true in ` +
    `.compose/compose.json) — its ROADMAP.md is hand-authored and is not ` +
    `regenerated from feature.json. Edit ROADMAP.md directly. To re-enable ` +
    `typed-roadmap generation, remove "roadmap": { "narrative": true } from ` +
    `.compose/compose.json.`
  );
}
