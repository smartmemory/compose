/**
 * smartmemory-ingest.js — COMP-SMARTMEMORY-INGEST S03
 *
 * Live emitter + shared pure renderers/context builders. Lazy-imported by the
 * two hook sites (lib/feature-events.js, server/gate-log-store.js) only when
 * smartmemory.enabled === true, so the fetch-capable module never loads when
 * the feature is off.
 *
 * Fail-open: emitFeatureEvent/emitGateLogEntry never throw and never affect
 * the caller — the local durable write has already completed by the time
 * this runs. A circuit breaker disables further attempts after 3 consecutive
 * failures so a dead service doesn't spam logs for the rest of the process
 * lifetime.
 */

import { getSmartmemoryConfig, resolveProjectTag, sourcePathFor } from './smartmemory-config.js';
import { createSmartmemoryClient } from './smartmemory-client.js';

// ── module state ──
let consecutiveFailures = 0;
let disabled = false;
const pending = new Set();

/** PURE. One deterministic line per feature-event row. Shared with sync. */
export function renderFeatureEventContent(row, projectTag) {
  return `[compose:${projectTag}] ${row.ts} ${row.tool} ${row.code ?? row.feature_code ?? '-'} by ${row.actor ?? 'mcp:agent'}`;
}

/** PURE. One deterministic line per gate-log entry. Shared with sync.
 *
 * GOV-COMPOSE-SEAM-1 step 0 (F2): this is a **Vision UI product gate** — a
 * human approving a feature in the Compose UI, keyed by the UI gate id and a
 * feature code. It is NOT Stratum's `gate_resolution`, which is a flow-step
 * gate keyed by `run_id`/`step_id` and emitted by the engine when a run carries
 * a policy bundle. The design assumed these were two records of one event and
 * called for deduping them by `run_id`; they are two events, and no Stratum
 * run id exists at this call site (see gate-log-store.js). Deduping them would
 * have destroyed a real record.
 *
 * So they are disambiguated instead of merged: this line is tagged
 * `vision-gate` rather than the bare `gate`, so a workspace query can separate
 * product approvals from enforcement gates without guessing from shape.
 */
export function renderGateLogContent(entry, projectTag) {
  return `[compose:${projectTag}] ${entry.timestamp} vision-gate:${entry.decision} ${entry.feature_code ?? '-'} ${entry.id}`;
}

/** PURE. context for an event item (cli:compose regime — content-hash dedupe). */
export function buildFeatureEventContext(projectTag, row) {
  return {
    origin: 'cli:compose',
    project: projectTag,
    source_path: sourcePathFor(projectTag, '.compose/data/feature-events.jsonl'),
    event: row,
  };
}

export function buildGateLogContext(projectTag, entry) {
  return {
    origin: 'cli:compose',
    project: projectTag,
    // Explicit record kind so a Compose product-gate approval is never mistaken
    // for a Stratum enforcement `gate_resolution`. See renderGateLogContent.
    record_kind: 'compose_vision_gate',
    source_path: sourcePathFor(projectTag, '.compose/data/gate-log.jsonl'),
    event: entry,
  };
}

function onFailure(err) {
  consecutiveFailures++;
  if (consecutiveFailures === 1) {
    console.warn('[smartmemory] ingest failed (fail-open): ' + err.message);
  }
  if (consecutiveFailures >= 3) {
    disabled = true;
  }
}

function emit(cwd, item, render, buildContext) {
  if (disabled) return;
  let cfg;
  try {
    cfg = getSmartmemoryConfig(cwd);
  } catch {
    return;
  }
  if (cfg.enabled !== true) return; // no fetch — byte-identity when off

  let p;
  try {
    const tag = resolveProjectTag(cwd);
    const content = render(item, tag);
    const ctx = buildContext(tag, item);
    const client = createSmartmemoryClient(cfg);
    p = client.ingest(content, ctx);
  } catch (err) {
    // Synchronous throw (e.g. missing api key) — treat as a failure, never rethrow.
    onFailure(err);
    return;
  }

  pending.add(p);
  p.then(
    () => { consecutiveFailures = 0; },
    (err) => onFailure(err),
  ).finally(() => pending.delete(p));
}

/** Fire-and-forget live emit after a durable local append. Never throws. */
export function emitFeatureEvent(cwd, row) {
  emit(cwd, row, renderFeatureEventContent, buildFeatureEventContext);
}

export function emitGateLogEntry(cwd, entry) {
  emit(cwd, entry, renderGateLogContent, buildGateLogContext);
}

/** Await in-flight POSTs (bounded by timeoutMs). Drain point for callers that exit. */
export async function flushPending(timeoutMs = 3000) {
  if (pending.size === 0) return;
  const settleAll = Promise.allSettled([...pending]);
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([settleAll, timeout]);
}

/** Test hook: clear circuit breaker + pending between cases. */
export function _resetEmitterState() {
  consecutiveFailures = 0;
  disabled = false;
  pending.clear();
}
