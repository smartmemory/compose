/**
 * experiment-metrics.js — Collect metrics from a completed sandbox run.
 *
 * COMP-MODEL-AB: four metric axes per run:
 *   cost     — tokens in/out, call count, wall-clock, USD (derived via pricing table)
 *   outcome  — completed, health score, test pass rate, files/lines changed
 *   process  — review iterations, gate failures, retries, escalations
 *
 * Reads ONLY sandbox artifacts on disk; makes no LLM calls and runs no builds.
 * A crashed build (exitCode ≠ 0, no history record) still yields a record with
 * outcome.completed=false and whatever partial data exists.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { deriveUsd } from './experiment-pricing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the last record from a JSONL file (most recent build history entry).
 * @param {string} filePath
 * @returns {object|null}
 */
function readLastJsonlRecord(filePath) {
  if (!existsSync(filePath)) return null;
  let raw;
  try { raw = readFileSync(filePath, 'utf-8'); } catch { return null; }
  const lines = raw.split('\n').filter(l => l.trim());
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

/**
 * Read all records from a JSONL file.
 * @param {string} filePath
 * @returns {object[]}
 */
function readAllJsonlRecords(filePath) {
  if (!existsSync(filePath)) return [];
  let raw;
  try { raw = readFileSync(filePath, 'utf-8'); } catch { return []; }
  const records = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return records;
}

/**
 * Run `git diff --stat` in the workspace and parse files/lines changed.
 * When baselineSha is provided, diffs against that commit so changes committed
 * in-process by the real build (ship step) are captured rather than returning
 * 0/0 from a clean post-commit working tree.
 * Returns { filesChanged: 0, linesChanged: 0 } on any error.
 *
 * @param {string}      workspace
 * @param {string|null} [baselineSha]  SHA of the pre-build baseline commit (fix #2)
 * @returns {{ filesChanged: number, linesChanged: number }}
 */
function gitDiffStat(workspace, baselineSha = null) {
  try {
    // Stage untracked files so new files created by the build appear in the stat.
    // Idempotent — safe to call after executeRun already ran git add -A.
    execSync('git add -A 2>/dev/null', { cwd: workspace, encoding: 'utf-8', timeout: 10_000 });
    const diffCmd = baselineSha
      ? `git diff --stat ${baselineSha} 2>/dev/null`
      : 'git diff --stat HEAD 2>/dev/null';
    const out = execSync(diffCmd, {
      cwd: workspace,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    // Last line: "N files changed, M insertions(+), K deletions(-)"
    const summary = out.split('\n').filter(Boolean).pop() ?? '';
    const filesMatch   = summary.match(/(\d+)\s+file/);
    const insertMatch  = summary.match(/(\d+)\s+insertion/);
    const deleteMatch  = summary.match(/(\d+)\s+deletion/);
    const filesChanged = filesMatch  ? parseInt(filesMatch[1],  10) : 0;
    const linesChanged = (insertMatch ? parseInt(insertMatch[1], 10) : 0)
                       + (deleteMatch ? parseInt(deleteMatch[1], 10) : 0);
    return { filesChanged, linesChanged };
  } catch {
    return { filesChanged: 0, linesChanged: 0 };
  }
}

/**
 * Extract process friction metrics from build-stream.jsonl events.
 *
 * Signal mapping (verified against lib/build.js):
 *   retries      — sum of `ev.retries` on `build_step_done` events (~line 1811).
 *                  The build does NOT emit step_retry / build_retry events.
 *   gateFailures — count of `build_gate_resolved` events with outcome 'revise' or
 *                  'kill' (~lines 1877–1988). Auto-approvals (skip/flag policy modes)
 *                  always emit outcome='approve' and are not counted. The old
 *                  ensure_failed event does NOT exist in the real build stream.
 *   escalations  — count of `build_error` events whose message matches /escalat/i
 *                  (~line 1766). The 'escalation' event type is written only to the
 *                  debug ledger, not the build stream.
 *   reviewIters  — count of `build_step_done` events with stepId 'review' or
 *                  'codex_review' (unchanged — these stepIds do occur).
 *
 * @param {object[]} events  All parsed build stream event objects
 * @returns {{ reviewIters: number, gateFailures: number, retries: number, escalations: number }}
 */
function parseProcessFromStream(events) {
  let reviewIters   = 0;
  let gateFailures  = 0;
  let retries       = 0;
  let escalations   = 0;

  for (const ev of events) {
    const type = ev?.type ?? ev?.kind;

    // review step completions count as review iterations; retries are a per-step
    // field on the same event, not a separate event type.
    // v1 limitation: retries is only non-zero for top-level steps; child-flow
    // steps and parallel dispatch completions always emit retries:0 in their
    // build_step_done payloads, so the sum undercounts multi-flow runs.
    if (type === 'build_step_done') {
      const stepId = ev?.stepId ?? ev?.step_id ?? '';
      if (stepId === 'review' || stepId === 'codex_review') reviewIters++;
      retries += typeof ev?.retries === 'number' ? ev.retries : 0;
    }

    // Gate failures: human gates resolved as 'revise' (rejected, needs rework)
    // or 'kill' (terminated). Policy-auto-approved gates emit outcome='approve'.
    if (type === 'build_gate_resolved') {
      const outcome = ev?.outcome ?? '';
      if (outcome === 'revise' || outcome === 'kill') gateFailures++;
    }

    // Escalations are signalled via build_error (not a separate 'escalation' event).
    if (type === 'build_error') {
      if (/escalat/i.test(ev?.message ?? '')) escalations++;
    }
  }
  return { reviewIters, gateFailures, retries, escalations };
}

/**
 * Extract health score from build-stream events.
 *
 * @param {object[]} events
 * @returns {number|null}
 */
function parseHealthFromStream(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if ((ev?.type === 'health_score' || ev?.kind === 'health_score') && typeof ev?.score === 'number') {
      return ev.score;
    }
    // health_score embedded in kind/metadata envelope format
    if (ev?.kind === 'health_score' && typeof ev?.metadata?.score === 'number') {
      return ev.metadata.score;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect all four metric axes from a sandbox's build artifacts.
 *
 * @param {object} args
 * @param {{ workspace: string, runDir: string }} args.sandbox
 *   workspace — the git workspace dir (for git diff --stat)
 *   runDir    — the run's output dir (contains manifest.json, build artifacts)
 * @param {{ exitCode?: number, stdout?: string, wallMs?: number }} [args.buildResult]
 *   Optional output from the build process. `wallMs` is used as a cost fallback
 *   when the history record has no durationMs (e.g. crash before history write).
 *   `stdout` is retained for backward-compat but is no longer parsed for tests.
 * @param {string|null} [args.baselineSha]
 *   SHA of the pre-build baseline commit. When provided, gitDiffStat diffs against
 *   this commit so in-process ship commits are counted (fix #2). Pass null / omit
 *   to fall back to `git diff --stat HEAD` (backward-compatible, greenfield fakes).
 *
 * @returns {{ cost: object, outcome: object, process: object }}
 */
export function collect({ sandbox, buildResult = {}, baselineSha = null }) {
  const dataDir  = join(sandbox.workspace, '.compose', 'data');
  const composeDir = join(sandbox.workspace, '.compose');

  // ---------------------------------------------------------------------------
  // 1. Build-history record (terminal record — most recent)
  // ---------------------------------------------------------------------------
  const historyRecord = readLastJsonlRecord(join(dataDir, 'build-history.jsonl'));

  // ---------------------------------------------------------------------------
  // 2. Build stream events
  // ---------------------------------------------------------------------------
  const streamEvents = readAllJsonlRecords(join(composeDir, 'build-stream.jsonl'));

  // ---------------------------------------------------------------------------
  // 3. Cost axis
  // ---------------------------------------------------------------------------
  const tokensIn  = historyRecord?.input_tokens  ?? 0;
  const tokensOut = historyRecord?.output_tokens ?? 0;
  // calls = stepCount (step records in history, including gate records). This is
  // NOT raw model invocations — one step can make multiple LLM calls internally.
  const calls     = historyRecord?.stepCount     ?? 0;
  const wallMs    = historyRecord?.durationMs    ?? (buildResult?.wallMs ?? 0);

  // Try to derive USD from the history record's embedded cost first.
  // Fall back to deriveUsd with a model from the stream if needed.
  let usd = null;
  if (typeof historyRecord?.cost_usd === 'number') {
    usd = historyRecord.cost_usd;
  } else {
    // Find any step_model event to get the model ID for pricing
    const modelEv = streamEvents.find(
      e => (e?.type === 'step_model' || e?.kind === 'step_model') && (e?.modelID ?? e?.metadata?.modelID)
    );
    const modelID = modelEv?.modelID ?? modelEv?.metadata?.modelID ?? null;
    if (modelID) usd = deriveUsd(modelID, tokensIn, tokensOut);
  }

  const cost = { tokensIn, tokensOut, calls, wallMs, usd };

  // ---------------------------------------------------------------------------
  // 4. Outcome axis
  // ---------------------------------------------------------------------------
  const completed     = historyRecord?.status === 'complete';
  const health        = parseHealthFromStream(streamEvents);

  // Test pass rate: the build's ship step runs tests via execSync and persists
  // structured counts to build-history.jsonl as test_count and pass_rate fields
  // (COMP-MODEL-AB fix B). Read directly from the history record — the ship step's
  // execSync output never reaches realHeadlessBuild's stdout buffer (only the
  // outer `node compose build` process's own stdout is captured there).
  //
  // v1 limitation: testsTotal/testsPass are null on failed, aborted, or thrown
  // builds even if tests ran before the failure. _extractShipTestMetrics only
  // fires on the success path (ship step completes + testSummary.parsed=true);
  // terminalizeThrownBuild and the early-abort path never carry test_count/pass_rate.
  // outcome.completed=false already signals the failure; null test metrics on those
  // paths are expected and should not be treated as a data gap.
  const testsTotal = historyRecord?.test_count ?? null;
  let testsPass  = null;
  if (testsTotal !== null && historyRecord?.pass_rate != null) {
    testsPass = historyRecord.pass_rate === 100
      ? testsTotal
      : Math.round((historyRecord.pass_rate / 100) * testsTotal);
  }

  const { filesChanged, linesChanged } = gitDiffStat(sandbox.workspace, baselineSha);

  const outcome = { completed, health, testsPass, testsTotal, filesChanged, linesChanged };

  // ---------------------------------------------------------------------------
  // 5. Process axis
  // ---------------------------------------------------------------------------
  const process = parseProcessFromStream(streamEvents);

  return { cost, outcome, process };
}
