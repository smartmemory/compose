/**
 * Drift detection for ROADMAP.md typed-writer regen.
 *
 * COMP-MCP-MIGRATION-2-1-1 T2 (Option A).
 *
 * When a phase heading carries a curated status override (e.g. `PARTIAL
 * (1a–1d COMPLETE, 2 PLANNED)`) that diverges from the rollup-computed
 * status from feature.json, the writer keeps the override (per Decision 2)
 * and emits a `roadmap_drift` event so the divergence is visible.
 *
 * Dedupe is at read time inside emitDrift() — appendEvent() does not
 * enforce idempotency_key, so we read recent events and short-circuit
 * if the same drift triple was already recorded.
 */

import { appendEvent, readEvents } from './feature-events.js';

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Emit a roadmap drift event with read-side dedupe.
 *
 * Always writes a stderr warning. Only writes a new event if the same
 * (phaseId, override, computed) triple hasn't been recorded in the last
 * 24h.
 *
 * @param {string} cwd
 * @param {{phaseId: string, override: string, computed: string}} info
 */
export function emitDrift(cwd, { phaseId, override, computed }) {
  process.stderr.write(
    `WARN: phase "${phaseId}" override "${override}" diverges from rollup "${computed}". Edit ROADMAP.md to acknowledge.\n`
  );

  const recent = readEvents(cwd, { since: Date.now() - DEDUPE_WINDOW_MS });
  for (const ev of recent) {
    if (
      ev.tool === 'roadmap_drift' &&
      ev.code === phaseId &&
      ev.from === computed &&
      ev.to === override
    ) {
      return; // already recorded within window
    }
  }

  appendEvent(cwd, {
    tool: 'roadmap_drift',
    code: phaseId,
    from: computed,
    to: override,
    reason: 'override-vs-rollup-divergence',
  });
}
