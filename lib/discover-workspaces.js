/**
 * discover-workspaces.js — bounded bidirectional discovery of compose workspaces.
 *
 * Walks upward to find an "anchor" (any of ANCHOR_MARKERS), then scans the anchor
 * subtree to MAX_DEPTH for `.compose/` markers. The scan prunes aggressively —
 * a workspace root is never a dot-directory (`.foo`) or a vendor/build/cache dir,
 * so those whole subtrees are skipped. This keeps the visit count proportional to
 * real source directories (a large monorepo scans in tens of ms), not to incidental
 * tooling cruft. A generous MAX_VISITED cap remains as a backstop against
 * pathological roots (e.g. $HOME); over-cap throws code='WorkspaceDiscoveryTooBroad',
 * which resolveWorkspace degrades to the nearest enclosing workspace. Permission
 * errors during readdir are skipped silently — discovery is best-effort, not
 * authoritative for individual subtrees.
 *
 * Exports:
 *   - findAnchor(startDir) → string|null
 *   - discoverWorkspaces(startDir) → { anchor, candidates: [{id, root, configPath}] }
 *   - deriveId({root}) → {id, root, configPath}
 */
import path from 'node:path';
import fs from 'node:fs';

export const ANCHOR_MARKERS = ['.compose', '.stratum.yaml', '.git'];
export const WORKSPACE_MARKER = '.compose';
// Non-dot directories that never contain a workspace root but are often huge.
// (Dot-directories are pruned separately — see shouldSkipDir.)
export const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage',
  'vendor', 'target', '__pycache__', 'venv',
]);
export const MAX_DEPTH = 3;
// Generous backstop, not a tuning knob. With dot/vendor pruning the visit count
// tracks real source dirs (~1.5k for a large monorepo, scanned in tens of ms),
// so this only trips on pathological roots like $HOME.
export const MAX_VISITED = 10000;

/**
 * A workspace root is always a normal project directory — never a dot-directory
 * (`.git`, `.venv`, `.playwright-mcp`, …) and never a vendor/build/cache dir.
 * Pruning these whole subtrees is both correct (no marker can live there) and
 * the single biggest cost lever for discovery on real repos.
 */
export function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

/**
 * Walk upward from startDir; return the first directory containing any
 * ANCHOR_MARKER, or null if none found before filesystem root.
 */
export function findAnchor(startDir) {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (true) {
    for (const marker of ANCHOR_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Discover candidate workspaces under the anchor for startDir.
 * If no anchor exists upward, anchors at startDir itself.
 */
export function discoverWorkspaces(startDir) {
  const anchor = findAnchor(startDir) ?? path.resolve(startDir);
  const visited = { count: 0 };
  const candidates = [];
  walkDescendants(anchor, 0, candidates, visited);
  if (fs.existsSync(path.join(anchor, WORKSPACE_MARKER))) {
    if (!candidates.find((c) => c.root === anchor)) {
      candidates.unshift({ root: anchor });
    }
  }
  return { anchor, candidates: candidates.map(deriveId) };
}

function walkDescendants(dir, depth, out, visited) {
  if (depth > MAX_DEPTH) return;
  if (++visited.count > MAX_VISITED) {
    const e = new Error(
      `Workspace discovery exceeded ${MAX_VISITED} directories from anchor. ` +
      'Set COMPOSE_TARGET=/absolute/path to bypass discovery.',
    );
    e.code = 'WorkspaceDiscoveryTooBroad';
    throw e;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // EACCES, EPERM, ENOENT (race with rm), ENOTDIR (symlink target gone) —
    // skip silently. Discovery is best-effort; missing perms aren't fatal.
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, WORKSPACE_MARKER))) {
      out.push({ root: child });
    }
    walkDescendants(child, depth + 1, out, visited);
  }
}

/**
 * Resolve {id, root, configPath} for a candidate workspace root.
 * Honors `.compose/compose.json#workspaceId` if it matches the canonical regex;
 * otherwise falls back to path.basename(root).
 *
 * Exported so resolve-workspace.js can derive ids without re-running discovery.
 */
export function deriveId({ root }) {
  const configPath = path.join(root, '.compose', 'compose.json');
  let id = path.basename(root);
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (
      typeof cfg.workspaceId === 'string' &&
      /^[a-z][a-z0-9-]{1,63}$/.test(cfg.workspaceId)
    ) {
      id = cfg.workspaceId;
    }
  } catch {
    // missing/unreadable/malformed → basename is fine
  }
  return { id, root, configPath };
}
