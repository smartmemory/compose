import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { loadFeaturesDir } from './project-paths.js';
import { getMode } from './lifecycle-modes.js';
import { guardPolicy, guardList } from '../server/stratum-client.js';
import { resourceId } from '../server/lifecycle-guard.js';
import { HINT_ENROL } from './guard-custody.js';

const POLICY_KEYS = ['graph', 'edge_predicates', 'terminal', 'stakes'];
const MODES = ['build', 'fix', 'plan', 'judgment'];

export function descriptorIdFor(fromChecksum, mode) {
  return `backfill-${mode}-${fromChecksum.slice(0, 12)}`;
}

/** Derive the signed target policy directly from a stored guard policy. */
export function deriveBackfillPolicy(storedPolicy, mode) {
  const terminal = new Set(storedPolicy.terminal || []);
  const graph = {};
  for (const [phase, targets] of Object.entries(storedPolicy.graph || {})) {
    if (terminal.has(phase)) {
      graph[phase] = [...targets];
      continue;
    }
    const next = [...targets].filter((target) => target !== 'complete_backfilled');
    const killedAt = next.indexOf('killed');
    if (killedAt === -1) next.push('complete_backfilled');
    else next.splice(killedAt, 0, 'complete_backfilled');
    graph[phase] = next;
  }
  graph.complete_backfilled = [];
  return {
    graph,
    edge_predicates: storedPolicy.edge_predicates,
    terminal: [...(storedPolicy.terminal || []).filter((phase) => phase !== 'complete_backfilled'), 'complete_backfilled'],
    stakes: storedPolicy.stakes,
  };
}

function assertPolicyShape(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('to_policy must be an object');
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.includes(key)) throw new TypeError(`unknown policy key ${JSON.stringify(key)}`);
  }
  for (const key of POLICY_KEYS) {
    if (!Object.hasOwn(policy, key)) throw new TypeError(`to_policy is missing ${JSON.stringify(key)}`);
  }
}

