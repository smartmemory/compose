/**
 * index.js — shared render/write/check helpers for the roadmap dependency
 * graph (COMP-ROADMAP-GRAPH-1 renderer; COMP-ROADMAP-GRAPH-2 made it
 * source-agnostic). The collection of inputs lives with the caller — today the
 * sole collector is the vision projection in server/roadmap-graph-vision.js.
 *
 *   buildArtifactFromInputs(cwd, inputs) — buildGraph + render (no write)
 *   writeArtifact(cwd, built, opts)      — atomic-write the HTML
 *   checkArtifact(cwd, built, opts)      — diff vs on-disk
 *
 * buildGraph throws DanglingEdgeError (code DANGLING_EDGE) when an edge points
 * at an unknown feature — the Cytoscape-crash bug class this feature kills.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { buildGraph } from './model.js';
import { renderGraphHtml } from './render.js';
import { loadGraphConfig } from './config.js';

/**
 * Build the HTML + stats from already-collected graph inputs. The inputs may
 * come from any collector (the static feature.json/deps.yaml path, or the
 * vision-store canonical projection) — this is the single render seam.
 * @param {string} cwd
 * @param {{ nodes: object[], rawEdges: object[], knownCodes: Set<string>, warnings?: string[] }} inputs
 */
export function buildArtifactFromInputs(cwd, inputs) {
  const graph = buildGraph(inputs); // throws DanglingEdgeError
  const config = loadGraphConfig(cwd);
  const html = renderGraphHtml({ nodes: graph.nodes, edges: graph.edges, config });
  return { html, nodes: graph.nodes, edges: graph.edges, dropped: graph.dropped, warnings: inputs.warnings || [], config };
}

function resolveOutPath(cwd, built, opts) {
  const outRel = opts.out || built.config.out;
  return isAbsolute(outRel) ? outRel : join(cwd, outRel);
}

/**
 * Atomically write a built artifact's HTML and return the summary.
 * @returns {{ path: string, nodeCount: number, edgeCount: number, droppedCount: number, warnings: string[] }}
 */
export function writeArtifact(cwd, built, opts = {}) {
  const outPath = resolveOutPath(cwd, built, opts);
  atomicWrite(outPath, built.html);
  return {
    path: outPath,
    nodeCount: built.nodes.length,
    edgeCount: built.edges.length,
    droppedCount: built.dropped.length,
    warnings: built.warnings,
  };
}

/**
 * Compare a built artifact's HTML to the on-disk file.
 * @returns {{ matches: boolean, path: string, exists: boolean, diffSummary: string, nodeCount: number, edgeCount: number, warnings: string[] }}
 */
export function checkArtifact(cwd, built, opts = {}) {
  const outPath = resolveOutPath(cwd, built, opts);
  const exists = existsSync(outPath);
  const onDisk = exists ? readFileSync(outPath, 'utf-8') : null;
  const matches = exists && onDisk === built.html;
  let diffSummary = '';
  if (!exists) diffSummary = `missing: ${outPath} not generated yet`;
  else if (!matches) diffSummary = `stale: ${outPath} differs from regenerated output (run \`compose roadmap graph\`)`;
  return {
    matches,
    path: outPath,
    exists,
    diffSummary,
    nodeCount: built.nodes.length,
    edgeCount: built.edges.length,
    warnings: built.warnings,
  };
}

function atomicWrite(outPath, content) {
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${outPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, outPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

export { DanglingEdgeError } from './model.js';
