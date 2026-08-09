/**
 * lineage.js — COMP-PROV-LINEAGE: W3C PROV-O artifact lineage (vocabulary only).
 *
 * Compose artifacts form a derivation chain — design.md produces blueprint.md
 * produces plan.md produces report.md — but nothing recorded it, so when an
 * upstream artifact changes, downstream artifacts went stale silently.
 *
 * We borrow the W3C PROV-O vocabulary (https://www.w3.org/TR/prov-o/), NOT the
 * RDF stack. See docs/features/COMP-PROV-LINEAGE/prov-o-mapping.md for the full
 * term mapping. In Compose terms:
 *
 *   prov:Entity          → a lifecycle artifact (design.md, blueprint.md, ...)
 *   prov:Activity        → a lifecycle phase (explore_design, blueprint, ...)
 *   prov:wasGeneratedBy  → the phase that produced this artifact (Entity → Activity)
 *   prov:wasDerivedFrom  → the upstream artifact(s) this was built on (Entity → Entity)
 *
 * `wasDerivedFrom` is the load-bearing edge: staleness becomes a graph
 * reachability query over it rather than bespoke logic.
 *
 * Storage: the lineage lives as HTML-comment markers in the first lines of each
 * artifact, reusing the `<!-- phase: ... -->` convention that lib/staleness.js
 * already reads (COMP-PROV-LINEAGE decision, embedded markers over a feature.json
 * block — canonical artifacts stay auto-discovered, never registered):
 *
 *   <!-- wasGeneratedBy: blueprint -->
 *   <!-- wasDerivedFrom: design.md -->
 *
 * The reachability query does NOT require the markers to have been stamped: for
 * canonical artifacts it falls back to CANONICAL_CHAIN, so it works on any
 * feature folder today. Markers only override the default derivation.
 *
 * Explicitly out of scope: RDF runtime, triple store, SPARQL, JSON-LD. A
 * JSON-LD export stays possible later by walking these same edges.
 */

import { readFileSync, writeFileSync, existsSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsOf, edgeEvidenceOf } from './lifecycle-modes.js';

/**
 * Canonical derivation chain for the `build` lifecycle, in derivation order.
 * Each entry is { file, phase } where `phase` is the prov:Activity that
 * generates the prov:Entity `file`.
 *
 * Ordered so that entry N wasDerivedFrom the nearest EXISTING predecessor
 * (predecessors may be skipped — prd/architecture/report are skippable phases).
 *
 * Mirrors lib/lifecycle-modes.js build mode. A test
 * (test/lineage.test.js) asserts this stays consistent with
 * `artifactsOf('build')` / `edgeEvidenceOf('build')` so the two never drift.
 */
export const CANONICAL_CHAIN = [
  { file: 'design.md', phase: 'explore_design' },
  { file: 'prd.md', phase: 'prd' },
  { file: 'architecture.md', phase: 'architecture' },
  { file: 'blueprint.md', phase: 'blueprint' },
  { file: 'plan.md', phase: 'plan' },
  { file: 'report.md', phase: 'report' },
];

const CHAIN_FILES = CANONICAL_CHAIN.map((e) => e.file);
const PHASE_BY_FILE = new Map(CANONICAL_CHAIN.map((e) => [e.file, e.phase]));

/**
 * The prov:Activity (phase) that generates a canonical artifact, or null if the
 * file is not a known canonical artifact.
 * @param {string} filename
 * @returns {string|null}
 */
export function generatingPhaseOf(filename) {
  return PHASE_BY_FILE.get(filename) ?? null;
}

/**
 * Extract PROV-O lineage markers from the first lines of artifact text.
 * Reads only the header region (first 8 lines) to match the cheap-scan spirit
 * of lib/staleness.js's extractPhaseMarker.
 *
 * @param {string} content
 * @returns {{ wasGeneratedBy: string|null, wasDerivedFrom: string[] }}
 */
export function extractLineageMarkers(content) {
  const lines = content.split('\n').slice(0, 8);
  let wasGeneratedBy = null;
  let wasDerivedFrom = null; // null = no usable marker present
  for (const line of lines) {
    // Anchored to a full line (optional surrounding whitespace) so a marker must
    // BE the line, not merely appear inside prose or a fenced code example.
    const g = line.match(/^\s*<!--\s*wasGeneratedBy:\s*([\w_-]+)\s*-->\s*$/);
    if (g) wasGeneratedBy = g[1];
    const d = line.match(/^\s*<!--\s*wasDerivedFrom:\s*([^>]*?)\s*-->\s*$/);
    if (d) {
      const parents = d[1]
        .split(',')
        .map((s) => s.trim())
        // Parents are sibling artifact filenames — never a path. Drop anything
        // with a separator or traversal so a hand-edited marker cannot point the
        // derivation graph outside the feature folder.
        .filter((s) => s && !s.includes('/') && !s.includes('\\') && !s.includes('..'));
      // An empty marker (`<!-- wasDerivedFrom:  -->`) is treated as no override
      // rather than an explicit "[]" state — Compose has no mid-chain
      // origin-override use case, and the phantom [] broke stamp idempotency.
      wasDerivedFrom = parents.length > 0 ? parents : null;
    }
  }
  return { wasGeneratedBy, wasDerivedFrom };
}

