/**
 * get-roadmap.js — COMP-MCP-ROADMAP-READ.
 *
 * Read-only roadmap reader for the compose MCP `get_roadmap` tool. Renders the
 * roadmap from canon (feature.json) WITHOUT writing any file, parses rows via the
 * shared parseRoadmap, and reports a staleness flag vs the on-disk ROADMAP.md.
 *
 * Invariants:
 *   - Never mutates the filesystem (no writeRoadmap / renderRoadmap).
 *   - Narrative-owned workspaces read ROADMAP.md verbatim (no console.warn path),
 *     and are never reported stale (the file IS the canon).
 *   - Row parsing reuses parseRoadmap — no second hand-rolled regex.
 */
import { existsSync, readFileSync } from 'node:fs';

import { generateRoadmap } from './roadmap-gen.js';
import { isNarrativeOwned } from './roadmap-config.js';
import { parseRoadmap, parseStatusToken } from './roadmap-parser.js';
import { resolveRoadmapPath } from './project-paths.js';

// Whole `**Last updated:** <date>` line — date-only and per-day, so it is
// stripped (not literal-matched) before drift comparison.
const LAST_UPDATED_RE = /^\*\*Last updated:\*\*.*$/m;

const ACTIVE_STATUSES = new Set(['IN_PROGRESS', 'PARTIAL']);

// Normalized status token -> summary bucket.
const BUCKET = {
  COMPLETE: 'complete',
  IN_PROGRESS: 'active',
  PARTIAL: 'active',
  PLANNED: 'planned',
  BLOCKED: 'blocked',
  PARKED: 'parked',
  SUPERSEDED: 'superseded',
};

function emptySummary() {
  return { complete: 0, active: 0, planned: 0, blocked: 0, parked: 0, superseded: 0 };
}

function stripVolatile(text) {
  return text.replace(LAST_UPDATED_RE, '').trimEnd();
}

/**
 * @param {string} root - Project root.
 * @param {object} [opts]
 * @param {string} [opts.status] - Comma-list status filter applied to active/blocked + rows.
 * @param {string} [opts.phase] - Exact phaseId filter applied to active/blocked + rows.
 * @param {'summary'|'markdown'} [opts.format='summary'] - Omit or include raw markdown.
 * @param {boolean} [opts.check_drift=true] - Compare render vs on-disk ROADMAP.md.
 * @param {number} [opts.limit=50] - Cap on the general `rows` list (emitted only when
 *   a status/phase filter or an explicit limit is supplied — keeps the default call token-safe).
 */
export function getRoadmap(root, opts = {}) {
  const { status, phase, format = 'summary', check_drift = true, limit } = opts ?? {};

  const roadmapPath = resolveRoadmapPath(root);
  const onDisk = existsSync(roadmapPath) ? readFileSync(roadmapPath, 'utf-8') : '';

  // Branch on narrative ownership ourselves: read the file directly for narrative
  // workspaces (avoids generateRoadmap's console.warn and is a true no-op read).
  const narrative = isNarrativeOwned(root);
  const markdown = narrative ? onDisk : generateRoadmap(root, {});
  const source = narrative ? 'narrative' : 'rendered';

  const rows = parseRoadmap(markdown);

  // Summary counts over ALL rows (anonymous included).
  const summary = emptySummary();
  for (const r of rows) {
    const bucket = BUCKET[parseStatusToken(r.status)];
    if (bucket) summary[bucket]++;
  }

  // active/blocked lists exclude anonymous rows. parseRoadmap rewrites
  // codeless rows to `_anon_${position}` (roadmap-parser.js), so filter on that
  // prefix — not the raw '—' glyph, which never reaches us.
  const named = rows.filter((r) => r.code && !r.code.startsWith('_anon_'));

  const matchFilter = (r) => {
    if (status) {
      const wanted = status.split(',').map((s) => s.trim().toUpperCase());
      if (!wanted.includes(parseStatusToken(r.status))) return false;
    }
    if (phase && r.phaseId !== phase) return false;
    return true;
  };
  const pick = (r) => ({
    code: r.code,
    description: r.description,
    status: parseStatusToken(r.status),
    phaseId: r.phaseId,
  });

  const active = named
    .filter((r) => ACTIVE_STATUSES.has(parseStatusToken(r.status)))
    .filter(matchFilter)
    .map(pick);
  const blocked = named
    .filter((r) => parseStatusToken(r.status) === 'BLOCKED')
    .filter(matchFilter)
    .map(pick);

  const out = { source, path: roadmapPath, summary, active, blocked };

  // General filtered rows list — emitted only when the caller signals intent via a
  // status/phase filter or an explicit limit. This is what lets `/roadmap next` read
  // the PLANNED list structured instead of re-parsing the markdown. The no-arg summary
  // call stays token-safe (no rows key). Anonymous rows are excluded, same as the lists.
  const wantsRows = status != null || phase != null || limit != null;
  if (wantsRows) {
    // Resolve the row cap with predictable semantics for malformed input: a finite
    // number is floored and clamped to >= 0 (so limit:-1 → 0 rows, limit:1.5 → 1),
    // never silently widened. Anything non-finite (no limit, just a status/phase
    // filter) falls back to the default 50.
    const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
    const matched = named.filter(matchFilter).map(pick);
    out.rowsTotal = matched.length;
    out.rows = matched.slice(0, cap);
    out.rowsTruncated = matched.length > cap;
  }

  if (check_drift) {
    if (narrative) {
      out.stale = false; // the content IS the file
    } else {
      const drifted = stripVolatile(markdown) !== stripVolatile(onDisk);
      out.stale = drifted;
      if (drifted) {
        out.drift = 'ROADMAP.md differs from the feature.json render (run validate_project --fix to reconcile)';
      }
    }
  }

  if (format === 'markdown') out.markdown = markdown;

  return out;
}
