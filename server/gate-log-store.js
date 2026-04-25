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
import { getDataDir } from './project-root.js';

// Gate log is project-scoped (mirrors sessions.json, active-build.json etc).
// COMPOSE_GATE_LOG env var overrides the path — read dynamically so tests can inject it.
function getGateLogPath() {
  return process.env.COMPOSE_GATE_LOG || join(getDataDir(), 'gate-log.jsonl');
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
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
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
