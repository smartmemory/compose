/**
 * STRAT-LEARN-INLINE-TS-1 §A5 / STRAT-LEARN-DELIVER-1 D6 — Compose build summary.
 *
 * At every build exit (completed, failed, killed) Compose asks stratum what the owner
 * still has to act on for this workspace: lessons staged but not yet applied, dismissed or
 * retired, and open retirement reviews. Compose's build end does not call stratum_audit
 * when the completion envelope carries a trace, so it cannot rely on the audit field.
 *
 * Both questions go through `stratum learn list ... --if-enabled --json`, which prints
 * nothing when the owning `[learn]` switch is OFF for the root — so an OFF workspace with a
 * populated sidecar prints nothing here. Fail-open: any error prints nothing and never
 * reaches the build.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveStratumBin } from './stratum-engine.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 20_000;

async function listJson(cwd, args, deps) {
  const env = deps.env ?? process.env;
  const bin = resolveStratumBin('cli', cwd, deps);
  const { stdout } = await execFileAsync(
    env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    [bin, 'learn', 'list', ...args, '--if-enabled', '--json', '--root', cwd],
    { cwd, env, signal: deps.signal, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );
  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
}

async function safely(fn, warn) {
  try { return await fn(); } catch (error) {
    warn(`[learn] summary unavailable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return [];
  }
}

/** The summary lines; [] when both switches are OFF, nothing is pending, or stratum failed. */
export async function learnSummaryLines(cwd, deps = {}) {
  if (deps.signal?.aborted) return [];
  const warn = deps.warn ?? (() => {});
  let [unreviewed, reviews] = await Promise.all([
    safely(() => listJson(cwd, ['--unreviewed'], deps), warn),
    safely(() => listJson(cwd, ['--reviews'], deps), warn),
  ]);
  if (deps.signal?.aborted) return [];
  const lines = [];
  // Requires a Stratum with `learn list --unreviewed/--reviews --if-enabled` (DELIVER-1
  // slices 4–5 + INLINE-TS-1). An older CLI ignores those flags and lists raw
  // PatchCandidate rows instead — recognizable by their `rendered`/`clusterKey`
  // fields, which the UnreviewedLesson shape (clusterId, revisionId, claim,
  // guidance?) never carries.
  const REVIEW_KINDS = new Set(['retire-candidate', 'not-holding', 'contract-changed', 'recurred-after-retirement']);
  if (Array.isArray(reviews)) reviews = reviews.filter((review) => REVIEW_KINDS.has(review?.kind));
  if (Array.isArray(unreviewed)) {
    unreviewed = unreviewed.filter((lesson) => lesson !== null && typeof lesson === 'object' && !('rendered' in lesson));
  }
  if (Array.isArray(unreviewed) && unreviewed.length > 0) {
    lines.push(`Lessons to review (${unreviewed.length}):`);
    for (const lesson of unreviewed) {
      lines.push(`  ${String(lesson.revisionId).slice(0, 12)}  ${lesson.claim}${lesson.guidance === undefined ? '  (note only)' : ''}`);
      if (lesson.guidance !== undefined) lines.push(`      guidance: ${lesson.guidance}`);
    }
    lines.push('  apply: stratum learn apply <revision>   dismiss: stratum learn dismiss <clusterId> --reason <text>');
  }
  if (Array.isArray(reviews) && reviews.length > 0) {
    lines.push(`Lesson reviews (${reviews.length}):`);
    for (const review of reviews) {
      lines.push(`  ${review.kind}  ${String(review.clusterId).slice(0, 12)}  ${review.detail}`);
    }
    lines.push('  close: stratum learn <retire|dismiss|ack> <clusterId> --reason <text>');
  }
  return lines;
}

/** Print the summary after the build's terminal status line. Never throws. */
export async function printLearnSummary(cwd, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  try {
    const lines = await learnSummaryLines(cwd, { ...deps, warn: (message) => {
      if (!deps.signal?.aborted) (deps.warn ?? console.warn)(message);
    } });
    if (!deps.signal?.aborted && lines.length > 0) log(`\n${lines.join('\n')}`);
  } catch {
    // Surfacing is advisory; a failure here must never change the build's outcome.
  }
}
