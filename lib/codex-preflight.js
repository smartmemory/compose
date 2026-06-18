/**
 * COMP-CODEX-IMPL — preflight probe for the Codex-as-implementer path.
 *
 * Codex self-applies a Seatbelt sandbox ([[project_codex_seatbelt_nonnesting]]).
 * Compose's `execute` step runs each task agent inside a *detached git worktree*
 * (`git worktree add --detach`), whose `.git` is a file pointer, not a directory.
 * Whether Codex's Seatbelt tolerates writing inside such a worktree is UNVERIFIED —
 * no Codex+worktree path exists in the repo today (Codex only ever ran read-only
 * reviews with cwd at the repo root). If it cannot, a `--codex` build would
 * hard-fail at `execute`. A runtime warning would only explain that after the fact.
 *
 * So before any real `--codex` work, we probe the exact primitive: create a throwaway
 * detached worktree, have Codex write a sentinel file in it, and verify the write
 * landed. On failure the build aborts fast with an actionable message rather than
 * failing mid-execute. The result is cached per-repo (the primitive doesn't change
 * between builds) and can be skipped via COMPOSE_SKIP_CODEX_PROBE for CI/tests.
 *
 * The proper fix for a probe-fails environment (a Codex `isolation: none` execution
 * path) is deferred to COMP-CODEX-IMPL-SPIKE.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const PROBE_SENTINEL = 'COMPOSE_CODEX_PROBE_OK';
const WORKTREE_BASE = join(homedir(), '.stratum', 'worktrees');
const PROBE_CACHE = 'codex-worktree-probe.json';
// Bound the probe's agent run so a wedged Codex CLI can't hang the whole build
// before the flow even starts. On timeout we reject → the finally cleanup runs.
const PROBE_AGENT_TIMEOUT_MS = 180_000;

function cachePath(dataDir) {
  return join(dataDir, PROBE_CACHE);
}

export function readProbeCache(dataDir) {
  try {
    return JSON.parse(readFileSync(cachePath(dataDir), 'utf-8'));
  } catch {
    return null;
  }
}

export function writeProbeCache(dataDir, result) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cachePath(dataDir), JSON.stringify(result, null, 2));
  } catch { /* best-effort cache; a miss just re-probes */ }
}

function isGitRepo(cwd) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify Codex can write inside a detached git worktree under its sandbox.
 *
 * @param {object} args
 * @param {string} args.cwd       repo working directory
 * @param {object} args.stratum   stratum client (uses runAgentText('codex', ...))
 * @param {string} args.dataDir   .compose/data dir for the per-repo cache
 * @param {string} args.ts        caller-supplied timestamp string (unique worktree name)
 * @param {boolean} [args.force]  ignore the cache and re-probe
 * @returns {Promise<{ok: boolean, reason: string, cached?: boolean, skipped?: boolean}>}
 */
export async function preflightCodexWorktreeProbe({ cwd, stratum, dataDir, ts, force = false }) {
  if (process.env.COMPOSE_SKIP_CODEX_PROBE) {
    return { ok: true, skipped: true, reason: 'COMPOSE_SKIP_CODEX_PROBE set — probe skipped' };
  }
  if (!force) {
    const cached = readProbeCache(dataDir);
    if (cached && cached.ok === true) return { ...cached, cached: true };
  }
  // Not a git repo → the execute step won't create worktrees (useWorktrees gates on
  // isGitRepo), so there is no worktree primitive to probe. Treat as a pass.
  if (!isGitRepo(cwd)) {
    return { ok: true, reason: 'not a git repo — worktree isolation is not used, nothing to probe' };
  }

  try { mkdirSync(WORKTREE_BASE, { recursive: true }); } catch { /* best-effort */ }
  const wtPath = join(WORKTREE_BASE, `codex-probe-${ts}`);

  // Create the detached worktree (the exact primitive the execute step uses).
  try {
    execSync(`git worktree add "${wtPath}" --detach HEAD`, {
      cwd, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
    });
  } catch (err) {
    try { execSync(`rm -rf "${wtPath}"`, { encoding: 'utf-8', timeout: 10_000 }); } catch { /* best-effort */ }
    const result = { ok: false, reason: `could not create a probe worktree: ${err?.message ?? err}` };
    writeProbeCache(dataDir, result);
    return result;
  }

  // Unique per-run filename so a file committed in the repo (carried into the
  // detached worktree from HEAD) can never make the probe false-pass.
  const probeName = `codex-probe-${ts}.txt`;
  try {
    const prompt =
      `Write a file named ${probeName} in the current working directory whose exact ` +
      `contents are the single line: ${PROBE_SENTINEL}\n` +
      `Do nothing else. This is an environment write-probe.`;
    try {
      // Bound the agent run — a hang here would otherwise stall the build and skip
      // the finally cleanup. On timeout the race rejects and we fall to the catch.
      await Promise.race([
        stratum.runAgentText('codex', prompt, { cwd: wtPath }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`probe timed out after ${PROBE_AGENT_TIMEOUT_MS}ms`)), PROBE_AGENT_TIMEOUT_MS).unref?.()
        ),
      ]);
    } catch (err) {
      const result = { ok: false, reason: `Codex agent run failed/timed out inside the worktree: ${err?.message ?? err}` };
      writeProbeCache(dataDir, result);
      return result;
    }
    const probeFile = join(wtPath, probeName);
    let landed = false;
    try {
      landed = existsSync(probeFile) && readFileSync(probeFile, 'utf-8').includes(PROBE_SENTINEL);
    } catch { landed = false; }
    const result = landed
      ? { ok: true, reason: 'Codex wrote the sentinel inside a detached worktree' }
      : { ok: false, reason: 'Codex did not write the sentinel file inside the detached worktree (likely a Seatbelt/worktree write restriction)' };
    writeProbeCache(dataDir, result);
    return result;
  } finally {
    try {
      execSync(`git worktree remove "${wtPath}" --force`, { cwd, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' });
    } catch {
      try { execSync(`rm -rf "${wtPath}"`, { encoding: 'utf-8', timeout: 10_000 }); } catch { /* give up */ }
    }
  }
}

/** The actionable abort message when the probe fails. */
export function codexProbeAbortMessage(reason) {
  return (
    `--codex aborted: Codex cannot write inside a detached git worktree in this environment.\n` +
    `  Reason: ${reason}\n` +
    `  This is the known COMP-CODEX-IMPL-SPIKE limitation (Codex Seatbelt vs worktree isolation).\n` +
    `  Re-run without --codex (Claude implements), or set COMPOSE_SKIP_CODEX_PROBE=1 to bypass the\n` +
    `  probe at your own risk. A Codex isolation:none execution path is tracked as the follow-up.`
  );
}
