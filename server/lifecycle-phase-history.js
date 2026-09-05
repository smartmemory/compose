/**
 * lifecycle-phase-history.js — Populate lifecycle.phaseHistory[].
 *
 * COMP-OBS-TIMELINE: plugs project_lifecycle_phasehistory_gap (memory note).
 * This module is the SOLE WRITER for lifecycle.phaseHistory[].
 *
 * Entries carry BOTH the legacy shape (`phase`, `step`, `enteredAt`, `exitedAt`,
 * `outcome`) consumed by `ItemDetailPanel.jsx`, `ContextPipelineDots.jsx`, and
 * `session-routes.js`, AND the new shape (`from`, `to`, `outcome`, `timestamp`)
 * consumed by `decision-events-snapshot.js`. Legacy `enteredAt` is the same
 * instant as the new `timestamp`. The previous entry's `exitedAt` is closed out
 * to the new entry's `enteredAt` (legacy semantic: a phase exits when its
 * successor begins).
 *
 * COMP-LIFECYCLE-BACKFILL (blueprint §4.1): the history is BITEMPORAL. `enteredAt`
 * / `exitedAt` are VALID time (when the phase was actually in force) and
 * `recordedAt` is TRANSACTION time (when we learned it). A live walk has the two
 * equal, which is why `appendPhaseHistory` stamps `recordedAt: timestamp`,
 * `origin: 'live'` and `confidence: 1.0` on every NEW write. Nothing migrates:
 * records written before this feature carry none of the three, and every reader
 * goes through `normaliseOrigin` so absence reads as 'live' in exactly one place.
 */

import { transitionsOf, terminalOf } from '../lib/lifecycle-modes.js';
import { buildPhaseGraph } from './lifecycle-guard.js';

/** One definition of "what does a missing `origin` mean", shared by every READER. */
export function normaliseOrigin(entry) {
  return entry?.origin ?? 'live';
}

/**
 * Append one phase transition entry to item.lifecycle.phaseHistory and close
 * out the prior entry's `exitedAt`.
 *
 * @param {object} item — vision store item (mutated in place)
 * @param {{ from: string|null, to: string, outcome: string|null, timestamp: string }} params
 */
export function appendPhaseHistory(item, { from, to, outcome, timestamp }) {
  if (!Array.isArray(item.lifecycle.phaseHistory)) {
    item.lifecycle.phaseHistory = [];
  }
  const history = item.lifecycle.phaseHistory;
  const prior = history[history.length - 1];
  if (prior && prior.exitedAt == null) {
    prior.exitedAt = timestamp;
  }
  history.push({
    // Legacy shape (preserves existing readers in ItemDetailPanel, ContextPipelineDots, session-routes)
    phase: to,
    step: to,
    enteredAt: timestamp,
    exitedAt: null,
    // New shape (consumed by decision-events-snapshot.js)
    from: from ?? null,
    to,
    outcome: outcome ?? null,
    timestamp,
    // Bitemporal provenance (COMP-LIFECYCLE-BACKFILL). A live walk learns the
    // transition at the instant it happens, so transaction time == valid time.
    recordedAt: timestamp,
    origin: 'live',
    confidence: 1.0,
  });
}

// ---------------------------------------------------------------------------
// COMP-LIFECYCLE-BACKFILL §4.1 — the valid-time merge
// ---------------------------------------------------------------------------

const UNIT_SEPARATOR = '\u001f';

/** BP-8: every ordering comparison is numeric on epoch ms, never on the string. */
const ms = (x) => Date.parse(x);

const clone = (x) => JSON.parse(JSON.stringify(x));

/** phase + UNIT SEPARATOR + evidence ref. Never a NUL byte — it breaks grep. */
export function occurrenceKey(o) {
  return `${o.phase}${UNIT_SEPARATOR}${o.evidence?.ref ?? ''}`;
}

/** The nodes a lifecycle may actually WALK in this mode. */
function walkableNodes(fwdGraph) {
  const nodes = new Set();
  for (const [from, tos] of Object.entries(fwdGraph)) {
    nodes.add(from);
    for (const t of tos || []) nodes.add(t);
  }
  return nodes;
}

function reachable(graph, from, to) {
  if (from === to) return true;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of graph[cur] || []) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

const IMMUTABLE_FIELDS = (x) => ({
  phase: x.phase,
  enteredAt: x.enteredAt,
  timestamp: x.timestamp,
  recordedAt: x.recordedAt,
  outcome: x.outcome,
  origin: x.origin,
  evidenceKind: x.evidence?.kind ?? null,
  evidenceRef: x.evidence?.ref ?? null,
  observedEpochMs: x.evidence?.observedEpochMs ?? null,
});

