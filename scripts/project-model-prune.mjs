#!/usr/bin/env node
/**
 * project-model-prune.mjs — COMP-COCKPIT-PROJECT-MODEL-1 Q1 (owner 2026-11-01: "keep the 77 parent items, can we
 * delete the drifted copies?").
 *
 * Deletes from a project ROOT store the items whose feature code one of its configured module stores
 * (`project.modules`) also holds. The module store is the truth. Dry run by default: prints the plan.
 *
 *   node scripts/project-model-prune.mjs <projectRoot> [--write --backup <file>]
 *
 * --write copies the store to <file> first (refusing when <file> exists), then deletes each `remove` item through
 * VisionStore.deleteItem, the store's own delete (which drops the item's edges and gates and throws when the save
 * fails). An item in `hold` carries a gate or an edge no module copy has: it is not deleted and is listed with why.
 * Refuses the live server's active project (its in-memory store would write the items back). Docs folders are never
 * touched: only store items go. Prints one JSON line.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { VisionStore } from '../server/vision-store.js';
import { planRootPrune, readProject } from '../server/project-model.js';

async function liveActiveRoot() {
  const port = process.env.PORT || '4001';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/project`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).targetRoot || null;
  } catch { return null; }
}

const load = (dir) => JSON.parse(readFileSync(join(dir, '.compose', 'data', 'vision-state.json'), 'utf8'));
const codesIn = (st) => new Set((st.items ?? []).map((i) => i?.lifecycle?.featureCode ?? i?.featureCode).filter(Boolean));

async function main(argv) {
  const rootArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--backup');
  const write = argv.includes('--write');
  const backup = argv.includes('--backup') ? argv[argv.indexOf('--backup') + 1] : null;
  if (!rootArg) { console.error('usage: project-model-prune.mjs <projectRoot> [--write --backup <file>]'); return 2; }
  const project = readProject(resolve(rootArg));
  if (project.errors.length) { console.error(`refusing: ${project.errors.join('; ')}`); return 2; }
  const mods = project.modules.filter((m) => m.hasStore && !m.error);
  if (!project.hasStore || !mods.length) { console.error('refusing: the root has no store or no module with a store'); return 2; }
  const rootState = load(project.root);
  const plan = planRootPrune(rootState, Object.fromEntries(mods.map((m) => [m.name, load(m.realpath)])));
  const out = {
    root: project.root, write, before: { items: rootState.items.length, codes: codesIn(rootState).size },
    remove: plan.remove.length, hold: plan.hold.length, rootOnly: plan.rootOnly,
    removeCodes: plan.remove.map((r) => r.code).sort(), holdItems: plan.hold.map((h) => ({ code: h.code, reasons: h.reasons })),
  };
  if (write) {
    if (!backup) { console.error('refusing: --write needs --backup <file>'); return 2; }
    if (existsSync(backup)) { console.error(`refusing: backup ${backup} already exists`); return 2; }
    const active = await liveActiveRoot();
    if (active && resolve(active) === project.root) { console.error(`refusing: ${project.root} is the live server's active project`); return 3; }
    const storeFile = join(project.root, '.compose', 'data', 'vision-state.json');
    copyFileSync(storeFile, backup);
    const store = new VisionStore(join(project.root, '.compose', 'data'));
    for (const r of plan.remove) store.deleteItem(r.id);
    const after = load(project.root);
    out.backup = backup;
    out.after = { items: after.items.length, codes: codesIn(after).size };
  }
  console.log(JSON.stringify(out));
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
