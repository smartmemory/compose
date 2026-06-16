/**
 * health-routes.js — Read-only environment-health REST API (COMP-PARITY-3).
 *
 * Routes:
 *   GET  /api/environment-health — surfaces `compose doctor` (external-dep
 *     presence + version drift) and `compose hooks status` (git-hook drift) as
 *     structured JSON for the cockpit's header health-dot + popover.
 *   POST /api/environment-health/repair-hooks (COMP-PARITY-3-1) — guarded,
 *     local, idempotent remediation: runs `compose hooks install --post-commit
 *     --pre-push --workspace=<id>` (+ `--force` when body.force) in the request
 *     workspace, then returns the recomputed hook states. Mutating → gated by
 *     requireSensitiveOrPaired. Dependency installs and `compose update` are
 *     deliberately NOT executed server-side (the panel surfaces command text).
 *
 * Deliberately NOT under `/api/health/*`: that prefix is in the remote auth
 * allowlist (server/index.js + auth-middleware.js prefix-match), so nesting
 * here would make local dependency inventory and `?refresh` registry fetches
 * publicly reachable in remote mode. This path is non-allowlisted → default-deny
 * in remote mode (sensitive token / paired JWT), open on localhost.
 *
 * Degrade-never-fail: each section is computed defensively; a failing sub-check
 * becomes `{ unavailable: true }` (deps/binaries/hooks) or `null` (version).
 * The endpoint never 500s on a sub-check.
 *
 * Reuses (no logic fork):
 *   - lib/deps.js          — dep/binary presence (off the compose PACKAGE_ROOT)
 *   - lib/version-check.js — version drift (off PACKAGE_ROOT + homedir cache)
 *   - lib/hooks-status.js  — git-hook drift (off the request's workspace root)
 */
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  loadDeps,
  checkExternalSkills,
  buildDepReport,
  checkExternalBinaries,
  buildBinaryReport,
} from '../lib/deps.js';
import { checkLatestVersion } from '../lib/version-check.js';
import { computeHooksStatus } from '../lib/hooks-status.js';
import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';

/** The compose package root (where .compose-deps.json + package.json live). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Map a raw hook status (from computeHooksStatus) to the API-facing shape.
 * The key honesty rule: an installed-current hook whose workspace id could not
 * be verified (expectedWsId was null) is reported as `workspace-unverified`,
 * never a false `installed-current`.
 */
export function hookRawToApi(raw) {
  if (!raw || typeof raw !== 'object') return { state: 'unavailable' };
  if (raw.state === 'installed-current') {
    return raw.wsVerified
      ? { state: 'installed-current', workspace: raw.bakedWorkspace ?? null }
      : { state: 'workspace-unverified' };
  }
  if (raw.state === 'installed-stale') {
    const out = { state: 'installed-stale', reason: raw.reason ?? null };
    if (raw.reason === 'STALE_WORKSPACE_ID') out.expected = { workspaceId: raw.expectedWorkspace ?? null };
    return out;
  }
  return { state: raw.state }; // 'absent' | 'foreign'
}

/**
 * Worst-wins summary rollup driving the header dot color.
 *   error: any required dep/binary missing OR any hook `foreign`
 *   warn:  version behind OR hook installed-stale/workspace-unverified OR
 *          optional dep/binary missing OR a section is unavailable
 *   ok:    everything present/current/up-to-date (version null & hook absent are neutral)
 */
export function rollupSummary({ dependencies, binaries, version, hooks }) {
  let error = false;
  let warn = false;

  for (const section of [dependencies, binaries]) {
    if (!section) continue;
    if (section.unavailable) {
      warn = true;
      continue;
    }
    for (const d of section.missing || []) {
      if (d.optional) warn = true;
      else error = true;
    }
  }

  if (version && version.behind) warn = true;

  if (hooks && hooks.unavailable) {
    warn = true;
  } else {
    for (const h of Object.values(hooks || {})) {
      if (h?.state === 'foreign') error = true;
      else if (h?.state === 'installed-stale' || h?.state === 'workspace-unverified') warn = true;
    }
  }

  return error ? 'error' : warn ? 'warn' : 'ok';
}

/**
 * Default command runner: spawn `node <composeBin> <args...>` synchronously in
 * the given cwd. Injectable via attachHealthRoutes so tests can stub it without
 * shelling out. Returns a normalized `{ status, stdout, stderr, error }` so the
 * route never has to know about spawnSync's shape and never throws on failure.
 *
 * @param {object} opts
 * @param {string} opts.composeNode — node binary to run compose with
 * @param {string} opts.composeBin  — path to bin/compose.js
 * @param {string[]} opts.args      — compose CLI args (e.g. ['hooks','install',…])
 * @param {string} opts.cwd         — working directory (the workspace root)
 * @returns {{status:number|null, stdout:string, stderr:string, error:string|null}}
 */
