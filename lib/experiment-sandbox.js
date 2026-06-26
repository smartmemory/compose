/**
 * experiment-sandbox.js — Provision an isolated sandbox workspace for COMP-MODEL-AB.
 *
 * Each sandbox is a fully isolated environment:
 *   workspace — a git-initialised temp dir (greenfield) or a clone/worktree at
 *               a pinned ref (seeded).
 *   data dir  — <workspace>/.compose/data  (COMPOSE_TARGET points here)
 *   env       — COMPOSE_TARGET + COMPOSE_PORT(=unused) isolate both the data
 *               dir and the vision-state HTTP writes so the live :4001 server
 *               is never touched.
 *
 * CRITICAL isolation proof (design §"Sandbox isolation"):
 *   COMPOSE_TARGET=<workspace>  → getDataDir() resolves to sandbox data dir.
 *   COMPOSE_PORT=<unused>       → VisionWriter's _serverAvailable() probes that
 *                                  dead port, gets ECONNREFUSED, and falls back to
 *                                  direct file writes inside the sandbox — the live
 *                                  :4001 server is never contacted.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Port that will not have a server listening (the sandbox builds must not reach
 * the live vision-state server).  Picking a fixed high port that we never bind
 * is simpler than dynamically finding a free port: ECONNREFUSED is instant.
 */
const SANDBOX_VISION_PORT = 19997;

/**
 * Derive the current Compose git SHA for provenance in manifest.json.
 * Returns 'unknown' if the git call fails (e.g. not in a git repo).
 *
 * @param {string} composePath
 * @returns {string}
 */
function composeSha(composePath) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: composePath,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Provision an isolated sandbox workspace for one experiment run.
 *
 * @param {object} args
 * @param {{ goal: string, seedRepo: string|null, seedRef: string|null }} args.fixture
 *   Fixture definition — seedRepo=null means greenfield (git init empty dir).
 * @param {string}  args.runId    Stable run identifier (e.g. "opus-impl-rep0")
 * @param {string}  args.expRoot  Experiment root directory.
 * @param {string}  [args.composePath]  Path to the Compose source for SHA lookup.
 *
 * @returns {Promise<{
 *   workspace: string,
 *   runDir:    string,
 *   env:       NodeJS.ProcessEnv,
 *   cleanup:   (opts?: { pruneWorkspace?: boolean }) => void,
 * }>}
 *
 * @throws {Error} if workspace provisioning fails (e.g. git operations error)
 */
export async function provision({ fixture, runId, expRoot, composePath }) {
  // Create the per-run output directory
  const runDir = join(expRoot, 'runs', runId);
  mkdirSync(runDir, { recursive: true });

  // Create the workspace
  const workspaceParent = join(runDir, 'workspace-tmp');
  mkdirSync(workspaceParent, { recursive: true });
  let workspace;

  if (!fixture.seedRepo) {
    // Greenfield: git init in a fresh temp dir
    workspace = mkdtempSync(join(workspaceParent, 'ws-'));
    try {
      execSync('git init -q', { cwd: workspace, timeout: 10_000 });
      execSync('git config user.email "compose-experiment@local"', { cwd: workspace, timeout: 5_000 });
      execSync('git config user.name "Compose Experiment"', { cwd: workspace, timeout: 5_000 });
    } catch (err) {
      // Clean up the partially-initialised workspace before re-throwing so
      // provision errors surface cleanly without leaving temp dirs behind.
      try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort */ }
      throw new Error(`Sandbox provision failed: git init in ${workspace}: ${err.message}`);
    }
  } else {
    // Seeded: clone + checkout at pinned ref
    const seedRef = fixture.seedRef ?? 'HEAD';
    workspace = join(workspaceParent, `ws-${runId}`);
    try {
      execSync(`git clone --quiet "${fixture.seedRepo}" "${workspace}"`, { timeout: 60_000 });
      execSync(`git checkout --quiet "${seedRef}"`, { cwd: workspace, timeout: 10_000 });
      execSync('git config user.email "compose-experiment@local"', { cwd: workspace, timeout: 5_000 });
      execSync('git config user.name "Compose Experiment"', { cwd: workspace, timeout: 5_000 });
    } catch (err) {
      try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort */ }
      throw new Error(`Sandbox provision failed: seeded clone of ${fixture.seedRepo}@${seedRef}: ${err.message}`);
    }
  }

  // Ensure the data dir exists (compose build will also create it, but having it
  // pre-created makes it clearer what COMPOSE_TARGET points to).
  const dataDir = join(workspace, '.compose', 'data');
  mkdirSync(dataDir, { recursive: true });

  // Build the env for the sandbox's child build process.
  // COMPOSE_TARGET → data dir isolated to sandbox workspace.
  // COMPOSE_PORT   → dead port so VisionWriter degrades to direct file writes,
  //                  never touching the live :4001 server.
  const env = {
    ...process.env,
    COMPOSE_TARGET: workspace,
    COMPOSE_PORT: String(SANDBOX_VISION_PORT),
  };

  // Write manifest.json for provenance
  const manifest = {
    composeSha: composeSha(composePath ?? resolve(__dirname, '..')),
    fixtureGoal: fixture.goal ?? null,
    seedRef: fixture.seedRef ?? null,
    runId,
    startedAt: new Date().toISOString(),
    endedAt: null,   // caller fills this in after the build
  };
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  /**
   * Cleanup function.
   * @param {{ pruneWorkspace?: boolean }} [opts]
   */
  function cleanup(opts = {}) {
    if (opts.pruneWorkspace && existsSync(workspace)) {
      try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  return { workspace, runDir, env, cleanup };
}
