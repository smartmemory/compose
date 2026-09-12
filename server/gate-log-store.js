/**
 * gate-log-store.js — COMP-OBS-GATELOG persistence layer.
 *
 * Persists GateLogEntry records to <projectDataDir>/gate-log.jsonl (append-only).
 * Project-scoped, NOT COMPOSE_HOME-scoped — gate decisions belong to the
 * project they were made in, otherwise gate_load_24h and `compose gates report`
 * would bleed across repos.
 * Never rewrites entries in place; idempotent on duplicate id.
 *
 * Storage: one JSON object per line (JSONL). Tolerates malformed lines (skips + warns).
 *
 * Decision 1a outcome map: route outcome → schema enum
 *   approve → approve
 *   revise  → interrupt
 *   kill    → deny
 *
 * Decision 1b featureless gates: callers are responsible for skipping when
 * gate.itemId is null or item lacks lifecycle.featureCode; this module does
 * not enforce that — it trusts the caller (vision-routes.js).
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir, getTargetRoot } from './project-root.js';
import { getSmartmemoryConfig } from '../lib/smartmemory-config.js';

// Gate log is project-scoped (mirrors sessions.json, active-build.json etc).
// COMPOSE_GATE_LOG env var overrides the path — read dynamically so tests can inject it.
function getGateLogPath() {
  return process.env.COMPOSE_GATE_LOG || join(getDataDir(), 'gate-log.jsonl');
}

/**
 * Read the log file's raw text for the idempotency scan, or null when it cannot be read.
 *
 * `existsSync` followed by `readFileSync` is a TOCTOU: the file can go away between the
 * two calls. Here that would throw BEFORE the append, losing a gate decision outright, so
 * this path fails OPEN. The two outcomes are asymmetric -- skipping the append loses a
 * decision, proceeding can at worst duplicate one -- and in the race that actually happens
 * the file vanished, so there are no prior entries for the new one to duplicate.
 *
 * Used ONLY by the append scan. `readGateLog` stays strict on purpose; see the comment
 * there.
 *
 * @param {string} filePath
 * @returns {string|null} file contents, or null if absent or unreadable
 */
function readLogTextOrNull(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    // ENOENT is the race and is silent: an absent log is the normal cold-start state.
    if (err?.code !== 'ENOENT') {
      console.warn(`[gate-log-store] gate log unreadable (${err?.code ?? err?.message}); treating as empty:`, filePath);
    }
    return null;
  }
}

/** Translate route outcome vocabulary → schema GateLogEntry.decision enum. */
export function mapResolveOutcomeToSchema(outcome) {
  if (outcome === 'approve') return 'approve';
  if (outcome === 'revise')  return 'interrupt';
  if (outcome === 'kill')    return 'deny';
  // Passthrough for already-normalized values (shouldn't happen in practice)
  return outcome;
}

/**
 * Append one GateLogEntry to disk.
 * Idempotent: if an entry with the same `id` already exists, the write is skipped.
 * @param {object} entry — a GateLogEntry object (must have .id)
 */
export function appendGateLogEntry(entry) {
  const filePath = getGateLogPath();
  const dataDir = join(filePath, '..');
  mkdirSync(dataDir, { recursive: true });

  // Idempotency check: scan existing entries for this id.
  // Volume is bounded (gate resolution is rare) so a linear scan is fine.
  // Fail OPEN on an unreadable scan. The cost of the two outcomes is asymmetric: skipping
  // the append loses a gate decision outright, while proceeding can at worst duplicate one
  // -- and in the race that actually happens (the file vanished) there are no prior entries
  // for this to be a duplicate OF.
  const scanRaw = existsSync(filePath) ? readLogTextOrNull(filePath) : null;
  if (scanRaw !== null) {
    for (const line of scanRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.id === entry.id) return; // already written
      } catch {
        // malformed line — skip
      }
    }
  }

  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  // COMP-SMARTMEMORY-INGEST: fail-open live emit after the durable append.
  try {
    const cwd = getTargetRoot();
    if (getSmartmemoryConfig(cwd).enabled === true) {
      import('../lib/smartmemory-ingest.js')
        .then((m) => m.emitGateLogEntry(cwd, entry))
        .catch(() => {});
    }
  } catch { /* fail-open */ }
}

/**
 * Read GateLogEntry records from disk with optional filters.
 *
 * @param {{ since?: number, featureCode?: string, logPath?: string }} opts
 *   - since:       optional epoch ms — only entries with timestamp >= since are returned
 *   - featureCode: optional string  — filter to a specific feature
 *   - logPath:     optional path override for tests
 * @returns {GateLogEntry[]}
 */
export function readGateLog({ since, featureCode, logPath } = {}) {
  const filePath = logPath || getGateLogPath();
  if (!existsSync(filePath)) return [];

  // DELIBERATELY STRICT: a read failure THROWS. lib/smartmemory-sync.js:66 depends on it --
  // it counts a surface that cannot be read as SKIPPED, which is how an unreadable gate log
  // stays visible instead of masquerading as an empty one. Callers that must degrade rather
  // than fail (the two snapshot builders) catch it at their own call site, where the choice
  // to serve partial data is explicit and local.
  const raw = readFileSync(filePath, 'utf8');
  const entries = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      console.warn('[gate-log-store] malformed line skipped:', trimmed.slice(0, 80));
      continue;
    }
    if (since !== undefined && Date.parse(obj.timestamp) < since) continue;
    if (featureCode !== undefined && obj.feature_code !== featureCode) continue;
    entries.push(obj);
  }

  return entries;
}
