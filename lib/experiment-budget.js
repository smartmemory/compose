/**
 * experiment-budget.js — run budget and checkpoint/retry for the experiment engine (COMP-STAGE-GRADING-12, B1).
 *
 * ONE gate for every dispatch path (stage runs, builds, legacy builds that opt in with `budget`):
 * runSlot() decides, per run slot and BEFORE provision, whether to reuse the record on disk, retry it, or
 * stop because the budget is spent. Shapes and the decision rows are fixed by
 * docs/features/COMP-MODEL-AB-DECISION/stage-run-contract.json (rules.checkpoint, $defs.runBudget, $defs.runSkipped).
 *
 * The meter covers THIS invocation only: a reused record was paid for by an earlier invocation, so a restart
 * that dispatches 1 run spends against the budget once, for 1 run.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256Hex, refusal } from './experiment-stage.js';

export { canonicalJson, sha256Hex };

const BUDGET_STOPS = new Set(['maxRuns', 'maxUsdTotal', 'maxTokensTotal']);

/** Where a run's record lives (same path the runners write). */
export function recordPath(expRoot, runId) {
  return join(expRoot, 'runs', runId, `${runId}.json`);
}

/** TERMINAL (contract rules.checkpoint): executed, no _error, not stopped by a total cap. A model timeout IS terminal. */
export function isTerminal(rec) {
  return Boolean(rec) && rec.skipped === undefined && rec._error === undefined && !BUDGET_STOPS.has(rec.budget?.stoppedBy);
}

/**
 * The checkpoint decision (contract rules.checkpoint.rows, evaluated top to bottom, first match wins).
 * @param {{runId: string, existing: object|null, newRunKey: string, rerun: string|null}} input
 * @returns {{row: string, dispatch: boolean, archivePrev: boolean}}
 */
export function decideCheckpoint({ runId, existing, newRunKey, rerun = null }) {
  const go = (row, archivePrev = false) => ({ row, dispatch: true, archivePrev });
  if (!existing) return go('none');
  if (existing.skipped === undefined && existing.runKey !== newRunKey) return go('mismatch', true);
  if (rerun === 'all') return go('rerun-all');
  if (rerun === runId) return go('rerun-one');
  if (rerun === 'failed' && (!isTerminal(existing) || existing.budget?.stoppedBy === 'timeout')) return go('rerun-failed');
  if (existing.skipped !== undefined) return go('skipped');
  if (existing._error !== undefined) return go('error');
  if (BUDGET_STOPS.has(existing.budget?.stoppedBy)) return go('budget-stopped');
  return { row: 'terminal', dispatch: false, archivePrev: false };
}

/** Validate --rerun against the matrix: null, "failed", "all" or one runId of this experiment. */
export function checkRerun(rerun, runDescs) {
  if (rerun === undefined || rerun === null) return null;
  if (typeof rerun !== 'string' || !rerun) throw new Error('rerun must be "failed", "all" or a runId');
  if (rerun !== 'failed' && rerun !== 'all' && !runDescs.some(r => r.runId === rerun)) {
    throw refusal('RERUN_UNKNOWN_RUN', `--rerun "${rerun}" is not "failed", "all" or a runId of this experiment`);
  }
  return rerun;
}

/**
 * The stop rule state for one invocation (plan ### B1). `dispatched` counts runs started now; the USD meter is
 * used only while every receipt so far has a usd; the token meter takes each record's spentTokens, which the
 * runners already set to perRunTokenAssume when a run has no usable receipt. Once a stop fires it is sticky.
 */
export function createMeter(budget) {
  const m = { dispatched: 0, usd: 0, usdKnown: true, tokens: 0, stoppedBy: null };
  return {
    get state() { return { ...m }; },
    /** The reason to stop starting runs now, else null. */
    check() {
      if (m.stoppedBy) return m.stoppedBy;
      if (m.dispatched >= budget.maxRuns) m.stoppedBy = 'maxRuns';
      else if (m.usdKnown && budget.maxUsdTotal !== null && m.usd >= budget.maxUsdTotal) m.stoppedBy = 'maxUsdTotal';
      else if (m.tokens >= budget.maxTokensTotal) m.stoppedBy = 'maxTokensTotal';
      return m.stoppedBy;
    },
    start() { m.dispatched++; },
    /** Add a finished run's spend (record.budget). */
    observe(rec) {
      const b = rec?.budget;
      if (Number.isFinite(b?.spentUsd)) m.usd += b.spentUsd; else m.usdKnown = false;
      m.tokens += Number.isFinite(b?.spentTokens) ? b.spentTokens : budget.perRunTokenAssume;
    },
    /** budget block for a run that was not started. */
    skippedBudget() {
      return { stoppedBy: m.stoppedBy, spentUsd: m.usdKnown ? m.usd : null, spentTokens: m.tokens };
    },
  };
}

/** The control a budgeted experiment carries through runSlot. */
export function createRunControl({ spec, expRoot, rerun = null }) {
  return { budget: spec.budget, expRoot, rerun, runner: spec.runner === 'stage' ? 'stage' : 'build', meter: createMeter(spec.budget) };
}

function readExisting(file) {
  if (!existsSync(file)) return { existing: null, corrupt: false };
  try { return { existing: JSON.parse(readFileSync(file, 'utf-8')), corrupt: false }; } catch { return { existing: null, corrupt: true }; }
}

function archive(file) {
  const to = `${file}.prev-${Date.now()}`;
  renameSync(file, to);
  return to;
}

const say = line => process.stderr.write(`[experiment] ${line}\n`);

/**
 * Drive one run slot through checkpoint and budget. `execute` runs the dispatch (provision and everything after)
 * and returns the written record; it is called only when the slot is dispatched.
 *  - reuse: a terminal record with an equal runKey is returned untouched, nothing dispatched;
 *  - stop: the budget is spent. An existing executed record stays (it is the better evidence); otherwise a
 *    `skipped: "BUDGET_STOP"` record is written, retried by the next restart;
 *  - dispatch: a runKey mismatch first moves the old record to `<runId>.json.prev-<epoch>`.
 */
export async function runSlot(ctl, runDesc, runKey, execute) {
  const { runId, config, rep } = runDesc;
  const file = recordPath(ctl.expRoot, runId);
  const { existing, corrupt } = readExisting(file);
  const d = corrupt
    ? { row: 'mismatch', dispatch: true, archivePrev: true }
    : decideCheckpoint({ runId, existing, newRunKey: runKey, rerun: ctl.rerun });

  if (!d.dispatch) {
    say(`${runId}: reused (checkpoint ${d.row})`);
    return existing;
  }

  const stop = ctl.meter.check();
  if (stop) {
    if (existing && existing.skipped === undefined) {
      say(`${runId}: kept existing record (budget stop ${stop})`);
      return existing;
    }
    if (corrupt) archive(file);
    const record = { runId, configLabel: config.label, rep, runner: ctl.runner, skipped: 'BUDGET_STOP', budget: ctl.meter.skippedBudget() };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    say(`${runId}: skipped (budget stop ${stop})`);
    return record;
  }

  if (d.archivePrev) say(`${runId}: runKey changed, old record moved to ${archive(file).split('/').pop()}`);
  ctl.meter.start();
  const record = await execute();
  ctl.meter.observe(record);
  return record;
}
