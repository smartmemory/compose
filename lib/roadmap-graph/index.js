/**
 * index.js — public API for the roadmap dependency graph generator
 * (COMP-ROADMAP-GRAPH-1).
 *
 *   generateRoadmapGraph(cwd, opts) — render + atomic-write the HTML
 *   checkRoadmapGraph(cwd, opts)    — render in-memory, diff vs on-disk
 *
 * Both throw DanglingEdgeError (code DANGLING_EDGE) when an edge points at an
 * unknown feature — the Cytoscape-crash bug class this feature kills.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { resolveFeaturesPath } from '../project-paths.js';
import { collectGraphInputs } from './collect.js';
import { buildGraph } from './model.js';
import { renderGraphHtml } from './render.js';
import { loadGraphConfig } from './config.js';

/**
 * Build the HTML + graph stats for a project without writing to disk.
 * @param {string} cwd
 * @returns {{ html: string, nodes: object[], edges: object[], dropped: string[], warnings: string[], config: object }}
 */
export function buildRoadmapGraph(cwd) {
  const featuresDir = resolveFeaturesPath(cwd);
  const inputs = collectGraphInputs(cwd, featuresDir);
  const graph = buildGraph(inputs); // throws DanglingEdgeError
  const config = loadGraphConfig(cwd);
  const html = renderGraphHtml({ nodes: graph.nodes, edges: graph.edges, config });
  return { html, nodes: graph.nodes, edges: graph.edges, dropped: graph.dropped, warnings: inputs.warnings, config };
}

/**
 * Generate and atomically write roadmap-graph.html.
 * @param {string} cwd project root
 * @param {{ out?: string }} [opts] out path (relative to cwd unless absolute); defaults to config.out
 * @returns {{ path: string, nodeCount: number, edgeCount: number, droppedCount: number, warnings: string[] }}
 */
export function generateRoadmapGraph(cwd, opts = {}) {
  const built = buildRoadmapGraph(cwd);
  const outRel = opts.out || built.config.out;
  const outPath = isAbsolute(outRel) ? outRel : join(cwd, outRel);
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
 * Render in-memory and compare to the on-disk file.
 * @param {string} cwd
 * @param {{ out?: string }} [opts]
 * @returns {{ matches: boolean, path: string, exists: boolean, diffSummary: string, nodeCount: number, edgeCount: number, warnings: string[] }}
 */
export function checkRoadmapGraph(cwd, opts = {}) {
  const built = buildRoadmapGraph(cwd);
  const outRel = opts.out || built.config.out;
  const outPath = isAbsolute(outRel) ? outRel : join(cwd, outRel);
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
