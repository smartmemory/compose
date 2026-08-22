/**
 * lib/judgment-decision-write.js — the judgment write path into SmartMemory
 * (GOV-COMPOSE-SEAM-1 step 1 `canon-on-decisions`, phase P2).
 *
 * FAIL-CLOSED, unlike `smartmemory-ingest.js`.
 *
 * Ingest is fire-and-forget on purpose: a dropped feature event costs an
 * analytics row, and the local durable write already happened. A dropped
 * DECISION is different — under D1 the SmartMemory record is the canon, so a
 * silently dropped write leaves a build governed by a rule set that is missing
 * the thing just decided. Nobody sees a warning in a log. So a failed decision
 * write throws, and the caller's tool call fails with it.
 *
 * Three guarantees, in the order they are enforced:
 *
 *   1. GATED — does nothing at all unless `smartmemory.enabled === true`.
 *   2. IDEMPOTENT — a stable key per ledger entry, recorded in ONE local
 *      ledger shared by the live path and the backfill, and verified against
 *      the service before a skip. **There must be exactly one such ledger.**
 *      Two of them briefly existed (this sidecar and the backfill's own
 *      `.compose/data/judgment-migration-state.json`), keyed identically but
 *      read separately, so a decision written live and then backfilled would
 *      be written twice — the create endpoint has no server-side idempotency
 *      to catch it. Merged here 2026-08-22; the old file is adopted on first
 *      read and then unused.
 *   3. VERIFIED — reads the decision back and checks the provenance survived,
 *      rather than trusting a 200. Against a service predating the 2026-08-22
 *      field addition, FastAPI silently ignores `source_type` /
 *      `context_snapshot`, so a 200 proves nothing about the thing D4 needs.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getSmartmemoryConfig } from './smartmemory-config.js';
import { createSmartmemoryClient } from './smartmemory-client.js';
import { atomicWrite } from './judgment/store/records.js';

/**
 * Local idempotency ledger: `idempotency_key -> decision_id`.
 *
 * Lives beside the judgment records because it IS judgment provenance — which
 * ledger entry became which decision. Also serves as the backfill's resume
 * file (P3), which is why it is a file and not process memory.
 */
export function sidecarPath(cwd) {
  return join(cwd, 'docs', 'judgment', 'records', 'decision-ids.json');
}

/**
 * Where the backfill's own resume file used to live before the two idempotency
 * ledgers were merged (2026-08-22). Read once, so a migration already run
 * against the old file is not repeated against the new one.
 */
export function legacyStatePath(cwd) {
  return join(cwd, '.compose', 'data', 'judgment-migration-state.json');
}

export function readSidecar(cwd) {
  const path = sidecarPath(cwd);
  if (!existsSync(path)) {
    const legacy = legacyStatePath(cwd);
    if (existsSync(legacy)) {
      try {
        const parsed = JSON.parse(readFileSync(legacy, 'utf8'));
        // Old shape was { version, written: {key: id} }.
        const written = parsed?.written;
        if (written && typeof written === 'object') return { ...written };
      } catch {
        throw new Error(
          `judgment-decision-write: the legacy resume file ${legacy} is unreadable. `
          + 'Repair or delete it deliberately; ignoring it would re-write every decision '
          + 'the earlier backfill already stored.',
        );
      }
    }
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt sidecar must not silently become "nothing was ever written" —
    // that would re-write every decision on the next run.
    throw new Error(
      `judgment-decision-write: ${path} is unreadable. Repair or delete it deliberately; `
      + 'treating it as empty would duplicate every decision already written.',
    );
  }
}

function writeSidecar(cwd, map) {
  const path = sidecarPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify(map, null, 2)}\n`);
}

/**
 * Did the provenance actually land?
 *
 * Checks the two fields the feature turns on, not the whole payload. A service
 * that ignored them answers 200 and stores a decision whose conviction
 * provenance is simply absent — indistinguishable, from the caller's side, from
 * a successful write, which is the exact failure D4 exists to prevent.
 */
export function provenanceLanded(stored, sent) {
  if (!stored) return false;
  if (sent.source_type !== undefined && stored.source_type !== sent.source_type) return false;
  if (sent.context_snapshot !== undefined) {
    const got = stored.context_snapshot;
    if (!got || typeof got !== 'object') return false;
    // Key-wise, not deep-equal: the lifecycle owns three reserved slots inside
    // context_snapshot and may add them (CORE-SUPERSEDE-NOTE-1), so a strict
    // equality check would fail on a correct write.
    for (const [k, v] of Object.entries(sent.context_snapshot)) {
      if (JSON.stringify(got[k]) !== JSON.stringify(v)) return false;
    }
  }
  return true;
}

/**
 * Write one mapped decision, once.
 *
 * @param {string} cwd
 * @param {object} decision payload from `ledgerEntryToDecision`
 * @param {{client?: object, config?: object}} [deps] injection seam for tests
 * @returns {Promise<{decision_id: string, skipped: boolean}|null>} null when the
 *   coupling is off — the ONLY silent no-op, and it is a configuration state,
 *   not a failure.
 */
export async function writeJudgmentDecision(cwd, decision, deps = {}) {
  const cfg = deps.config ?? getSmartmemoryConfig(cwd);
  if (cfg.enabled !== true) return null;

  const key = decision.idempotency_key;
  if (!key) {
    throw new Error('judgment-decision-write: decision has no idempotency_key; refusing to write');
  }

  const sidecar = readSidecar(cwd);
  const client = deps.client ?? createSmartmemoryClient(cfg);

  const known = sidecar[key];
  if (known) {
    // Idempotency is VERIFIED, not assumed. A key in the local ledger only
    // counts once the decision is confirmed still present server-side —
    // otherwise a ledger that has drifted from the service (restored backup,
    // deleted decision, wrong workspace) silently skips a write that never
    // landed, and the gap is invisible forever after.
    const live = await client.getDecision(known);
    if (live) return { decision_id: known, skipped: true };
    process.stderr.write(
      `[judgment-decision-write] ledger claimed ${key} -> ${known} but the service has no `
      + 'such decision; rewriting.\n',
    );
  }

  // `idempotency_key` and `supersedes_slug` are mapper-internal and are not
  // fields on the create contract. The key travels inside context_snapshot so
  // the remote record can be reconciled against the sidecar if they diverge.
  const { idempotency_key: _k, supersedes_slug: _s, ...rest } = decision;
  const payload = {
    ...rest,
    context_snapshot: { ...(decision.context_snapshot ?? {}), idempotency_key: key },
  };

  const created = await client.createDecision(payload);
  const stored = await client.getDecision(created.decision_id);

  if (!provenanceLanded(stored, payload)) {
    throw new Error(
      `judgment-decision-write: ${created.decision_id} was created but its provenance did not land. `
      + 'The service is probably older than the 2026-08-22 source_type/context_snapshot change, '
      + 'which FastAPI ignores silently. Failing rather than recording a decision whose '
      + 'conviction provenance is absent.',
    );
  }

  // Remote first, sidecar second. The reverse would leave a phantom entry when
  // the write fails, permanently skipping a decision that was never stored.
  //
  // KNOWN WINDOW: a crash between the two duplicates this one decision on the
  // next run. Stated rather than hidden — closing it needs a server-side
  // idempotency key, which the create contract does not have. The remote record
  // carries `context_snapshot.idempotency_key`, so a duplicate is detectable
  // and repairable after the fact.
  sidecar[key] = created.decision_id;
  writeSidecar(cwd, sidecar);

  return { decision_id: created.decision_id, skipped: false };
}
