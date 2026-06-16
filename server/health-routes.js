/**
 * health-routes.js — Read-only environment-health REST API (COMP-PARITY-3).
 *
 * Route:
 *   GET /api/environment-health — surfaces `compose doctor` (external-dep
 *     presence + version drift) and `compose hooks status` (git-hook drift) as
 *     structured JSON for the cockpit's header health-dot + popover.
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

import {
  loadDeps,
  checkExternalSkills,
  buildDepReport,
  checkExternalBinaries,
  buildBinaryReport,
} from '../lib/deps.js';
import { checkLatestVersion } from '../lib/version-check.js';
import { computeHooksStatus } from '../lib/hooks-status.js';

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
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {string} [deps.packageRoot] — compose package root (default: resolved from this module)
 * @param {string} [deps.composeBin]  — expected COMPOSE_BIN baked in hooks
 * @param {string} [deps.composeNode] — expected COMPOSE_NODE baked in hooks
 */
export function attachHealthRoutes(app, {
  packageRoot = PACKAGE_ROOT,
  composeBin = join(PACKAGE_ROOT, 'bin', 'compose.js'),
  composeNode = process.execPath,
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
}
