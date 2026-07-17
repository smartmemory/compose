// lib/gsd.js
//
// COMP-GSD-2 T6: runGsd lifecycle entry — `compose gsd <featureCode>`.
//
// Self-contained status loop. Does NOT modify lib/build.js. Reuses primitives:
//   - StratumMcpClient (lib/stratum-mcp-client.js) for plan/stepDone/runAgentText
//   - executeParallelDispatchServer (lib/build.js) for the execute step
//   - validateBoundaryMap (lib/boundary-map.js) for precondition check
//   - enrichTaskGraph (lib/gsd-decompose-enrich.js) for decompose validation
//   - buildTaskDescription (lib/gsd-prompt.js) for description repair fallback
//   - gsd-blackboard.writeAll for post-step finalization
//
// V1 limitation: runtime task-to-task handoff is not implemented; tasks see
// only spec-level upstream context (Boundary Map declarations) per blueprint.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

import { StratumMcpClient } from './stratum-mcp-client.js';
import { validateBoundaryMap } from './boundary-map.js';
import { enrichTaskGraph } from './gsd-decompose-enrich.js';
import { buildTaskDescription } from './gsd-prompt.js';
import { writeAll, validate as validateTaskResult, read as readBlackboard } from './gsd-blackboard.js';
import { executeParallelDispatchServer, executeShipStep, runConsumerIssuance, ConsumerStuckError, filesOwnedConflict, toEngineUsage } from './build.js';
import {
  ConsumerFanoutArtifacts,
  ConsumerMergeDecisionError,
  isConsumerDescriptor,
} from './consumer-fanout.js';
import { GsdStuckDetector, DEFAULT_THRESHOLDS } from './gsd-stuck.js';
import { readGsdBudgetConfig, buildBudgetBlock, injectBudget, composeBudgetDiagnostic, budgetStateFromLedger } from './gsd-budget.js';
import { recordGsdUsage, checkGsdCumulativeBudget } from './budget-ledger.js';
// COMP-GSD-6: continuous run-state checkpoint + canonical pid-liveness probe.
// pidAlive is canonical in gsd-state.js (EPERM=alive) and imported one-way here.
import { writeGsdState, readGsdState, gsdStatePath, pidAlive, clearGsdHaltArtifacts } from './gsd-state.js';
import { generateGsdMilestoneReport } from './gsd-milestone-report.js';
import { readHeadlessConfig } from './gsd-headless-config.js';
import { appendGsdEvent, clearGsdEvents } from './gsd-events.js';
import { resolveFeaturesPath } from './project-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');

const DEFAULT_GATE_COMMANDS = ['pnpm lint', 'pnpm build', 'pnpm test'];
// COMP-PAR-MERGE-QUEUE: the fast per-task pre-merge gate (lint + build, no full
// test suite). Enforced in each task's worktree before its diff merges; the full
// `pnpm test` runs once at ship_gsd. Single-sourced into both the enforced gate
// (execute.pre_merge_verify) and the instructed gate (task descriptions).
const DEFAULT_FAST_GATE = ['pnpm lint', 'pnpm build'];

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

// ---------- Public API ----------

