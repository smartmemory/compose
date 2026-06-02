/**
 * lib/checkpoint/store/jsonl.js — the floor checkpoint backend.
 *
 * COMP-RESUME slices S4/S5 (correction C4): checkpoints are stored in
 * feature-scoped JSONL files `checkpoints-<featureCode>.jsonl` under the data
 * dir. Feature-scoping keeps `readLatest`/`list` cheap (no global filter) while
 * each record still carries its own `featureCode`.
 *
 * This backend is "floor-only": it implements the base CheckpointStore contract
 * (write / readLatest / list / capabilities) and advertises no optional
 * capabilities. Richer backends (e.g. SmartMemory) layer semanticRecall /
 * temporalRange / procedureMatch on top — see ./index.js.
 */

import { join } from 'node:path';
import { appendJsonl, readJsonl } from '../atomic.js';

export class JsonlCheckpointBackend {
  /**
   * @param {{ dataDir: string }} opts — dataDir is passed per-construction so the
   *   backend honors project switches (server re-creates the store on switch).
   */
  constructor({ dataDir } = {}) {
    if (!dataDir) throw new Error('JsonlCheckpointBackend requires { dataDir }');
    this.dataDir = dataDir;
  }

  /** Absolute path to the JSONL file for a given feature. */
  _file(featureCode) {
    return join(this.dataDir, `checkpoints-${featureCode}.jsonl`);
  }

  /**
   * Append a checkpoint. Idempotent on `cp.id`: if a record with the same id
   * already exists in this feature's file, the existing record is returned and
   * nothing is appended. Otherwise the cp is appended and returned.
   *
   * @param {object} cp — a Checkpoint (must have .id and .featureCode)
   * @returns {object} the persisted checkpoint
   */
  write(cp) {
    if (!cp || !cp.id) throw new Error('checkpoint requires an id');
    if (!cp.featureCode) throw new Error('checkpoint requires a featureCode');
    const file = this._file(cp.featureCode);

    // Idempotency scan. Volume per feature is bounded, so a linear scan is fine.
    const existing = readJsonl(file);
    const prior = existing.find((r) => r.id === cp.id);
    if (prior) return prior;

    appendJsonl(file, cp);
    return cp;
  }

  /**
   * @param {string} featureCode
   * @returns {object|null} the most-recently-written checkpoint, or null.
   */
  readLatest(featureCode) {
    const all = readJsonl(this._file(featureCode));
    return all.length ? all[all.length - 1] : null;
  }

  /**
   * @param {string} featureCode
   * @param {{ limit?: number }} [opts]
   * @returns {object[]} checkpoints for the feature, NEWEST-FIRST, sliced to limit.
   */
  list(featureCode, { limit } = {}) {
    const newestFirst = readJsonl(this._file(featureCode)).reverse();
    return limit !== undefined ? newestFirst.slice(0, limit) : newestFirst;
  }

  /**
   * @returns {Set<string>} optional capabilities — empty for the jsonl floor.
   */
  capabilities() {
    return new Set();
  }
}
