#!/usr/bin/env node
/**
 * roadmap-rescan.mjs — COMP-ROADMAP-GRAPH-EDGES-1.
 *
 * Rescan ONE project's features into its own vision store
 * (`<root>/.compose/data/vision-state.json`), the same seed the server runs when
 * it prepares a workspace (workspace-runtime.js `prepare` -> reseed), without
 * switching the live cockpit's active project.
 *
 *   node scripts/roadmap-rescan.mjs <projectRoot> [--dry-run]
 *
 * Refuses the project the live server has active: that store is owned by the
 * running server, which reseeds itself when a feature file changes. --dry-run
 * seeds a temp copy of the store and prints the counts without writing.
 * Prints one JSON line: {root, store, before, after}.
 */
import { existsSync, mkdtempSync, copyFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { prepareProject, withProjectContext } from '../server/project-root.js';
import { VisionStore } from '../server/vision-store.js';
import { scanFeatures, seedFeatures, scanSubPackages, seedSubPackages } from '../server/feature-scan.js';

export function storeCounts(file) {
  if (!existsSync(file)) return { present: false };
  const state = JSON.parse(readFileSync(file, 'utf-8'));
  const items = Object.values(state.items || {});
  const conns = Object.values(state.connections || {});
  const byType = (t) => conns.filter((c) => c.type === t).length;
  return {
    present: true,
    mtime: statSync(file).mtime.toISOString(),
    features: items.filter((i) => i.type === 'feature').length,
    blocks: byType('blocks'),
    informs: byType('informs'),
    supports: byType('supports'),
  };
}

async function liveActiveRoot() {
  const port = process.env.PORT || '4001';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/project`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).targetRoot || null;
  } catch { return null; } // no server: nothing owns the store
}

async function main(argv) {
  const root = argv.find((a) => !a.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  if (!root) { console.error('usage: roadmap-rescan.mjs <projectRoot> [--dry-run]'); return 2; }
  const target = resolve(root);
  if (!existsSync(join(target, '.compose'))) {
    console.error(`refusing: ${target} has no .compose directory (not a Compose project)`);
    return 2;
  }
  const active = await liveActiveRoot();
  if (!dryRun && active && resolve(active) === target) {
    console.error(`refusing: ${target} is the live server's active project; it reseeds itself on feature changes`);
    return 3;
  }

  const binding = prepareProject(target);
  const storeFile = join(binding.dataDir, 'vision-state.json');
  const before = storeCounts(storeFile);
  let dataDir = binding.dataDir;
  if (dryRun) {
    dataDir = mkdtempSync(join(tmpdir(), 'roadmap-rescan-'));
    if (existsSync(storeFile)) copyFileSync(storeFile, join(dataDir, 'vision-state.json'));
  }
  try {
    withProjectContext({ ...binding, dataDir }, () => {
      const store = new VisionStore(dataDir);
      seedFeatures(scanFeatures(), store);
      seedSubPackages(scanSubPackages(), store);
    });
    const after = storeCounts(join(dataDir, 'vision-state.json'));
    console.log(JSON.stringify({ root: target, store: storeFile, dryRun, before, after }));
  } finally {
    if (dryRun) rmSync(dataDir, { recursive: true, force: true });
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