function defaultRunCommand({ composeNode, composeBin, args, cwd }) {
  const r = spawnSync(composeNode, [composeBin, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.message : null,
  };
}

/**
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {string} [deps.packageRoot] — compose package root (default: resolved from this module)
 * @param {string} [deps.composeBin]  — expected COMPOSE_BIN baked in hooks
 * @param {string} [deps.composeNode] — expected COMPOSE_NODE baked in hooks
 * @param {Function} [deps.runCommand] — injectable command runner (default: spawnSync-based)
 */
export function attachHealthRoutes(app, {
  packageRoot = PACKAGE_ROOT,
  composeBin = join(PACKAGE_ROOT, 'bin', 'compose.js'),
  composeNode = process.execPath,
  runCommand = defaultRunCommand,
} = {}) {
  app.get('/api/environment-health', async (req, res) => {
    // --- dependencies + binaries (compose install) ---------------------------
    let dependencies;
    let binaries;
    const deps = safe(() => loadDeps(packageRoot), null);
    if (!deps) {
      // loadDeps returns null (not throws) on a missing/invalid manifest — must
      // branch explicitly; the checkers would throw or mislead on a null deps.
      dependencies = { unavailable: true };
      binaries = { unavailable: true };
    } else {
      dependencies = safe(() => {
        // Drop scannedPaths — it leaks absolute host filesystem paths
        // (e.g. ~/.claude/...) the UI doesn't need; this route is remotely
        // reachable when paired. The contract is {present, missing}.
        const { scannedPaths, ...rest } = buildDepReport(checkExternalSkills(deps));
        return rest;
      }, { unavailable: true });
      binaries = safe(() => buildBinaryReport(checkExternalBinaries(deps)), { unavailable: true });
    }

    // --- version drift (compose install + homedir cache) ---------------------
    let version = null;
    try {
      const current = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')).version;
      version = await checkLatestVersion(current, { force: req.query.refresh === '1' });
    } catch {
      version = null;
    }

    // --- git hooks (this request's workspace) --------------------------------
    let hooks;
    try {
      const root = req.workspace?.root;
      if (!root) throw new Error('no workspace root');
      const raw = computeHooksStatus({
        projectRoot: root,
        expectedWsId: req.workspace?.id ?? null,
        composeNode,
        composeBin,
      });
      hooks = {};
      for (const [type, r] of Object.entries(raw)) hooks[type] = hookRawToApi(r);
    } catch {
      hooks = { unavailable: true };
    }

    const summary = rollupSummary({ dependencies, binaries, version, hooks });
    res.json({ summary, dependencies, binaries, version, hooks });
  });

  // --- POST /api/environment-health/repair-hooks (COMP-PARITY-3-1) ----------
  // Guarded, local, idempotent remediation. Only the hook repair is executed
  // server-side; dependency installs and `compose update` are intentionally NOT
  // run here (the panel surfaces their command text instead).
  app.post('/api/environment-health/repair-hooks', requireSensitiveToken, (req, res) => {
    const root = req.workspace?.root;
    const wsId = req.workspace?.id ?? null;
    if (!root) {
      // No workspace to operate in — a guarded failure, not a 500.
      return res.json({ ok: false, error: 'no workspace root', stderr: '' });
    }

    const force = req.body && req.body.force === true;
    const args = ['hooks', 'install', '--post-commit', '--pre-push'];
    if (wsId != null) args.push(`--workspace=${wsId}`);
    if (force) args.push('--force');
    const ranCommand = `compose ${args.join(' ')}`;

    // Run the repair. The runner normalizes spawnSync's shape and never throws;
    // a non-zero exit / spawn error becomes { ok:false }, never a 500.
    let result;
    try {
      result = runCommand({ composeNode, composeBin, args, cwd: root });
    } catch (e) {
      return res.json({ ok: false, error: e?.message || 'command failed', stderr: '' });
    }

    const failed = result.error != null || (result.status != null && result.status !== 0);
    if (failed) {
      return res.json({
        ok: false,
        error: result.error || `compose hooks install exited with status ${result.status}`,
        stderr: result.stderr || '',
        ranCommand,
      });
    }

    // Recompute hook states so the panel can refresh from the response (or refetch).
    let hooks;
    try {
      const raw = computeHooksStatus({
        projectRoot: root,
        expectedWsId: wsId,
        composeNode,
        composeBin,
      });
      hooks = {};
      for (const [type, r] of Object.entries(raw)) hooks[type] = hookRawToApi(r);
    } catch {
      hooks = { unavailable: true };
    }

    res.json({ ok: true, ranCommand, hooks });
  });
}
