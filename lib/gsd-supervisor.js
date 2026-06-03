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

import { buildGsdQuery, pidAlive, clearGsdPause } from './gsd-state.js';
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

// Abort-aware, unref'd sleep for the watchdog poll: resolves immediately when the
// signal aborts (so a clean child exit doesn't leave the supervisor waiting a full
// poll interval) and never holds the process open (unref).
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// COMP-GSD-6-WATCHDOG: poll the child's state.json for a HUNG run — heartbeat
// frozen on a still-alive pid. Resolves the hung snapshot, or null when aborted
// (the child exited first). Requires the child's independent heartbeat timer
// (gsd.js) for `heartbeatStale` to be a sound signal.
//
// Confirm-poll: declares hung only after TWO consecutive stale polls with an
// UNCHANGED heartbeatAt. A host suspend / forward clock jump can momentarily make
// `now - heartbeatAt > staleMs` true before the just-woken child re-stamps its
// heartbeat; requiring the heartbeat to stay frozen across two polls lets a
// healthy child clear the alarm, so only a truly wedged loop is killed.
export async function defaultWatch({ feature, cwd, cfg, signal, sleep, buildQuery }) {
  const query = buildQuery ?? buildGsdQuery;
  // Default to an abort-aware unref'd sleep so a clean exit ends the poll at once
  // and the timer never holds the process open. Tests inject an instant sleep.
  const nap = sleep ?? ((ms) => abortableSleep(ms, signal));
  let prevHb = null;
  while (!signal.aborted) {
    await nap(cfg.watchdogPollMs);
    if (signal.aborted) return null;
    const s = query(cwd, feature, { staleMs: cfg.heartbeatStaleMs });
    if (s.status === 'running' && s.heartbeatStale) {
      if (prevHb !== null && s.heartbeatAt === prevHb) return s; // frozen across 2 polls → hung
      prevHb = s.heartbeatAt;
    } else {
      prevHb = null; // healthy, or heartbeat advanced (suspend/wake) → reset
    }
  }
  return null;
}

// COMP-GSD-6-WATCHDOG: kill a hung child by pid. SIGTERM, wait the grace window,
// then SIGKILL if it's still alive. The supervisor never holds the child handle
// (defaultSpawnRun discards it), so the kill is pid-based. Best-effort: a child
// that already exited (ESRCH) is fine.
export async function defaultKillChild(pid, cfg, deps = {}) {
  if (!pid) return;
  const kill = deps.kill ?? process.kill.bind(process);
  const nap = deps.sleep ?? defaultSleep;
  const alive = deps.isAlive ?? pidAlive;
  try { kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  await nap(cfg.watchdogKillGraceMs);
  if (alive(pid)) {
    try { kill(pid, 'SIGKILL'); } catch { /* gone during grace */ }
  }
}

// The supervisor loop. opts.spawnRun / opts.sleep are injectable for tests.
// Returns { status, attempts, history }.
export async function runGsdHeadless(feature, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = opts.config ?? readHeadlessConfig(cwd);
  const spawnRun = opts.spawnRun ?? defaultSpawnRun;
  const sleep = opts.sleep ?? defaultSleep;
  const watch = opts.watch ?? defaultWatch;          // COMP-GSD-6-WATCHDOG
  const killChild = opts.killChild ?? defaultKillChild;
  const log = opts.log ?? ((m) => console.error(`[gsd-headless] ${m}`));
  const maxTotalAttempts = opts.maxTotalAttempts ?? 50; // hard backstop

  const counts = { crash: 0, stuck: 0, budget: 0, hung: 0 };
  const history = [];
  let mode = opts.resume ? 'resume' : 'fresh';
  let attempt = 0;

  while (attempt < maxTotalAttempts) {
    attempt += 1;
    log(`attempt ${attempt} (${mode})`);

    // COMP-GSD-6-WATCHDOG: race the child's exit against the hung watchdog. When
    // the watchdog wins, kill+reap the child and classify as a 'hung' recovery.
    // When the watchdog is disabled, this degrades to the plain `await spawnRun`.
    const exitP = spawnRun({ feature, resume: mode === 'resume', cwd, attempt });
    let exit, snap, outcome;
    const hungPolicy = cfg.autoResume.hung;

    if (hungPolicy && hungPolicy.enabled) {
      const ac = new AbortController();
      // No `sleep` passed → defaultWatch uses its abort-aware unref'd poll sleep.
      const watchP = watch({ feature, cwd, cfg, signal: ac.signal });
      const raced = await Promise.race([
        exitP.then((e) => ({ type: 'exit', exit: e })),
        watchP.then((s) => (s ? { type: 'hung', snap: s } : { type: 'idle' })),
      ]);
      if (raced.type === 'hung') {
        log(`watchdog: hung run (heartbeat frozen, pid ${raced.snap.pid}) — killing`);
        await killChild(raced.snap.pid, cfg);
        exit = await exitP;                          // reap the killed child
        clearGsdPause(cwd, feature);                 // crash-bridge uses current state.json
        const m = raced.snap.resumeReady ? 'resume' : 'fresh';
        snap = { status: 'hung' };
        outcome = retryDecision('hung', 'hung', m, cfg, counts);
      } else {
        ac.abort();                                  // stop the watcher; exit won
        exit = raced.exit;
      }
    } else {
      exit = await exitP;                            // watchdog off → today's path
    }

    if (!outcome) {
      // Classify via the full query precedence (state.json -> pause.json ->
      // budget.json -> absent), NOT raw state alone, so a pre-dispatch cumulative-
      // budget refusal (budget.json, no state.json) is seen as 'budget', not
      // 'absent'. The snapshot also carries resumeReady for the crashed branch.
      snap = buildGsdQuery(cwd, feature, { staleMs: cfg.heartbeatStaleMs });
      outcome = classifyOutcome(snap.status, snap, cfg, counts);
    }
    history.push({ attempt, mode, exitCode: exit.code ?? null, derived: snap.status, outcome: outcome.status });

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
