/**
 * Combined drift verification for the judgment canon.
 *
 * The inventory, projection roundtrip, and record attestation are evaluated
 * under the writer's advisory lock so a legitimate write cannot expose a
 * partially-published canon to the verifier.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join, posix } from 'node:path';

import { recordFileSet, verifyRecords } from './judgment-attest.js';
import {
  checkProjectionRoundtrip,
  generateFromRecords,
  loadSnapshot,
} from './judgment-gen.js';
import { withJudgmentLock } from './judgment-writer.js';

const JUDGMENT_REL = 'docs/judgment';
const MANIFEST_REL = `${JUDGMENT_REL}/.attest.json`;
const RECORDS_REL = `${JUDGMENT_REL}/records`;
const STRUCTURAL_DIRS = [
  RECORDS_REL,
  `${JUDGMENT_REL}/people`,
  `${JUDGMENT_REL}/positions`,
];

function expectedTree(cwd) {
  // Derive the expected projection set from the SAME snapshot builder that
  // checkProjectionRoundtrip uses (loadSnapshot, exported from judgment-gen).
  // Reconstructing it here would be a mirror that silently diverges into false
  // tree drift the moment loadSnapshot changes.
  const projections = Object.keys(generateFromRecords(loadSnapshot(cwd)));
  const records = recordFileSet(cwd);
  const files = new Set([...projections, ...records, MANIFEST_REL]);
  const directories = new Set([JUDGMENT_REL, ...STRUCTURAL_DIRS]);

  for (const relPath of files) {
    let parent = posix.dirname(relPath);
    while (parent.startsWith(`${JUDGMENT_REL}/`)) {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
  }

  return { files, directories };
}

function inventoryTree(cwd, expected) {
  const root = join(cwd, ...JUDGMENT_REL.split('/'));
  if (!existsSync(root)) return [];

  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    return [{ path: JUDGMENT_REL, kind: 'symlink' }];
  }
  if (!rootStat.isDirectory()) {
    return [{ path: JUDGMENT_REL, kind: 'unexpected' }];
  }

  const drift = [];

  function walk(absDir, relDir) {
    const entries = readdirSync(absDir)
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

    for (const name of entries) {
      const absPath = join(absDir, name);
      const relPath = `${relDir}/${name}`;
      const stat = lstatSync(absPath);

      if (stat.isSymbolicLink()) {
        drift.push({ path: relPath, kind: 'symlink' });
        continue;
      }

      if (stat.isDirectory()) {
        const isRecordsSubdir = relPath.startsWith(`${RECORDS_REL}/`);
        if (!expected.directories.has(relPath) && !isRecordsSubdir) {
          drift.push({ path: relPath, kind: 'unexpected' });
        }
        walk(absPath, relPath);
        continue;
      }

      if (!stat.isFile() || !expected.files.has(relPath)) {
        drift.push({ path: relPath, kind: 'unexpected' });
      }
    }
  }

  walk(root, JUDGMENT_REL);
  drift.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
  return drift;
}

export async function verifyJudgmentCanon(cwd) {
  return withJudgmentLock(cwd, async () => {
    const treeDrift = inventoryTree(cwd, expectedTree(cwd));
    const projection = checkProjectionRoundtrip(cwd);
    const records = verifyRecords(cwd);
    const projectionDrift = projection.diffs;
    const recordDrift = records.drift;

    return {
      ok: treeDrift.length === 0 && projection.fixedPoint && records.ok,
      treeDrift,
      projectionDrift,
      recordDrift,
    };
  });
}