const CLAIM_FIELDS = (x) => ({
  phase: x.phase,
  kind: x.evidence?.kind ?? null,
  ref: x.evidence?.ref ?? null,
  // A STORED entry carries the epoch on its evidence; an incoming one does too.
  observedEpochMs: x.evidence?.observedEpochMs ?? null,
});

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const refuse = (...reasons) => ({ ok: false, reasons: reasons.flat() });

/**
 * Merge backfilled occurrences into a phase history by VALID TIME.
 *
 * PURE (BP-7): `item` is never mutated and no input object is ever aliased into
 * the result. R2B-5: the comparison baseline is an INDEPENDENT deep clone taken
 * before anything is rewritten.
 *
 * @param {object} item      vision item, read-only
 * @param {object[]} incoming  already materialised occurrences (§5.5)
 * @returns {{ok:true, history:Array, written:string[], skipped:string[]}
 *         | {ok:false, reasons:string[]}}
 */
export function insertBackfilledPhases(item, incoming) {
  const lc = item.lifecycle;
  const mode = lc.mode ?? 'build';
  const fwdGraph = transitionsOf(mode);
  const fullGraph = buildPhaseGraph(mode);
  // R2B-1: fwdGraph is what a lifecycle may WALK; fullGraph is what the guard
  // ACCEPTS, and only fullGraph contains complete_backfilled.
  const walkable = walkableNodes(fwdGraph);
  const adapterTerminals = new Set(terminalOf(mode).filter((t) => !walkable.has(t)));

  const startedMs = ms(lc.startedAt);
  if (!Number.isFinite(startedMs)) {
    return refuse('lifecycle.startedAt is not a parseable instant');
  }
  for (const o of incoming) {
    if (!Number.isFinite(o.evidence?.observedEpochMs)) {
      return refuse(`unparseable evidence time for ${occurrenceKey(o)}`);
    }
  }
  for (const e of lc.phaseHistory ?? []) {
    if (!Number.isFinite(ms(e.enteredAt))) {
      return refuse('stored occurrence has an unparseable enteredAt');
    }
  }

  // BP-7 / R2B-5: temp ids WE assign, on CLONES, plus a SEPARATE immutable
  // snapshot cloned independently so step 4d and the marker test both read
  // pre-rewrite values.
  const existing = (lc.phaseHistory ?? []).map((e, seq) => ({ ...clone(e), _tid: `x${seq}`, _seq: seq }));
  const snapshot = new Map(existing.map((e) => [e._tid, clone(e)]));

  // MARKER IDENTITY IS COMPUTED NOW, off the snapshot, before any rewrite.
  const markerTids = new Set(
    existing
      .filter((e) => e._seq === 0
        && normaliseOrigin(e) !== 'backfill'
        && snapshot.get(e._tid).from == null
        && !walkable.has(e.phase))
      .map((e) => e._tid),
  );

  const skipped = [];

  // ---- STEP 3a FIRST OF ALL (R3-5): dedup by operation_id.
  const byOpId = new Map(
    existing.filter((e) => e.operation_id != null).map((e) => [e.operation_id, e]),
  );
  const remaining = [];
  for (const o of incoming) {
    if (o.operation_id == null) { remaining.push(o); continue; }
    const prior = byOpId.get(o.operation_id);
    if (prior === undefined) { remaining.push(o); continue; }
    // ALREADY PERSISTED BY THIS OPERATION. A stored entry sharing our id but
    // differing in any immutable field is corruption, not idempotence.
    if (!eq(IMMUTABLE_FIELDS(prior), IMMUTABLE_FIELDS(o))) {
      return refuse(
        `an entry under operation ${o.operation_id} is already stored with different `
        + 'immutable fields — refusing to overwrite it',
      );
    }
    skipped.push(occurrenceKey(o));
  }

  // ---- STEP 3b: dedup by CLAIM, for everything with no operation id.
  const byKey = new Map(
    existing.filter((e) => normaliseOrigin(e) === 'backfill').map((e) => [occurrenceKey(e), e]),
  );
  const batch = [];
  for (const o of remaining) {
    const prior = byKey.get(occurrenceKey(o));
    if (prior === undefined) {
      batch.push({ ...clone(o), _tid: `n${batch.length}`, _seq: Number.POSITIVE_INFINITY });
      continue;
    }
    if (eq(CLAIM_FIELDS(prior), CLAIM_FIELDS(o))) { skipped.push(occurrenceKey(o)); continue; }
    return refuse(`occurrence already recorded with other evidence: ${occurrenceKey(o)}`);
  }
  if (batch.length === 0) {
    // Pure no-op: the persisted history is returned untouched.
    return { ok: true, history: lc.phaseHistory ?? [], written: [], skipped };
  }

  // ---- STEP 4 refusals. Whole batch, nothing persisted.

  // 4a. TIE — only an INCOMING backfilled occurrence triggers it.
  const instants = [
    ...existing.map((e) => ms(e.enteredAt)),
    ...batch.map((o) => o.evidence.observedEpochMs),
  ];
  for (const o of batch) {
    const at = o.evidence.observedEpochMs;
    if (instants.filter((x) => x === at).length > 1) {
      return refuse(`two phases cannot start at the same instant — cite distinct evidence for ${occurrenceKey(o)}`);
    }
  }

  // 4b. ADOPTION INSTANT — anchored to lc.startedAt, not to any occurrence.
  for (const o of batch) {
    if (o.evidence.observedEpochMs === startedMs) {
      return refuse('backfilled occurrence at the adoption instant is ambiguously placed');
    }
  }
  const episodeOf = (at) => (at < startedMs ? 1 : 2);

  // 4c. CLOSED LIVE INTERVAL.
  for (const o of batch) {
    for (const e of existing) {
      if (normaliseOrigin(e) === 'backfill' || e.exitedAt == null) continue;
      const at = o.evidence.observedEpochMs;
      if (ms(e.enteredAt) < at && at < ms(e.exitedAt)) {
        return refuse(
          `backfilled ${occurrenceKey(o)} falls inside the closed live interval `
          + `${e.phase} [${e.enteredAt}, ${e.exitedAt})`,
        );
      }
    }
  }

  // ---- STEP 2. Merge and recompute closure from valid time.
  const instantOf = (x) => x.evidence?.observedEpochMs ?? ms(x.enteredAt);
  const merged = [...existing, ...batch].sort((a, b) => {
    const d = instantOf(a) - instantOf(b);
    if (d !== 0) return d;
    return a._seq - b._seq;
  });
  for (let i = 0; i < merged.length; i += 1) {
    merged[i].exitedAt = i + 1 < merged.length ? merged[i + 1].enteredAt : null;
    merged[i].from = i > 0 ? merged[i - 1].phase : null;
    merged[i].episode = episodeOf(instantOf(merged[i]));
  }

  // 4d. LIVE RECORDS ARE NEVER REWRITTEN — compared against the INDEPENDENT
  //     pre-rewrite clones.
  for (const e of existing) {
    if (normaliseOrigin(e) === 'backfill') continue;
    const original = snapshot.get(e._tid);
    const m = merged.find((x) => x._tid === e._tid);
    if (m.enteredAt !== original.enteredAt) {
      return refuse(`the merge would move the live occurrence ${original.phase}`);
    }
    if (original.exitedAt != null && m.exitedAt !== original.exitedAt) {
      return refuse(
        `the merge would re-close the live occurrence ${original.phase} `
        + `from ${original.exitedAt} to ${m.exitedAt}`,
      );
    }
    // An OPEN live occurrence may legitimately be closed by a later backfilled one.
  }

  // 4e. TRANSITIVE REACHABILITY within an episode.
  for (let i = 1; i < merged.length; i += 1) {
    const a = merged[i - 1];
    const b = merged[i];
    if (markerTids.has(a._tid) || markerTids.has(b._tid)) continue;
    if (a.episode !== b.episode) continue;   // the single adoption-boundary pair
    const g = adapterTerminals.has(b.phase) ? fullGraph : fwdGraph;
    if (!reachable(g, a.phase, b.phase)) {
      return refuse(`${a.phase} -> ${b.phase} is not reachable in ${mode}`);
    }
  }

  // 4f. INTERVAL INVARIANT, last, numerically, over the whole merged list.
  for (const m of merged) {
    if (m.exitedAt != null && ms(m.exitedAt) < ms(m.enteredAt)) {
      return refuse(`interval invariant violated at ${m.phase}`);
    }
  }

  const history = merged.map((m) => {
    const out = { ...m };
    delete out._tid;
    delete out._seq;
    return out;
  });
  return { ok: true, history, written: batch.map(occurrenceKey), skipped };
}