export async function runGsd(featureCode, opts = {}) {
  if (!featureCode || typeof featureCode !== 'string') {
    throw new Error('runGsd: featureCode required');
  }
  const cwd = opts.cwd ?? process.cwd();

  // COMP-GSD-6: a FRESH (non-resume) run must not inherit a prior run's
  // state.json. Clear it up front so that if a precondition below throws BEFORE
  // the planning checkpoint, NO running state remains → the headless supervisor
  // (and `query`) read 'absent' → fatal-by-absence, never a stale 'complete'
  // success. A resume keeps the old state.json (the crash-bridge may need it).
  if (!opts.resume) {
    try { rmSync(gsdStatePath(cwd, featureCode), { force: true }); } catch { /* ignore */ }
  }

  // 1. Validate preconditions: blueprint exists + Boundary Map ok
  const blueprintPath = join(resolveFeaturesPath(cwd), featureCode, 'blueprint.md');
  if (!existsSync(blueprintPath)) {
    throw new Error(
      `runGsd: blueprint missing at ${blueprintPath}. ` +
        `Run \`compose build ${featureCode}\` to generate it, or author it by hand.`,
    );
  }
  const blueprintText = readFileSync(blueprintPath, 'utf-8');
  const bmResult = validateBoundaryMap({
    blueprintText,
    blueprintPath,
    repoRoot: cwd,
  });
  if (!bmResult.ok) {
    const summary = bmResult.violations
      .slice(0, 5)
      .map((v) => `${v.kind}: ${v.message}`)
      .join('\n  - ');
    throw new Error(
      `runGsd: Boundary Map invalid in ${blueprintPath}:\n  - ${summary}`,
    );
  }

  // 2. COMP-GSD-5 resume branch — runs BEFORE the dirty-tree check so a
  // pid/mode-guard failure (the more specific precondition) is reported first.
  // --resume reads pause.json, guards on ownership (no live pid) +
  // mode==='gsd' (mirrors `compose fix --resume`), and seeds a precomputed task
  // graph = decomposedTasks MINUS completedTaskIds so the execute step
  // re-dispatches only the unfinished work. Completed results already live in
  // the blackboard. resumeTaskGraph (when set) makes runOneStep skip the
  // decompose agent entirely → stable task IDs, no re-decompose.
  // COMP-GSD-4: read+guard the resume graph here for guard-ordering, but DEFER
  // the atomic pause.lock claim (claim:false) — runGsd claims inside its try so
  // the finally always releases it (no strand on re-halt/refusal/throw).
  let resumeTaskGraph = null;
  if (opts.resume) {
    resumeTaskGraph = loadResumeTaskGraph(cwd, featureCode, { claim: false });
  }

  // 3. Refuse to start in a dirty workspace BEFORE any Stratum side effects.
  // v1 rationale: alternatives (baseline subtract + post-execute delta) drop
  // legitimate edits to pre-existing dirty files. Refuse-if-dirty makes
  // post-execute dirty set unambiguous: every entry is GSD-produced.
  //
  // On --resume the GSD control plane (.compose/gsd/<feature>/) legitimately
  // carries the prior run's pause.json/blackboard.json/results — that's the
  // resume STATE, not an unrelated edit — so exclude it from the dirty set.
  if (!opts.allowDirtyWorkspace) {
    let startingDirty = collectChangedFiles(cwd);
    if (opts.resume) {
      const ctrlPrefix = `.compose/gsd/${featureCode}/`;
      startingDirty = startingDirty.filter((f) => !f.startsWith(ctrlPrefix));
    }
    if (startingDirty.length > 0) {
      throw new Error(
        `runGsd: working tree must be clean to ensure ship_gsd stages only GSD-produced changes. ` +
          `Dirty files: ${startingDirty.slice(0, 5).join(', ')}${startingDirty.length > 5 ? `, +${startingDirty.length - 5} more` : ''}. ` +
          `Commit or stash and re-run, or pass {allowDirtyWorkspace: true} (advanced; risks staging unrelated edits).`,
      );
    }
  }

  // 4. Resolve gateCommands. loadProjectConfig() does not merge defaults, so
  // explicit fallback here.
  const gateCommands = resolveGateCommands(cwd, opts.gateCommands);
  // COMP-PAR-MERGE-QUEUE: the fast per-task pre-merge gate (lint+build).
  const preMergeGate = resolvePreMergeGate(cwd, opts.preMergeGate);

  // 4. Load pipeline spec
  const specPath = join(PACKAGE_ROOT, 'pipelines', 'gsd.stratum.yaml');
  // 4a. COMP-GSD-4: inject the stratum flow budget block from `gsd.budget.*`.
  // injectBudget is IDENTITY when nothing is configured, so an un-budgeted gsd
  // run (and plain `compose build`) is byte-identical.
  const budgetCfg = readGsdBudgetConfig(cwd);
  const specYaml = injectBudget(readFileSync(specPath, 'utf-8'), budgetCfg);
  const localSpec = YAML.parse(specYaml);
  const localSpecDigest = sha256(JSON.stringify(localSpec));

  // 4a. COMP-GSD-4: cumulative cross-session ceiling pre-check (tokens/cost).
  // Refuse to start/resume a run that has already spent its lifetime budget —
  // re-dispatching would immediately re-trip. Runs before the try, so no
  // pause.lock is held yet (the claim is the first statement inside the try).
  const cumulative = buildBudgetBlock(budgetCfg).cumulative;
  if (cumulative) {
    const chk = checkGsdCumulativeBudget(join(cwd, '.compose'), featureCode, cumulative);
    if (chk.exceeded) {
      writeCumulativeRefusal(cwd, featureCode, chk, cumulative);
      return { status: 'budget', flowId: null, axis: 'cumulative', reason: chk.reason };
    }
  }

  // 4b. COMP-GSD-5 stuck detector — thresholds from .compose/compose.json
  // `gsd.stuck.*` with documented defaults. ONLY gsd passes this into the
  // shared executeParallelDispatchServer, so build mode is byte-identical.
  const stuckDetector = buildStuckDetector(cwd);

  // 5. Connect Stratum + plan (only after preconditions pass)
  const stratum = opts.stratum ?? new StratumMcpClient();
  const ownsStratum = !opts.stratum;
  if (ownsStratum) await stratum.connect();
  // COMP-GSD-4: ownership flag — release the resume lock in finally ONLY if THIS
  // process successfully claimed it (set below). Prevents (a) a non-resume run
  // from clobbering a concurrent resume's valid claim and (b) a claim-race loser
  // (EEXIST) from deleting the winner's lock on its way out.
  let lockClaimed = false;
  let runLockClaimed = false;
  // COMP-GSD-6: the in-memory run-state, threaded through stepCtx and flushed to
  // state.json. Declared here so the catch/finally can read it.
  let stepCtx = null;
  // COMP-GSD-6-WATCHDOG: independent wall-clock heartbeat timer (see below).
  // Declared here so the finally can always clear it.
  let heartbeatTimer = null;
  try {
    // COMP-GSD-6: claim the live-run lock BEFORE any stratum side effect, so two
    // fresh `compose gsd <same-feature>` runs can't race the results dir. Takes
    // over a stale lock (dead owner) and refuses a live one.
    claimRunLock(cwd, featureCode);
    runLockClaimed = true;

    // COMP-GSD-4: claim the resume lock HERE (first statement in the try) so the
    // finally releases it on EVERY exit — budget/stuck re-halt, throw, or clean
    // finish. loadResumeTaskGraph above already read+guarded (claim:false).
    if (opts.resume) {
      claimResumeLock(cwd, featureCode); // throws EEXIST → finally sees lockClaimed=false
      lockClaimed = true;
    }

    // COMP-GSD-6: pre-plan "planning" checkpoint. A crash during plan/decompose
    // now leaves a dead-pid state.json — the failed-vs-fatal boundary. A throw
    // BEFORE this point (preconditions) leaves no running state → fatal by
    // absence; a throw AFTER → the catch converts it to status:"failed".
    // On resume, seed the planning checkpoint from the (in-memory) resume graph
    // so that if THIS resume re-crashes before its decompose step repopulates
    // state.json, the crash-bridge still has a task graph to recover from
    // (otherwise the fresh empty checkpoint would clobber the prior good data).
    const resumeTasks = opts.resume ? (resumeTaskGraph?.tasks ?? []).map((t) => ({ ...t })) : [];
    const initialState = {
      feature: featureCode,
      flowId: null,
      pid: process.pid,
      mode: 'gsd',
      phase: 'planning',
      status: 'running',
      startedAt: new Date().toISOString(),
      headless: !!opts.headless,
      attempt: opts.attempt ?? 1,
      resumeReady: opts.resume && resumeTasks.length > 0,
      decomposedTasks: resumeTasks,
      completedTaskIds: collectCompletedTaskIds(cwd, featureCode),
    };

    // Track files merged into the base cwd by the execute step so ship_gsd
    // can stage them. executeShipStep's default filter only stages feature
    // docs unless context.filesChanged is provided.
    stepCtx = {
      stratum, cwd, featureCode, blueprintText, gateCommands, preMergeGate,
      localSpec, localSpecDigest,
      filesChanged: [],
      stuckDetector,
      // D2(a): per-ITEM wall-clock ceiling from gsd.budget.per_task_ms, enforced
      // compose-side in runConsumerIssuance (the engine can't bound N items).
      perItemTimeoutMs: budgetCfg.per_task_ms ?? null,
      resumeTaskGraph,
      stuck: null, // set by runOneStep on a stuck verdict
      runState: initialState, // COMP-GSD-6: flushState merges into this
      // COMP-GSD-7-EVENTLOG: tasks already completed at run start (a resume
      // preloads them) are seeded as already-emitted so the appended log never
      // re-fires task_completed for prior-session completions.
      emittedCompletions: new Set(initialState.completedTaskIds),
      // COMP-GSD-7-EVENTLOG: phases already announced (dedupe — runState.phase is
      // set to 'execute' before the merge checkpoint, so it can't gate emission).
      emittedPhases: new Set(),
    };
    flushState(stepCtx, {}); // write the planning checkpoint

    // COMP-GSD-7-EVENTLOG: at the planning checkpoint — AFTER preconditions
    // passed (so a failed fresh invocation never wipes a prior run's history) —
    // a fresh run truncates the event log and clears stale halt artifacts so the
    // timeline reflects only this run; a resume appends to the existing log.
    if (!opts.resume) {
      clearGsdEvents(cwd, featureCode);
      clearGsdHaltArtifacts(cwd, featureCode);
    }
    appendGsdEvent(cwd, featureCode, 'run_started', {
      mode: opts.resume ? 'resume' : 'fresh',
      attempt: opts.attempt ?? 1,
    });

    // COMP-GSD-6-WATCHDOG: an INDEPENDENT wall-clock heartbeat. The existing
    // heartbeat only advances on agent push-events (onHeartbeat below), so a
    // quiet-but-healthy task would look stale. This timer restamps state.json's
    // heartbeat on a fixed cadence whenever the event loop is still turning — so
    // a stale heartbeat genuinely means the loop is WEDGED (or the process dead),
    // which is what the headless watchdog keys its hung-kill on. .unref() so it
    // never holds the process open; cleared in finally. Same empty-patch restamp
    // onHeartbeat uses, so it's behavior-compatible.
    //
    // Gated to SUPERVISED children only (GSD_HEADLESS_ATTEMPT, set by the
    // supervisor's spawner) — the supervisor is the sole watcher, so an
    // interactive `compose gsd` stays byte-identical (no extra state.json writes).
    if (process.env.GSD_HEADLESS_ATTEMPT != null) {
      const hbMs = readHeadlessConfig(cwd).watchdogHeartbeatMs;
      heartbeatTimer = setInterval(() => {
        try { if (stepCtx?.runState) flushState(stepCtx, {}); } catch { /* best-effort */ }
      }, hbMs);
      heartbeatTimer.unref?.();
    }

    let response = await stratum.plan(specYaml, 'gsd', {
      featureCode,
      gateCommands,
      pre_merge_gate: preMergeGate,
    }, { workspaceRoot: cwd });
    const flowId = response.runId ?? response.flow_id;
    flushState(stepCtx, { flowId, phase: 'decompose' });
    emitPhaseOnce(stepCtx, 'decompose'); // COMP-GSD-7-EVENTLOG

    // 5. Status loop. `stuck` (COMP-GSD-5) and `budget_exhausted` (COMP-GSD-4)
    // are terminal statuses. `stuck` is set compose-side by runOneStep; budget
    // is the stratum flow-budget terminal, surfaced verbatim through the advance/
    // poll envelopes (and carries budget_state).
    while (
      response.status !== 'complete' &&
      response.status !== 'completed' &&
      response.status !== 'failed' &&
      response.status !== 'killed' &&
      response.status !== 'stuck' &&
      response.status !== 'budget_exhausted' &&
      response.status !== 'error'   // COMP-PAR-MERGE-QUEUE: terminal step failure (e.g. retries_exhausted)
    ) {
      response = await runOneStep(response, stepCtx);
    }

    // COMP-PAR-MERGE-QUEUE: a step that exhausted its retries (e.g. the execute
    // step after repeated pre-merge gate failures) surfaces as a terminal `error`
    // envelope rather than silently advancing to ship. Stop here with the failure
    // and its bounce context instead of throwing `unknown response status`.
    if (response.status === 'error') {
      emitCompletionDeltas(stepCtx);
      flushState(stepCtx, { status: 'failed' });
      return {
        status: 'failed',
        flowId,
        stepId: response.step_id ?? stepCtx.lastStepId ?? null,
        errorType: response.error_type ?? 'step_failed',
        message: response.message ?? 'GSD step failed',
        violations: response.violations ?? [],
        bouncedTasks: response.bounced_tasks ?? [],
      };
    }

    if (response.status === 'stuck') {
      // Artifacts (stuck.md/json + pause.json) were written by runOneStep.
      // COMP-GSD-7-EVENTLOG: flush any completions that finished before the stuck
      // verdict (the stuck path returns early, before the execute-merge delta),
      // then record the pause.
      emitCompletionDeltas(stepCtx);
      appendGsdEvent(cwd, featureCode, 'paused', { pauseKind: 'stuck', taskId: stepCtx.stuck?.taskId ?? null });
      flushState(stepCtx, { status: 'stuck' }); // COMP-GSD-6 terminal checkpoint
      return {
        status: 'stuck',
        flowId,
        stuckTaskId: stepCtx.stuck?.taskId ?? null,
        signal: stepCtx.stuck?.signal ?? null,
      };
    }

    if (response.status === 'budget_exhausted') {
      // COMP-GSD-4: the stratum flow budget tripped. The flow already
      // cascade-cancelled in-flight siblings. Persist budget.{md,json} +
      // pause.json (kind:budget) for --resume, record cumulative usage, and
      // return a terminal `budget` envelope. pause.lock is released by finally.
      // D2(c): the TS engine returns `ledger`, not the python `budget_state`.
      const budgetState = response.budget_state ?? budgetStateFromLedger(response.ledger) ?? {};
      writeBudgetArtifacts(stepCtx, response, budgetState);
      recordGsdUsageFromState(cwd, featureCode, budgetState, stepCtx.recordedUsage);
      const axis = composeBudgetDiagnostic(budgetState, { feature: featureCode }).json.axis;
      // COMP-GSD-7-EVENTLOG: flush pre-halt completions, then record the pause.
      emitCompletionDeltas(stepCtx);
      appendGsdEvent(cwd, featureCode, 'paused', { pauseKind: 'budget', axis });
      flushState(stepCtx, { status: 'budget' }); // COMP-GSD-6 terminal checkpoint
      return { status: 'budget', flowId, axis, consumed: budgetState.consumed ?? {}, caps: budgetState.caps ?? {} };
    }

    // 6. Post-step blackboard finalization — read each task's TaskResult JSON
    // and write the consolidated blackboard.
    const blackboard = collectBlackboard(cwd, featureCode);
    if (Object.keys(blackboard).length > 0) {
      await writeAll(featureCode, blackboard, { cwd });
    }

    // 6b. COMP-GSD-5: a clean (non-stuck) finish clears any pause.json — the
    // resume completed, or a fresh run superseded a stale pause.
    if (response.status === 'complete' || response.status === 'completed') {
      // COMP-GSD-4: record this run's cumulative usage (best-effort; no-op when
      // the terminal envelope carries no budget accounting, e.g. un-budgeted
      // runs). D2(c): the TS engine returns `ledger`, not `budget_state`.
      const terminalBudgetState = response.budget_state ?? budgetStateFromLedger(response.ledger);
      recordGsdUsageFromState(cwd, featureCode, terminalBudgetState, stepCtx.recordedUsage);
      clearPauseFile(cwd, featureCode);
      // COMP-GSD-7: on a clean complete, budget.json is NOT written (only halts
      // write it). Persist a budget-final.json snapshot so the milestone report
      // (auto + retroactive `gsd report`) has actuals-vs-caps. No-op when the
      // envelope carries no budget accounting (un-budgeted run). Best-effort:
      // this is a derived report input — a write failure must NEVER demote a
      // successful run to 'failed' via the outer catch.
      if (terminalBudgetState) {
        try {
          writeBudgetFinalSnapshot(stepCtx, terminalBudgetState);
        } catch (err) {
          console.warn(`[gsd] budget-final snapshot failed: ${err.message}`);
        }
      }
    }

    // COMP-GSD-6: terminal state.json flush. Only 'complete' is a success; any
    // other terminal here (e.g. stratum 'killed') maps to 'failed' so we stay
    // within the closed status vocabulary the contract + supervisor share.
    // COMP-GSD-7: stamp completedAt so retroactive reports can recover wall-clock.
    const terminalStatus = ['complete', 'completed'].includes(response.status) ? 'complete' : 'failed';
    // COMP-GSD-7-EVENTLOG: emit the terminal event. complete → final completion
    // deltas + 'completed'; any other terminal (e.g. stratum 'killed') → 'failed'.
    if (terminalStatus === 'complete') {
      emitCompletionDeltas(stepCtx);
      appendGsdEvent(cwd, featureCode, 'completed', {});
    } else {
      appendGsdEvent(cwd, featureCode, 'failed', { reason: response.status ?? 'unknown' });
    }
    flushState(stepCtx, { status: terminalStatus, phase: 'done', completedAt: new Date().toISOString() });

    // COMP-GSD-7: best-effort milestone report on a clean complete. A report
    // failure must never fail the run — it is a derived artifact.
    if (terminalStatus === 'complete') {
      try {
        const r = generateGsdMilestoneReport(featureCode, cwd);
        if (!r.ok) console.warn(`[gsd] milestone report skipped: ${r.error}`);
      } catch (err) {
        console.warn(`[gsd] milestone report generation failed: ${err.message}`);
      }
    }

    // Return the normalized closed-vocabulary status (not the raw stratum status)
    // so the CLI/callers don't mistake a 'killed' terminal for success.
    return {
      status: terminalStatus,
      flowId,
      blackboardEntries: Object.keys(blackboard).length,
    };
  } catch (err) {
    // COMP-GSD-6: an orderly throw AFTER the planning checkpoint becomes a
    // terminal status:"failed" so the supervisor treats it as non-recoverable
    // (vs a hard crash → status stays "running" + dead pid → reader-derived
    // "crashed"). Guard on a persisted running state so pre-checkpoint throws
    // (which left no running state) stay fatal-by-absence, not "failed".
    if (stepCtx?.runState && readGsdState(cwd, featureCode)?.status === 'running') {
      try { flushState(stepCtx, { status: 'failed' }); } catch { /* best-effort */ }
      // COMP-GSD-7-EVENTLOG: record the failure (only when a run actually started
      // — a pre-checkpoint throw left no running state and gets no event). Append
      // is best-effort; never mask the original error.
      appendGsdEvent(cwd, featureCode, 'failed', { reason: err?.message ?? 'error' });
    }
    throw err;
  } finally {
    // COMP-GSD-6-WATCHDOG: stop the independent heartbeat timer.
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    // COMP-GSD-6: release the live-run lock if THIS process claimed it.
    if (runLockClaimed) releaseRunLock(cwd, featureCode);
    // COMP-GSD-4: release the resume claim ONLY if THIS process claimed it
    // (ownership-aware — never clobber a concurrent run's valid claim, and don't
    // release after losing the claim race). pause.json persists for --resume
    // unless a clean complete cleared it above.
    if (lockClaimed) releasePauseLock(cwd, featureCode);
    if (ownsStratum) {
      try { await stratum.disconnect?.(); } catch { /* best-effort */ }
    }
  }
}

