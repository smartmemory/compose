#!/usr/bin/env node
/**
 * One-shot: backfill `group` field into every docs/features/<code>/feature.json
 * using the current deriveGroup() rule (first-2-tokens after stripping numeric
 * suffixes). Idempotent — skips files that already have a `group` field.
 *
 * Usage: node bin/backfill-feature-groups.js [features-dir]
 */
import fs from 'node:fs';
import path from 'node:path';

const CODE_PREFIX_RE = /^([A-Z][A-Z0-9-]*)/;
function deriveGroup(code) {
  const m = code.match(CODE_PREFIX_RE);
  if (!m) return null;
  const stripped = m[1].replace(/(?:-\d+)+$/, '');
  const tokens = stripped.split('-').filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.slice(0, 2).join('-');
}

const featuresDir = process.argv[2] || path.resolve('docs/features');
if (!fs.existsSync(featuresDir)) {
  console.error(`No features dir: ${featuresDir}`);
  process.exit(1);
}

let updated = 0, skipped = 0, missing = 0;
for (const entry of fs.readdirSync(featuresDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const specPath = path.join(featuresDir, entry.name, 'feature.json');
  if (!fs.existsSync(specPath)) { missing++; continue; }
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')); } catch { missing++; continue; }
  if (typeof spec.group === 'string' && spec.group.trim()) { skipped++; continue; }
  const code = spec.code || entry.name;
  const group = deriveGroup(code);
  if (!group) { skipped++; continue; }
  spec.group = group;
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`  ${entry.name} → ${group}`);
  updated++;
}
console.log(`\nBackfilled ${updated} files. Skipped ${skipped}. Missing/malformed ${missing}.`);
