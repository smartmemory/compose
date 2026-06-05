#!/usr/bin/env node
/**
 * backproject-vision-status.mjs — one-time back-projection of historical
 * vision-state status drift (COMP-MCP-VALIDATE-3).
 *
 * The typed writers now project status onto vision-state on every transition,
 * but historical vision-state was never reconciled. This script projects the
 * canonical feature.json status onto each bound vision item, clearing the
 * pre-existing STATUS_MISMATCH_*_VS_VISION_STATE findings the write-time hook
 * cannot reach (they predate any new mutation).
 *
 * Idempotent: a second run stages zero changes. Dry-run by default; pass
 * --apply to write. Operates on the project root (default: process.cwd()),
 * NOT compose's own data/.
 *
 *   node scripts/backproject-vision-status.mjs            # dry-run, cwd
 *   node scripts/backproject-vision-status.mjs --apply    # write
 *   node scripts/backproject-vision-status.mjs --root /path/to/project --apply
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { loadFeaturesDir } from '../lib/project-paths.js';
import { featureStatusToVisionStatus } from '../lib/status-projection.js';

/**
 * Compute (and optionally apply) the back-projection for one project root.
 *
 * @param {object} opts
 * @param {string} opts.root   Project root containing .compose/data + features dir.
 * @param {boolean} [opts.apply=false]  Write the reconciled state when true.
 * @returns {{changes: Array<{code:string, id:string, from:string|null, to:string}>,
 *           skipped: number, total: number, applied: boolean}}
 */
export function backprojectVisionStatus({ root, apply = false }) {
  const visionPath = join(root, '.compose', 'data', 'vision-state.json');
  if (!existsSync(visionPath)) {
    return { changes: [], skipped: 0, total: 0, applied: false };
  }
  const state = JSON.parse(readFileSync(visionPath, 'utf-8'));
  const items = Array.isArray(state.items) ? state.items : [];
  const featuresDir = join(root, loadFeaturesDir(root));

  const changes = [];
  let skipped = 0;
  for (const item of items) {
    const code = item.lifecycle?.featureCode || item.featureCode;
    if (!code) { skipped++; continue; }
    const fjPath = join(featuresDir, code, 'feature.json');
    if (!existsSync(fjPath)) { skipped++; continue; } // UI-only / external items
    let feature;
    try {
      feature = JSON.parse(readFileSync(fjPath, 'utf-8'));
    } catch {
      skipped++; continue;
    }
    const target = featureStatusToVisionStatus(feature.status);
    if (!target) { skipped++; continue; }
    if (item.status !== target) {
      changes.push({ code, id: item.id, from: item.status ?? null, to: target });
      item.status = target;
    }
  }

  if (apply && changes.length > 0) {
    const tmp = `${visionPath}.tmp.${crypto.randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    renameSync(tmp, visionPath);
  }

  return { changes, skipped, total: items.length, applied: apply && changes.length > 0 };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx !== -1 ? argv[rootIdx + 1] : process.cwd();

  const { changes, skipped, total, applied } = backprojectVisionStatus({ root, apply });

  console.log(`Back-projection — ${total} vision items, ${skipped} skipped (no bound feature.json).`);
  if (changes.length === 0) {
    console.log('No drift. vision-state already matches canonical feature.json status.');
  } else {
    console.log(`${changes.length} item(s) ${applied ? 'reconciled' : 'would change'}:`);
    for (const c of changes) {
      console.log(`  ${c.code.padEnd(28)} ${String(c.from).padEnd(12)} → ${c.to}`);
    }
    if (!applied) console.log('\nDry-run. Re-run with --apply to write.');
  }
}