// ---------- Internals ----------

export function resolveGateCommands(cwd, override) {
  if (Array.isArray(override) && override.length > 0) return override;
  // loadProjectConfig() returns raw .compose/compose.json — does NOT merge
  // defaults — so we must do our own fallback.
  const configPath = join(cwd, '.compose', 'compose.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (Array.isArray(cfg.gateCommands) && cfg.gateCommands.length > 0) {
        return cfg.gateCommands;
      }
    } catch {
      /* fall through to default */
    }
  }
  return [...DEFAULT_GATE_COMMANDS];
}

// COMP-PAR-MERGE-QUEUE: resolve the fast per-task pre-merge gate. Mirrors
// resolveGateCommands but defaults to lint+build (no full test suite). Honors
// `.compose/compose.json#preMergeGate`, else falls back to the non-test subset
// of `gateCommands`, else DEFAULT_FAST_GATE.
export function resolvePreMergeGate(cwd, override) {
  if (Array.isArray(override) && override.length > 0) return override;
  const configPath = join(cwd, '.compose', 'compose.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (Array.isArray(cfg.preMergeGate) && cfg.preMergeGate.length > 0) {
        return cfg.preMergeGate;
      }
      if (Array.isArray(cfg.gateCommands) && cfg.gateCommands.length > 0) {
        const fast = cfg.gateCommands.filter((c) => !/\btest\b/.test(c));
        if (fast.length > 0) return fast;
      }
    } catch {
      /* fall through to default */
    }
  }
  return [...DEFAULT_FAST_GATE];
}

