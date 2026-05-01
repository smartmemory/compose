/**
 * debug-discipline.js — Debug Discipline Engine for COMP-DEBUG-1.
 *
 * Detects fix-chain thrashing, validates trace evidence, tracks attempts,
 * and audits cross-layer scope. Called from build.js during fix retry loops.
 *
 * See: docs/features/COMP-DEBUG-1/design.md
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Fix-Chain Detector
// ---------------------------------------------------------------------------

const FEATURE_MODE_KEY = '__feature_mode__';
const LEGACY_KEY = '__legacy__';

/**
 * Tracks which files are modified across fix iterations.
 * Detects thrashing: same file touched in multiple iterations.
 *
 * Per-bug keying (COMP-FIX-HARD T9): state is namespaced by bug code.
 * Legacy flat API (recordIteration/detect/iteration) delegates to a
 * synthetic `__feature_mode__` key for feature-mode builds.
 */
export class FixChainDetector {
  constructor() {
    /** @type {Map<string, { iteration: number, fileHits: Map<string, number> }>} */
    this.byBug = new Map();
  }

  _slot(bugCode) {
    let s = this.byBug.get(bugCode);
    if (!s) {
      s = { iteration: 0, fileHits: new Map() };
      this.byBug.set(bugCode, s);
    }
    return s;
  }

  recordIterationForBug(bugCode, filesChanged) {
    const s = this._slot(bugCode);
    s.iteration++;
    for (const file of filesChanged) {
      s.fileHits.set(file, (s.fileHits.get(file) ?? 0) + 1);
    }
  }

  detectForBug(bugCode) {
    const s = this.byBug.get(bugCode);
    if (!s) return [];
    return [...s.fileHits.entries()]
      .filter(([, count]) => count >= 2)
      .map(([file, count]) => ({
        file,
        iterations: count,
        level: count >= 3 ? 'critical' : 'warning',
      }));
  }

  getIterationForBug(bugCode) {
    return this.byBug.get(bugCode)?.iteration ?? 0;
  }

  resetForBug(bugCode) {
    this.byBug.delete(bugCode);
  }

  // --- Legacy global API (feature mode) ----------------------------------

  recordIteration(filesChanged) {
    this.recordIterationForBug(FEATURE_MODE_KEY, filesChanged);
  }

  detect() {
    return this.detectForBug(FEATURE_MODE_KEY);
  }

  get iteration() {
    return this.getIterationForBug(FEATURE_MODE_KEY);
  }

  set iteration(v) {
    this._slot(FEATURE_MODE_KEY).iteration = v;
  }

  get fileHits() {
    return this._slot(FEATURE_MODE_KEY).fileHits;
  }

  set fileHits(map) {
    this._slot(FEATURE_MODE_KEY).fileHits = map instanceof Map ? map : new Map(Object.entries(map ?? {}));
  }

  // --- Serialization ------------------------------------------------------

  toJSON() {
    const out = {};
    for (const [key, s] of this.byBug.entries()) {
      out[key] = {
        iteration: s.iteration,
        fileHits: Object.fromEntries(s.fileHits),
      };
    }
    return out;
  }

  static fromJSON(json) {
    const d = new FixChainDetector();
    if (!json || typeof json !== 'object') return d;
    // Legacy detection: flat shape has top-level `iteration` and/or `fileHits`
    // and no per-bug sub-objects with the per-bug shape.
    // Salvage any top-level legacy fields. Fold into __feature_mode__ so the
    // existing global-API getters (recordIteration / detect / iteration getter)
    // continue to surface it. If there's already a per-bug subkey for
    // __feature_mode__ in the same JSON, the explicit subkey wins.
    if ('iteration' in json || 'fileHits' in json) {
      const slot = d._slot(FEATURE_MODE_KEY);
      slot.iteration = json.iteration ?? 0;
      slot.fileHits = new Map(Object.entries(json.fileHits ?? {}));
    }
    for (const [key, sub] of Object.entries(json)) {
      if (key === 'iteration' || key === 'fileHits') continue; // top-level legacy, already folded
      if (!sub || typeof sub !== 'object') continue;
      const slot = d._slot(key);
      slot.iteration = sub.iteration ?? 0;
      slot.fileHits = new Map(Object.entries(sub.fileHits ?? {}));
    }
    return d;
  }
}

// ---------------------------------------------------------------------------
// Attempt Counter
// ---------------------------------------------------------------------------

const VISUAL_EXTENSIONS = /\.(css|scss|jsx|tsx)$/i;

/**
 * Tracks fix attempts and enforces thresholds with escalation.
 * Visual bugs escalate at attempt 2; all bugs escalate at attempt 5.
 *
 * Per-bug keying (COMP-FIX-HARD T9): state is namespaced by bug code.
 * Legacy flat API (record/getIntervention/count/isVisual) delegates to a
 * synthetic `__feature_mode__` key for feature-mode builds.
 */
export class AttemptCounter {
  constructor() {
    /** @type {Map<string, { count: number, isVisual: boolean }>} */
    this.byBug = new Map();
  }

  _slot(bugCode) {
    let s = this.byBug.get(bugCode);
    if (!s) {
      s = { count: 0, isVisual: false };
      this.byBug.set(bugCode, s);
    }
    return s;
  }

