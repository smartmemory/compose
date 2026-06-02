/**
 * gsd-stuck.js — GsdStuckDetector for COMP-GSD-5.
 *
 * Detects, in real time during per-task `compose gsd` dispatch, that an agent
 * is spinning, and emits a structured verdict so the run loop can halt cleanly.
 *
 * Four signals (thresholds tunable via constructor opts; defaults 3/3/8/600000):
 *   - same_file:        one file_path edited >= sameFileEdits times.
 *   - error_recurrence: a normalized error hash recurs >= errorRepeats.
 *   - no_progress:      >= noProgressCalls consecutive non-file-changing tool calls.
 *   - wall_clock:       nowMs - startedAt(taskId) >= wallClockMs.
 *
 * The same-file signal REUSES FixChainDetector (lib/debug-discipline.js) for its
 * per-key file-hit counting — keyed here by taskId. Error-recurrence and
 * no-progress are the only new bookkeeping.
 *
 * Consumes BuildStreamEvents from stratum.onEvent inside
 * executeParallelDispatchServer, keyed by event.task_id. gsd runs the execute
 * step max_concurrent:1, so per-task state is unambiguous. Telemetry contract
 * (schema 0.2.7, STRAT-PAR-STREAM-TOOLDETAIL):
 *   tool_use_summary.metadata = { tool, summary, ok, duration_ms, input, tool_use_id }
 *     input.file_path present for Edit/Write/MultiEdit/Read
 *   tool_result.metadata     = { tool_use_id, ok, output }
 *
 * See: docs/features/COMP-GSD-5/{design,blueprint,plan}.md
 *      contracts/gsd-stuck.json (`stuck` diagnostic shape)
 */

import { createHash } from 'node:crypto';
import { FixChainDetector } from './debug-discipline.js';

// Default thresholds (Decision 4 in design.md).
export const DEFAULT_THRESHOLDS = Object.freeze({
  sameFileEdits: 3,
  errorRepeats: 3,
  noProgressCalls: 8,
  wallClockMs: 600000,
});

// Tools that change files on disk — they reset no-progress and feed same-file.
// Read is deliberately excluded: it touches a file_path but makes no change.
const FILE_CHANGING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// ---------------------------------------------------------------------------
// Error normalization — collapse cosmetic diffs (volatile paths, line:col
// numbers, whitespace, hex/temp ids) so the SAME logical failure hashes the
// same across repeats.
// ---------------------------------------------------------------------------

export function normalizeError(output) {
  if (output == null) return '';
  let s = String(output);
  // Absolute/relative file paths -> a stable token. Catches /Users/..,
  // /tmp/.., /var/.., ./rel/path, C:\... etc. up to a :line:col or space.
  s = s.replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s:]+(?:[/\\][^\s:]+)*/g, '<path>');
  // Bare relative module-ish paths (a/b/c.js) that didn't start with a slash.
  s = s.replace(/\b[\w.-]+(?:\/[\w.-]+)+\.\w+\b/g, '<path>');
  // line:col suffixes (e.g. :12:5 or :12).
  s = s.replace(/:\d+(?::\d+)?\b/g, ':<n>');
  // Standalone long digit runs (ids, ports, offsets) and hex blobs.
  s = s.replace(/0x[0-9a-fA-F]+/g, '<hex>');
  s = s.replace(/\b\d{2,}\b/g, '<n>');
  // Collapse all whitespace (incl. the em-dash-adjacent spacing) to single spaces.
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