/** Create the exact bytes that the human operator signs. */
export function buildDescriptorFile(entries) {
  const candidates = entries.map((entry) => {
    const fromChecksum = entry.from_checksum ?? entry.fromChecksum;
    const mode = entry.mode;
    const toPolicy = entry.to_policy ?? entry.toPolicy ?? deriveBackfillPolicy(entry.storedPolicy, mode);
    assertPolicyShape(toPolicy);
    return {
      id: descriptorIdFor(fromChecksum, mode),
      rationale: `Add complete_backfilled to ${mode} guard policies; authorization scope is policy-wide.`,
      from_checksum: fromChecksum,
      to_policy: toPolicy,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const unique = new Map();
  for (const descriptor of candidates) {
    if (!unique.has(descriptor.from_checksum)) unique.set(descriptor.from_checksum, descriptor);
  }
  const descriptors = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  return `${JSON.stringify({ version: 1, descriptors }, null, 2)}\n`;
}

async function directoriesAt(root) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Same 12-hex workspace hash `resourceId` (server/lifecycle-guard.js) embeds in every id. */
function workspaceHash(workspaceRoot) {
  return createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
}

/**
 * Parse a `compose:<hash>:<code>` (build, legacy) or `compose:<hash>:<mode>:<code>`
 * (namespaced) resource id for this workspace's hash. Returns null for ids that don't
 * belong to this workspace or whose mode segment isn't one of MODES.
 */
function parseWorkspaceResourceId(resourceIdValue, hash) {
  const prefix = `compose:${hash}:`;
  if (typeof resourceIdValue !== 'string' || !resourceIdValue.startsWith(prefix)) return null;
  const rest = resourceIdValue.slice(prefix.length);
  const colonAt = rest.indexOf(':');
  if (colonAt === -1) return { mode: 'build', featureCode: rest };
  const maybeMode = rest.slice(0, colonAt);
  if (maybeMode === 'build' || !MODES.includes(maybeMode)) return null;
  return { mode: maybeMode, featureCode: rest.slice(colonAt + 1) };
}

/** Probe known lifecycle artifact roots because stratum intentionally has no list API. */
export async function enumerateByProbe(workspaceRoot, deps = {}) {
  const { guardPolicy: guardPolicyFn = guardPolicy } = deps;
  const results = [];
  for (const mode of MODES) {
    const artifactRoot = getMode(mode).runner.artifactRoot;
    const root = artifactRoot === 'features'
      ? path.resolve(workspaceRoot, loadFeaturesDir(workspaceRoot))
      : path.resolve(workspaceRoot, artifactRoot);
    for (const featureCode of await directoriesAt(root)) {
      const resource = await guardPolicyFn(resourceId(featureCode, workspaceRoot, mode));
      if (resource?.status === 'error' && resource.error_type === 'guard_not_found') continue;
      if (!resource || resource.error || resource.status === 'error') {
        throw new Error(`could not read guard policy for ${mode}:${featureCode}: ${resource?.message || resource?.error?.message || 'no guard response'}`);
      }
      if ((resource.terminal || []).includes(resource.current_state)) continue;
      if ((resource.terminal || []).includes('complete_backfilled')) continue;
      results.push({ from_checksum: resource.checksum, mode, storedPolicy: resource });
    }
  }
  return results;
}

/**
 * Discover registered guard resources for this workspace. Tries the fast path first —
 * a single `stratum guard list` call scoped to this workspace's id prefix — and falls
 * back to the historical per-directory probe when list is unsupported (older stratum,
 * or any non-ok response).
 */
export async function enumerateRegisteredResources(workspaceRoot, deps = {}) {
  const { guardList: guardListFn = guardList, guardPolicy: guardPolicyFn = guardPolicy } = deps;
  const hash = workspaceHash(workspaceRoot);
  const listed = await guardListFn({ prefix: `compose:${hash}:` });
  if (listed?.status !== 'ok' || !Array.isArray(listed.resources)) {
    return enumerateByProbe(workspaceRoot, { guardPolicy: guardPolicyFn });
  }
  const results = [];
  for (const resource of listed.resources) {
    const parsed = parseWorkspaceResourceId(resource.resource_id, hash);
    if (!parsed) continue;
    if ((resource.terminal || []).includes(resource.current_state)) continue;
    if ((resource.terminal || []).includes('complete_backfilled')) continue;
    const full = await guardPolicyFn(resource.resource_id);
    if (full?.status === 'error' && full.error_type === 'guard_not_found') continue;
    if (!full || full.error || full.status === 'error') {
      throw new Error(`could not read guard policy for ${parsed.mode}:${parsed.featureCode}: ${full?.message || full?.error?.message || 'no guard response'}`);
    }
    results.push({ from_checksum: full.checksum, mode: parsed.mode, storedPolicy: full });
  }
  return results;
}

export const GENERATIONS_DIR = '.compose/guard-upgrades';
export const LEGACY_FLAT = '.compose/guard-upgrades.json';
const DESCRIPTOR_FILE = 'descriptors.json';
const DESCRIPTOR_NAMESPACE = 'stratum-guard-descriptors';
const SHA_RE = /^[a-f0-9]{64}$/;

export function generationPaths(workspaceRoot, sha) {
  const dir = path.resolve(workspaceRoot, GENERATIONS_DIR, sha);
  return { dir, file: path.join(dir, DESCRIPTOR_FILE), sig: path.join(dir, `${DESCRIPTOR_FILE}.sig`) };
}

async function exists(file) {
  try { await realpath(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

/**
 * True for ANY directory entry at `sig` — a regular file, a working symlink, or a DANGLING
 * symlink. Unlike exists() (which realpaths and so treats a dangling symlink as absent), this
 * is the right check before deciding "no signature yet": a dangling .sig symlink must never be
 * read as "unsigned candidate", because writing a signature through it would create a file
 * wherever the symlink points, possibly outside the workspace.
 */
async function sigEntryExists(sig) {
  try { await lstat(sig); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

/**
 * The generations directory itself must be a real directory inside the workspace, never a
 * symlink (which would make every containment check below meaningless) and never resolve
 * outside the workspace root. Returns its realpath.
 */
async function assertGenerationsDirSafe(workspaceRoot) {
  const base = path.resolve(workspaceRoot, GENERATIONS_DIR);
  await mkdir(base, { recursive: true });
  const baseLstat = await lstat(base);
  if (baseLstat.isSymbolicLink()) {
    throw new Error('generations directory is a symlink; remove it and retry');
  }
  const workspaceReal = await realpath(workspaceRoot);
  const baseReal = await realpath(base);
  if (baseReal !== workspaceReal && !baseReal.startsWith(workspaceReal + path.sep)) {
    throw new Error('generations directory escapes the workspace');
  }
  return baseReal;
}

async function setCurrent(workspaceRoot, sha) {
  const base = await assertGenerationsDirSafe(workspaceRoot);
  const current = path.join(base, 'current');
  const temporary = path.join(base, 'current.tmp');
  await rm(temporary, { recursive: true, force: true });
  await symlink(sha, temporary);
  await rename(temporary, current);
}

/** Require a resolved (realpath'd) generation path to live inside the workspace generations directory. */
async function assertContained(workspaceRoot, resolvedPath) {
  const baseReal = await assertGenerationsDirSafe(workspaceRoot);
  if (resolvedPath !== baseReal && !resolvedPath.startsWith(baseReal + path.sep)) {
    throw new Error('generation path escapes the workspace generations directory');
  }
}

/** Resolve the immutable pair selected by the mutable current symlink. */
export async function currentGeneration(workspaceRoot) {
  const base = path.resolve(workspaceRoot, GENERATIONS_DIR);
  try {
    const dir = await realpath(path.join(base, 'current'));
    const sha = path.basename(dir);
    if (!SHA_RE.test(sha)) return null;
    await assertContained(workspaceRoot, dir);
    const file = await realpath(path.join(dir, DESCRIPTOR_FILE));
    await assertContained(workspaceRoot, file);
    const sig = await realpath(path.join(dir, `${DESCRIPTOR_FILE}.sig`));
    await assertContained(workspaceRoot, sig);
    const bytes = await readFile(file);
    const actualSha = createHash('sha256').update(bytes).digest('hex');
    if (actualSha !== sha) throw new Error(`generation ${sha} bytes do not hash to its name`);
    return { sha, file, sig };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Copy the historical flat pair into a generation, without deleting operator-owned legacy files.
 *  Never adopts (or makes current) a pair that does not verify. */
export async function adoptLegacyFlatPair(workspaceRoot, verifier) {
  const legacy = path.resolve(workspaceRoot, LEGACY_FLAT);
  const legacySig = `${legacy}.sig`;
  if (!(await exists(legacy)) || !(await exists(legacySig))) return { adopted: false };

  const base = await assertGenerationsDirSafe(workspaceRoot);
  const staging = await mkdtemp(path.join(base, '.staging-'));
  let stagingRemoved = false;
  try {
    const stagedFile = path.join(staging, DESCRIPTOR_FILE);
    const stagedSig = path.join(staging, `${DESCRIPTOR_FILE}.sig`);
    await copyFile(legacy, stagedFile);
    await copyFile(legacySig, stagedSig);
    await chmod(stagedFile, 0o600);
    await chmod(stagedSig, 0o600);
    await chmod(staging, 0o700);

    const verdict = await verifyGeneration(workspaceRoot, stagedFile, verifier);
    if (!verdict.verified) {
      await rm(staging, { recursive: true, force: true });
      stagingRemoved = true;
      return { adopted: false, reason: 'legacy descriptor pair does not verify' };
    }

    const bytes = await readFile(stagedFile);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const target = generationPaths(workspaceRoot, sha);
    if (await exists(target.dir)) {
      const existingLstat = await lstat(target.dir);
      if (existingLstat.isSymbolicLink()) {
        await rm(staging, { recursive: true, force: true });
        stagingRemoved = true;
        return { adopted: false, reason: `generation ${sha} is a symlink; remove it and retry` };
      }
      try {
        await assertContained(workspaceRoot, await realpath(target.dir));
        await assertContained(workspaceRoot, await realpath(target.file));
        if (await sigEntryExists(target.sig)) {
          if ((await lstat(target.sig)).isSymbolicLink()) {
            throw new Error(`generation ${sha} signature is a symlink; remove it and retry`);
          }
          await assertContained(workspaceRoot, await realpath(target.sig));
        }
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        stagingRemoved = true;
        return { adopted: false, reason: error.message };
      }
      const existingVerdict = await verifyGeneration(workspaceRoot, target.file, verifier);
      // A generation with this content already exists; keep it, discard the redundant staging copy.
      await rm(staging, { recursive: true, force: true });
      stagingRemoved = true;
      if (!existingVerdict.verified) {
        return { adopted: false, reason: `existing generation ${sha} does not verify` };
      }
    } else {
      await rename(staging, target.dir);
      stagingRemoved = true;
    }

    if (!(await exists(path.join(workspaceRoot, GENERATIONS_DIR, 'current')))) {
      await setCurrent(workspaceRoot, sha);
      return { adopted: true };
    }
    return { adopted: false };
  } finally {
    if (!stagingRemoved) await rm(staging, { recursive: true, force: true });
  }
}

/** Ask the real verifier and make its three-part safety verdict explicit. */
export async function verifyGeneration(_workspaceRoot, file, verifier) {
  const result = await verifier(file);
  return {
    ...result,
    verified: result?.status === 'ok'
      && typeof result.signature === 'string'
      && result.signature.startsWith('verified:')
      && result.group_or_world_writable === false,
  };
}

async function coversChecksums(file, needChecksums) {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  const descriptors = Array.isArray(parsed?.descriptors) ? parsed.descriptors : [];
  return needChecksums.every((checksum) => descriptors.some((descriptor) =>
    descriptor?.from_checksum === checksum || descriptor?.id === descriptorIdFor(checksum, descriptor?.id?.split('-')[1])));
}

function verificationText(result) {
  return result?.signature || result?.message || 'not verified';
}

function refusal(code, message, hint = HINT_ENROL) {
  return { status: 'refused', code, message, hint };
}

async function resolvedFile(file) {
  return realpath(file);
}

/**
 * Ensure an immutable, verified descriptor generation exists for these checksums.
 * The caller owns the workspace descriptor lock; this function intentionally does not take one.
 */
export async function ensureSignedDescriptors({ workspaceRoot, needChecksums, custody, verifier, enumerate = enumerateRegisteredResources }) {
  let staging = null;
  try {
    await adoptLegacyFlatPair(workspaceRoot, verifier);
    const bytes = Buffer.from(buildDescriptorFile(await enumerate(workspaceRoot)));
    const sha = createHash('sha256').update(bytes).digest('hex');
    const current = await currentGeneration(workspaceRoot);
    if (current) {
      const verdict = await verifyGeneration(workspaceRoot, current.file, verifier);
      if (verdict.verified && await coversChecksums(current.file, needChecksums)) {
        return { status: 'fresh', path: await resolvedFile(current.file), prompts: 0, sha: current.sha };
      }
    }

    const target = generationPaths(workspaceRoot, sha);
    const targetExists = await exists(target.dir);
    let useExistingUnsigned = false;
    if (targetExists) {
      const targetLstat = await lstat(target.dir);
      if (targetLstat.isSymbolicLink()) {
        return refusal('upgrade_descriptor_unavailable', `generation ${sha} is a symlink; remove it and retry`, HINT_ENROL);
      }
      await assertContained(workspaceRoot, await realpath(target.dir));
      await assertContained(workspaceRoot, await realpath(target.file));
      if (await sigEntryExists(target.sig)) {
        if ((await lstat(target.sig)).isSymbolicLink()) {
          return refusal('upgrade_descriptor_unavailable', `generation ${sha} signature is a symlink; remove it and retry`, HINT_ENROL);
        }
        await assertContained(workspaceRoot, await realpath(target.sig));
        const verdict = await verifyGeneration(workspaceRoot, target.file, verifier);
        if (verdict.verified && await coversChecksums(target.file, needChecksums)) {
          await setCurrent(workspaceRoot, sha);
          return { status: 'fresh', path: await resolvedFile(target.file), prompts: 0, sha };
        }
        const reason = verdict?.group_or_world_writable
          ? 'is group or world writable'
          : `signature does not verify: ${verificationText(verdict)}`;
        return refusal('upgrade_descriptor_unavailable', `generation ${sha} exists but ${reason}; remove it and retry`);
      }
      const candidateBytes = await readFile(target.file);
      if (!candidateBytes.equals(bytes)) {
        return refusal('upgrade_descriptor_unavailable', `generation ${sha} exists but its descriptor bytes do not match; remove it and retry`);
      }
      useExistingUnsigned = true;
    } else {
      const safeBase = await assertGenerationsDirSafe(workspaceRoot);
      staging = await mkdtemp(path.join(safeBase, '.staging-'));
      const stagedFile = path.join(staging, DESCRIPTOR_FILE);
      await writeFile(stagedFile, bytes, { mode: 0o600 });
      await chmod(stagedFile, 0o600);
    }

    const signed = await custody.sign({ bytes, namespace: DESCRIPTOR_NAMESPACE });
    if (!signed?.ok) {
      return refusal(signed?.code ?? 'upgrade_descriptor_unavailable', signed?.message ?? 'no signing custody on this platform', signed?.hint ?? HINT_ENROL);
    }

    const candidate = useExistingUnsigned ? target : { dir: staging, file: path.join(staging, DESCRIPTOR_FILE), sig: path.join(staging, `${DESCRIPTOR_FILE}.sig`) };
    await writeFile(candidate.sig, signed.armored, { mode: 0o600 });
    await chmod(candidate.sig, 0o600);
    const verdict = await verifyGeneration(workspaceRoot, candidate.file, verifier);
    if (!verdict.verified) {
      if (staging) await rm(staging, { recursive: true, force: true });
      else await rm(candidate.sig, { force: true });
      staging = null;
      return refusal('upgrade_descriptor_unavailable', `signature did not verify: ${verificationText(verdict)}`);
    }

    if (!useExistingUnsigned) {
      try {
        await rename(staging, target.dir);
        staging = null;
      } catch (error) {
        // ENOTDIR covers renaming a directory onto a path that now exists as a non-directory
        // (e.g. a symlink an attacker planted while we were staging) — the recovery path below
        // re-inspects whatever now occupies target.dir instead of trusting it.
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOTDIR') throw error;
        await rm(staging, { recursive: true, force: true });
        staging = null;
        const raceLstat = await lstat(target.dir);
        if (raceLstat.isSymbolicLink()) {
          return refusal('upgrade_descriptor_unavailable', `generation ${sha} is a symlink; remove it and retry`, HINT_ENROL);
        }
        await assertContained(workspaceRoot, await realpath(target.dir));
        await assertContained(workspaceRoot, await realpath(target.file));
        if (await sigEntryExists(target.sig)) {
          if ((await lstat(target.sig)).isSymbolicLink()) {
            return refusal('upgrade_descriptor_unavailable', `generation ${sha} signature is a symlink; remove it and retry`, HINT_ENROL);
          }
          await assertContained(workspaceRoot, await realpath(target.sig));
        }
        const raced = await verifyGeneration(workspaceRoot, target.file, verifier);
        if (!raced.verified || !(await coversChecksums(target.file, needChecksums))) {
          return refusal('upgrade_descriptor_unavailable', `generation ${sha} exists but its signature does not verify; remove it and retry`);
        }
        await setCurrent(workspaceRoot, sha);
        return { status: 'fresh', path: await resolvedFile(target.file), prompts: 0, sha };
      }
    }
    await setCurrent(workspaceRoot, sha);
    return { status: 'signed', path: await resolvedFile(target.file), prompts: 1, sha };
  } catch (error) {
    return refusal('upgrade_descriptor_unavailable', error?.message || String(error));
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

/** Write a durable but unsigned manual-signing candidate, without changing current. */
export async function prepareUnsignedCandidate(workspaceRoot, { enumerate = enumerateRegisteredResources } = {}) {
  await assertGenerationsDirSafe(workspaceRoot);
  const bytes = Buffer.from(buildDescriptorFile(await enumerate(workspaceRoot)));
  const sha = createHash('sha256').update(bytes).digest('hex');
  const target = generationPaths(workspaceRoot, sha);
  if (await exists(target.dir)) {
    const existing = await readFile(target.file);
    if (!existing.equals(bytes)) throw new Error(`generation ${sha} exists but its descriptor bytes do not match`);
    if (await sigEntryExists(target.sig)) {
      if ((await lstat(target.sig)).isSymbolicLink()) {
        throw new Error(`generation ${sha} signature is a symlink; remove it and retry`);
      }
      throw new Error(`generation ${sha} already has a signature; remove it and retry`);
    }
    return { sha, path: await resolvedFile(target.file) };
  }
  await mkdir(target.dir, { recursive: true, mode: 0o700 });
  await writeFile(target.file, bytes, { mode: 0o600 });
  await chmod(target.file, 0o600);
  return { sha, path: await resolvedFile(target.file) };
}

function findGenerationReferences(value, found = new Set()) {
  if (typeof value === 'string') {
    const match = value.match(/guard-upgrades\/([a-f0-9]{64})(?:\/|$)/);
    if (match) found.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) findGenerationReferences(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'generation' && typeof item === 'string' && SHA_RE.test(item)) found.add(item);
      findGenerationReferences(item, found);
    }
  }
  return found;
}

/** Remove unreferenced immutable generations. The caller owns the descriptor lock. */
export async function pruneGenerations(workspaceRoot) {
  await assertGenerationsDirSafe(workspaceRoot);
  const base = path.resolve(workspaceRoot, GENERATIONS_DIR);
  let currentSha = null;
  try {
    const currentDir = await realpath(path.join(base, 'current'));
    if (SHA_RE.test(path.basename(currentDir))) currentSha = path.basename(currentDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const keep = new Set(currentSha ? [currentSha] : []);
  const intents = path.resolve(workspaceRoot, '.compose', 'data', 'completion-intents');
  try {
    for (const entry of await readdir(intents)) {
      if (!entry.endsWith('.json')) continue;
      try { findGenerationReferences(JSON.parse(await readFile(path.join(intents, entry), 'utf8')), keep); } catch { /* malformed intents are not deletion authority */ }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const removed = [];
  try {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      // Dirent.isDirectory() is false for symlinks (it reports the dirent's own type without
      // following the link), so a symlink entry is never a deletion candidate here.
      if (!entry.isDirectory() || !SHA_RE.test(entry.name) || keep.has(entry.name)) continue;
      await rm(path.join(base, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { removed };
}