async function runOneTsStep(response, ctx) {
  const { stratum, cwd, featureCode, localSpec, localSpecDigest } = ctx;
  const flowId = response.runId;

  if (response.status === 'ready') {
    const ready = response.ready ?? [];
    if (ready.length === 0) throw new Error('runGsd: TS engine returned ready without a ready entry');
    const descriptor = ready.find(isConsumerDescriptor);
    if (descriptor) {
      if (!ctx.consumerArtifacts) {
        ctx.consumerArtifacts = new ConsumerFanoutArtifacts({
          runId: flowId,
          targetCwd: cwd,
          revisionDigest: descriptor.revisionDigest,
          specDigest: localSpecDigest,
        });
      }
      ctx.consumerArtifacts.bindRunRevision({
        revisionDigest: descriptor.revisionDigest,
        specDigest: localSpecDigest,
      });
      // D7(a): render the exact TaskResult path from the item's task id (the
      // fanout `over` is decompose_gsd.output.tasks, indexed by itemIndex).
      const consumerItem = ctx.lastTaskGraph?.tasks?.[descriptor.itemIndex];
      const taskResultPath = consumerItem?.id
        ? gsdTaskResultPath(featureCode, consumerItem.id)
        : undefined;
      try {
        return await runConsumerIssuance({
          descriptor,
          flowId,
          stratum,
          artifacts: ctx.consumerArtifacts,
          audit: await stratum.audit(flowId),
          localSpec,
          // D2(b): onUsage debits each item's agent usage into the cumulative
          // ledger. D2(a): per-item wall-clock ceiling from gsd.budget.per_task_ms.
          // D3: the stuck detector observes this item's agent tool events.
          // D7(a): taskResultPath spells out the exact TaskResult filename.
          context: { cwd, featureCode, filesChanged: ctx.filesChanged, onUsage: (usage) => recordTsAgentUsage(ctx, usage), taskResultPath },
          // runAndNormalize narrates via progress.debug/warn/info/toolUse — gsd
          // has no cockpit, so a COMPLETE no-op (not just stepStart/stepDone) is
          // required or the item throws "progress.debug is not a function".
          progress: NOOP_PROGRESS,
          streamWriter: { write() {} },
          perItemTimeoutMs: ctx.perItemTimeoutMs,
          stuckDetector: ctx.stuckDetector,
        });
      } catch (error) {
        // D3: a stuck verdict halts the run. Persist the diagnostic + resume
        // state and return a terminal `stuck` envelope so runGsd's loop exits,
        // mirroring the legacy executeParallelDispatchServer stuck path.
        if (!(error instanceof ConsumerStuckError)) throw error;
        const verdict = {
          taskId: error.taskId,
          signal: error.verdict?.signal,
          detail: error.verdict?.detail,
          attemptCounts: ctx.stuckDetector?.attemptCounts?.(error.taskId) ?? {},
        };
        ctx.stuck = verdict;
        writeStuckArtifacts(ctx, { flow_id: flowId, step_id: descriptor.step ?? descriptor.id }, verdict);
        return { status: 'stuck', flow_id: flowId, step_id: descriptor.step ?? descriptor.id };
      }
    }

    const step = ready[0];
    ctx.lastStepId = step.id;
    if (step.id === 'ship_gsd') {
      const result = await executeShipStep(
        featureCode,
        cwd,
        cwd,
        { cwd, featureCode, mode: 'feature', filesChanged: ctx.filesChanged ?? [] },
        '',
        null,
      );
      return stratum.stepDone(flowId, step.id, { output: result }, step.epoch, step.dispatchToken);
    }
    if (step.id === 'decompose_gsd' && ctx.resumeTaskGraph) {
      ctx.lastTaskGraph = ctx.resumeTaskGraph;
      return stratum.stepDone(
        flowId, step.id, { output: ctx.resumeTaskGraph }, step.epoch, step.dispatchToken,
      );
    }

    // D2(b): dispatch via agentRun (not runAgentText) so the TS complete
    // envelope's usage is captured and debited into the cumulative ledger.
    const runOut = await stratum.agentRun(step.agent ?? 'claude', step.do ?? '', { cwd });
    const text = runOut?.text ?? '';
    recordTsAgentUsage(ctx, runOut?.usage);
    // V1: also report usage in the step_done envelope so the ENGINE debits its
    // flow budget (not just compose's cumulative ledger above).
    const ordinaryUsage = toEngineUsage(runOut?.usage);
    let result;
    try {
      result = parseJsonFromText(text);
    } catch (err) {
      throw new Error(`runGsd: step ${step.id} agent did not return parseable JSON: ${err.message}`);
    }
    if (step.id === 'decompose_gsd') {
      try {
        result = validateAndRepairTaskGraph(result, ctx.blueprintText, ctx.preMergeGate ?? ctx.gateCommands);
      } catch (err) {
        // F6: an ownership conflict is an expected, retryable rejection. Send a
        // FAILURE step_done envelope (not a thrown abort) so decompose_gsd's
        // declared attempts govern — the engine retries with previousFailure
        // feedback. Genuinely unexpected errors still propagate.
        if (!(err instanceof TaskGraphOwnershipError)) throw err;
        return stratum.stepDone(
          flowId, step.id,
          { failure: err.message, ...(ordinaryUsage ? { usage: ordinaryUsage } : {}) },
          step.epoch, step.dispatchToken,
        );
      }
      ctx.lastTaskGraph = result;
      if (ctx.runState) {
        flushState(ctx, {
          phase: 'execute',
          resumeReady: true,
          decomposedTasks: (result.tasks ?? []).map((task) => ({ ...task })),
        });
      }
    }
    return stratum.stepDone(
      flowId, step.id,
      { output: result, ...(ordinaryUsage ? { usage: ordinaryUsage } : {}) },
      step.epoch, step.dispatchToken,
    );
  }

  if (response.status === 'running') {
    const audit = await stratum.audit(flowId);
    const waiting = Object.entries(audit?.steps ?? {})
      .find(([, state]) => state?.status === 'waiting_gate');
    if (!waiting) throw new Error('runGsd: TS engine is running without ready work or a waiting gate');
    const [gateStepId, gateState] = waiting;
    const steps = localSpec.flows[localSpec.flows.entry].steps;
    const gateStep = steps.find((step) => step.id === gateStepId);
    const predecessorIds = new Set(gateStep?.after ?? []);
    const fanoutStep = steps.find((step) => predecessorIds.has(step.id) && step.fanout?.dispatch === 'consumer');
    if (!fanoutStep) {
      throw new Error(`runGsd: unexpected non-consumer gate ${gateStepId} on the TS path`);
    }
    if (!ctx.consumerArtifacts) {
      ctx.consumerArtifacts = new ConsumerFanoutArtifacts({
        runId: flowId,
        targetCwd: cwd,
        revisionDigest: response.revisionDigest,
        specDigest: localSpecDigest,
      });
    }
    const artifacts = ctx.consumerArtifacts;
    artifacts.recordGateBinding({ gateStepId, fanoutStepId: fanoutStep.id });
    let transaction;
    let outcome = 'approve';
    let rationale = 'consumer fanout artifacts merged';
    try {
      transaction = artifacts.prepareMerge({
        gateStepId,
        gateToken: gateState.gateToken,
        fanoutStepId: fanoutStep.id,
        audit,
      });
      await artifacts.applyMerge(transaction);
    } catch (error) {
      if (!(error instanceof ConsumerMergeDecisionError)) throw error;
      outcome = gateStep?.gate?.on_revise ? 'revise' : 'kill';
      rationale = `${error.code}: ${error.message}`;
      transaction ??= artifacts.journal.mergeTransactions.find(
        (entry) => entry.gateToken === gateState.gateToken,
      );
      if (transaction) artifacts.restoreMergeBaseline(transaction, audit);
    }
    const next = await stratum.gateResolve(
      flowId, gateStepId, outcome, rationale, 'system', gateState.gateToken,
    );
    artifacts.markGateResolved(transaction, outcome);
    if (outcome !== 'revise') artifacts.cleanupWorktrees(`GSD merge gate ${outcome}`);
    if (outcome === 'approve') ctx.filesChanged = collectChangedFiles(cwd);
    return next;
  }

  return response;
}

