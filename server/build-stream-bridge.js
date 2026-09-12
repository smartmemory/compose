/**
 * BuildStreamBridge — tails .compose/build-stream.jsonl and rebroadcasts
 * events as SSE messages via the agent-server's broadcast() function.
 *
 * File-based decoupling: the CLI writes JSONL, this bridge reads it.
 * The CLI and server are separate OS processes with independent lifecycles.
 */

import { readFileSync, statSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { emitDecisionEvent, buildPolicyViolationEvent } from './decision-event-emit.js';

const JSONL_FILENAME = 'build-stream.jsonl';
const DEFAULT_CRASH_TIMEOUT_MS = 300_000; // 5 min
const STALE_GATE_TIMEOUT_MS = 86_400_000; // 24h
const DEBOUNCE_MS = 50;
const POLL_INTERVAL_MS = 2000;

// COMP-AGENT-LANES: forward a producer-stamped lane envelope untouched; absent,
// contribute nothing so lane-less events keep their exact historical shape.
function laneOf(event) {
  return event.lane && typeof event.lane === 'object' ? { lane: event.lane } : {};
}

export class BuildStreamBridge {
  #filePath;
  #composeDir;
  #broadcast;
  #crashTimeoutMs;

  // Byte-level cursor tracking
  #cursor = 0;
  #lastSeq = -1;
  #lastIno = null;
  #trailingFragment = '';

  // Lifecycle state for crash detection
  #buildActive = false;
  #inStep = false;

  // Timers and watchers
  #watcher = null;
  #pollInterval = null;
  #debounceTimer = null;
  #crashTimer = null;
  #polling = false;
  #safetyInterval = null;
  #watchFn;
  #pollIntervalMs;

  /**
   * @param {string} composeDir  Path to .compose directory
   * @param {Function} broadcast  broadcast(msg) function from agent-server
   * @param {object} [opts]
   * @param {number} [opts.crashTimeoutMs]  Crash detection timeout (default 5min)
   * @param {number} [opts.pollIntervalMs]  Safety re-read cadence (default 2s)
   * @param {Function} [opts.watchFn]  Injected for tests that need a watcher
   *   which never delivers — the condition the safety poll exists to survive.
   */
  constructor(composeDir, broadcast, opts = {}) {
    this.#composeDir = composeDir;
    this.#filePath = join(composeDir, JSONL_FILENAME);
    this.#broadcast = broadcast;
    this.#crashTimeoutMs = opts.crashTimeoutMs ?? DEFAULT_CRASH_TIMEOUT_MS;
    this.#pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#watchFn = opts.watchFn ?? watch;
  }

  /**
   * Begin tailing the JSONL file. Catches up from byte 0 if file already
   * exists and is fresh (active build).
   */
  start() {
    if (existsSync(this.#composeDir)) {
      this._startWatching();
      // Catch up if file exists and is fresh
      if (existsSync(this.#filePath)) {
        if (!this._isStaleOnStartup()) {
          this.#cursor = 0;
          this.#lastSeq = -1;
          this._readNewLines();
        } else {
          // Stale file — skip to EOF
          try {
            const stat = statSync(this.#filePath);
            this.#cursor = stat.size;
            this.#lastIno = stat.ino;
          } catch { /* ignore */ }
        }
      }
    } else {
      // Directory doesn't exist yet — poll until it appears
      this._pollForDirectory();
    }
  }

  /** Stop all timers, watchers, and intervals. */
  stop() {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = null;
    }
    if (this.#pollInterval) {
      clearInterval(this.#pollInterval);
      this.#pollInterval = null;
    }
    if (this.#safetyInterval) {
      clearInterval(this.#safetyInterval);
      this.#safetyInterval = null;
    }
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#crashTimer) {
      clearTimeout(this.#crashTimer);
      this.#crashTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // File watching
  // ---------------------------------------------------------------------------

  _startWatching() {
    // The safety poll is armed FIRST and unconditionally, because the watcher
    // cannot be trusted to be listening (see _startSafetyPoll).
    this._startSafetyPoll();
    try {
      this.#watcher = this.#watchFn(this.#composeDir, (eventType, filename) => {
        if (filename === JSONL_FILENAME || filename === null) {
          this._debouncedRead();
        }
      });
      this.#watcher.on('error', () => {
        // Watcher died — fall back to polling
        this.#watcher = null;
        this._pollForDirectory();
      });
    } catch {
      // fs.watch can throw on some platforms — fall back to polling
      this._pollForDirectory();
    }
  }

  /**
   * Re-read on a timer for as long as we are tailing, regardless of the watcher.
   *
   * `fs.watch` is an OPTIMISATION here, never the guarantee. It is not armed
   * when the call returns: on macOS libuv registers the FSEvents stream
   * asynchronously, so writes landing between `watch()` returning and the stream
   * actually listening are delivered to nobody. `start()` arms the watcher and
   * then reads synchronously, which is exactly that window — and under load the
   * window stretches to cover a whole build's first events.
   *
   * Measured before this existed (600 runs of the scenario, 6 concurrent
   * processes, full suite as load): 14/450 runs saw the watcher deliver NOTHING
   * after start, so the bridge broadcast the pre-existing lines and then went
   * permanently deaf — no periodic re-check existed to recover it. The same 450
   * runs with a settle delay before the writes: 0 failures. That was a live
   * cockpit stream that silently never starts, not a test-timing problem.
   *
   * A missed event is therefore recoverable rather than terminal. `_readNewLines`
   * exits on a single `statSync` when the file has not grown, so the standing
   * cost is one stat per interval.
   */
  _startSafetyPoll() {
    if (this.#safetyInterval) return;
    this.#safetyInterval = setInterval(() => this._readNewLines(), this.#pollIntervalMs);
    this.#safetyInterval.unref();
  }

  _pollForDirectory() {
    if (this.#polling) return;
    this.#polling = true;

    this.#pollInterval = setInterval(() => {
      if (existsSync(this.#composeDir)) {
        clearInterval(this.#pollInterval);
        this.#pollInterval = null;
        this.#polling = false;
        this._startWatching();
        // Check if file appeared while polling
        if (existsSync(this.#filePath)) {
          this._readNewLines();
        }
      }
    }, POLL_INTERVAL_MS);
    this.#pollInterval.unref();
  }

  _debouncedRead() {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this._readNewLines();
    }, DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Core read logic — Buffer-based cursor tracking
  // ---------------------------------------------------------------------------

  _readNewLines() {
    let stat;
    try {
      stat = statSync(this.#filePath);
    } catch {
      return; // file doesn't exist yet
    }

    // Inode change detection (primary): file was replaced
    if (this.#lastIno !== null && stat.ino !== this.#lastIno) {
      this.#cursor = 0;
      this.#lastSeq = -1;
      this.#trailingFragment = '';
    }
    // Size-based fallback: truncation without inode change
    else if (stat.size < this.#cursor) {
      this.#cursor = 0;
      this.#lastSeq = -1;
      this.#trailingFragment = '';
    }

    this.#lastIno = stat.ino;

    if (stat.size <= this.#cursor) return; // no new data

    // Read new bytes as Buffer
    let buf;
    try {
      const fd = readFileSync(this.#filePath);
      buf = fd.subarray(this.#cursor, stat.size);
    } catch {
      return; // read error — will retry on next event
    }

    this.#cursor = stat.size;

    // Convert to string and split on newlines
    const text = this.#trailingFragment + buf.toString('utf-8');
    const lines = text.split('\n');

    // Last element is either empty (complete line) or a trailing fragment
    this.#trailingFragment = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // malformed JSON — skip
      }

      // Dedup via monotonic _seq guard
      if (typeof event._seq === 'number' && event._seq <= this.#lastSeq) {
        continue;
      }
      if (typeof event._seq === 'number') {
        this.#lastSeq = event._seq;
      }

      // Map and broadcast
      const mapped = this._mapEvent(event);
      if (mapped) {
        this.#broadcast(mapped);
      }

      // COMP-POLICY-CHECK-5: a policy match also lands on the feature-level
      // decision timeline, alongside the step event, for live cockpit visibility.
      if (event.type === 'policy_violation') {
        try {
          emitDecisionEvent(this.#broadcast, buildPolicyViolationEvent({
            featureCode: event.featureCode ?? null,
            buildId: event.buildId ?? null,
            stepId: event.stepId,
            rule: event.rule,
            matched: event.matched,
            suppressed: event.suppressed,
            userMode: event.userMode,
            timestamp: event._ts ? new Date(event._ts).toISOString() : undefined,
          }));
        } catch { /* timeline emit is best-effort — never break the tail loop */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Stale file detection on startup
  // ---------------------------------------------------------------------------

  _isStaleOnStartup() {
    try {
      const content = readFileSync(this.#filePath, 'utf-8').trim();
      if (!content) return true;

      const lines = content.split('\n');
      const lastLine = lines[lines.length - 1];
      const stat = statSync(this.#filePath);
      const age = Date.now() - stat.mtimeMs;

      let lastEvent;
      try {
        lastEvent = JSON.parse(lastLine);
      } catch {
        // Malformed last line — stale if old enough
        return age > this.#crashTimeoutMs;
      }

      // Completed/killed/aborted build — stale
      if (lastEvent.type === 'build_end') return true;

      // Gate-pending: stale only if older than 24h (gates have unbounded wait)
      if (lastEvent.type === 'build_gate') {
        return age > STALE_GATE_TIMEOUT_MS;
      }

      // Non-gate, non-terminal: stale if older than crash timeout
      return age > this.#crashTimeoutMs;
    } catch {
      return true; // can't read — treat as stale
    }
  }

  // ---------------------------------------------------------------------------
  // Event mapping (JSONL -> SSE)
  // ---------------------------------------------------------------------------

  _mapEvent(event) {
    const type = event.type;

    // Track lifecycle state for crash timer
    if (type === 'build_start' || type === 'build_resume') {
      this.#buildActive = true;
      this.#inStep = false;
      this._clearCrashTimer();
    } else if (type === 'build_step_start') {
      this.#inStep = true;
      this._resetCrashTimer();
    } else if (type === 'build_step_done' || type === 'build_gate') {
      this.#inStep = false;
      this._clearCrashTimer();
    } else if (type === 'build_end') {
      this.#buildActive = false;
      this.#inStep = false;
      this._clearCrashTimer();
    } else if (type === 'tool_use' || type === 'assistant') {
      // Content events during active step — reset crash timer
      if (this.#inStep) this._resetCrashTimer();
    }

    switch (type) {
      case 'build_start':
      case 'build_resume':
        return {
          type: 'system', subtype: type,
          featureCode: event.featureCode, flowId: event.flowId,
          _source: 'build',
        };

      case 'build_step_start':
        return {
          type: 'system', subtype: 'build_step',
          stepId: event.stepId, stepNum: event.stepNum,
          totalSteps: event.totalSteps, agent: event.agent,
          intent: event.intent,
          flowId: event.flowId,
          ...(event.parentFlowId ? { parentFlowId: event.parentFlowId } : {}),
          ...(event.parallel ? { parallel: true } : {}),
          ...laneOf(event),
          _source: 'build',
        };

      case 'tool_use':
        return {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: event.tool, input: event.input }] },
          ...laneOf(event),
          _source: 'build',
        };

      case 'tool_use_summary':
        return {
          type: 'assistant', subtype: 'tool_use_summary',
          summary: event.summary, output: event.output,
          ...laneOf(event),
          _source: 'build',
        };

      case 'tool_progress':
        return {
          type: 'tool_progress',
          tool: event.tool, elapsed: event.elapsed,
          _source: 'build',
        };

      case 'assistant':
        return {
          type: 'assistant',
          message: { content: [{ type: 'text', text: event.content }] },
          ...laneOf(event),
          _source: 'build',
        };

      case 'build_step_done':
        return {
          type: 'system', subtype: 'build_step_done',
          stepId: event.stepId, summary: event.summary,
          retries: event.retries, violations: event.violations,
          flowId: event.flowId,
          // COMP-OBS-COST: per-step and cumulative cost fields
          input_tokens: event.input_tokens ?? 0,
          output_tokens: event.output_tokens ?? 0,
          cost_usd: event.cost_usd ?? 0,
          cumulative_cost_usd: event.cumulative_cost_usd ?? 0,
          ...(event.parentFlowId ? { parentFlowId: event.parentFlowId } : {}),
          ...(event.parallel ? { parallel: true } : {}),
          // COMP-AGENT-LANES: explicit terminal status — the UI must not infer
          // "complete" from the done event's existence.
          ...(event.status ? { status: event.status } : {}),
          ...(event.outcome ? { outcome: event.outcome } : {}),
          ...laneOf(event),
          _source: 'build',
        };

      case 'build_gate':
        return {
          type: 'system', subtype: 'build_gate',
          stepId: event.stepId, gateType: event.gateType,
          flowId: event.flowId,
          ...(event.parentFlowId ? { parentFlowId: event.parentFlowId } : {}),
          _source: 'build',
        };

      case 'build_gate_resolved':
        return {
          type: 'system', subtype: 'build_gate_resolved',
          stepId: event.stepId, outcome: event.outcome,
          rationale: event.rationale,
          flowId: event.flowId,
          ...(event.parentFlowId ? { parentFlowId: event.parentFlowId } : {}),
          _source: 'build',
        };

      case 'build_error':
        return {
          type: 'error',
          message: event.message, source: 'build',
          // COMP-AGENT-LANES: stepId + lane let the cockpit scope a failure to
          // its worker lane (C5 — dropped here before, so lane-scoped failure
          // could never fire). laneTerminal distinguishes a lane-closing error
          // from an advisory one — the reducer closes only on laneTerminal.
          ...(event.stepId ? { stepId: event.stepId } : {}),
          ...(event.laneTerminal === true ? { laneTerminal: true } : {}),
          ...laneOf(event),
          _source: 'build',
        };

      case 'build_end':
        return {
          type: 'system', subtype: 'build_end',
          status: event.status, featureCode: event.featureCode,
          // COMP-OBS-COST: cumulative build totals
          total_input_tokens: event.total_input_tokens ?? 0,
          total_output_tokens: event.total_output_tokens ?? 0,
          total_cost_usd: event.total_cost_usd ?? 0,
          _source: 'build',
        };

      case 'step_usage':
        return {
          type: 'system', subtype: 'step_usage',
          stepId: event.stepId,
          input_tokens: event.input_tokens ?? 0,
          output_tokens: event.output_tokens ?? 0,
          cache_creation_input_tokens: event.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: event.cache_read_input_tokens ?? 0,
          // COMP-COST-OWNER S2. Tokens default to 0 because a missing token count
          // genuinely IS zero tokens. A missing COST is not zero dollars -- it is an
          // unknown, and `?? 0` here was the last of the coercions that turned it into
          // an affirmative claim of near-zero spend on the cockpit. Provenance rides
          // along so the surface can say which it is; the old projection dropped
          // `usd_source` entirely, so even a correctly labelled amount arrived bare.
          cost_usd: typeof event.cost_usd === 'number' ? event.cost_usd : null,
          usd_source: ['reported', 'estimated'].includes(event.usd_source) ? event.usd_source : null,
          model: event.model ?? null,
          _source: 'build',
        };

      case 'idea_suggestion':
        return {
          type: 'system', subtype: 'idea_suggestion',
          text: event.text, stepId: event.stepId,
          _source: 'build',
        };

      // COMP-OBS-GATES: tier evaluation events
      case 'gate_tier_result':
        return {
          type: 'system', subtype: 'gate_tier_result',
          stepId: event.stepId,
          tierId: event.tierId,
          passed: event.passed,
          details: event.details ?? null,
          _source: 'build',
        };

      case 'gate_tier_failed':
        return {
          type: 'system', subtype: 'gate_tier_failed',
          stepId: event.stepId,
          tierId: event.tierId,
          summary: event.summary ?? null,
          flowId: event.flowId ?? null,
          _source: 'build',
        };

      case 'gate_tier_summary':
        return {
          type: 'system', subtype: 'gate_tier_summary',
          featureCode: event.featureCode,
          passed: event.passed,
          tierThatFailed: event.tierThatFailed ?? null,
          tiersRun: event.tiersRun ?? [],
          tiersSkipped: event.tiersSkipped ?? [],
          costSaved: event.costSaved ?? 0,
          _source: 'build',
        };

      // COMP-QA items 113-116: diff-aware QA scoping — affected routes from filesChanged analysis
      case 'qa_scope':
        return {
          type: 'system', subtype: 'qa_scope',
          affectedRoutes: event.affectedRoutes ?? [],
          adjacentRoutes: event.adjacentRoutes ?? [],
          unmappedFiles: event.unmappedFiles ?? [],
          framework: event.framework ?? 'unknown',
          docsOnly: event.docsOnly ?? false,
          skipCoverage: event.skipCoverage ?? false,
          reason: event.reason ?? null,
          _source: 'build',
        };

      // STRAT-PAR-STREAM: typed BuildStreamEvent envelope (schema v0.2.5+) wrapped
      // by build.js as { type: 'build_stream_event', event: {...} }. Pass the
      // inner envelope through to the cockpit unchanged so renderers can
      // discriminate by `kind`.
      case 'build_stream_event': {
        const inner = event.event;
        if (!inner || typeof inner !== 'object' || typeof inner.kind !== 'string') {
          return null;
        }
        return {
          type: 'buildStreamEvent',
          event: inner,
          _source: 'build',
        };
      }

      // COMP-TEST-BOOTSTRAP-4-1: advisory review of the tests the coverage step
      // generated this build. Forwarded so the cockpit can surface the findings
      // for human verification (the step never blocks ship).
      case 'test_review':
        return {
          type: 'system', subtype: 'test_review',
          clean: event.clean ?? true,
          summary: event.summary ?? '',
          findings: event.findings ?? [],
          _source: 'build',
        };

      // COMP-HEALTH item 118: health score after build completion
      case 'health_score':
        return {
          type: 'system', subtype: 'health_score',
          score: event.score,
          breakdown: event.breakdown ?? {},
          missing: event.missing ?? [],
          _source: 'build',
        };

      // COMP-AGENT-CAPS-5: capability violation audit events
      case 'capability_violation':
        return {
          type: 'system', subtype: 'capability_violation',
          stepId: event.stepId,
          agent: event.agent,
          template: event.template,
          detail: event.detail,
          severity: event.severity ?? 'violation',
          _source: 'build',
        };

      // COMP-POLICY-CHECK-5: pre-response policy check pattern matches
      case 'policy_violation':
        return {
          type: 'system', subtype: 'policy_violation',
          stepId: event.stepId,
          rule: event.rule,
          matched: event.matched,
          suppressed: Boolean(event.suppressed),
          detail: event.detail,
          userMode: event.userMode,
          _source: 'build',
        };

      default:
        return null; // unknown event type — skip
    }
  }

  // ---------------------------------------------------------------------------
  // Crash detection
  // ---------------------------------------------------------------------------

  _resetCrashTimer() {
    this._clearCrashTimer();
    this.#crashTimer = setTimeout(() => {
      this.#crashTimer = null;
      if (this.#buildActive && this.#inStep) {
        // Emit synthetic build_end(crashed)
        this.#broadcast({
          type: 'system', subtype: 'build_end',
          status: 'crashed', _source: 'build',
        });
        // Suppress late events from dead build
        this.#lastSeq = Infinity;
        this.#buildActive = false;
        this.#inStep = false;
      }
    }, this.#crashTimeoutMs);
    if (this.#crashTimer.unref) this.#crashTimer.unref();
  }

  _clearCrashTimer() {
    if (this.#crashTimer) {
      clearTimeout(this.#crashTimer);
      this.#crashTimer = null;
    }
  }
}
