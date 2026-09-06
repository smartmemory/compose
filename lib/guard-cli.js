import { execFile as defaultExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile as defaultReadFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { acquireDirLock as defaultAcquireDirLock } from './dir-lock.js';
import { CUSTODY_TIMEOUT_MS, custodyBackend, custodySign, custodyStatus, DESCRIPTOR_LOCK_TIMEOUT_MS } from './guard-custody.js';
import {
  currentGeneration as defaultCurrentGeneration, descriptorIdFor, ensureSignedDescriptors as defaultEnsureSignedDescriptors,
  enumerateRegisteredResources as defaultEnumerateRegisteredResources, prepareUnsignedCandidate as defaultPrepareUnsignedCandidate,
  pruneGenerations as defaultPruneGenerations, verifyGeneration as defaultVerifyGeneration,
} from './guard-descriptors.js';
import { guardDescriptors as defaultGuardDescriptors } from '../server/stratum-client.js';
import { runEnrol } from './guard-enrol.js';

const require = createRequire(import.meta.url);
const { parseAllowedSigners } = await import(require.resolve('@smartmemory/stratum/dist/guard/sshsig.js'));

const LOCK_RELATIVE = path.join('.compose', 'data', 'locks', 'guard-descriptors');
const LEGACY_FLAT = path.join('.compose', 'guard-upgrades.json');
const NAMESPACE = 'stratum-guard-descriptors';

function descriptorLock(workspaceRoot) { return path.join(workspaceRoot, LOCK_RELATIVE); }

function makeResult(status, lines, extra = {}) { return { status, lines, ...extra }; }

async function withLock(workspaceRoot, deps, operation) {
  const release = await (deps.acquireDirLock ?? defaultAcquireDirLock)(descriptorLock(workspaceRoot), { timeoutMs: DESCRIPTOR_LOCK_TIMEOUT_MS });
  try { return await operation(); } finally { release(); }
}

function asWorkspace(input) {
  return typeof input === 'string' ? input : input?.workspaceRoot;
}

function manualSignLine(file) {
  return `ssh-keygen -Y sign -f ~/.stratum/guard-signing -n ${NAMESPACE} ${file}`;
}

function signedLine(signature, count) {
  const match = /^verified: signed by (.+) \(([^)]+)\)$/.exec(signature || '');
  if (!match) return null;
  return `signed by ${match[1]} (${match[2]}), ${count} descriptor(s), verified`;
}

async function descriptorCount(file, readFile) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed?.descriptors) ? parsed.descriptors.length : 0;
  } catch { return 0; }
}

/** Generate/sign descriptor generations. This returns lines; the bin owns stdout. */
export async function runGuardDescriptors(input, deps = {}) {
  const workspaceRoot = asWorkspace(input);
  if (!workspaceRoot) throw new Error('workspaceRoot is required');
  try {
    return await withLock(workspaceRoot, deps, async () => {
      const backend = (deps.custodyBackend ?? custodyBackend)();
      const enumerate = deps.enumerateRegisteredResources ?? defaultEnumerateRegisteredResources;
      const resources = await enumerate(workspaceRoot);
      const needChecksums = resources.map((resource) => resource.from_checksum ?? resource.fromChecksum).filter(Boolean);
      const verifier = deps.guardDescriptors ?? defaultGuardDescriptors;
      const ensured = await (deps.ensureSignedDescriptors ?? defaultEnsureSignedDescriptors)({
        workspaceRoot,
        needChecksums,
        custody: { sign: (request) => (deps.custodySign ?? custodySign)(request) },
        verifier,
        enumerate,
      });
      if (ensured.status === 'refused') {
        // Only the plain "no custody available" refusal falls back to the manual
        // unsigned-candidate path. Any other refusal (e.g. an existing generation
        // whose signature does not verify) must be returned as-is — falling back
        // here would print a `ssh-keygen -Y sign` line targeting a path that
        // already carries an invalid `.sig`, which is exactly the "sign over an
        // invalid generation" path S1 forbids.
        if (backend === 'none' && ensured.message === 'no signing custody on this platform') {
          const candidate = await (deps.prepareUnsignedCandidate ?? defaultPrepareUnsignedCandidate)(workspaceRoot, { enumerate });
          return makeResult('manual', [manualSignLine(candidate.path)], { path: candidate.path, sha: candidate.sha });
        }
        return makeResult('refused', [ensured.message, ensured.hint].filter(Boolean), ensured);
      }
      if (ensured.status === 'fresh') return makeResult('fresh', [`fresh: ${ensured.path}`], ensured);
      const inspected = await verifier(ensured.path);
      const verdict = signedLine(inspected?.signature, await descriptorCount(ensured.path, deps.readFile ?? defaultReadFile));
      if (!verdict || inspected?.status !== 'ok' || inspected?.group_or_world_writable !== false) {
        return makeResult('refused', [`signature did not verify: ${inspected?.signature || 'no verifier verdict'}`], { code: 'upgrade_descriptor_unavailable', path: ensured.path });
      }
      return makeResult('signed', [verdict], ensured);
    });
  } catch (error) {
    return makeResult('refused', [error?.message || String(error)], { code: 'upgrade_descriptor_unavailable' });
  }
}