async function runOneStep(response, ctx) {
  // TS-native responses are handled by the same ready[]/step_done consumer
  // issuance helper as build.js. The Python-era parallel branch below is kept
  // for the flag-day endgame, but cannot match a TS status.
  if (['ready', 'running', 'completed', 'failed'].includes(response.status)) {
    return runOneTsStep(response, ctx);
  }
  const { stratum, cwd, featureCode, blueprintText, gateCommands, preMergeGate } = ctx;
  const flowId = response.flow_id;
  const stepId = response.step_id;
  const stepType = response.type ?? response.step_type;
  if (stepId) ctx.lastStepId = stepId; // COMP-GSD-4: for the budget pause's stepId

  if (response.status === 'execute_step') {
    // parallel_dispatch step (the `execute` step)
    if (stepType === 'parallel_dispatch' || response.tasks) {
      const outcome = await executeParallelDispatchServer(
        response,
        stratum,
        { cwd, featureCode, gsd: true }, // COMP-GSD-7: gates timing+diff capture
        null, // progress
        { write: () => {} }, // streamWriter — no-op for v1
        cwd,
        {
          stuckDetector: ctx.stuckDetector, // COMP-GSD-5 (null in non-gsd callers)
          // COMP-GSD-6: bump state.json's heartbeat on every task event so a long
          // task sitting in the dispatch poll loop isn't mistaken for crashed.
          onHeartbeat: ctx.runState ? () => { try { flushState(ctx, {}); } catch { /* best-effort */ } } : null,
        },
      );

      // COMP-GSD-5: a stuck verdict halts the run. Persist the diagnostic +
      // resume state, then return a terminal `stuck` envelope so runGsd's loop
      // exits. The task was already cancelled (conflict) inside dispatch.
      if (outcome && outcome.stuck) {
        ctx.stuck = outcome.stuck;
        writeStuckArtifacts(ctx, response, outcome.stuck);
        return { status: 'stuck', flow_id: flowId, step_id: stepId };
      }

      // After diffs are merged, capture the touched files for ship_gsd
      // staging. The clean-workspace precondition above guarantees every
      // file in the post-execute dirty set is genuinely a GSD-produced change.
      ctx.filesChanged = collectChangedFiles(cwd);
      // COMP-GSD-6: checkpoint completed tasks after the execute merge.
      // COMP-GSD-7-EVENTLOG: emit the execute-phase transition once, then a
      // task_completed event per newly-completed task.
      if (ctx.runState) {
        const completed = collectCompletedTaskIds(cwd, featureCode);
        flushState(ctx, { phase: 'execute', completedTaskIds: completed });
        emitPhaseOnce(ctx, 'execute'); // dedupes; runState.phase can't gate this
        emitCompletionDeltas(ctx, completed);
      }
      // executeParallelDispatchServer returns the next-step dispatch envelope
      return outcome;
    }

    // ship_gsd: delegate to executeShipStep with filesChanged from execute step
    // so source files are staged. Agent sandbox blocks git, so commit must
    // run in-process (mirrors runBuild's special case at lib/build.js:963-981).
    if (stepId === 'ship_gsd') {
      const shipResult = await executeShipStep(
        featureCode,
        cwd,
        cwd,
        { cwd, featureCode, mode: 'feature', filesChanged: ctx.filesChanged ?? [] },
        '',
        null,
      );
      // executeShipStep stages + commits but does NOT push. Push is a
      // user-facing operation deferred to the user in v1; runBuild's ship
      // step doesn't auto-push either. Document via ship intent later.
      return await stratum.stepDone(flowId, stepId, shipResult);
    }

    // COMP-GSD-5 resume: skip the decompose AGENT entirely and substitute the
    // persisted task graph (already enriched/repaired during the original run
    // and already filtered to exclude completedTaskIds). We do NOT re-run
    // validateAndRepairTaskGraph: enrichTaskGraph would flag the completed
    // tasks' Boundary Map slices as orphaned (no task in the SUBSET owns them).
    // Stable task IDs + no re-decompose are the whole point.
    if (stepId === 'decompose_gsd' && ctx.resumeTaskGraph) {
      ctx.lastTaskGraph = ctx.resumeTaskGraph;
      // COMP-GSD-6: a resume already has the (filtered) task graph — mark
      // resumeReady so a re-crash during execute resumes rather than restarts.
      if (ctx.runState) {
        flushState(ctx, {
          phase: 'execute',
          resumeReady: true,
          decomposedTasks: (ctx.resumeTaskGraph.tasks ?? []).map((t) => ({ ...t })),
        });
      }
      return await stratum.stepDone(flowId, stepId, ctx.resumeTaskGraph);
    }

    // Single-agent step: dispatch via runAgentText. The agent returns text;
    // we expect JSON matching the step's output_contract.
    const prompt = response.intent ?? '';
    const text = await stratum.runAgentText(response.agent ?? 'claude', prompt, { cwd });
    let result;
    try {
      result = parseJsonFromText(text);
    } catch (err) {
      throw new Error(
        `runGsd: step ${stepId} agent did not return parseable JSON: ${err.message}`,
      );
    }

    // T6 step 7: validate decompose_gsd output and repair missing descriptions.
    if (stepId === 'decompose_gsd') {
      // COMP-PAR-MERGE-QUEUE: single-source the per-task instructed gate to the
      // fast pre-merge gate (== the enforced execute.pre_merge_verify). Full
      // `pnpm test` is instructed only at ship_gsd.
      result = validateAndRepairTaskGraph(result, blueprintText, preMergeGate ?? gateCommands);
      // COMP-GSD-5: remember the ENRICHED graph so a later stuck halt can
      // persist the full task definitions (with descriptions/produces/consumes)
      // into pause.json — resume re-dispatches these without re-enriching.
      ctx.lastTaskGraph = result;
      // COMP-GSD-6: the task graph now exists → resumeReady true; persist it so a
      // crash during execute can synthesize a resume graph from state.json.
      if (ctx.runState) {
        flushState(ctx, {
          phase: 'execute',
          resumeReady: true,
          decomposedTasks: (result.tasks ?? []).map((t) => ({ ...t })),
        });
      }
    }

    return await stratum.stepDone(flowId, stepId, result);
  }

  if (response.status === 'await_gate') {
    // GSD has no gates in v1. If we hit one, surface it.
    throw new Error(
      `runGsd: unexpected gate at step ${stepId}. v1 has no gates in the gsd flow.`,
    );
  }

  throw new Error(`runGsd: unknown response status: ${response.status}`);
}

/**
 * F6: raised by validateAndRepairTaskGraph on a files_owned conflict. A typed
 * class lets the decompose_gsd site distinguish this expected, retryable rejection
 * (→ failure step_done envelope, engine attempts govern) from a genuinely
 * unexpected error (which still propagates).
 */
export class TaskGraphOwnershipError extends Error {
  constructor(conflict) {
    super(`decompose_gsd file-ownership conflict: ${conflict}`);
    this.name = 'TaskGraphOwnershipError';
    this.conflict = conflict;
  }
}

export function validateAndRepairTaskGraph(taskGraph, blueprintText, gateCommands) {
  // D5: deterministic file-ownership enforcement — reject overlapping
  // files_owned before any repair. Two tasks owning the same file would race
  // in their worktrees and collide at merge; fail loudly with the conflict.
  const conflict = filesOwnedConflict(taskGraph?.tasks);
  if (conflict) throw new TaskGraphOwnershipError(conflict);

  // Structural check via enrichTaskGraph. Throws on orphan slice/task —
  // that's a "fail loudly" case (no reliable repair path).
  const enriched = enrichTaskGraph(taskGraph, blueprintText);

  // Per-task description check. The agent must produce a description with
  // all six required sections (per T4 prompt contract). If ANY section
  // marker is missing, repair via buildTaskDescription. Length-only would
  // miss long-but-malformed strings.
  const enrichedById = new Map(enriched.tasks.map((t) => [t.id, t]));
  const repairedTasks = enriched.tasks.map((task) => {
    if (typeof task.description === 'string' && hasAllRequiredSections(task.description)) {
      return task;
    }
    // Repair: synthesize a fresh description.
    const sliceText = extractSliceTextForTask(blueprintText, task);
    const upstream = (task.depends_on || [])
      .map((dep) => enrichedById.get(dep))
      .filter(Boolean);
    const fresh = buildTaskDescription({
      task,
      slice: sliceText,
      upstreamTasks: upstream,
      gateCommands,
    });
    return { ...task, description: fresh };
  });

  return { tasks: repairedTasks };
}

const REQUIRED_DESCRIPTION_SECTIONS = [
  'Symbols you must produce',
  'Symbols you may consume from upstream tasks',
  'Boundary Map slice',
  'Upstream tasks',
  'GATES',
];

function hasAllRequiredSections(description) {
  for (const marker of REQUIRED_DESCRIPTION_SECTIONS) {
    if (!description.includes(marker)) return false;
  }
  return true;
}