  recordForBug(bugCode, { filesChanged = [], isVisual = null } = {}) {
    const s = this._slot(bugCode);
    s.count++;
    if (isVisual !== null) {
      s.isVisual = isVisual;
    } else if (filesChanged.some(f => AttemptCounter.isVisualFile(f))) {
      s.isVisual = true;
    }
  }

  getCountForBug(bugCode) {
    return this.byBug.get(bugCode)?.count ?? 0;
  }

  getInterventionForBug(bugCode) {
    const s = this.byBug.get(bugCode);
    if (!s) return null;
    if (s.count >= 5) return 'escalate';
    if (s.count >= 3 && !s.isVisual) return 'trace_refresh';
    if (s.count >= 2 && s.isVisual) return 'escalate';
    if (s.count >= 2) return 'trace_reminder';
    return null;
  }

  resetForBug(bugCode) {
    this.byBug.delete(bugCode);
  }

  // --- Legacy global API (feature mode) ----------------------------------

  record(opts) {
    this.recordForBug(FEATURE_MODE_KEY, opts ?? {});
  }

  getIntervention() {
    return this.getInterventionForBug(FEATURE_MODE_KEY);
  }

  get count() {
    return this.getCountForBug(FEATURE_MODE_KEY);
  }

  set count(v) {
    this._slot(FEATURE_MODE_KEY).count = v;
  }

  get isVisual() {
    return this.byBug.get(FEATURE_MODE_KEY)?.isVisual ?? false;
  }

  set isVisual(v) {
    this._slot(FEATURE_MODE_KEY).isVisual = !!v;
  }

  static isVisualFile(file) {
    return VISUAL_EXTENSIONS.test(file);
  }

  // --- Serialization ------------------------------------------------------

  toJSON() {
    const out = {};
    for (const [key, s] of this.byBug.entries()) {
      out[key] = { count: s.count, isVisual: s.isVisual };
    }
    return out;
  }

  static fromJSON(json) {
    const c = new AttemptCounter();
    if (!json || typeof json !== 'object') return c;
    // Legacy detection: flat shape has top-level `count`/`isVisual` and
    // no per-bug sub-objects with the per-bug shape.
    // Salvage any top-level legacy fields. Fold into __feature_mode__ so the
    // existing global-API getters (count getter, getIntervention, etc.)
    // continue to surface it. If an explicit __feature_mode__ subkey is also
    // present, it wins (loop below).
    if ('count' in json || 'isVisual' in json) {
      const slot = c._slot(FEATURE_MODE_KEY);
      slot.count = json.count ?? 0;
      slot.isVisual = json.isVisual ?? false;
    }
    for (const [key, sub] of Object.entries(json)) {
      if (key === 'count' || key === 'isVisual') continue; // top-level legacy, already handled
      if (!sub || typeof sub !== 'object') continue;
      const slot = c._slot(key);
      slot.count = sub.count ?? 0;
      slot.isVisual = sub.isVisual ?? false;
    }
    return c;
  }
}

// ---------------------------------------------------------------------------
// Trace Validator
// ---------------------------------------------------------------------------

const MIN_EVIDENCE_ITEMS = 2;
const MIN_OUTPUT_LENGTH = 5;

/**
 * Validates diagnose step output meets trace evidence requirements.
 * Rejects prose-only analysis without concrete command output.
 */
export class TraceValidator {
  static validate(diagnoseResult) {
    const evidence = diagnoseResult?.trace_evidence;

    if (!evidence) {
      return { valid: false, reason: 'trace_evidence is missing or null' };
    }
    if (!Array.isArray(evidence) || evidence.length < MIN_EVIDENCE_ITEMS) {
      return { valid: false, reason: `trace_evidence requires minimum ${MIN_EVIDENCE_ITEMS} items, got ${evidence?.length ?? 0}` };
    }

    for (const [i, e] of evidence.entries()) {
      if (!e.command) {
        return { valid: false, reason: `trace_evidence[${i}] missing command field` };
      }
      if (!e.actual_output) {
        return { valid: false, reason: `trace_evidence[${i}] missing actual_output field` };
      }
    }

    const hasSubstantialOutput = evidence.some(e =>
      typeof e.actual_output === 'string' && e.actual_output.length > MIN_OUTPUT_LENGTH
    );
    if (!hasSubstantialOutput) {
      return { valid: false, reason: `no trace evidence has output longer than ${MIN_OUTPUT_LENGTH} chars` };
    }

    if (!diagnoseResult.root_cause) {
      return { valid: false, reason: 'root_cause is missing — connect evidence to a conclusion' };
    }

    return { valid: true };
  }
}

// ---------------------------------------------------------------------------
// Debug Ledger (file-based, upgrades to COMP-HARNESS-9 later)
// ---------------------------------------------------------------------------

const LEDGER_FILE = 'debug-ledger.jsonl';

/**
 * Append-only JSONL ledger for debug discipline events.
 * Writes to .compose/debug-ledger.jsonl.
 */
export class DebugLedger {
  constructor(composeDir) {
    this.path = join(composeDir, LEDGER_FILE);
  }

  record(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(this.path, line + '\n', 'utf-8');
  }
}
