/**
 * roadmap-graph-vision.js — COMP-ROADMAP-GRAPH-2 S4.
 *
 * The CANONICAL projection of the one graph model: build the roadmap graph from
 * a freshly, deterministically seeded vision store (committed source only — no
 * persisted cockpit state), through the same adapter + renderer the live
 * cockpit export uses. This is what the headless CLI / MCP / CI call.
 *
 * Lives in server/ (not lib/) because it depends on the vision store + seed,
 * which are server-side; it reuses the pure render/write/check helpers from
 * lib/roadmap-graph/index.js. This is the seam that lets us retire collect.js.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VisionStore } from './vision-store.js';
import { scanFeatures, seedFeatures } from './feature-scan.js';
import { resolveFeaturesPath, resolveRoadmapPath, loadExternalPrefixes } from '../lib/project-paths.js';
import { parseRoadmap } from '../lib/roadmap-parser.js';
import { visionToGraphInputs } from '../lib/roadmap-graph/vision-adapter.js';
import { depsToEdges, DanglingEdgeError } from '../lib/roadmap-graph/model.js';
import { buildArtifactFromInputs, writeArtifact, checkArtifact } from '../lib/roadmap-graph/index.js';

// ROADMAP/feature UPPERCASE status -> vision status. The vision vocab has no
// `partial`; PARTIAL collapses to in_progress (documented delta — the adapter
// maps it back to IN_PROGRESS, so a PARTIAL feature renders as in_progress in
// the canonical graph rather than the static path's `partial` border).
const ROADMAP_TO_VISION_STATUS = {
  PLANNED: 'planned',
  IN_PROGRESS: 'in_progress',
  PARTIAL: 'in_progress',
  COMPLETE: 'complete',
  BLOCKED: 'blocked',
  PARKED: 'parked',
  KILLED: 'killed',
  SUPERSEDED: 'superseded',
};

function toVisionStatus(status) {
  return ROADMAP_TO_VISION_STATUS[String(status || 'PLANNED').toUpperCase()] || 'planned';
}

/**
 * Seed ROADMAP.md rows that lack a feature folder as fallback feature items,
 * mirroring collect.js section (b) so the node universe matches.
 */
function seedRoadmapFallback(store, cwd, externalPrefixes) {
  const roadmapPath = resolveRoadmapPath(cwd);
  if (!existsSync(roadmapPath)) return;
  const isExternal = (code) => externalPrefixes.some((p) => code.startsWith(p));
  const have = new Set(
    [...store.items.values()]
      .filter((i) => i.type === 'feature')
      .map((i) => i.lifecycle?.featureCode || i.title),
  );
  let entries = [];
  try { entries = parseRoadmap(readFileSync(roadmapPath, 'utf-8')); } catch { return; }
  for (const e of entries) {
    if (!e.code || e.code.startsWith('_anon_')) continue;
    if (have.has(e.code) || isExternal(e.code)) continue;
    const item = store.createItem({
      type: 'feature',
      title: e.code,
      description: e.description || '',
      status: toVisionStatus(e.status),
      phase: 'planning',
      confidence: 0,
      group: 'standalone',
    });
    try { store.updateLifecycle(item.id, { featureCode: e.code, currentPhase: 'explore_design' }); } catch { /* optional */ }
    have.add(e.code);
  }
}

/**
 * Build the canonical graph inputs from committed source via a throwaway store.
 * @param {string} cwd
 * @returns {{ nodes, rawEdges, knownCodes, warnings }}
 */
export function collectVisionInputs(cwd) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rg2-canonical-'));
  try {
    const store = new VisionStore(dataDir);
    const featuresDir = resolveFeaturesPath(cwd);
    const externalPrefixes = loadExternalPrefixes(cwd);
    // Canon: only feature.json-backed folders are managed features (mirrors
    // collect.js's listFeatures universe — doc-only folders are not nodes).
    const features = scanFeatures(featuresDir).filter((f) => f.hasFeatureJson);
    seedFeatures(features, store);
    seedRoadmapFallback(store, cwd, externalPrefixes);

    // Preserve the dangling-edge refusal (the anti-typo lint kept from the
    // static path). A deps.yaml edge to a code that resolves to no managed
    // feature and isn't an external reference can't become a connection, so it
    // would silently vanish; detect + refuse instead, mirroring collect.js.
    const isExternal = (code) => externalPrefixes.some((p) => code.startsWith(p));
    const known = new Set(
      [...store.items.values()]
        .filter((i) => i.type === 'feature')
        .map((i) => i.lifecycle?.featureCode || i.title),
    );
    const dangling = [];
    for (const f of features) {
      if (!f.deps) continue;
      for (const e of depsToEdges(f.name, f.deps)) {
        const missing = [e.from, e.to].filter((c) => !known.has(c) && !isExternal(c));
        if (missing.length) dangling.push({ from: e.from, to: e.to, kind: e.type, missing });
      }
    }
    if (dangling.length) throw new DanglingEdgeError(dangling);

    return visionToGraphInputs(
      [...store.items.values()],
      [...store.connections.values()],
      { externalPrefixes, includeProseEdges: false },
    );
  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Build HTML + stats from the canonical vision projection (no disk write). */
export function buildRoadmapGraph(cwd) {
  return buildArtifactFromInputs(cwd, collectVisionInputs(cwd));
}

/** Generate + atomically write roadmap-graph.html from the canonical projection. */
export function generateRoadmapGraph(cwd, opts = {}) {
  return writeArtifact(cwd, buildRoadmapGraph(cwd), opts);
}

/** Render in-memory and diff vs on-disk, from the canonical projection. */
export function checkRoadmapGraph(cwd, opts = {}) {
  return checkArtifact(cwd, buildRoadmapGraph(cwd), opts);
}

export { DanglingEdgeError };