function extractSliceTextForTask(blueprintText, task) {
  // Find any Boundary Map slice whose File Plan files match the task's
  // files_owned. We don't have a sliceId here, so we scan slice blocks for
  // the first one whose File Plan ⊆ task.files_owned. Best-effort — only
  // used in the description-repair path.
  const lines = blueprintText.split(/\r?\n/);
  const owned = new Set(task.files_owned || []);
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^### (S\d{2,})/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { id: m[1], start: i, end: lines.length };
    } else if (cur && /^### S\d/.test(lines[i])) {
      cur.end = i;
      blocks.push(cur);
      cur = null;
    } else if (cur && /^## /.test(lines[i])) {
      cur.end = i;
      blocks.push(cur);
      cur = null;
    }
  }
  if (cur) blocks.push(cur);
  for (const b of blocks) {
    const block = lines.slice(b.start, b.end).join('\n');
    const fpMatch = block.match(/^File Plan\s*:\s*(.+)$/m);
    if (!fpMatch) continue;
    const files = [...fpMatch[1].matchAll(/`([^`]+)`/g)].map((mm) => mm[1].trim());
    if (files.length > 0 && files.every((f) => owned.has(f))) {
      return block;
    }
  }
  return '';
}

function parseJsonFromText(text) {
  // Strip code fences if present.
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const body = fenced ? fenced[1] : trimmed;
  return JSON.parse(body);
}

function collectChangedFiles(cwd) {
  try {
    const tracked = execSync('git diff --name-only HEAD', {
      cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const all = [
      ...tracked.split('\n').filter(Boolean),
      ...untracked.split('\n').filter(Boolean),
    ];
    return [...new Set(all)];
  } catch {
    return [];
  }
}

function collectBlackboard(cwd, featureCode) {
  const dir = join(cwd, '.compose', 'gsd', featureCode, 'results');
  if (!existsSync(dir)) return {};
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const out = {};
  const failures = [];
  for (const f of files) {
    const taskId = f.replace(/\.json$/, '');
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    } catch (err) {
      failures.push(`${f}: unreadable JSON (${err.message})`);
      continue;
    }
    const v = validateTaskResult(parsed);
    if (v.ok) {
      out[taskId] = parsed;
    } else {
      failures.push(`${f}: ${v.errors.join('; ')}`);
    }
  }
  if (failures.length > 0) {
    // Plan T6 acceptance: blackboard must contain one VALIDATED entry per task.
    // A partial blackboard is worse than no blackboard — fail loudly.
    throw new Error(
      `runGsd: ${failures.length} TaskResult file(s) failed validation; refusing to write partial blackboard:\n  - ${failures.join('\n  - ')}`,
    );
  }
  return out;
}

// ===========================================================================
// COMP-GSD-5: stuck detection + resume
// ===========================================================================

function gsdDir(cwd, featureCode) {
  return join(cwd, '.compose', 'gsd', featureCode);
}

// ===========================================================================
// COMP-GSD-6: run.lock (live-run exclusivity) + state.json flush helpers
// ===========================================================================

const RUN_LOCK_STALE_MS = 90000;

function runLockDir(cwd, featureCode) {
  return join(gsdDir(cwd, featureCode), 'run.lock');
}

// Atomically take over a stale lock dir. The naive `rmSync` + `mkdirSync` is
// racy — two reclaimers can both see "stale", both rm, and one deletes the
// other's fresh lock. renameSync IS atomic, so only one racer can rename the
// stale dir aside; the loser gets ENOENT. The winner removes the renamed copy
// and re-creates the lock; if a NEW claimant raced into the freed name first,
// our mkdir gets EEXIST and we (correctly) report we lost. Returns true iff WE
// recreated the lock.
function takeoverStaleLock(lockPath) {
  const aside = `${lockPath}.stale.${process.pid}.${Date.now()}`;
  try {
    renameSync(lockPath, aside); // atomic — loser gets ENOENT
  } catch {
    return false; // another racer already took it over (or it vanished)
  }
  try { rmSync(aside, { recursive: true, force: true }); } catch { /* best-effort */ }
  try {
    mkdirSync(lockPath);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false; // a fresh claimant won the freed name
    throw err;
  }
}

// Read the owning pid for a run.lock: run.lock/owner.json first (lock-local
// record), then state.json (Codex review precedence). Returns a number or null.
function runLockOwnerPid(cwd, featureCode) {
  const ownerPath = join(runLockDir(cwd, featureCode), 'owner.json');
  if (existsSync(ownerPath)) {
    try {
      const o = JSON.parse(readFileSync(ownerPath, 'utf-8'));
      if (typeof o.pid === 'number') return o.pid;
    } catch { /* fall through to state.json */ }
  }
  const state = readGsdState(cwd, featureCode);
  return typeof state?.pid === 'number' ? state.pid : null;
}

// Atomic live-run claim, taken BEFORE the first stratum side effect. mkdirSync
// is atomic on POSIX: the loser gets EEXIST. On EEXIST we take over a STALE lock
// — owner pid dead, OR (no owner record AND lock-dir mtime older than the stale
// window, which covers the sub-ms gap before owner.json lands). A live owner
// refuses. Writes run.lock/owner.json {pid,startedAt} immediately after winning.
export function claimRunLock(cwd, featureCode) {
  const dir = gsdDir(cwd, featureCode);
  mkdirSync(dir, { recursive: true });
  const lock = runLockDir(cwd, featureCode);
  const write = () => {
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    );
  };
  try {
    mkdirSync(lock);
    write();
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  // EEXIST — decide stale vs live.
  const ownerPid = runLockOwnerPid(cwd, featureCode);
  let stale = false;
  if (typeof ownerPid === 'number') {
    stale = !pidAlive(ownerPid);
  } else {
    // No owner record yet: fall back to lock-dir age.
    try {
      stale = Date.now() - statSync(lock).mtimeMs > RUN_LOCK_STALE_MS;
    } catch { stale = true; }
  }
  if (!stale) {
    throw new Error(
      `runGsd: another gsd run owns ${featureCode} (.compose/gsd/${featureCode}/run.lock, ` +
        `pid ${ownerPid ?? 'unknown'} alive). Refusing to start a concurrent run.`,
    );
  }
  // Atomic stale takeover (rename-aside). If we lose the takeover race, another
  // run now legitimately owns the feature — refuse.
  if (!takeoverStaleLock(lock)) {
    throw new Error(
      `runGsd: another gsd run claimed ${featureCode} during stale-lock takeover. ` +
        `Refusing to start a concurrent run.`,
    );
  }
  write();
}

export function releaseRunLock(cwd, featureCode) {
  rmSync(runLockDir(cwd, featureCode), { recursive: true, force: true });
}

// Merge a patch into ctx.runState and atomically flush state.json. ctx.runState
// is the single in-memory source of truth; every flush restamps heartbeatAt.
function flushState(ctx, patch) {
  ctx.runState = { ...(ctx.runState ?? {}), ...patch };
  writeGsdState(ctx.cwd, ctx.featureCode, ctx.runState);
}

// COMP-GSD-7-EVENTLOG: emit a `task_completed` event for each task that has
// completed since the last emit. Dedupes via ctx.emittedCompletions (seeded from
// the run's initial completed snapshot, so a resume never re-fires prior-session
// completions). Called at the execute-merge checkpoint and before each halt
// (stuck/budget) — the halt paths return early, before the merge checkpoint.
function emitCompletionDeltas(ctx, completedIds) {
  if (!ctx?.emittedCompletions) return;
  const ids = completedIds ?? collectCompletedTaskIds(ctx.cwd, ctx.featureCode);
  for (const id of ids) {
    if (!id || ctx.emittedCompletions.has(id)) continue;
    ctx.emittedCompletions.add(id);
    appendGsdEvent(ctx.cwd, ctx.featureCode, 'task_completed', { taskId: id });
  }
}

// COMP-GSD-7-EVENTLOG: emit a `phase` event the first time a phase is entered.
// Deduped via ctx.emittedPhases — runState.phase is set to 'execute' before the
// execute-merge checkpoint runs, so it can't itself gate the emission.
function emitPhaseOnce(ctx, phase) {
  if (!ctx?.emittedPhases || ctx.emittedPhases.has(phase)) return;
  ctx.emittedPhases.add(phase);
  appendGsdEvent(ctx.cwd, ctx.featureCode, 'phase', { phase });
}

/**
 * Build a GsdStuckDetector from `.compose/compose.json` `gsd.stuck.*`, falling
 * back to documented defaults (sameFileEdits=3, errorRepeats=3,
 * noProgressCalls=8, wallClockMs=600000). Config keys use snake_case to match
 * the design table; the detector takes camelCase.
 */
export function buildStuckDetector(cwd) {
  const cfg = readGsdStuckConfig(cwd);
  return new GsdStuckDetector({
    sameFileEdits: cfg.same_file_edits ?? DEFAULT_THRESHOLDS.sameFileEdits,
    errorRepeats: cfg.error_repeats ?? DEFAULT_THRESHOLDS.errorRepeats,
    noProgressCalls: cfg.no_progress_calls ?? DEFAULT_THRESHOLDS.noProgressCalls,
    wallClockMs: cfg.wall_clock_ms ?? DEFAULT_THRESHOLDS.wallClockMs,
  });
}

function readGsdStuckConfig(cwd) {
  const configPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return cfg?.gsd?.stuck ?? {};
  } catch {
    return {};
  }
}

/**
 * Task ids whose VALIDATED TaskResult is already known — the union of the
 * persisted blackboard and any per-task result files that validate. Lenient
 * (does NOT throw on a bad file) because at stuck-halt time the run is being
 * abandoned, not finalized.
 */
function collectCompletedTaskIds(cwd, featureCode) {
  const done = new Set(Object.keys(readBlackboard(featureCode, { cwd }) ?? {}));
  const dir = join(gsdDir(cwd, featureCode), 'results');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (validateTaskResult(parsed).ok) done.add(f.replace(/\.json$/, ''));
      } catch { /* skip unreadable */ }
    }
  }
  return [...done];
}

/** Best-effort unified diff of the whole working tree (for the stuck.md triage). */
function captureWorkingDiff(cwd) {
  try {
    return execSync('git diff HEAD', {
      cwd, encoding: 'utf-8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Persist the stuck diagnostic (stuck.md + stuck.json, per
 * contracts/gsd-stuck.json#stuck) AND the resume state (pause.json, per
 * #pause). decomposedTasks is the FULL task list (from the dispatch envelope),
 * persisted so --resume does not re-decompose. completedTaskIds comes from the
 * blackboard / results dir.
 */
function writeStuckArtifacts(ctx, dispatchResponse, verdict) {
  const { cwd, featureCode } = ctx;
  const dir = gsdDir(cwd, featureCode);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();

  // Persist the FULLY-ENRICHED task graph (captured at decompose) so --resume
  // re-dispatches the unfinished subset WITHOUT re-decomposing or re-enriching.
  // Fall back to the dispatch envelope's tasks only if enrichment wasn't seen.
  const sourceTasks = ctx.lastTaskGraph?.tasks ?? dispatchResponse.tasks ?? [];
  const decomposedTasks = sourceTasks.map((t) => ({ ...t }));
  const completedTaskIds = collectCompletedTaskIds(cwd, featureCode);
  const partialDiff = captureWorkingDiff(cwd);

  const stuck = {
    feature: featureCode,
    taskId: verdict.taskId,
    signal: verdict.signal,
    detail: verdict.detail,
    attemptCounts: verdict.attemptCounts ?? {},
    ts,
  };
  if (partialDiff) stuck.partialDiff = partialDiff;
  writeFileSync(join(dir, 'stuck.json'), JSON.stringify(stuck, null, 2) + '\n');

  const pause = {
    flowId: dispatchResponse.flow_id,
    stepId: dispatchResponse.step_id,
    stuckTaskId: verdict.taskId,
    signal: verdict.signal,
    detail: verdict.detail,
    decomposedTasks,
    completedTaskIds,
    pid: process.pid,
    mode: 'gsd',
    ts,
  };
  writeFileSync(join(dir, 'pause.json'), JSON.stringify(pause, null, 2) + '\n');

  writeFileSync(join(dir, 'stuck.md'), renderStuckMarkdown(stuck, pause));
}

function renderStuckMarkdown(stuck, pause) {
  const remaining = pause.decomposedTasks
    .map((t) => t.id)
    .filter((id) => !pause.completedTaskIds.includes(id));
  return `# GSD stuck: ${stuck.feature}

**Signal:** \`${stuck.signal}\`
**Stuck task:** \`${stuck.taskId}\`
**Detected:** ${stuck.ts}

## What happened

${stuck.detail}

Attempt counts at halt:
- same-file edits (max across files): ${stuck.attemptCounts.sameFileEdits ?? 0}
- error repeats (max across hashes): ${stuck.attemptCounts.errorRepeats ?? 0}
- consecutive no-progress calls: ${stuck.attemptCounts.noProgressCalls ?? 0}

The in-flight task was cancelled and the run halted cleanly.

## Resume or abort

Completed tasks (already in the blackboard, will be skipped): ${pause.completedTaskIds.length ? pause.completedTaskIds.map((x) => `\`${x}\``).join(', ') : '(none)'}
Tasks that will re-dispatch on resume: ${remaining.length ? remaining.map((x) => `\`${x}\``).join(', ') : '(none)'}

