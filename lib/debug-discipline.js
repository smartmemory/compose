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

/**
 * Tracks which files are modified across fix iterations.
 * Detects thrashing: same file touched in multiple iterations.
 */
export class FixChainDetector {
  constructor() {
    this.fileHits = new Map();
    this.iteration = 0;
  }

  recordIteration(filesChanged) {
    this.iteration++;
    for (const file of filesChanged) {
      this.fileHits.set(file, (this.fileHits.get(file) ?? 0) + 1);
    }
  }

  detect() {
    return [...this.fileHits.entries()]
      .filter(([, count]) => count >= 2)
      .map(([file, count]) => ({
        file,
        iterations: count,
        level: count >= 3 ? 'critical' : 'warning',
      }));
  }

  toJSON() {
    return {
      iteration: this.iteration,
      fileHits: Object.fromEntries(this.fileHits),
    };
  }

  static fromJSON(json) {
    const d = new FixChainDetector();
    d.iteration = json.iteration ?? 0;
    d.fileHits = new Map(Object.entries(json.fileHits ?? {}));
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
 */
export class AttemptCounter {
  constructor() {
    this.count = 0;
    this.isVisual = false;
  }

  record({ filesChanged = [], isVisual = null }) {
    this.count++;
    if (isVisual !== null) {
      this.isVisual = isVisual;
    } else if (filesChanged.some(f => AttemptCounter.isVisualFile(f))) {
      this.isVisual = true;
    }
  }

  getIntervention() {
    if (this.count >= 5) return 'escalate';
    if (this.count >= 3 && !this.isVisual) return 'trace_refresh';
    if (this.count >= 2 && this.isVisual) return 'escalate';
    if (this.count >= 2) return 'trace_reminder';
    return null;
  }

  static isVisualFile(file) {
    return VISUAL_EXTENSIONS.test(file);
  }

  toJSON() {
    return { count: this.count, isVisual: this.isVisual };
  }

  static fromJSON(json) {
    const c = new AttemptCounter();
    c.count = json.count ?? 0;
    c.isVisual = json.isVisual ?? false;
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