/**
 * Compute the canonical lineage for an artifact filename given which sibling
 * artifacts actually exist in the feature folder. `wasDerivedFrom` is the
 * nearest EXISTING predecessor in CANONICAL_CHAIN (so skipped phases don't
 * break the edge); the first artifact in the chain derives from nothing.
 *
 * @param {string} filename
 * @param {string[]} existingFiles  filenames present in the feature folder
 * @returns {{ entity: string, wasGeneratedBy: string|null, wasDerivedFrom: string[] }}
 */
export function canonicalLineageOf(filename, existingFiles) {
  const idx = CHAIN_FILES.indexOf(filename);
  if (idx === -1) {
    return { entity: filename, wasGeneratedBy: null, wasDerivedFrom: [] };
  }
  const present = new Set(existingFiles);
  let wasDerivedFrom = [];
  for (let i = idx - 1; i >= 0; i--) {
    if (present.has(CHAIN_FILES[i])) {
      wasDerivedFrom = [CHAIN_FILES[i]];
      break;
    }
  }
  return {
    entity: filename,
    wasGeneratedBy: PHASE_BY_FILE.get(filename) ?? null,
    wasDerivedFrom,
  };
}

/**
 * Resolve the effective lineage for an on-disk artifact: markers override the
 * canonical chain. Returns null if the file does not exist.
 *
 * @param {string} featureDir
 * @param {string} filename
 * @param {string[]} [existingFiles] optional precomputed sibling list
 * @returns {{ entity: string, wasGeneratedBy: string|null, wasDerivedFrom: string[], source: 'marker'|'canonical' }|null}
 */
export function lineageOf(featureDir, filename, existingFiles) {
  const filePath = join(featureDir, filename);
  if (!existsSync(filePath)) return null;
  const siblings = existingFiles ?? CHAIN_FILES.filter((f) => existsSync(join(featureDir, f)));

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    content = '';
  }
  const markers = extractLineageMarkers(content);
  const canonical = canonicalLineageOf(filename, siblings);

  // Markers override; fall back to canonical per-field.
  const usesMarker = markers.wasGeneratedBy !== null || markers.wasDerivedFrom !== null;
  return {
    entity: filename,
    wasGeneratedBy: markers.wasGeneratedBy ?? canonical.wasGeneratedBy,
    wasDerivedFrom: markers.wasDerivedFrom ?? canonical.wasDerivedFrom,
    source: usesMarker ? 'marker' : 'canonical',
  };
}

/**
 * Build the derivation graph (child -> parents) for the canonical artifacts that
 * exist in a feature folder, honouring marker overrides.
 *
 * @param {string} featureDir
 * @returns {Map<string, string[]>} filename -> its wasDerivedFrom parents
 */
export function buildDerivationGraph(featureDir) {
  const existing = CHAIN_FILES.filter((f) => existsSync(join(featureDir, f)));
  const graph = new Map();
  for (const file of existing) {
    const lin = lineageOf(featureDir, file, existing);
    graph.set(file, lin ? lin.wasDerivedFrom : []);
  }
  return graph;
}

/**
 * Reachability query — the core deliverable.
 *
 * Given an artifact that changed, return the downstream artifacts (transitive
 * descendants via wasDerivedFrom) that are now STALE: they exist, they descend
 * from the changed artifact, and their last-modified time is older than the
 * changed artifact's (they were derived before the upstream changed).
 *
 * @param {string} featureDir
 * @param {string} changedFile  filename of the artifact that changed
 * @returns {Array<{ file: string, stale: boolean, derivedFromChanged: boolean, mtimeMs: number }>}
 *          descendants of changedFile, stale ones first
 */