- **Resume:** \`compose gsd ${stuck.feature} --resume\` — re-dispatches the unfinished tasks into fresh worktrees.
- **Abort:** delete \`.compose/gsd/${stuck.feature}/pause.json\` and start over.

State for resume is in \`pause.json\` (schema: \`contracts/gsd-stuck.json#/definitions/pause\`).
`;
}

/**
 * --resume: read pause.json, enforce the ownership + mode guard (mirrors
 * `compose fix --resume`, bin/compose.js:1933), and return the persisted task
 * graph filtered to exclude completedTaskIds. Throws (caller surfaces the
 * message + exits 1) when there is nothing to resume or the guard fails.
 *
 * COMP-GSD-4: `claim` (default true) controls the atomic pause.lock ownership
 * claim. runGsd passes `{claim:false}` and claims later (claimResumeLock) as
 * the first statement INSIDE its try, so the run-loop's finally always releases
 * the lock — no strand on a budget/stuck re-halt or a pre-dispatch throw. The
 * CLI/test callers keep the default (read+guard+claim in one call).
 */
export function loadResumeTaskGraph(cwd, featureCode, { claim = true } = {}) {
  const pausePath = join(gsdDir(cwd, featureCode), 'pause.json');
  let pause;
  if (existsSync(pausePath)) {
    try {
      pause = JSON.parse(readFileSync(pausePath, 'utf-8'));
    } catch (err) {
      throw new Error(`runGsd: pause.json for ${featureCode} is unreadable: ${err.message}`);
    }
  } else {
    // COMP-GSD-6 crash bridge: a hard crash never reaches the stuck/budget halt
    // paths that write pause.json. If state.json shows a running run with a DEAD
    // pid and a populated task graph (resumeReady), synthesize a pause-shaped
    // object so the unfinished subset can be re-dispatched through the same
    // guards/filtering below. An EMPTY graph (crashed pre/at decompose) is NOT
    // resumable here — it (correctly) falls through to the throw; the supervisor
    // restarts such runs fresh rather than --resume.
    const state = readGsdState(cwd, featureCode);
    if (
      state && state.status === 'running' && !pidAlive(state.pid) &&
      Array.isArray(state.decomposedTasks) && state.decomposedTasks.length > 0
    ) {
      pause = {
        flowId: state.flowId ?? null,
        stepId: state.lastStepId ?? 'execute',
        decomposedTasks: state.decomposedTasks,
        completedTaskIds: state.completedTaskIds ?? [],
        pid: state.pid,
        mode: 'gsd',
        ts: state.heartbeatAt ?? new Date().toISOString(),
      };
    } else {
      throw new Error(
        `runGsd: no pause.json to resume for ${featureCode}. ` +
          `Nothing to resume — run \`compose gsd ${featureCode}\` to start fresh.`,
      );
    }
  }

  // Mode guard: refuse to resume a non-gsd pause file.
  if (pause.mode && pause.mode !== 'gsd') {
    throw new Error(
      `runGsd: cannot --resume: pause.json for ${featureCode} is in ${pause.mode} mode, not gsd.`,
    );
  }

  // Ownership guard: refuse if the recorded pid is still alive. A resumable
  // pause is one whose writing process has EXITED — a live pid means another
  // run still owns this feature (mirrors `compose fix --resume`). We do not
  // make a self-pid exception: if a live process holds the pause, resuming is
  // unsafe regardless of whether that pid happens to match ours.
  if (typeof pause.pid === 'number' && pidAlive(pause.pid)) {
    throw new Error(
      `runGsd: cannot --resume: pid ${pause.pid} still owns this gsd run (process is live). ` +
        `Wait for it to exit (or remove a stale pause.json) before resuming.`,
    );
  }

  const tasks = Array.isArray(pause.decomposedTasks) ? pause.decomposedTasks : [];
  if (tasks.length === 0) {
    throw new Error(`runGsd: pause.json for ${featureCode} has no decomposedTasks to resume.`);
  }
  const completed = new Set(pause.completedTaskIds ?? []);
  const remaining = tasks
    .filter((t) => !completed.has(t.id))
    .map((t) => {
      // A completed dependency is already satisfied (its result is in the
      // blackboard); strip it from depends_on so the re-dispatched subgraph is
      // self-consistent and a remaining task does not wait on a task that will
      // never be re-dispatched (COMP-GSD-5 Codex review residual).
      if (!Array.isArray(t.depends_on) || t.depends_on.length === 0) return t;
      const deps = t.depends_on.filter((id) => !completed.has(id));
      return deps.length === t.depends_on.length ? t : { ...t, depends_on: deps };
    });
  if (remaining.length === 0) {
    // Everything already completed — nothing to re-dispatch. Treat as clean.
    throw new Error(
      `runGsd: all tasks for ${featureCode} are already completed; nothing to re-dispatch. ` +
        `Delete pause.json to finish.`,
    );
  }
  if (claim) claimResumeLock(cwd, featureCode);
  return { tasks: remaining };
}

/**
 * Atomic ownership claim (COMP-GSD-5 Codex review, HIGH). `mkdirSync` is an
 * atomically exclusive create, so two concurrent --resume invocations cannot
 * both claim — the loser gets EEXIST and refuses.
 *
 * COMP-GSD-6: a STALE claim left by a crashed --resume is now auto-recovered.
 * The HOLDER of pause.lock writes its own pid into pause.lock/owner.json (NOT
 * pause.json.pid, which is the original crashed run's pid — always dead at
 * resume time and so useless for liveness). Takeover when that holder pid is
 * dead, OR no owner record exists and the lock-dir mtime is older than the
 * stale window. TOCTOU-safe: remove + re-attempt the atomic mkdir; a concurrent
 * winner still wins.
 */
export function claimResumeLock(cwd, featureCode) {
  const claimPath = join(gsdDir(cwd, featureCode), 'pause.lock');
  const writeOwner = () => {
    try {
      writeFileSync(
        join(claimPath, 'owner.json'),
        JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }, null, 2),
      );
    } catch { /* best-effort; mtime fallback still protects takeover */ }
  };
  try {
    mkdirSync(claimPath);
    writeOwner();
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  // EEXIST — decide stale vs live by the lock HOLDER's own owner record.
  let holderPid = null;
  const ownerPath = join(claimPath, 'owner.json');
  if (existsSync(ownerPath)) {
    try {
      const o = JSON.parse(readFileSync(ownerPath, 'utf-8'));
      if (typeof o.pid === 'number') holderPid = o.pid;
    } catch { /* fall through to mtime */ }
  }
  let stale = false;
  if (typeof holderPid === 'number') {
    stale = !pidAlive(holderPid);
  } else {
    try {
      stale = Date.now() - statSync(claimPath).mtimeMs > RUN_LOCK_STALE_MS;
    } catch { stale = true; }
  }
  if (!stale) {
    throw new Error(
      `runGsd: a resume claim already exists for ${featureCode} ` +
        `(.compose/gsd/${featureCode}/pause.lock, pid ${holderPid ?? 'unknown'} alive). ` +
        `Another --resume may be in progress; if none is, remove that directory to clear a stale claim.`,
    );
  }
  // Atomic stale takeover (rename-aside) — a concurrent reclaimer can't delete
  // our fresh lock. If we lose the race, refuse.
  if (!takeoverStaleLock(claimPath)) {
    throw new Error(
      `runGsd: another --resume claimed ${featureCode} during stale-claim takeover; retry.`,
    );
  }
  writeOwner();
}

