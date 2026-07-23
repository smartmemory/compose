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

const EFFECTIVE_STORES = new WeakSet();

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

/**
 * Construct a read-only view that excludes whole artifacts attributed to an
 * intent which was pending when the view was created.
 *
 * The intent set is deliberately snapshotted once. Record files and ledger
 * lines are filtered only by top-level provenance; nested intent attribution
 * belongs to the containing record and is not recursively hidden.
 *
 * @param {RecordsStore} rawStore
 */
export function effectiveStore(rawStore) {
  if (EFFECTIVE_STORES.has(rawStore)) return rawStore;

  const pendingIntents = rawStore.readIntents();
  const pendingIds = new Set(pendingIntents.map((intent) => intent.id));
  const isVisible = (record) => (
    record != null && !pendingIds.has(record.provenance?.intent_id)
  );
  const visibleOrNull = (record) => (isVisible(record) ? record : null);

  const adapter = {
    capabilities() {
      return rawStore.capabilities();
    },

    readPositionRevision(slug, rev) {
      return visibleOrNull(rawStore.readPositionRevision(slug, rev));
    },

    readPositionChain(slug) {
      return rawStore.readPositionChain(slug)
        .map((record) => adapter.readPositionRevision(slug, record.rev))
        .filter(Boolean);
    },

    latestPositionRevision(slug) {
      const chain = adapter.readPositionChain(slug);
      return chain.length === 0 ? null : chain[chain.length - 1];
    },

    listPositionSlugs() {
      return rawStore.listPositionSlugs()
        .filter((slug) => adapter.readPositionChain(slug).length > 0);
    },

    derivePositionStatus(slug) {
      const latest = adapter.latestPositionRevision(slug);
      if (!latest) return null;
      if (latest.retracted === true) return 'retracted';
      for (const other of adapter.listPositionSlugs()) {
        if (other === slug) continue;
        const otherLatest = adapter.latestPositionRevision(other);
        if (!otherLatest || otherLatest.retracted === true) continue;
        const ref = otherLatest.supersedes;
        if (typeof ref === 'string' && ref.startsWith(`${slug}#r`)) {
          return 'superseded';
        }
      }
      return 'live';
    },

    readJoint(slug) {
      return visibleOrNull(rawStore.readJoint(slug));
    },

    listJoints() {
      return rawStore.listJoints()
        .map((record) => adapter.readJoint(record.slug))
        .filter(Boolean);
    },

    readPrediction(id) {
      return visibleOrNull(rawStore.readPrediction(id));
    },

    listPredictions({ status } = {}) {
      return rawStore.listPredictions()
        .map((record) => adapter.readPrediction(record.id))
        .filter(Boolean)
        .filter((record) => (status ? record.status === status : true));
    },

    readLedgerEvents() {
      return rawStore.readLedgerEvents().filter(isVisible);
    },

    readPerson(slug) {
      return visibleOrNull(rawStore.readPerson(slug));
    },

    listPeople() {
      return rawStore.listPeople()
        .map((record) => adapter.readPerson(record.slug))
        .filter(Boolean);
    },

    readSituationEntity(slug) {
      return visibleOrNull(rawStore.readSituationEntity(slug));
    },

    listSituationEntities() {
      return rawStore.listSituationEntities()
        .map((record) => adapter.readSituationEntity(record.slug))
        .filter(Boolean);
    },

    readGoalVersion(version) {
      return visibleOrNull(rawStore.readGoalVersion(version));
    },

    readGoalChain() {
      return rawStore.readGoalChain()
        .map((record) => adapter.readGoalVersion(record.version))
        .filter(Boolean);
    },

    latestGoalVersion() {
      const chain = adapter.readGoalChain();
      return chain.length === 0 ? null : chain[chain.length - 1];
    },

    readGoalState() {
      const raw = rawStore.readGoalState();
      // Records-atomic guarantee (C3): while a goal migration is pending, a
      // state.json the migration already wrote (attributed to that intent)
      // must read back as the captured PREIMAGE, not as absence. Every other
      // family hides an attributed record as null; goal state instead
      // substitutes the pre-migration bytes the intent carries.
      const migration = pendingIntents.find((intent) => intent.kind === 'goal_migration');
      if (migration && raw?.provenance?.intent_id === migration.id) {
        return migration.payload?.goal_state_preimage?.record ?? null;
      }
      return visibleOrNull(raw);
    },

    hasPendingIntentKind(kind) {
      return pendingIntents.some((intent) => intent.kind === kind);
    },
  };

  EFFECTIVE_STORES.add(adapter);
  return Object.freeze(adapter);
}

/**
 * True once a published goal chain exists and no goal migration is pending.
 * Accepts either a raw RecordsStore or an already-effective view.
 */
export function goalCutoverComplete(store) {
  const effective = EFFECTIVE_STORES.has(store) ? store : effectiveStore(store);
  return (
    effective.readGoalChain().length > 0
    && !effective.hasPendingIntentKind('goal_migration')
  );
}
