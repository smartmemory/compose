/**
 * resolve-workspace.js — single resolver chain for compose workspaces.
 *
 * Precedence:
 *   1. explicit hint.workspaceId  (cheap upward walk first; falls back to discovery)
 *   2. COMPOSE_TARGET env         (absolute path bypasses discovery; id routes through it)
 *   3. hint.getBinding() (MCP binding)
 *   4. discovery (auto-pick when exactly one candidate; throws otherwise) —
 *      degrades to the nearest-enclosing workspace if the subtree is too broad
 *      to enumerate within the visit bound.
 *
 * Throws structured errors with `.code`: WorkspaceUnknown, WorkspaceAmbiguous,
 * WorkspaceIdCollision, WorkspaceUnset. The CLI's dieOnWorkspaceError consumes them.
 *
 * Design intent: explicit-flag path uses findWorkspaceById (cheap upward walk)
 * BEFORE invoking discoverWorkspaces — this lets users escape WorkspaceDiscoveryTooBroad
 * by passing --workspace=<ancestor-id>. A descendant id still routes through discovery.
 *
 * The no-hint path mirrors that instinct only when the descendant scan can't
 * enumerate the subtree (WorkspaceDiscoveryTooBroad): rather than failing, it
 * falls back to the nearest enclosing `.compose` ancestor (upward walk), so
 * running from a large workspace root resolves instead of dying. A tractable
 * tree is still enumerated in full — genuine nested-workspace ambiguity (a
 * parent workspace with a child below it) deliberately surfaces and forces an
 * explicit --workspace.
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

  // 4. Discovery — fan out under the anchor; collisions/ambiguity matter
  //    because we're auto-picking. A normal tree enumerates fine, so genuine
  //    nested-workspace ambiguity (e.g. a parent workspace with a child below)
  //    still surfaces as WorkspaceAmbiguous and forces an explicit --workspace.
  let candidates;
  try {
    ({ candidates } = discoverWorkspaces(cwd));
  } catch (err) {
    // The subtree was too large to enumerate within the visit bound. That cap
    // is a cost guard, not a verdict — if cwd is itself inside a workspace, the
    // nearest enclosing `.compose` ancestor is the unambiguous answer, so we
    // degrade to it instead of failing (best-effort, same philosophy as the
    // scan silently skipping EACCES subtrees). Only when cwd is inside NO
    // workspace must the caller disambiguate explicitly — then we rethrow.
    if (err.code === 'WorkspaceDiscoveryTooBroad') {
      const enclosing = findEnclosingWorkspace(cwd);
      if (enclosing) return { ...deriveId({ root: enclosing }), source: 'discovery' };
    }
    throw err;
  }
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

/**
 * Cheap upward-only lookup: walk ancestors from startDir and return the first
 * directory containing a `.compose/` marker, or null if none exists before the
 * filesystem root. This is the no-hint "nearest enclosing workspace" resolver —
 * identical walk to findWorkspaceById but id-agnostic (returns the closest
 * workspace regardless of its derived id).
 */
function findEnclosingWorkspace(startDir) {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.compose'))) return dir;
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
