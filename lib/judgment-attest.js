import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const RECORDS_REL = 'docs/judgment/records';
// The manifest lives OUTSIDE the records dir it attests, so that an accidental
// `rm -rf docs/judgment/records` cannot delete the canon and its baseline
// together (which would read as a false GREEN — violating R4 fail-closed).
// With the baseline surviving, a wiped records dir surfaces every entry as
// `removed` drift. A genuinely fresh repo (no manifest, no records) stays green.
const MANIFEST_REL = 'docs/judgment/.attest.json';

function absolutePath(cwd, relPath) {
  return join(cwd, ...relPath.split('/'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inspectRecord(cwd, relPath) {
  const bytes = readFileSync(absolutePath(cwd, relPath));
  let malformed = false;

  if (relPath.endsWith('.json')) {
    try {
      JSON.parse(bytes.toString('utf8'));
    } catch {
      malformed = true;
    }
  }

  return { hash: sha256(bytes), malformed };
}

function malformedRecordError(relPath) {
  const error = new SyntaxError(`Malformed JSON judgment record: ${relPath}`);
  error.code = 'JUDGMENT_RECORD_MALFORMED';
  error.path = relPath;
  error.kind = 'malformed';
  return error;
}

export function recordFileSet(cwd) {
  const recordsRoot = absolutePath(cwd, RECORDS_REL);
  if (!existsSync(recordsRoot)) return [];

  const paths = [];

  function walk(absDir, relDir) {
    const entries = readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile() && basename(relPath) !== '.attest.json') {
        paths.push(relPath);
      }
    }
  }

  walk(recordsRoot, RECORDS_REL);
  return paths.sort();
}

export function computeRecordHashes(cwd) {
  const hashes = {};

  for (const relPath of recordFileSet(cwd)) {
    const record = inspectRecord(cwd, relPath);
    if (record.malformed) throw malformedRecordError(relPath);
    hashes[relPath] = record.hash;
  }

  return hashes;
}

export function readManifest(cwd) {
  const manifestPath = absolutePath(cwd, MANIFEST_REL);
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeManifest(cwd, hashes) {
  const manifestPath = absolutePath(cwd, MANIFEST_REL);
  mkdirSync(dirname(manifestPath), { recursive: true });

  const sortedHashes = {};
  for (const relPath of Object.keys(hashes).sort()) {
    sortedHashes[relPath] = hashes[relPath];
  }

  const tempPath = `${manifestPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(sortedHashes, null, 2)}\n`);
    renameSync(tempPath, manifestPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may not exist or may already have been renamed.
    }
    throw error;
  }
}

export function stampRecord(cwd, relPath) {
  const record = inspectRecord(cwd, relPath);
  if (record.malformed) throw malformedRecordError(relPath);

  const hashes = readManifest(cwd) ?? {};
  hashes[relPath] = record.hash;
  writeManifest(cwd, hashes);
}

export function removeRecord(cwd, relPath) {
  const hashes = readManifest(cwd) ?? {};
  delete hashes[relPath];
  writeManifest(cwd, hashes);
}

export function verifyRecords(cwd) {
  const manifest = readManifest(cwd) ?? {};
  const currentPaths = recordFileSet(cwd);
  const currentPathSet = new Set(currentPaths);
  const drift = [];

  for (const relPath of Object.keys(manifest)) {
    if (!currentPathSet.has(relPath)) {
      drift.push({ path: relPath, kind: 'removed' });
    }
  }

  for (const relPath of currentPaths) {
    const record = inspectRecord(cwd, relPath);
    if (record.malformed) {
      drift.push({ path: relPath, kind: 'malformed' });
    } else if (!Object.hasOwn(manifest, relPath)) {
      drift.push({ path: relPath, kind: 'added' });
    } else if (manifest[relPath] !== record.hash) {
      drift.push({ path: relPath, kind: 'modified' });
    }
  }

  drift.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  return { ok: drift.length === 0, drift };
}
