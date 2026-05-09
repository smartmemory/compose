/**
 * resolve-workspace.js — single resolver chain for compose workspaces.
 *
 * Precedence:
 *   1. explicit hint.workspaceId  (cheap upward walk first; falls back to discovery)
 *   2. COMPOSE_TARGET env         (absolute path bypasses discovery; id routes through it)
 *   3. hint.getBinding() (MCP binding)
 *   4. discovery (auto-pick when exactly one candidate; throws otherwise)
 *
 * Throws structured errors with `.code`: WorkspaceUnknown, WorkspaceAmbiguous,
 * WorkspaceIdCollision, WorkspaceUnset. The CLI's dieOnWorkspaceError consumes them.
 *
 * Design intent: explicit-flag path uses findWorkspaceById (cheap upward walk)
 * BEFORE invoking discoverWorkspaces — this lets users escape WorkspaceDiscoveryTooBroad
 * by passing --workspace=<ancestor-id>. A descendant id still routes through discovery.
 */
import path from 'node:path';
import fs from 'node:fs';
import { discoverWorkspaces, deriveId } from './discover-workspaces.js';

export class WorkspaceUnknown extends Error {
  constructor(id) {
    super(`Unknown workspaceId: ${id}`);
    this.code = 'WorkspaceUnknown';
    this.id = id;
  }
}

export class WorkspaceAmbiguous extends Error {
  constructor(candidates) {
    super('Multiple workspaces match cwd');
    this.code = 'WorkspaceAmbiguous';
    this.candidates = candidates;
  }
}

export class WorkspaceIdCollision extends Error {
  constructor(id, roots) {
    super(`workspaceId "${id}" used by multiple roots`);
    this.code = 'WorkspaceIdCollision';
    this.id = id;
    this.roots = roots;
  }
}

export class WorkspaceUnset extends Error {
  constructor() {
    super('No workspace resolved');
    this.code = 'WorkspaceUnset';
  }
}

/**
 * Resolve a workspace from hints + env + cwd.
 *
 * @param {object} hint
 * @param {string} [hint.cwd]          — defaults to process.cwd()
 * @param {string} [hint.workspaceId]  — explicit --workspace=<id>
 * @param {() => string|null} [hint.getBinding] — MCP binding accessor
 * @returns {{id: string, root: string, configPath: string, source: string}}
 */
export function resolveWorkspace(hint = {}) {
  const cwd = hint.cwd ?? process.cwd();

  // 1. Explicit flag — authoritative. Cheap upward walk first; fall back to
  //    discovery (which may throw TooBroad for pathological trees).
  if (hint.workspaceId) {
    const found = findWorkspaceById(cwd, hint.workspaceId);
    if (found) return { ...found, source: 'explicit-flag' };
    const { candidates } = discoverWorkspaces(cwd);
    return resolveByIdScopedCollisionCheck(hint.workspaceId, candidates, 'explicit-flag');
  }

  // 2. COMPOSE_TARGET — absolute path is authoritative without discovery.
  if (process.env.COMPOSE_TARGET) {
    const t = process.env.COMPOSE_TARGET;
    if (path.isAbsolute(t)) {
      if (!fs.existsSync(t)) {
        const e = new Error(`COMPOSE_TARGET=${t} does not exist`);
        e.code = 'WorkspaceUnknown';
        e.id = t;
        throw e;
      }
      return { ...deriveId({ root: t }), source: 'env' };
    }
    const { candidates } = discoverWorkspaces(cwd);
    return resolveByIdScopedCollisionCheck(t, candidates, 'env');
  }

  // 3. MCP binding — scoped collision check on the bound id.
  if (hint.getBinding) {
    const id = hint.getBinding();
    if (id) {
      const { candidates } = discoverWorkspaces(cwd);
      return resolveByIdScopedCollisionCheck(id, candidates, 'mcp-binding');
    }
  }

  // 4. Discovery — collisions matter because we're auto-picking.
  const { candidates } = discoverWorkspaces(cwd);
  detectCollisions(candidates);
  if (candidates.length === 0) throw new WorkspaceUnset();
  if (candidates.length === 1) return { ...candidates[0], source: 'discovery' };
  throw new WorkspaceAmbiguous(candidates.map(({ id, root }) => ({ id, root })));
}

/**
 * Cheap upward-only lookup: walk ancestors from startDir, return the first
 * `.compose/` directory whose derived id matches targetId. Lets users bypass
 * descendant-cap entirely via `--workspace=<ancestor-id>`.
 */
function findWorkspaceById(startDir, targetId) {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.compose'))) {
      const candidate = deriveId({ root: dir });
      if (candidate.id === targetId) return candidate;
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveByIdScopedCollisionCheck(id, candidates, source) {
  const matching = candidates.filter((c) => c.id === id);
  if (matching.length === 0) throw new WorkspaceUnknown(id);
  if (matching.length > 1) {
    throw new WorkspaceIdCollision(id, matching.map((m) => m.root));
  }
  return { ...matching[0], source };
}

function detectCollisions(candidates) {
  const byId = new Map();
  for (const c of candidates) {
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id).push(c.root);
  }
  for (const [id, roots] of byId) {
    if (roots.length > 1) throw new WorkspaceIdCollision(id, roots);
  }
}

/**
 * Pull --workspace=<id> or --workspace <id> out of args, mutating in place.
 * Returns the id, or null if absent.
 */
export function getWorkspaceFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace' && i + 1 < args.length) {
      const id = args[i + 1];
      args.splice(i, 2);
      return id;
    }
    if (typeof a === 'string' && a.startsWith('--workspace=')) {
      const id = a.slice('--workspace='.length);
      args.splice(i, 1);
      return id;
    }
  }
  return null;
}