/** Explicit signing uses the same safe generation path as descriptors. */
export async function runGuardSign(input, deps = {}) {
  return runGuardDescriptors(input, deps);
}

export async function runGuardEnrol(options = {}, deps = {}) {
  return runEnrol(options, deps);
}

function runCommand(execFile, file, args, options) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, options, (error, stdout = '', stderr = '') => resolve({ error, stdout, stderr }));
    } catch (error) { resolve({ error, stdout: '', stderr: '' }); }
  });
}

async function coverage(workspaceRoot, generation, deps) {
  const enumerate = deps.enumerateRegisteredResources ?? defaultEnumerateRegisteredResources;
  const readFile = deps.readFile ?? defaultReadFile;
  try {
    const resources = await enumerate(workspaceRoot);
    if (!generation) return { covered: 0, total: resources.length };
    const parsed = JSON.parse(await readFile(generation.file, 'utf8'));
    const ids = new Set((parsed.descriptors || []).map((item) => item?.id));
    const covered = resources.filter((resource) => {
      const checksum = resource.from_checksum ?? resource.fromChecksum;
      return (parsed.descriptors || []).some((item) => item?.from_checksum === checksum)
        || ids.has(descriptorIdFor(checksum, resource.mode));
    }).length;
    return { covered, total: resources.length };
  } catch (error) { return { error: error?.message || String(error) }; }
}

/** Read-only signing diagnostics. `--prune` is deliberately handled by the caller first. */
export async function signingStatusLines(input, deps = {}) {
  const workspaceRoot = asWorkspace(input);
  if (!workspaceRoot) throw new Error('workspaceRoot is required');
  const status = await (deps.custodyStatus ?? custodyStatus)();
  const current = await (deps.currentGeneration ?? defaultCurrentGeneration)(workspaceRoot);
  let verdict = null;
  if (current) {
    try { verdict = await (deps.verifyGeneration ?? defaultVerifyGeneration)(workspaceRoot, current.file, deps.guardDescriptors ?? defaultGuardDescriptors); } catch (error) { verdict = { signature: `NOT VERIFIED: ${error.message}`, verified: false }; }
  }
  // Coverage probes every feature dir x mode through the stratum CLI (76 s and
  // ~370 spawns on the compose repo itself, measured 2026-09-06) — opt-in.
  const covered = deps.coverage ? await coverage(workspaceRoot, current, deps) : null;
  const git = await runCommand(deps.execFile ?? defaultExecFile, 'git', ['status', '--porcelain', '--', '.compose/guard-upgrades'], { cwd: workspaceRoot, timeout: CUSTODY_TIMEOUT_MS });
  const publicSigner = status.publicKeyLine ? (() => {
    try { return parseAllowedSigners(`status ${status.publicKeyLine.trim()}\n`)[0]?.fingerprint ?? null; } catch { return null; }
  })() : null;
  const lines = [
    'signing:',
    `  backend: ${status.backend}`,
    `  installed: ${status.installed ? 'yes' : 'no'}`,
    `  rule: ${status.rule}`,
    `  presence: ${status.presence}`,
    `  enrolled fingerprint: ${publicSigner || 'absent'}`,
    `  current generation: ${current ? current.sha : 'absent'}`,
    `  signature: ${current ? (verdict?.signature || 'NOT VERIFIED') : 'absent'}`,
    `  coverage: ${covered === null ? 'skipped (pass --coverage)' : covered.error ? `unknown (${covered.error})` : `${covered.covered}/${covered.total}`}`,
    `  generations committed: ${!git.error && !String(git.stdout).trim() ? 'yes' : 'no'}`,
    `  legacy flat pair: ${existsSync(path.join(workspaceRoot, LEGACY_FLAT)) && existsSync(path.join(workspaceRoot, `${LEGACY_FLAT}.sig`)) ? 'present — delete after committing generations' : 'absent'}`,
    `  cached admin credential: ${status.cachedCredential}`,
  ];
  for (const detail of status.detail || []) lines.push(`  detail: ${detail}`);
  return makeResult('ok', lines, { custodyStatus: status, current, verdict, coverage: covered });
}

export async function pruneGuardGenerations(input, deps = {}) {
  const workspaceRoot = asWorkspace(input);
  try {
    const result = await withLock(workspaceRoot, deps, () => (deps.pruneGenerations ?? defaultPruneGenerations)(workspaceRoot));
    return makeResult('ok', result.removed.length ? result.removed.map((sha) => `pruned: ${sha}`) : ['pruned: none'], result);
  } catch (error) {
    return makeResult('refused', [error?.message || String(error)], { code: 'upgrade_descriptor_unavailable' });
  }
}
