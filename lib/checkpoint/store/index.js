/**
 * lib/checkpoint/store/index.js — CheckpointStore interface + backend registry.
 *
 * COMP-RESUME slice S4. The base contract every backend implements:
 *   - write(cp)                 → persist a Checkpoint, idempotent on cp.id; returns the cp
 *   - readLatest(featureCode)   → most recent Checkpoint or null
 *   - list(featureCode, {limit})→ Checkpoints newest-first, sliced to limit
 *   - capabilities()            → Set<string> of optional capabilities
 *
 * Optional (advertised via capabilities(), absent on the jsonl floor):
 *   - semanticRecall, temporalRange, procedureMatch
 *
 * Backend selection defaults to 'jsonl' (read from loadProjectConfig().checkpoint?.backend
 * by the caller). 'smartmemory' and 'memory-pointer' are registered seams that
 * throw NOT_IMPLEMENTED in v1.
 */

import { JsonlCheckpointBackend } from './jsonl.js';

/**
 * Construct a checkpoint store backend.
 *
 * @param {string} [backendId='jsonl'] — one of 'jsonl' | 'smartmemory' | 'memory-pointer'
 * @param {{ dataDir?: string }} [opts]
 * @returns {object} a CheckpointStore
 */
export function createCheckpointStore(backendId = 'jsonl', { dataDir } = {}) {
  switch (backendId) {
    case 'jsonl':
      return new JsonlCheckpointBackend({ dataDir });

    case 'smartmemory':
      // ── SmartMemory backend — intended interface mapping (NOT built in v1) ──
      //
      // When implemented, map the CheckpointStore contract onto the SmartMemory SDK:
      //
      //   write(cp)                  → ReasoningTracesAPI.store({ trace, artifactIds })
      //                                 (cp.soft + fingerprint serialize into `trace`;
      //                                  returned trace/artifact ids fill cp.artifactIds)
      //   readLatest(featureCode)    → TemporalAPI  (most-recent trace for the feature scope)
      //   list(featureCode, {limit}) → TemporalAPI  (temporal range / latest-N for the scope)
      //   semanticRecall({query,limit}) → query({ query, limit })   (capability: 'semanticRecall')
      //   procedureMatch(...)        → ProcedureMatchAPI            (capability: 'procedureMatch')
      //
      // Requires adding `smart-memory-sdk-js` as an OPTIONAL peer dep and a LAZY
      // (dynamic) import here so the dep is only loaded when this backend is
      // actually selected. Deliberately NOT done in v1 (SmartMemory was scoped
      // out — see blueprint correction C2).
      throw Object.assign(
        new Error('SmartMemory checkpoint backend not implemented'),
        { code: 'NOT_IMPLEMENTED' }
      );

    case 'memory-pointer':
      // Registered seam, deferred. Intended to store only a pointer/ref to an
      // external memory record rather than the full checkpoint inline.
      throw Object.assign(
        new Error('memory-pointer checkpoint backend not implemented'),
        { code: 'NOT_IMPLEMENTED' }
      );

    default:
      throw new Error(
        `Unknown checkpoint backend '${backendId}'. Valid ids: jsonl, smartmemory, memory-pointer.`
      );
  }
}
