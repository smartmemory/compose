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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const RECORDS_REL = 'docs/judgment/records';
// The manifest lives OUTSIDE `docs/judgment/**` entirely, so no deletion of the
// canon can also delete the baseline that would expose the deletion (R4
// fail-closed). Two review findings and one earlier fix converge here: a
// baseline stored inside the tree it attests dies with that tree and reads as a
// false GREEN. `.compose/` is git-tracked (only `.compose/data/` is ignored), so
// this location is BOTH committed — a fresh clone can verify — and immune to
// `rm -rf docs/judgment`. A wiped canon now surfaces every record as `removed`
// drift; a genuinely fresh repo (no canon, no manifest) stays green.
const MANIFEST_REL = '.compose/judgment-attest.json';

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

/**
 * Synchronize the manifest for touched records under an absolute workspace
 * root. Path entries may be absolute filesystem paths or repo-relative POSIX
 * paths; non-record paths are ignored.
 */
export function syncManifest(cwd, paths) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    const error = new TypeError(
      'syncManifest contract violation: cwd must be an absolute workspace path',
    );
    error.code = 'JUDGMENT_ATTEST_CWD_ABSOLUTE';
    throw error;
  }

  const cwdAbs = resolve(cwd);
  const recordPaths = new Map();

  for (const path of paths) {
    if (typeof path !== 'string') continue;
    const absPath = resolve(cwdAbs, path);
    const nativeRelPath = relative(cwdAbs, absPath);
    if (
      nativeRelPath === ''
      || nativeRelPath === '..'
      || nativeRelPath.startsWith(`..${sep}`)
      || isAbsolute(nativeRelPath)
    ) {
      continue;
    }

    const relPath = nativeRelPath.split(sep).join('/');
    if (!relPath.startsWith(`${RECORDS_REL}/`)) continue;
    recordPaths.set(relPath, absPath);
  }

  for (const [relPath, absPath] of recordPaths) {
    if (existsSync(absPath)) stampRecord(cwdAbs, relPath);
    else removeRecord(cwdAbs, relPath);
  }
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
