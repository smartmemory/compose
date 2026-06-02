/**
 * lib/checkpoint/reconciler.js — COMP-RESUME slice S8: resume reconciliation.
 *
 * CORRECTED BOUNDARY (per the Codex boundary review, blueprint.md "Boundary
 * review" note + design.md Decision 5):
 *
 *   `reconcile()` is DETERMINISTIC. It does NOT:
 *     - write to the CheckpointStore,
 *     - mutate any persistent DB (vision-state, etc.),
 *     - call an LLM / agent connector.
 *
 *   It computes and RETURNS a `ReconcileResult`. Persistence and the
 *   reconciliation agent-run happen at the CALLER:
 *     - the route (S10 `POST /api/session/bind/reconcile`) applies
 *       `result.lifecycleMutations` via `store.updateLifecycle` and persists,
 *     - the orchestrator (S9 `compose_resume` consumer) runs the reconciliation
 *       agent with `result.reconcilePrompt` when `action === 'needs-sync'`, then
 *       writes the synced checkpoint and re-decides via `decideAfterSync`.
 *
 *   `reconcile()` does NOT mutate the passed-in `item` either — it only emits
 *   plain mutation descriptors in `result.lifecycleMutations`. The route is the
 *   SINGLE application point (it calls `appendPhaseHistory`, producing the correct
 *   dual-shape entry, then persists). Mutating here as well double-applied and
 *   malformed the entry (Codex impl review #1). It must not perform broad state
 *   surgery — only the well-defined backfill below.
 *
 * @see docs/features/COMP-RESUME/blueprint.md (slice S8 + Boundary review note)
 * @see docs/features/COMP-RESUME/design.md (Decision 5)
 *
 * ReconcileResult = {
 *   action: 'resume' | 'needs-sync' | 'gate',
 *   drift: 'clean' | 'advanced' | 'diverged',
 *   lifecycleMutations: Array<LifecycleMutation>,
 *   checkpoint: object | null,       // the latest recorded checkpoint (or null)
 *   rendered: string | null,         // renderCheckpoint(checkpoint) — human-readable resume view
 *   nextStep?: string | null,        // present on the 'resume' path
 *   reconcilePrompt?: string,        // present on the 'needs-sync' path
 *   gatePayload?: object,            // reserved for the orchestrator's gate path
 * }
 *
 * LifecycleMutation (plain descriptor the caller applies + persists):
 *   { type: 'phaseHistory.append', entry: { from, to, outcome, timestamp } }
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureFingerprint, classify } from './fingerprint.js';
import { reconcilePrompt } from './prompts.js';
import { renderCheckpoint } from './render.js';

/**
 * Read `<dataDir>/active-build.json` if present. Tolerates an absent or corrupt
 * file (returns null) — a crash can leave a torn write, and the reconciler must
 * degrade gracefully rather than throw.
 *
 * @param {string|null} dataDir
 * @returns {object|null}
 */
function readActiveBuild(dataDir) {
  if (!dataDir) return null;
  const file = join(dataDir, 'active-build.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // corrupt / partially-written — tolerate
  }
}

/**
 * Rebuild derived state in memory and collect plain mutation descriptors the
 * caller will apply + persist. Deliberately minimal and well-defined:
 *
 *   - phaseHistory backfill: if `item.lifecycle.phaseHistory` is missing/empty
 *     AND `item.lifecycle.currentPhase` is set, surface a single
 *     `phaseHistory.append` for `{ from:null, to:currentPhase, outcome:'resumed' }`.
 *     This repairs the known gap where phaseHistory is never reconstructed after
 *     a crash from a prior session (design Decision 5 step 1; blueprint C5).
 *
 * Returns descriptors ONLY; does not mutate `item`. The route applies them via
 * appendPhaseHistory and persists (single application point).
 *
 * @param {object} item — vision item; inspected, not mutated.
 * @param {object|null} _activeBuild — parsed active-build.json (reserved for
 *   future derived-pointer rebuild; not used for broad surgery in v1).
 * @returns {Array<object>} lifecycleMutations
 */