/**
 * COMP-GSD-4: release ONLY the resume ownership claim (pause.lock), leaving
 * pause.json intact for the next --resume. Called in runGsd's finally on every
 * exit so a budget/stuck re-halt, cumulative refusal, or pre-dispatch throw
 * never strands the lock. Idempotent (force) — a no-op when no lock was claimed.
 */
function releasePauseLock(cwd, featureCode) {
  try { rmSync(join(gsdDir(cwd, featureCode), 'pause.lock'), { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * COMP-GSD-4: persist the budget halt diagnostic (budget.json + budget.md, via
 * composeBudgetDiagnostic) AND the resume state (pause.json, kind:'budget').
 * Mirrors writeStuckArtifacts but carries the `budget` block instead of the
 * stuck-specific fields. decomposedTasks comes from the enriched graph so
 * --resume re-dispatches the unfinished subset without re-decomposing.
 */
function writeBudgetArtifacts(ctx, response, budgetState) {
  const { cwd, featureCode } = ctx;
  const dir = gsdDir(cwd, featureCode);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();

  const sourceTasks = ctx.lastTaskGraph?.tasks ?? response.tasks ?? [];
  const decomposedTasks = sourceTasks.map((t) => ({ ...t }));
  const completedTaskIds = collectCompletedTaskIds(cwd, featureCode);

  const { json, md } = composeBudgetDiagnostic(budgetState, { feature: featureCode, decomposedTasks, completedTaskIds });
  writeFileSync(join(dir, 'budget.json'), JSON.stringify(json, null, 2) + '\n');
  writeFileSync(join(dir, 'budget.md'), md);

  const pause = {
    flowId: response.flow_id ?? null,
    stepId: response.step_id ?? ctx.lastStepId ?? 'execute',
    kind: 'budget',
    budget: { axis: json.axis, caps: budgetState.caps ?? {}, consumed: budgetState.consumed ?? {} },
    decomposedTasks,
    completedTaskIds,
    pid: process.pid,
    mode: 'gsd',
    ts,
  };
  writeFileSync(join(dir, 'pause.json'), JSON.stringify(pause, null, 2) + '\n');
}

/**
 * COMP-GSD-7: on a clean complete, snapshot the run's final budget actuals-vs-caps
 * to budget-final.json so the milestone report has them retroactively (a clean
 * complete writes no budget.json — only halts do). Distinct filename from the
 * halt artifact budget.json (which buildGsdQuery's precedence reads). Atomic write.
 */
export function writeBudgetFinalSnapshot(ctx, budgetState) {
  const { cwd, featureCode } = ctx;
  const dir = gsdDir(cwd, featureCode);
  mkdirSync(dir, { recursive: true });
  const decomposedTasks = (ctx.runState?.decomposedTasks ?? []).map((t) => ({ ...t }));
  const completedTaskIds = collectCompletedTaskIds(cwd, featureCode);
  const { json } = composeBudgetDiagnostic(budgetState, { feature: featureCode, decomposedTasks, completedTaskIds });
  const target = join(dir, 'budget-final.json');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  renameSync(tmp, target);
}

/**
 * COMP-GSD-4: append a run's consumed usage to the cumulative ledger. Sourced
 * from the stratum budget_state.consumed ({tokens,dispatches,wall_s,dollars}).
 * No-op when budget_state is absent (un-budgeted runs).
 */
export function recordGsdUsageFromState(cwd, featureCode, budgetState, alreadyRecorded = null) {
  const consumed = budgetState?.consumed;
  if (!consumed) return;
  const engine = {
    tokens: consumed.tokens ?? 0,
    costUsd: consumed.dollars ?? 0,
    dispatches: consumed.dispatches ?? 0,
    timeMs: Math.round((consumed.wall_s ?? 0) * 1000),
  };
  // G4: the engine ledger is ground truth, but on the TS path it now INCLUDES the
  // per-invocation usage compose already recorded incrementally into the same
  // cumulative store (via recordTsAgentUsage, from the step_done envelopes). Fold
  // only the DELTA — the engine-only debits (e.g. judged predicates) not already
  // counted — so nothing is double-debited. `alreadyRecorded` is this run's
  // incremental total (ctx.recordedUsage); absent (python path) → full fold.
  const prior = alreadyRecorded ?? { tokens: 0, costUsd: 0, dispatches: 0, timeMs: 0 };
  const delta = {
    tokens: Math.max(0, engine.tokens - (prior.tokens ?? 0)),
    costUsd: Math.max(0, engine.costUsd - (prior.costUsd ?? 0)),
    dispatches: Math.max(0, engine.dispatches - (prior.dispatches ?? 0)),
    timeMs: Math.max(0, engine.timeMs - (prior.timeMs ?? 0)),
  };
  if (delta.tokens === 0 && delta.costUsd === 0 && delta.dispatches === 0 && delta.timeMs === 0) return;
  recordGsdUsage(join(cwd, '.compose'), featureCode, delta);
}

/**
 * D7(a): the exact TaskResult path a gsd execute item must write, keyed by the
 * item's task id. Single-sources the filename with the blackboard reader
 * (collectBlackboard reads .compose/gsd/<feature>/results/<taskId>.json).
 */
export function gsdTaskResultPath(featureCode, taskId) {
  return `.compose/gsd/${featureCode}/results/${taskId}.json`;
}

// runAndNormalize narrates through a progress object (debug/warn/info/toolUse/
// toolSummary/stepStart/stepDone). GSD runs headless with no cockpit, so it
// hands the consumer loop a COMPLETE no-op — a partial stub throws mid-item.
const NOOP_PROGRESS = Object.freeze({
  stepStart() {}, stepDone() {}, debug() {}, warn() {}, info() {},
  toolUse() {}, toolSummary() {},
});

/**
 * D2(b): debit one TS-route agent invocation's usage into the cumulative gsd
 * ledger. On the TS path the engine's flow ledger never sees compose-dispatched
 * agents, so compose accounts each dispatch itself. `usage` is the normalized
 * shape from runAndNormalize ({input_tokens, output_tokens, cost_usd,
 * duration_ms}) or the raw TS complete usage ({tokens, usd, ms}).
 */
export function recordTsAgentUsage(ctx, usage) {
  if (!usage || !ctx?.cwd || !ctx?.featureCode) return;
  const tokens = usage.tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0));
  const costUsd = usage.cost_usd ?? usage.usd ?? 0;
  const timeMs = usage.duration_ms ?? usage.ms ?? 0;
  if (tokens === 0 && costUsd === 0 && timeMs === 0) return;
  recordGsdUsage(join(ctx.cwd, '.compose'), ctx.featureCode, { tokens, costUsd, timeMs, dispatches: 1 });
  // G4: remember what THIS run recorded incrementally so the terminal/budget-halt
  // fold (recordGsdUsageFromState) records only the engine-only delta, never
  // double-counting these envelope-reported invocations.
  ctx.recordedUsage ??= { tokens: 0, costUsd: 0, dispatches: 0, timeMs: 0 };
  ctx.recordedUsage.tokens += tokens;
  ctx.recordedUsage.costUsd += costUsd;
  ctx.recordedUsage.timeMs += timeMs;
  ctx.recordedUsage.dispatches += 1;
}

/**
 * COMP-GSD-4: write a budget refusal diagnostic when the cumulative ceiling is
 * already spent (pre-dispatch). No pause.json — nothing was dispatched, so
 * there is no run to resume; the user raises the cap or runs --reset-budget.
 */
function writeCumulativeRefusal(cwd, featureCode, chk, limits) {
  const dir = gsdDir(cwd, featureCode);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const json = { feature: featureCode, kind: 'budget', axis: 'cumulative', reason: chk.reason, usage: chk.usage, limits, ts };
  writeFileSync(join(dir, 'budget.json'), JSON.stringify(json, null, 2) + '\n');
  const md = [
    `# GSD budget refusal — ${featureCode}`,
    '',
    `**${chk.reason}**`,
    '',
    `Cumulative usage: ${chk.usage.totalTokens} tokens, $${(chk.usage.totalCostUsd ?? 0).toFixed(4)}.`,
    '',
    'This feature has already spent its cumulative `gsd.budget.cumulative.*` ceiling.',
    'Raise the cap in `.compose/compose.json`, or clear the ledger:',
    '',
    '```',
    `compose gsd ${featureCode} --reset-budget`,
    '```',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'budget.md'), md);
}

function clearPauseFile(cwd, featureCode) {
  const dir = gsdDir(cwd, featureCode);
  try { rmSync(join(dir, 'pause.json'), { force: true }); } catch { /* best-effort */ }
  // Release the resume ownership claim dir (COMP-GSD-5 Codex review) alongside it.
  try { rmSync(join(dir, 'pause.lock'), { recursive: true, force: true }); } catch { /* best-effort */ }
}
