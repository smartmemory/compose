/**
 * build-history.js — COMP-COCKPIT-3 run history (past builds).
 *
 * Append-only log of terminal build records at <dataDir>/build-history.jsonl.
 * Written once per build, after the COMP-HEALTH gate resolves the final
 * buildStatus (lib/build.js), assembled from the in-memory build context for
 * that run — NEVER re-read from active-build.json, which is last-writer-wins
 * across concurrent builds (see project_compose_idempotency_gaps).
 *
 * Sync I/O is intentional and matches BuildStreamWriter — records are small
 * and the CLI is I/O-bound on agent calls. Writes must never break the build,
 * so appendBuildHistory swallows its own errors.
 */
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'build-history.jsonl';

/**
 * Append a single build record as one JSON line. Never throws.
 * @param {string} dataDir  .compose/data directory
 * @param {object} record   terminal build record
 */
export function appendBuildHistory(dataDir, record) {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, FILE), JSON.stringify(record) + '\n');
  } catch {
    // History is best-effort observability — must not break the build path.
  }
}

/**
 * Read build records, most-recent-first, bounded by limit. Missing file → [].
 * Malformed lines are skipped. A file that exists but cannot be read logs a WARNING
 * and throws (`Error.code` = the fs code); it is never reported as an empty history.
 * @param {string} dataDir
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @returns {object[]}
 */
export function readBuildHistory(dataDir, { limit = 50 } = {}) {
  const path = join(dataDir, FILE);
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return []; // missing is an empty history; any other fault (EACCES on a parent, EISDIR) is a source error
    // A present-but-unreadable file is not an empty history: say what was lost and let the caller see the fault.
    // The message carries the fs code only, never the absolute path.
    const code = err?.code || 'unknown error';
    console.warn(`[build-history] build-history.jsonl unreadable (${code}): build records are unavailable`);
    throw Object.assign(new Error(`build history unreadable (${code})`), { code });
  }
  const records = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  records.reverse(); // most-recent-first
  return records.slice(0, Math.max(0, limit));
}

/**
 * Map a stepHistory outcome to the UI step status vocabulary.
 * Single source of truth shared by syncStepHistory (active-build.json)
 * and projectHistorySteps (build-history.jsonl) so the two surfaces
 * can never drift.
 * @param {string|undefined} outcome
 * @returns {string}
 */
export function stepOutcomeToStatus(outcome) {
  return outcome === 'complete' ? 'done'
       : outcome === 'failed' ? 'failed'
       : outcome === 'approve' ? 'done'
       : outcome === 'revise' ? 'revised'
       : outcome === 'kill' ? 'killed'
       : outcome ?? 'done';
}

/**
 * Project the in-memory stepHistory into the compact per-step shape stored
 * on build-history records (COMP-MOBILE-1-1). Deliberately smaller than the
 * active-build.json step objects: summary is kept only for failed steps so
 * JSONL lines stay bounded.
 * @param {object[]} stepHistory
 * @returns {Array<{id: string, status: string, agent: string|null, durationMs: number|null, summary?: string}>}
 */
export function projectHistorySteps(stepHistory) {
  if (!Array.isArray(stepHistory)) return [];
  return stepHistory.map(h => {
    const status = stepOutcomeToStatus(h?.outcome);
    const step = {
      id: h?.stepId ?? null,
      status,
      agent: h?.agent ?? null,
      durationMs: h?.durationMs ?? null,
    };
    if (status === 'failed' && h?.summary) step.summary = h.summary;
    return step;
  });
}
