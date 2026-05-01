/**
 * bug-ledger.js — COMP-FIX-HARD hypothesis ledger persistence.
 *
 * Persists hypothesis entries to docs/bugs/<bug-code>/hypotheses.jsonl
 * (append-only JSONL). One JSON object per line.
 *
 * Idempotent on (attempt, ts): repeated writes with the same key are skipped
 * (the first writer wins). Tolerates malformed lines on read (skip + warn).
 *
 * Pattern reference: server/gate-log-store.js (gate log JSONL helpers).
 *
 * Entry shape:
 *   Required: attempt (number), ts (ISO string), hypothesis (string),
 *             verdict ('confirmed' | 'rejected' | 'inconclusive')
 *   Optional: evidence_for[], evidence_against[], next_to_try, agent,
 *             tokens_used, findings[]
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Resolve the on-disk path for a bug's hypothesis ledger.
 * @param {string} cwd      — repository root
 * @param {string} bugCode  — bug identifier (e.g. "BUG-123")
 * @returns {string} absolute path to hypotheses.jsonl
 */
export function getHypothesesPath(cwd, bugCode) {
  return join(cwd, 'docs', 'bugs', bugCode, 'hypotheses.jsonl');
}

/**
 * Append one hypothesis entry to the bug's ledger.
 * Idempotent: if an entry with the same (attempt, ts) already exists, the
 * write is skipped. Creates the parent directory if missing.
 *
 * @param {string} cwd
 * @param {string} bugCode
 * @param {object} entry — must have attempt, ts, hypothesis, verdict
 */
export function appendHypothesisEntry(cwd, bugCode, entry) {
  const filePath = getHypothesesPath(cwd, bugCode);
  mkdirSync(dirname(filePath), { recursive: true });

  // Idempotency check: scan existing entries for matching (attempt, ts).
  // Volume per bug is small so a linear scan is fine.
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.attempt === entry.attempt && obj.ts === entry.ts) return; // already written
      } catch {
        // malformed line — skip
      }
    }
  }

  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Read all hypothesis entries for a bug.
 * Returns [] if the file does not exist. Tolerates malformed lines: each
 * unparseable line is skipped with a stderr warning, valid lines returned.
 *
 * @param {string} cwd
 * @param {string} bugCode
 * @returns {object[]}
 */
export function readHypotheses(cwd, bugCode) {
  const filePath = getHypothesesPath(cwd, bugCode);
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, 'utf8');
  const entries = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      console.warn('[bug-ledger] malformed line skipped:', trimmed.slice(0, 80));
    }
  }

  return entries;
}

/**
 * Render rejected hypotheses as a markdown block, suitable for splicing into
 * a bug-fix prompt so the next attempt avoids re-trying dead ends.
 *
 * Returns "" if the input has no entries with verdict === 'rejected'.
 *
 * @param {object[]} entries
 * @returns {string}
 */
export function formatRejectedHypotheses(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const rejected = entries.filter((e) => e && e.verdict === 'rejected');
  if (rejected.length === 0) return '';

  const blocks = rejected.map((e) => {
    const lines = [];
    lines.push(`### Attempt ${e.attempt} (${e.ts})`);
    lines.push(`**Hypothesis:** ${e.hypothesis}`);
    if (Array.isArray(e.evidence_against) && e.evidence_against.length > 0) {
      lines.push('**Evidence against:**');
      for (const ev of e.evidence_against) lines.push(`- ${ev}`);
    }
    if (Array.isArray(e.evidence_for) && e.evidence_for.length > 0) {
      lines.push('**Evidence for:**');
      for (const ev of e.evidence_for) lines.push(`- ${ev}`);
    }
    if (e.next_to_try) {
      lines.push(`**Next to try:** ${e.next_to_try}`);
    }
    return lines.join('\n');
  });

  return ['## Previously Rejected Hypotheses', '', ...blocks].join('\n\n') + '\n';
}
