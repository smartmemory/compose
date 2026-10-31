#!/usr/bin/env node
/**
 * roadmap-deps-gen.mjs — COMP-ROADMAP-GRAPH-EDGES-1.
 *
 * Infer `depends_on` edges for one project (lib/roadmap-graph/deps-gen.js) and
 * write them into each feature's deps.yaml. Deterministic and idempotent: a
 * second run with no source change writes nothing.
 *
 *   node scripts/roadmap-deps-gen.mjs <projectRoot> [--write] [--edges <file.jsonl>]
 *
 * Without --write it prints what would change. --edges writes every placed edge
 * (from, to, source, where, file) as JSON lines for auditing.
 * Prints one JSON summary line.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveFeaturesPath, resolveRoadmapPath, loadExternalPrefixes } from '../lib/project-paths.js';
import { planProject, applyWrites } from '../lib/roadmap-graph/deps-gen.js';

const argv = process.argv.slice(2);
const root = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--edges');
if (!root) {
  console.error('usage: roadmap-deps-gen.mjs <projectRoot> [--write] [--edges <file.jsonl>]');
  process.exit(2);
}
const cwd = resolve(root);
const plan = planProject({
  root: cwd,
  featuresDir: resolveFeaturesPath(cwd),
  roadmapPath: resolveRoadmapPath(cwd),
  externalPrefixes: loadExternalPrefixes(cwd),
});
const edgesAt = argv.indexOf('--edges');
if (edgesAt !== -1) writeFileSync(argv[edgesAt + 1], plan.placed.map((e) => JSON.stringify(e)).join('\n') + '\n');
if (argv.includes('--write')) applyWrites(plan.writes);

const bySource = {};
for (const e of plan.placed) bySource[e.source] = (bySource[e.source] || 0) + 1;
console.log(JSON.stringify({
  root: cwd,
  write: argv.includes('--write'),
  folders: plan.folders,
  roadmapRows: plan.roadmapRows,
  hand: plan.handCount,
  placed: plan.placed.length,
  bySource,
  dropped: Object.fromEntries(Object.entries(plan.dropped).map(([k, v]) => [k, v.length])),
  files: plan.writes.length,
}));
