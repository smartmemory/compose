/**
 * lib/judgment/store/index.js — judgment canon provider registry (S02).
 *
 * Exactly one configured canon provider (design Decision 1/5): selection is
 * read from `.compose/compose.json#judgment.provider`, default 'records'
 * (the tracked floor). 'smartmemory' is the checkpoint-store-precedent seam:
 * it throws NOT_IMPLEMENTED AT SELECTION — no stub object is ever returned.
 * W4's SmartMemory integration is an enrichment emitter behind the SEPARATE
 * `judgment.enrichment.smartmemory` key, never a canon provider.
 *
 * `capabilities()` lives on each backend (records ⇒ empty set), not here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RecordsStore } from './records.js';

function configuredProvider(cwd) {
  try {
    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf8'));
    return config?.judgment?.provider ?? 'records';
  } catch {
    return 'records';
  }
}

/**
 * Construct the configured judgment canon store for a project root.
 * @param {string} cwd project root
 * @returns {RecordsStore}
 */
export function createJudgmentStore(cwd) {
  const provider = configuredProvider(cwd);
  switch (provider) {
    case 'records':
      return new RecordsStore(cwd);

    case 'smartmemory':
      // A SmartMemory CANON provider would need the full store contract plus
      // an owner-ruled one-time import (Decision 1). Not built; selection
      // fails loudly rather than returning a partial stub.
      throw Object.assign(
        new Error("SmartMemory judgment canon provider not implemented — v1 canon is 'records'; SmartMemory ships as enrichment (judgment.enrichment.smartmemory) in W4"),
        { code: 'NOT_IMPLEMENTED' },
      );

    default:
      throw new Error(`Unknown judgment provider '${provider}'. Valid ids: records, smartmemory.`);
  }
}
