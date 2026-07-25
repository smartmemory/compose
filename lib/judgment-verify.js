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

import { readManifest, recordFileSet, verifyRecords } from './judgment-attest.js';
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
// The legitimate depth-1 dirs under records/. Anything else there (e.g. a
// Bash-created `records/garbage/`) is drift. Deeper legitimate dirs — such as
// `records/positions/<slug>/` — are admitted by expectedTree's parent-walk over
// the real record files, so this list stays exact rather than blanket-exempting
// every nested path.
const RECORD_STRUCTURAL_DIRS = [
  'goal', 'intents', 'joints', 'people', 'positions', 'predictions', 'situation',
].map((name) => `${RECORDS_REL}/${name}`);

function expectedTree(cwd) {
  // Derive the expected projection set from the SAME snapshot builder that
  // checkProjectionRoundtrip uses (loadSnapshot, exported from judgment-gen).
  // Reconstructing it here would be a mirror that silently diverges into false
  // tree drift the moment loadSnapshot changes.
  const projections = Object.keys(generateFromRecords(loadSnapshot(cwd)));
  const records = recordFileSet(cwd);
  // The manifest is NOT in this set: it lives at .compose/judgment-attest.json,
  // outside the tree being inventoried.
  const files = new Set([...projections, ...records]);
  const directories = new Set([JUDGMENT_REL, ...STRUCTURAL_DIRS, ...RECORD_STRUCTURAL_DIRS]);

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
        // An EMPTY unexpected dir is not reported: it holds no canon, and
        // UndoLog.restore unlinks files without removing their directories, so a
        // rolled-back op legitimately leaves e.g. an empty positions/<slug>/.
        // Flagging those would false-RED on correct behaviour. A non-empty stray
        // dir is still caught — every file inside it fails the file rule below.
        if (!expected.directories.has(relPath) && readdirSync(absPath).length > 0) {
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

/**
 * True when this project has no judgment canon at all — no `docs/judgment/`
 * tree and no attestation baseline. There is nothing to verify, so verification
 * must pass: most Compose projects never adopt the judgment layer, and a
 * gate that fails them would break every pre-push and ship in those repos.
 *
 * This is NOT the same as a deleted canon. The baseline lives outside
 * `docs/judgment/**` (at `.compose/judgment-attest.json`), so wiping the canon
 * leaves the manifest behind — `hasNoCanon` is false and every record it
 * remembers surfaces as `removed` drift.
 */
function hasNoCanon(cwd) {
  return !existsSync(join(cwd, ...JUDGMENT_REL.split('/')))
    && readManifest(cwd) === null;
}

export async function verifyJudgmentCanon(cwd) {
  return withJudgmentLock(cwd, async () => {
    if (hasNoCanon(cwd)) {
      return { ok: true, treeDrift: [], projectionDrift: [], recordDrift: [] };
    }

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
