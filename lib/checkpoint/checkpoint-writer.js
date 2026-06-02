/**
 * checkpoint-writer.js — COMP-RESUME S9 (lib side of the MCP `write_checkpoint` tool).
 *
 * Reads directly from disk (no server dependency) so a checkpoint can be written
 * even when the Compose server is not running — same stance as compose-mcp-tools.js.
 *
 * The resume path (`compose_resume`) is NOT here: it HTTP-delegates to the server
 * route POST /api/session/bind/reconcile, because reconcile must run server-side
 * where the live vision item / lifecycle state and broadcasts exist.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { captureFingerprint } from './fingerprint.js';
import { captureAnchor } from './anchor.js';
import { scribePrompt } from './prompts.js';
import { createCheckpointStore } from './store/index.js';

/**
 * Resolve the checkpoint config block from .compose/compose.json with defaults
 * applied EXPLICITLY (loadProjectConfig does not merge defaults — Codex #4).
 */
export function checkpointConfig(targetRoot) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path.join(targetRoot, '.compose', 'compose.json'), 'utf-8'));
  } catch {
    raw = {};
  }
  const c = raw.checkpoint ?? {};
  return {
    enabled: c.enabled !== false,
    backend: c.backend ?? 'jsonl',
    confidenceThreshold: typeof c.confidenceThreshold === 'number' ? c.confidenceThreshold : 0.6,
  };
}

/** Best-effort read of a feature's lifecycle phase label from feature.json. */
function readFeaturePhase(featureDir) {
  try {
    const fj = JSON.parse(readFileSync(path.join(featureDir, 'feature.json'), 'utf-8'));
    return fj.phase || fj.status || null;
  } catch {
    return null;
  }
}

/**
 * Write a checkpoint to the configured backend.
 *
 * @param {string} targetRoot  Project root (git repo / cwd to fingerprint).
 * @param {object} args
 * @param {string} args.featureCode
 * @param {string} [args.phase]      Lifecycle phase label; falls back to feature.json then 'unknown'.
 * @param {string} [args.trigger]    Schema enum; default 'manual'.
 * @param {object|null} [args.soft]  {goal,nextStep,risks} for a narrative checkpoint; null → anchor.
 * @param {string|null} [args.flowId]
 * @param {number} [args.confidence] Present only on resume-sync checkpoints.
 * @returns {{ checkpoint: object, scribePrompt: string|null }} the written
 *   Checkpoint, plus — when `soft` was NOT provided (an anchor write at a
 *   boundary) — a `scribePrompt` the orchestrator can answer and re-submit as a
 *   narrative checkpoint (the hybrid "anchor now, narrative on-demand" flow).
 *   `scribePrompt` is null when `soft` was supplied (already a narrative cp).
 */
export function writeCheckpoint(targetRoot, {
  featureCode,
  phase = null,
  trigger = 'manual',
  soft = null,
  flowId = null,
  confidence = null,
} = {}) {
  if (!featureCode) throw new Error('write_checkpoint: featureCode is required');
  const cfg = checkpointConfig(targetRoot);
  const dataDir = path.join(targetRoot, '.compose', 'data');
  const composeDir = path.join(targetRoot, '.compose');
  const featureDir = path.join(targetRoot, 'docs', 'features', featureCode);

  const store = createCheckpointStore(cfg.backend, { dataDir });
  // The prior checkpoint (read before writing) seeds the scribe prompt's context.
  const priorCheckpoint = soft ? null : store.readLatest(featureCode);

  const cp = {
    id: randomUUID(),
    featureCode,
    phase: phase ?? readFeaturePhase(featureDir) ?? 'unknown',
    createdAt: new Date().toISOString(),
    trigger,
    fingerprint: captureFingerprint(targetRoot, { featureDir, composeDir, dataDir, flowId }),
    soft: soft ?? null,
    artifactIds: [],
  };
  if (typeof confidence === 'number') cp.confidence = confidence;
  store.write(cp);

  // No soft → this is an anchor; hand back the scribe prompt so the orchestrator
  // can generate {goal,nextStep,risks} (anchored to the fingerprint) and write a
  // narrative checkpoint. Wires scribePrompt into the production path (impl #3).
  const prompt = soft
    ? null
    : scribePrompt({ fingerprint: cp.fingerprint, journalTail: '', priorCheckpoint });

  return { checkpoint: cp, scribePrompt: prompt };
}

/**
 * Server-side boundary convenience: write an anchor checkpoint for a live vision
 * `item` at a lifecycle boundary. Resolves config/store/paths and delegates to
 * captureAnchor. Gated on `checkpoint.enabled`. BEST-EFFORT — never throws (so a
 * checkpoint failure can never break a route handler); returns the cp or null.
 *
 * @param {string} targetRoot
 * @param {{ item: object, trigger: string, flowId?: string|null }} opts
 */
export function anchorBoundary(targetRoot, { item, trigger, flowId = null } = {}) {
  try {
    const cfg = checkpointConfig(targetRoot);
    if (!cfg.enabled) return null;
    const featureCode = item?.lifecycle?.featureCode;
    if (!featureCode) return null;
    const dataDir = path.join(targetRoot, '.compose', 'data');
    const composeDir = path.join(targetRoot, '.compose');
    const featureDir = path.join(targetRoot, 'docs', 'features', featureCode);
    const store = createCheckpointStore(cfg.backend, { dataDir });
    return captureAnchor({ item, trigger, cwd: targetRoot, featureDir, composeDir, dataDir, store, flowId });
  } catch (err) {
    console.warn('[checkpoint] anchorBoundary failed:', err?.message ?? err);
    return null;
  }
}
