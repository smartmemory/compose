import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadFeaturesDir } from './project-paths.js';
import { getMode } from './lifecycle-modes.js';
import { guardPolicy } from '../server/stratum-client.js';
import { resourceId } from '../server/lifecycle-guard.js';

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

/** Probe known lifecycle artifact roots because stratum intentionally has no list API. */
export async function enumerateRegisteredResources(workspaceRoot) {
  const results = [];
  for (const mode of MODES) {
    const artifactRoot = getMode(mode).runner.artifactRoot;
    const root = artifactRoot === 'features'
      ? path.resolve(workspaceRoot, loadFeaturesDir(workspaceRoot))
      : path.resolve(workspaceRoot, artifactRoot);
    for (const featureCode of await directoriesAt(root)) {
      const resource = await guardPolicy(resourceId(featureCode, workspaceRoot, mode));
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

/** Write a mode-0600 descriptor file and leave signing to the human operator. */
export async function writeDescriptorFile(workspaceRoot) {
  const target = path.resolve(workspaceRoot, '.compose', 'guard-upgrades.json');
  const bytes = buildDescriptorFile(await enumerateRegisteredResources(workspaceRoot));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o600 });
  await chmod(target, 0o600);
  return {
    path: target,
    descriptors: JSON.parse(bytes).descriptors,
    signCommand: `ssh-keygen -Y sign -f ~/.stratum/guard-signing -n stratum-guard-descriptors ${JSON.stringify(target)}`,
  };
}