function hashError(output) {
  return createHash('sha1').update(normalizeError(output)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// GsdStuckDetector
// ---------------------------------------------------------------------------

export class GsdStuckDetector {
  constructor(opts = {}) {
    this.sameFileEdits = opts.sameFileEdits ?? DEFAULT_THRESHOLDS.sameFileEdits;
    this.errorRepeats = opts.errorRepeats ?? DEFAULT_THRESHOLDS.errorRepeats;
    this.noProgressCalls = opts.noProgressCalls ?? DEFAULT_THRESHOLDS.noProgressCalls;
    this.wallClockMs = opts.wallClockMs ?? DEFAULT_THRESHOLDS.wallClockMs;

    // same-file: reuse FixChainDetector's per-key file-hit counter, keyed by taskId.
    this._fixChain = new FixChainDetector();
    // error-recurrence: per-task Map<normalizedHash, count>.
    /** @type {Map<string, Map<string, number>>} */
    this._errorHits = new Map();
    // no-progress: per-task consecutive non-file-changing call count.
    /** @type {Map<string, number>} */
    this._noProgress = new Map();
    // wall-clock baseline per task.
    /** @type {Map<string, number>} */
    this._startedAt = new Map();
  }

  /** Mark a task's dispatch start — establishes the wall-clock baseline. */
  startTask(taskId, nowMs) {
    if (!taskId) return;
    if (!this._startedAt.has(taskId)) {
      this._startedAt.set(taskId, nowMs);
    }
  }

  /**
   * Route a BuildStreamEvent into per-task state. Only tool_use_summary and
   * tool_result are meaningful; everything else (and any untagged event) is
   * ignored. Keyed by event.task_id.
   */
  record(event) {
    if (!event || typeof event !== 'object') return;
    const taskId = event.task_id;
    if (!taskId) return; // gsd is max_concurrent:1 but be defensive about attribution.
    const md = event.metadata ?? {};

    if (event.kind === 'tool_use_summary') {
      const tool = md.tool;
      const filePath = md.input?.file_path;
      if (FILE_CHANGING_TOOLS.has(tool)) {
        // same-file: count the file hit (reuse FixChainDetector per-key counter).
        if (filePath) {
          this._fixChain.recordIterationForBug(taskId, [filePath]);
        }
        // no-progress: a file-changing tool resets the consecutive run.
        this._noProgress.set(taskId, 0);
      } else if ((this._fixChain.byBug.get(taskId)?.fileHits?.size ?? 0) > 0) {
        // "No progress" = non-file-changing calls (Bash, Grep, Read, Glob, ...)
        // AFTER the task has started editing. A task's initial read/grep/test
        // exploration is legitimate work, not a stall — counting it would
        // false-positive and abort productive TDD loops (COMP-GSD-5 Codex
        // review). A task that NEVER edits is caught by the wall_clock backstop.
        this._noProgress.set(taskId, (this._noProgress.get(taskId) ?? 0) + 1);
      }
      return;
    }

    if (event.kind === 'tool_result') {
      if (md.ok === false) {
        const hash = hashError(md.output);
        let m = this._errorHits.get(taskId);
        if (!m) { m = new Map(); this._errorHits.set(taskId, m); }
        m.set(hash, (m.get(hash) ?? 0) + 1);
      }
      return;
    }
  }

  /**
   * Evaluate the stuck signals for a task. Returns the FIRST signal that has
   * tripped (precedence: same_file, error_recurrence, no_progress, wall_clock).
   * @returns {{stuck:true, signal:string, detail:string} | {stuck:false}}
   */
  check(taskId, nowMs) {
    // --- same_file ---
    const fileHits = this._fixChain.byBug.get(taskId)?.fileHits;
    if (fileHits) {
      for (const [file, count] of fileHits.entries()) {
        if (count >= this.sameFileEdits) {
          return {
            stuck: true,
            signal: 'same_file',
            detail: `file ${file} edited ${count} times (>= ${this.sameFileEdits}) without converging`,
          };
        }
      }
    }

    // --- error_recurrence ---
    const errs = this._errorHits.get(taskId);
    if (errs) {
      for (const [hash, count] of errs.entries()) {
        if (count >= this.errorRepeats) {
          return {
            stuck: true,
            signal: 'error_recurrence',
            detail: `the same error recurred ${count} times (>= ${this.errorRepeats}); normalized hash ${hash}`,
          };
        }
      }
    }

    // --- no_progress ---
    const np = this._noProgress.get(taskId) ?? 0;
    if (np >= this.noProgressCalls) {
      return {
        stuck: true,
        signal: 'no_progress',
        detail: `${np} consecutive tool calls (>= ${this.noProgressCalls}) with no file-changing edit`,
      };
    }

    // --- wall_clock ---
    const startedAt = this._startedAt.get(taskId);
    if (startedAt != null && nowMs - startedAt >= this.wallClockMs) {
      return {
        stuck: true,
        signal: 'wall_clock',
        detail: `task ran ${nowMs - startedAt}ms (>= ${this.wallClockMs}ms) without finishing`,
      };
    }

    return { stuck: false };
  }

  /**
   * Build the `attemptCounts` snapshot for the stuck.json diagnostic
   * (contracts/gsd-stuck.json#/definitions/stuck/attemptCounts).
   */
  attemptCounts(taskId) {
    const fileHits = this._fixChain.byBug.get(taskId)?.fileHits;
    const maxFileEdits = fileHits ? Math.max(0, ...fileHits.values()) : 0;
    const errs = this._errorHits.get(taskId);
    const maxErrorRepeats = errs ? Math.max(0, ...errs.values()) : 0;
    return {
      sameFileEdits: maxFileEdits,
      errorRepeats: maxErrorRepeats,
      noProgressCalls: this._noProgress.get(taskId) ?? 0,
    };
  }

  /** Clear all state for one task without touching others. */
  reset(taskId) {
    this._fixChain.resetForBug(taskId);
    this._errorHits.delete(taskId);
    this._noProgress.delete(taskId);
    this._startedAt.delete(taskId);
  }

  // --- Serialization (resume) ----------------------------------------------

  toJSON() {
    return {
      thresholds: {
        sameFileEdits: this.sameFileEdits,
        errorRepeats: this.errorRepeats,
        noProgressCalls: this.noProgressCalls,
        wallClockMs: this.wallClockMs,
      },
      fixChain: this._fixChain.toJSON(),
      errorHits: Object.fromEntries(
        [...this._errorHits.entries()].map(([t, m]) => [t, Object.fromEntries(m)]),
      ),
      noProgress: Object.fromEntries(this._noProgress),
      startedAt: Object.fromEntries(this._startedAt),
    };
  }

  static fromJSON(json) {
    const t = (json && typeof json === 'object' && json.thresholds) || {};
    const d = new GsdStuckDetector({
      sameFileEdits: t.sameFileEdits,
      errorRepeats: t.errorRepeats,
      noProgressCalls: t.noProgressCalls,
      wallClockMs: t.wallClockMs,
    });
    if (!json || typeof json !== 'object') return d;

    d._fixChain = FixChainDetector.fromJSON(json.fixChain ?? {});
    if (json.errorHits && typeof json.errorHits === 'object') {
      for (const [taskId, hashes] of Object.entries(json.errorHits)) {
        d._errorHits.set(taskId, new Map(Object.entries(hashes ?? {})));
      }
    }
    if (json.noProgress && typeof json.noProgress === 'object') {
      for (const [taskId, n] of Object.entries(json.noProgress)) {
        d._noProgress.set(taskId, Number(n) || 0);
      }
    }
    if (json.startedAt && typeof json.startedAt === 'object') {
      for (const [taskId, ms] of Object.entries(json.startedAt)) {
        d._startedAt.set(taskId, Number(ms) || 0);
      }
    }
    return d;
  }
}
