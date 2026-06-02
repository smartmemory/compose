/**
 * COMP-RESUME S7 — boundary anchor capture.
 *
 * captureAnchor() builds an *anchor* Checkpoint (design Decision 1: `soft: null`,
 * no LLM) from a deterministic environment fingerprint and writes it to the
 * CheckpointStore. It is the cheap, frequent grade: pure structured capture at
 * every build boundary (phase transition, iteration-complete, gate resolution,
 * pre-risky-action), so resume always has a recent deterministic anchor.
 *
 * BEST-EFFORT (design Decision 4, "failure isolation"): a failing checkpoint
 * write must never break the build path. The whole body is wrapped in try/catch;
 * on any error it warns and returns null. A missing checkpoint degrades resume
 * quality — it never breaks the build. Mirrors the emitCheckpoint guard in
 * lib/build.js (~1669).
 *
 * Contract: the produced object conforms to contracts/checkpoint.schema.json
 * (anchor grade → `soft: null`, empty `artifactIds` on the jsonl floor).
 */

import { randomUUID } from 'node:crypto';
import { captureFingerprint } from './fingerprint.js';

/**
 * Build and persist an anchor checkpoint. Never throws.
 *
 * @param {object} args
 * @param {object} args.item — vision item; reads `item.lifecycle.featureCode` and
 *   `item.lifecycle.currentPhase`.
 * @param {('phase-transition'|'pre-risky-action'|'iteration-complete'|'gate-resolution'|'manual'|'resume-sync')} args.trigger
 *   One of the checkpoint.schema.json trigger enum values; supplied by the caller.
 * @param {string} args.cwd — working dir / repo to fingerprint.
 * @param {string} args.featureDir — dir holding phase artifacts (design/blueprint/plan).
 * @param {string|null} [args.composeDir] — `.compose` dir for build-stream lookup.
 * @param {string|null} [args.dataDir] — `.compose/data` dir; used to derive composeDir.
 * @param {object} args.store — a CheckpointStore (must implement write(cp)).
 * @param {string|null} [args.flowId] — Stratum flow id, passed through to the fingerprint.
 * @returns {object|null} the persisted anchor Checkpoint, or null on any failure.
 */
export function captureAnchor({
  item,
  trigger,
  cwd,
  featureDir,
  composeDir = null,
  dataDir = null,
  store,
  flowId = null,
}) {
  try {
    const cp = {
      id: randomUUID(),
      featureCode: item.lifecycle.featureCode,
      phase: item.lifecycle.currentPhase,
      createdAt: new Date().toISOString(),
      trigger,
      fingerprint: captureFingerprint(cwd, { featureDir, composeDir, dataDir, flowId }),
      soft: null,
      artifactIds: [],
    };
    store.write(cp);
    return cp;
  } catch (err) {
    console.warn('[checkpoint] anchor write failed:', err?.message ?? err);
    return null;
  }
}