export function findStaleDescendants(featureDir, changedFile) {
  const graph = buildDerivationGraph(featureDir); // child -> parents

  // Invert to parent -> children for forward reachability.
  const children = new Map();
  for (const [child, parents] of graph) {
    for (const parent of parents) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
  }

  // BFS forward from changedFile to collect all transitive descendants.
  const descendants = new Set();
  const queue = [...(children.get(changedFile) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift();
    if (descendants.has(node)) continue;
    descendants.add(node);
    for (const c of children.get(node) ?? []) queue.push(c);
  }

  const changedPath = join(featureDir, changedFile);
  let changedMtime = 0;
  try {
    changedMtime = statSync(changedPath).mtimeMs;
  } catch {
    return []; // changed file gone — nothing to compare against
  }

  const results = [];
  for (const file of descendants) {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(featureDir, file)).mtimeMs;
    } catch {
      continue;
    }
    results.push({
      file,
      stale: mtimeMs < changedMtime,
      derivedFromChanged: true,
      mtimeMs,
    });
  }
  // Stale first, then by chain order for stable output.
  results.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? -1 : 1;
    return CHAIN_FILES.indexOf(a.file) - CHAIN_FILES.indexOf(b.file);
  });
  return results;
}

/**
 * Render the PROV-O marker header lines for an artifact's lineage.
 * @param {{ wasGeneratedBy: string|null, wasDerivedFrom: string[] }} lineage
 * @returns {string[]} marker lines (may be empty)
 */
function renderMarkers(lineage) {
  const out = [];
  if (lineage.wasGeneratedBy) out.push(`<!-- wasGeneratedBy: ${lineage.wasGeneratedBy} -->`);
  if (lineage.wasDerivedFrom && lineage.wasDerivedFrom.length > 0) {
    out.push(`<!-- wasDerivedFrom: ${lineage.wasDerivedFrom.join(', ')} -->`);
  }
  return out;
}

const MARKER_RE = /^<!--\s*(?:wasGeneratedBy|wasDerivedFrom):[^>]*-->\s*$/;

/**
 * Stamp PROV-O lineage markers into an artifact's content, idempotently.
 * Existing wasGeneratedBy/wasDerivedFrom marker lines are removed and replaced,
 * so re-stamping never duplicates. The `<!-- phase: -->` marker (staleness.js)
 * is left untouched. Returns the new content (unchanged if lineage is empty and
 * no markers were present).
 *
 * Pure string transform — does not touch the filesystem. Callers persist.
 *
 * @param {string} content
 * @param {{ wasGeneratedBy: string|null, wasDerivedFrom: string[] }} lineage
 * @returns {string}
 */
export function stampLineageContent(content, lineage) {
  const markers = renderMarkers(lineage);
  const lines = content.split('\n');

  // Remove any existing lineage markers (anywhere in the header region or body —
  // they are only ever ours), preserving everything else.
  const kept = lines.filter((line) => !MARKER_RE.test(line.trim()));

  if (markers.length === 0) return kept.join('\n');

  // Insert markers directly after a leading `<!-- phase: -->` marker if present,
  // otherwise at the very top, so all lineage lives together in the header.
  let insertAt = 0;
  if (kept[0] && /^<!--\s*phase:/.test(kept[0].trim())) insertAt = 1;
  kept.splice(insertAt, 0, ...markers);
  return kept.join('\n');
}

/**
 * Stamp PROV-O lineage markers onto every existing canonical artifact in a
 * feature folder, on disk. Effective lineage comes from `lineageOf`, so any
 * hand-authored marker override is preserved (re-written identically, no diff).
 * Idempotent: running twice makes no second change.
 *
 * This is the "lifecycle writer" surface — the point at which lineage markers
 * are materialised into artifacts during the lifecycle (invoked by
 * `compose lineage stamp`).
 *
 * @param {string} featureDir
 * @returns {Array<{ file: string, changed: boolean, wasGeneratedBy: string|null, wasDerivedFrom: string[] }>}
 */
export function stampFeatureLineage(featureDir) {
  const existing = CHAIN_FILES.filter((f) => existsSync(join(featureDir, f)));
  const out = [];
  for (const file of existing) {
    const filePath = join(featureDir, file);
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const lin = lineageOf(featureDir, file, existing);
    const next = stampLineageContent(content, lin);
    const changed = next !== content;
    if (changed) {
      // Stamping lineage markers is a metadata annotation, NOT a regeneration of
      // the artifact — it must not reset the mtime that findStaleDescendants uses
      // as the derivation clock, or a retrofit stamp would erase existing
      // staleness. Preserve the original mtime across the write.
      let mtime = null;
      try {
        mtime = statSync(filePath).mtime;
      } catch { /* no prior stat — leave mtime as written */ }
      writeFileSync(filePath, next);
      if (mtime) {
        try {
          utimesSync(filePath, mtime, mtime);
        } catch { /* best effort */ }
      }
    }
    out.push({
      file,
      changed,
      wasGeneratedBy: lin.wasGeneratedBy,
      wasDerivedFrom: lin.wasDerivedFrom,
    });
  }
  return out;
}