function rebuildDerivedState(item, _activeBuild) {
  const mutations = [];
  const lifecycle = item && item.lifecycle;
  if (!lifecycle) return mutations;

  const history = lifecycle.phaseHistory;
  const historyEmpty = !Array.isArray(history) || history.length === 0;
  const currentPhase = lifecycle.currentPhase;

  if (historyEmpty && currentPhase) {
    // Return a descriptor ONLY — do NOT mutate item.lifecycle.phaseHistory here.
    // The route (S10) is the single application point: it calls
    // appendPhaseHistory(item, entry), which produces the correct dual-shape
    // entry (legacy phase/step/enteredAt/exitedAt + new from/to/outcome/timestamp)
    // and persists it. Mutating here too would double-append AND the direct push
    // would omit the legacy fields existing readers expect (Codex impl review #1).
    const entry = {
      from: null,
      to: currentPhase,
      outcome: 'resumed',
      timestamp: new Date().toISOString(),
    };
    mutations.push({ type: 'phaseHistory.append', entry });
  }

  return mutations;
}

/**
 * Reconcile recorded intent against the live environment and return a
 * ReconcileResult. Deterministic — no store writes, no DB mutation, no LLM.
 *
 * @param {object} args
 * @param {string} args.featureCode
 * @param {object} args.item — vision item (may be mutated in memory; see above).
 * @param {string} args.cwd — repo / working dir to fingerprint.
 * @param {string} args.featureDir — dir holding phase artifacts.
 * @param {string|null} [args.composeDir] — `.compose` dir for build-stream lookup.
 * @param {string|null} [args.dataDir] — `.compose/data` dir.
 * @param {object} args.store — a CheckpointStore (read-only here).
 * @param {number} [args.confidenceThreshold=0.6] — passed through for the caller.
 * @returns {object} ReconcileResult
 */
export function reconcile({
  featureCode,
  item,
  cwd,
  featureDir,
  composeDir = null,
  dataDir = null,
  store,
  confidenceThreshold = 0.6,
}) {
  // 1. Rebuild derived state (in-memory, deterministic). Read active-build.json
  //    tolerantly; collect lifecycle mutation descriptors for the caller.
  const activeBuild = readActiveBuild(dataDir);
  const lifecycleMutations = rebuildDerivedState(item, activeBuild);

  // 2. Load latest recorded intent (read-only). Opportunistically use
  //    semanticRecall if the backend advertises it; the jsonl floor does not, so
  //    this falls through to readLatest.
  let latest = null;
  const caps = typeof store.capabilities === 'function' ? store.capabilities() : new Set();
  if (caps && caps.has && caps.has('semanticRecall') && typeof store.semanticRecall === 'function') {
    const hits = store.semanticRecall(featureCode, '', { limit: 1 });
    latest = Array.isArray(hits) && hits.length ? hits[0] : null;
  } else {
    latest = store.readLatest(featureCode);
  }

  // 3. Capture the live fingerprint and classify drift against the checkpoint's.
  const live = captureFingerprint(cwd, { featureDir, composeDir, dataDir });
  const drift = classify(latest?.fingerprint ?? null, live);

  // A human-readable view of the recorded intent, for the resume UX (wires
  // renderCheckpoint into the production path — Codex impl review #3).
  const rendered = latest ? renderCheckpoint(latest) : null;

  // 4. clean / advanced → resume at the recorded nextStep (no agent).
  if (drift === 'clean' || drift === 'advanced') {
    return {
      action: 'resume',
      nextStep: latest?.soft?.nextStep ?? null,
      drift,
      lifecycleMutations,
      checkpoint: latest,
      rendered,
    };
  }

  // 5. diverged → needs-sync. The orchestrator runs the reconciliation agent
  //    with this prompt, then writes the synced checkpoint and calls
  //    decideAfterSync. reconcile itself does NOT run the agent or persist.
  return {
    action: 'needs-sync',
    drift,
    lifecycleMutations,
    checkpoint: latest,
    rendered,
    reconcilePrompt: reconcilePrompt({
      staleCheckpoint: latest,
      liveFingerprint: live,
      envScan: '',
    }),
  };
}

/**
 * Pure gate decision made by the orchestrator AFTER it has run the
 * reconciliation agent (on the needs-sync path) and obtained a confidence.
 * Kept here, separate from any LLM call, so the decision is unit-testable.
 *
 * @param {object} args
 * @param {number} args.confidence — agent-reported confidence in [0,1].
 * @param {number} [args.confidenceThreshold=0.6]
 * @returns {'resume'|'gate'} resume when confidence >= threshold (inclusive), else gate.
 */
export function decideAfterSync({ confidence, confidenceThreshold = 0.6 }) {
  return confidence >= confidenceThreshold ? 'resume' : 'gate';
}
