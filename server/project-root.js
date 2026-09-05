/**
 * project-root.js — Resolve COMPOSE_HOME and TARGET_ROOT.
 *
 * COMPOSE_HOME: where Compose's own code lives (server/, node_modules/, etc.)
 * TARGET_ROOT:  the project being developed. Resolved by:
 *   1. COMPOSE_TARGET env var (explicit override)
 *   2. Walk up from cwd looking for .compose/, .stratum.yaml, or .git
 *   3. Fall back to cwd
 *
 * All project paths are accessed via getTargetRoot() / getDataDir() so they
 * update when switchProject() is called at runtime.
 */

import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from './find-root.js';
import { DEFAULT_PATHS, resolvePathValue } from '../lib/paths-core.js';

export { findProjectRoot } from './find-root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where Compose's own code lives. Never changes. */
export const COMPOSE_HOME = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mutable project binding
// ---------------------------------------------------------------------------

let _targetRoot = (() => {
  if (process.env.COMPOSE_TARGET) {
    const resolved = path.resolve(process.env.COMPOSE_TARGET);
    if (!fs.existsSync(resolved)) {
      console.error(`[project-root] COMPOSE_TARGET=${process.env.COMPOSE_TARGET} does not exist`);
      process.exit(1);
    }
    return resolved;
  }
  return findProjectRoot(process.cwd()) || process.cwd();
})();

let _dataDir = path.join(_targetRoot, '.compose', 'data');
let _configCache = null;
const projectContext = new AsyncLocalStorage();

/** Pin a request and all of its asynchronous descendants to one workspace. */
export function withProjectContext(binding, fn) {
  return projectContext.run(binding, fn);
}

/** Keep asynchronous work pinned even when its HTTP client disconnects. */
export async function trackProjectWork(operation) {
  const binding = projectContext.getStore();
  if (!binding) return operation();
  binding.activeWork = (binding.activeWork ?? 0) + 1;
  try { return await operation(); }
  finally { binding.activeWork--; }
}

/** Validate a destination before changing the process default or its services. */
export function prepareProject(newRoot) {
  const targetRoot = path.resolve(newRoot);
  if (!fs.statSync(targetRoot).isDirectory()) throw new Error(`Project path is not a directory: ${targetRoot}`);
  const dataDir = path.join(targetRoot, '.compose', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const config = readProjectConfig(targetRoot, true);
  return { targetRoot, dataDir, config };
}

/** The target project being developed. */
export function getTargetRoot() { return projectContext.getStore()?.targetRoot ?? _targetRoot; }

/** Data directory for Compose state. Lives in the target project. */
export function getDataDir() { return projectContext.getStore()?.dataDir ?? _dataDir; }

let _currentWorkspaceId = null;
export function getCurrentWorkspaceId() { return projectContext.getStore()?.workspaceId ?? _currentWorkspaceId; }
export function setCurrentWorkspaceId(id) { _currentWorkspaceId = id; }

// ---------------------------------------------------------------------------
// Switch project at runtime
// ---------------------------------------------------------------------------

const _switchListeners = [];

/**
 * Register a callback for project switches.
 * @param {(targetRoot: string, dataDir: string) => void} fn
 */
export function onProjectSwitch(fn) {
  _switchListeners.push(fn);
}

/**
 * Switch to a different project directory.
 * @param {string} newRoot — absolute path to the new project
 * @returns {{ targetRoot: string, dataDir: string }}
 */
export function switchProject(newRoot) {
  const prepared = prepareProject(newRoot);
  _targetRoot = prepared.targetRoot;
  _dataDir = prepared.dataDir;
  _configCache = prepared.config;
  _currentWorkspaceId = null;
  console.error(`[project-root] Switched to: ${_targetRoot}`);
  for (const fn of _switchListeners) {
    try { fn(_targetRoot, _dataDir); } catch (e) { console.error('[project-root] Switch listener error:', e.message); }
  }
  return { targetRoot: _targetRoot, dataDir: _dataDir };
}

/** Ensure the data directory exists. */
export function ensureDataDir() {
  fs.mkdirSync(getDataDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  capabilities: Object.freeze({ stratum: true, lifecycle: true }),
  paths: DEFAULT_PATHS,                        // single source of truth (COMP-PATHS-EXTERNAL)
});

function cloneConfig(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function readProjectConfig(root, strict = false) {
  const file = path.join(root, '.compose', 'compose.json');
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('project config must be a JSON object');
    return { ...config, capabilities: { ...DEFAULT_CONFIG.capabilities, ...config.capabilities } };
  } catch (err) {
    if (strict && err.code !== 'ENOENT') {
      // C10: a malformed config is fatal on purpose — silently falling back to
      // defaults switched the workspace into a configuration nobody wrote. Say
      // which file is broken and what to do about it; a bare SyntaxError does
      // neither. A MISSING file is still fine (defaults apply).
      throw Object.assign(
        new Error(`Invalid Compose config at ${file}: ${err.message}. Fix the file or delete it to fall back to defaults.`),
        { code: 'InvalidProjectConfig', file, cause: err },
      );
    }
    return cloneConfig(DEFAULT_CONFIG);
  }
}

export function loadProjectConfig() {
  const context = projectContext.getStore();
  if (context) return cloneConfig(context.config ?? readProjectConfig(context.targetRoot));
  _configCache ??= readProjectConfig(_targetRoot);
  return cloneConfig(_configCache);
}

export function resolveProjectPath(key) {
  const config = loadProjectConfig();
  // resolvePathValue handles in-root / ../-escaping / absolute overrides.
  // Preserve the legacy `|| key` fallback for keys absent from DEFAULT_PATHS.
  // (COMP-PATHS-EXTERNAL)
  const value = config.paths?.[key] ?? DEFAULT_PATHS[key] ?? key;
  return resolvePathValue(getTargetRoot(), value, key);
}

/**
 * Whether the bound workspace runs the lifecycle/vision store.
 *
 * FORGE-ROADMAP-RETIRE-STORE: a workspace sets `capabilities.lifecycle: false`
 * to RETIRE its vision store — used by narrative-owned workspaces (e.g. forge-top)
 * where the prose ROADMAP is the single source of truth and a second, frozen
 * `vision-state.json` would only be a drift-prone parallel answer. Default true
 * (absent ⇒ enabled); only an explicit `false` disables it.
 * @returns {boolean}
 */
export function isLifecycleEnabled() {
  return loadProjectConfig().capabilities?.lifecycle !== false;
}
