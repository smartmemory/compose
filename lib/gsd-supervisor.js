// lib/gsd-supervisor.js
//
// COMP-GSD-6 S06: the `--headless` supervisor. An outer loop that owns child
// run attempts — a self-resuming in-process loop can't survive a hard crash, so
// the supervisor spawns each attempt and re-spawns on a recoverable non-clean
// exit with exponential backoff and per-kind attempt caps.
//
// Classification is driven by the TERMINAL state.json status (not exit code
// alone): complete | stuck | budget | failed | crashed | (no-state ⇒ fatal).
// Budget never auto-resumes unless explicitly opted in (protects the GSD-4
// ceiling). A crash re-spawns --resume only when resumeReady, else fresh.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGsdState, deriveRunStatus } from './gsd-state.js';
import { readHeadlessConfig, backoffMs } from './gsd-headless-config.js';

const COMPOSE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'compose.js');

// Map a derived run status to a recovery decision. Pure — takes the per-kind
// retry counts already consumed, returns what the loop should do next.
//
// Returns one of:
//   { terminal: true,  status }                          — done / non-recoverable
//   { terminal: false, status, kind, mode, capExhausted } — retry (or capped)
export function classifyOutcome(derivedStatus, state, cfg, counts) {
  switch (derivedStatus) {
    case 'complete':
      return { terminal: true, status: 'complete', ok: true };
    case 'failed':
      // Orderly fatal exit (dirty workspace, parse error) — re-running re-fails.
      return { terminal: true, status: 'failed', ok: false };
    case 'absent':
      // No running checkpoint was ever written → a pre-checkpoint failure
      // (bad args, dirty tree before planning). Non-recoverable by absence.
      return { terminal: true, status: 'fatal', ok: false };
    case 'stuck':
      return retryDecision('stuck', 'stuck', 'resume', cfg, counts);
    case 'budget':
      return retryDecision('budget', 'budget', 'resume', cfg, counts);
    case 'crashed': {
      // resumeReady gates --resume (task graph exists) vs fresh restart
      // (crashed during plan/decompose — nothing merged yet).
      const mode = state?.resumeReady ? 'resume' : 'fresh';
      return retryDecision('crash', 'crashed', mode, cfg, counts);
    }
    default:
      // running with a live pid after the child exited shouldn't happen.
      return { terminal: true, status: derivedStatus ?? 'unknown', ok: false };
  }
}

function retryDecision(policyKey, status, mode, cfg, counts) {
  const policy = cfg.autoResume[policyKey];
  if (!policy || !policy.enabled) {
    return { terminal: true, status, ok: false, reason: 'auto-resume disabled' };
  }
  const used = counts[policyKey] ?? 0;
  if (used >= policy.maxAttempts) {
    return { terminal: true, status, ok: false, reason: 'maxAttempts exhausted', capExhausted: true };
  }
  return { terminal: false, status, kind: policyKey, mode };
}

// Default real spawner — runs a PLAIN `compose gsd <feature> [--resume]` child
// (NOT --headless: that would recurse into another supervisor). Resolves with
// { code, signal } on exit.
function defaultSpawnRun({ feature, resume, cwd, attempt }) {
  return new Promise((resolve) => {
    const args = [COMPOSE_BIN, 'gsd', feature];
    if (resume) args.push('--resume');
    if (cwd) args.push('--cwd', cwd);
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, GSD_HEADLESS_ATTEMPT: String(attempt) },
    });
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => resolve({ code: 1, signal: null, error: err }));
  });
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The supervisor loop. opts.spawnRun / opts.sleep are injectable for tests.
// Returns { status, attempts, history }.
export async function runGsdHeadless(feature, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = opts.config ?? readHeadlessConfig(cwd);
  const spawnRun = opts.spawnRun ?? defaultSpawnRun;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((m) => console.error(`[gsd-headless] ${m}`));
  const maxTotalAttempts = opts.maxTotalAttempts ?? 50; // hard backstop

  const counts = { crash: 0, stuck: 0, budget: 0 };
  const history = [];
  let mode = opts.resume ? 'resume' : 'fresh';
  let attempt = 0;

  while (attempt < maxTotalAttempts) {
    attempt += 1;
    log(`attempt ${attempt} (${mode})`);
    const exit = await spawnRun({ feature, resume: mode === 'resume', cwd, attempt });
    const state = readGsdState(cwd, feature);
    const { status: derived } = deriveRunStatus(state, { staleMs: cfg.heartbeatStaleMs });
    const outcome = classifyOutcome(derived, state, cfg, counts);
    history.push({ attempt, mode, exitCode: exit.code ?? null, derived, outcome: outcome.status });

    if (outcome.terminal) {
      if (outcome.ok) log(`run complete after ${attempt} attempt(s)`);
      else log(`stopping: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`);
      return { status: outcome.status, ok: !!outcome.ok, attempts: attempt, history };
    }

    // Recoverable — consume a retry for this kind, back off, re-spawn.
    counts[outcome.kind] += 1;
    mode = outcome.mode;
    const wait = backoffMs(cfg, counts[outcome.kind]);
    log(`recovering ${outcome.status} via ${mode} (retry ${counts[outcome.kind]}); backoff ${wait}ms`);
    await sleep(wait);
  }

  log(`hit maxTotalAttempts (${maxTotalAttempts}) — giving up`);
  return { status: 'aborted', ok: false, attempts: attempt, history };
}
