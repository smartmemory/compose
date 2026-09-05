/**
 * test/phase-history-merge.test.js — COMP-LIFECYCLE-BACKFILL blueprint §4.1/§4.2.
 *
 * The seven histories H1–H7. Every fixture uses full ISO-8601 with an explicit
 * `Z`, and every expected closure is asserted on the EPOCH value as well as the
 * string (BP-8/BP-15) — `git show -s --format=%aI` emits the committer's UTC
 * offset, so string comparison across timezones is wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendPhaseHistory,
  insertBackfilledPhases,
  normaliseOrigin,
  occurrenceKey,
} from '../server/lifecycle-phase-history.js';

const SEP = '\u001f';
const NOW = '2026-09-10T00:00:00.000Z';

/** Assert a closure on BOTH the epoch and the string (BP-8/BP-15). */
function closes(entry, expected, label) {
  assert.equal(entry.exitedAt, expected, `${label}: string`);
  if (expected === null) return;
  assert.equal(Date.parse(entry.exitedAt), Date.parse(expected), `${label}: epoch`);
}

function occ(phase, observedTime, over = {}) {
  return {
    phase, step: phase, to: phase, from: null,
    enteredAt: observedTime, timestamp: observedTime, exitedAt: null,
    outcome: 'backfilled', recordedAt: NOW, origin: 'backfill',
    confidence: 0.9, episode: 1,
    evidence: {
      kind: 'commit',
      ref: `sha-${phase}`,
      verifiedAt: NOW,
      observedTime,
      observedEpochMs: Date.parse(observedTime),
    },
    ...over,
  };
}

/** The terminal occurrence the gate constructs in §5.5 step 4. */
function terminal(fromState, at = NOW, operationId = 'op-1') {
  return {
    phase: 'complete_backfilled', step: 'complete_backfilled', to: 'complete_backfilled',
    from: fromState, enteredAt: at, timestamp: at, exitedAt: null,
    outcome: 'backfilled', recordedAt: at, origin: 'live',
    confidence: 1.0, episode: 2, operation_id: operationId,
    evidence: { kind: 'commit', ref: 'sha-terminal', verifiedAt: at, observedTime: at, observedEpochMs: Date.parse(at) },
  };
}

/** A stored LIVE record in the pre-feature on-disk shape. */
function live(phase, enteredAt, over = {}) {
  return {
    phase, step: phase, enteredAt, exitedAt: null,
    from: null, to: phase, outcome: null, timestamp: enteredAt,
    ...over,
  };
}

function itemWith(history, { startedAt = '2026-09-01T00:00:00.000Z', mode = 'build' } = {}) {
  return { id: 'i1', lifecycle: { mode, startedAt, currentPhase: 'explore_design', phaseHistory: history } };
}

const byPhase = (history) => Object.fromEntries(history.map((e) => [e.phase, e]));

// ---------------------------------------------------------------------------

test('H1 — pre-adoption occurrences sort ahead of the live genesis entry', () => {
  const item = itemWith([live('explore_design', '2026-09-01T00:00:00.000Z')]);
  const res = insertBackfilledPhases(item, [
    occ('blueprint', '2026-06-01T00:00:00.000Z'),
    occ('execute', '2026-07-01T00:00:00.000Z'),
    occ('ship', '2026-08-01T00:00:00.000Z'),
  ]);
  assert.equal(res.ok, true, JSON.stringify(res.reasons));
  assert.deepEqual(res.history.map((e) => e.phase),
    ['blueprint', 'execute', 'ship', 'explore_design']);

  const h = byPhase(res.history);
  closes(h.blueprint, '2026-07-01T00:00:00.000Z', 'blueprint');
  closes(h.execute, '2026-08-01T00:00:00.000Z', 'execute');
  // Byte-equal to explore_design.enteredAt AND to lc.startedAt — asserted
  // against those, never a re-typed literal.
  assert.equal(h.ship.exitedAt, item.lifecycle.startedAt);
  assert.equal(h.ship.exitedAt, h.explore_design.enteredAt);
  assert.equal(Date.parse(h.ship.exitedAt), Date.parse(item.lifecycle.startedAt));
  closes(h.explore_design, null, 'explore_design');

  assert.deepEqual(res.history.map((e) => e.from), [null, 'blueprint', 'execute', 'ship']);
  assert.deepEqual(res.history.map((e) => e.episode), [1, 1, 1, 2]);
  for (const p of ['blueprint', 'execute', 'ship']) assert.equal(h[p].confidence, 0.9);
  assert.deepEqual(res.written, [`blueprint${SEP}sha-blueprint`, `execute${SEP}sha-execute`, `ship${SEP}sha-ship`]);
  assert.deepEqual(res.skipped, []);
});

test('H2 — post-adoption occurrences close the open live entry and ARE reachability-checked', () => {
  const item = itemWith([live('explore_design', '2026-09-01T00:00:00.000Z')]);
  const res = insertBackfilledPhases(item, [
    occ('blueprint', '2026-09-02T10:00:00.000Z'),
    occ('execute', '2026-09-03T10:00:00.000Z'),
  ]);
  assert.equal(res.ok, true, JSON.stringify(res.reasons));
  const h = byPhase(res.history);
  closes(h.explore_design, '2026-09-02T10:00:00.000Z', 'explore_design closed by the backfill');
  closes(h.blueprint, '2026-09-03T10:00:00.000Z', 'blueprint');
  closes(h.execute, null, 'execute');
  assert.deepEqual(res.history.map((e) => e.episode), [2, 2, 2]);
});

test('H3 — fix-mode out-of-graph genesis is a marker, and the exemption is NARROW', () => {
  const item = itemWith(
    [live('explore_design', '2026-09-01T00:00:00.000Z')],
    { mode: 'fix' },
  );
  const res = insertBackfilledPhases(item, [
    occ('diagnose', '2026-09-02T00:00:00.000Z'),
    occ('fix', '2026-09-03T00:00:00.000Z'),
  ]);
  assert.equal(res.ok, true, JSON.stringify(res.reasons));
  assert.deepEqual(res.history.map((e) => e.phase), ['explore_design', 'diagnose', 'fix']);

  // Negative variant: only _seq 0 is a marker.
  const item2 = itemWith(
    [
      live('explore_design', '2026-09-01T00:00:00.000Z', { exitedAt: '2026-09-01T06:00:00.000Z' }),
      live('explore_design', '2026-09-01T06:00:00.000Z'),
    ],
    { mode: 'fix' },
  );
  const res2 = insertBackfilledPhases(item2, [occ('diagnose', '2026-09-02T00:00:00.000Z')]);
  assert.equal(res2.ok, false);
  assert.match(res2.reasons.join(' '), /explore_design -> diagnose is not reachable in fix/);
});

test('H4 — a reconstructed resumed entry is NOT a marker; ship -> execute refuses', () => {
  const item = itemWith([
    { phase: 'ship', step: 'ship', enteredAt: '2026-09-04T12:00:00.000Z', exitedAt: null,
      from: null, to: 'ship', outcome: 'resumed', timestamp: '2026-09-04T12:00:00.000Z' },
  ]);
  const res = insertBackfilledPhases(item, [occ('execute', '2026-09-05T09:00:00.000Z')]);
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /ship -> execute is not reachable in build/);
});

test('H5 — a pre-existing live tie is preserved, and the merge does not alias or mutate', () => {
  const stored = [
    live('explore_design', '2026-09-01T00:00:00.000Z', { exitedAt: '2026-09-02T10:00:00.000Z' }),
    live('blueprint', '2026-09-02T10:00:00.000Z', { exitedAt: '2026-09-02T10:00:00.000Z' }),
    live('verification', '2026-09-02T10:00:00.000Z'),
  ];
  const item = itemWith(stored);
  const before = JSON.parse(JSON.stringify(item.lifecycle.phaseHistory));

  const res = insertBackfilledPhases(item, [occ('execute', '2026-09-03T10:00:00.000Z')]);
  assert.equal(res.ok, true, JSON.stringify(res.reasons));
  assert.deepEqual(res.history.map((e) => e.phase),
    ['explore_design', 'blueprint', 'verification', 'execute']);

  // BP-7: the caller's array and every object in it are unchanged…
  assert.deepEqual(item.lifecycle.phaseHistory, before);
  // …and no returned element is reference-identical to any input element.
  for (const out of res.history) {
    for (const input of item.lifecycle.phaseHistory) assert.notEqual(out, input);
  }

  // The tie rule fires only when an INCOMING backfilled occurrence is involved.
  const res2 = insertBackfilledPhases(itemWith(stored), [occ('execute', '2026-09-02T10:00:00.000Z')]);
  assert.equal(res2.ok, false);
  assert.match(res2.reasons.join(' '), /two phases cannot start at the same instant/);
});

test('H6 — retry after partial persistence is a no-op; changed evidence refuses', () => {
  const item = itemWith([live('explore_design', '2026-09-01T00:00:00.000Z')]);
  const batch = [
    occ('blueprint', '2026-06-01T00:00:00.000Z'),
    occ('execute', '2026-07-01T00:00:00.000Z'),
    occ('ship', '2026-08-01T00:00:00.000Z'),
  ];
  const first = insertBackfilledPhases(item, batch);
  assert.equal(first.ok, true);

  const persisted = itemWith(first.history);
  const second = insertBackfilledPhases(persisted, batch);
  assert.equal(second.ok, true, JSON.stringify(second.reasons));
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.skipped.sort(), [
    `blueprint${SEP}sha-blueprint`, `execute${SEP}sha-execute`, `ship${SEP}sha-ship`,
  ].sort());
  // Deep-equal to the persisted history INCLUDING every recordedAt — only sound
  // because timestamps are minted once (BP-6) and the claim excludes them (R3-2).
  assert.deepEqual(second.history, first.history);
  for (const e of second.history) {
    if (normaliseOrigin(e) === 'backfill') assert.equal(e.recordedAt, NOW);
  }

  const moved = [
    batch[0],
    occ('execute', '2026-07-02T00:00:00.000Z'),
    batch[2],
  ];
  const third = insertBackfilledPhases(persisted, moved);
  assert.equal(third.ok, false);
  assert.match(third.reasons.join(' '), /already recorded with other evidence/);
});

test('H7 — a future-dated commit sorts AFTER the terminal, so the batch refuses at history', () => {
  const item = itemWith([live('explore_design', '2026-09-01T00:00:00.000Z')]);

  // Nothing forbids a future VALID time on its own: without the terminal
  // occurrence the merge is clean and `execute` simply lands last.
  const alone = insertBackfilledPhases(item, [occ('execute', '2027-01-01T00:00:00.000Z')]);
  assert.equal(alone.ok, true, JSON.stringify(alone.reasons));
  assert.equal(alone.history[alone.history.length - 1].phase, 'execute');

  // With the terminal occurrence — which is what §5.5 actually validates — the
  // future-dated commit sorts after it, leaving `complete_backfilled -> execute`
  // as a consecutive pair inside episode 2. The batch refuses.
  //
  // DIVERGENCE from blueprint §4.2 H7: the blueprint predicts the merge SUCCEEDS
  // and that §5.5 step 5's "last entry is not complete_backfilled" check produces
  // the refusal. Step 4e fires first, because `complete_backfilled` is not a node
  // of the forward graph and the pair's TARGET (`execute`) selects fwdGraph
  // (R2B-1). Both land on `refusedAt: 'history'`, which is what R13 requires;
  // only the message differs. Step 5 is kept as the belt-and-braces check.
  const res = insertBackfilledPhases(item, [
    occ('execute', '2027-01-01T00:00:00.000Z'),
    terminal('explore_design'),
  ]);
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /complete_backfilled -> execute is not reachable in build/);
});

// ---------------------------------------------------------------------------
// The remaining §4.1 refusals, and the step-3a dedup R3-5 turns on.
// ---------------------------------------------------------------------------

test('an occurrence at exactly lifecycle.startedAt refuses (4b, anchored to startedAt)', () => {
  // The stored genesis deliberately does NOT sit on startedAt — the reconciler
  // recreates a missing first live entry with the CURRENT time (R3-4), so 4b is
  // anchored to the instant, not to any occurrence. Keeping it off startedAt also
  // keeps 4a (the tie rule) from firing first and masking this refusal.
  const item = itemWith([live('explore_design', '2026-09-02T00:00:00.000Z')]);
  const res = insertBackfilledPhases(item, [occ('blueprint', '2026-09-01T00:00:00.000Z')]);
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /adoption instant is ambiguously placed/);
});

test('an occurrence strictly inside a CLOSED live interval refuses', () => {
  const item = itemWith([
    live('explore_design', '2026-09-01T00:00:00.000Z', { exitedAt: '2026-09-05T00:00:00.000Z' }),
    live('blueprint', '2026-09-05T00:00:00.000Z'),
  ]);
  const res = insertBackfilledPhases(item, [occ('prd', '2026-09-03T00:00:00.000Z')]);
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /falls inside the closed live interval explore_design/);
});

test('R3-5: an already-persisted terminal is deduped by operation_id, not by claim', () => {
  const item = itemWith([live('explore_design', '2026-09-01T00:00:00.000Z')]);
  const t = terminal('explore_design', '2026-09-10T00:00:00.000Z', 'op-abc');
  const first = insertBackfilledPhases(item, [occ('ship', '2026-09-05T00:00:00.000Z'), t]);
  assert.equal(first.ok, true, JSON.stringify(first.reasons));

  // Re-run the merge after step 6.0 already persisted the terminal. Its origin
  // is 'live', so the claim index cannot match it and — without step 3a — the
  // tie check would fire and EVERY ordinary recovery would refuse at `history`.
  const persisted = itemWith(first.history);
  const again = insertBackfilledPhases(persisted, [occ('ship', '2026-09-05T00:00:00.000Z'), t]);
  assert.equal(again.ok, true, JSON.stringify(again.reasons));
  assert.deepEqual(again.written, []);
  assert.ok(again.skipped.includes(`complete_backfilled${SEP}sha-terminal`));
  assert.equal(again.history.filter((e) => e.operation_id != null).length, 1);
});

test('R3-5: a stored entry under our operation id with a different enteredAt refuses', () => {
  const t = terminal('explore_design', '2026-09-10T00:00:00.000Z', 'op-abc');
  const stored = { ...t, enteredAt: '2026-09-09T00:00:00.000Z', timestamp: '2026-09-09T00:00:00.000Z' };
  const item = itemWith([live('explore_design', '2026-09-01T00:00:00.000Z'), stored]);
  const res = insertBackfilledPhases(item, [t]);
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /already stored with different immutable fields/);
});

test('unparseable instants refuse before anything else', () => {
  assert.equal(insertBackfilledPhases(itemWith([], { startedAt: 'nope' }), []).ok, false);
  const item = itemWith([live('explore_design', '2026-09-01T00:00:00.000Z')]);
  const bad = occ('ship', '2026-09-05T00:00:00.000Z');
  bad.evidence.observedEpochMs = NaN;
  const res = insertBackfilledPhases(item, [bad]);
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /unparseable evidence time/);
});

test('BP-8: an offset-bearing author date orders by INSTANT, not by string', () => {
  // "2026-06-01T00:00:00+02:00" sorts AFTER "…Z" as a string and BEFORE it as an
  // instant. If any comparison were lexical this would come out in the wrong order.
  const item = itemWith([live('explore_design', '2026-09-01T00:00:00.000Z')]);
  const offset = '2026-06-01T05:00:00+02:00';   // = 03:00Z
  const utc = '2026-06-01T04:00:00.000Z';
  // Lexically the offset form sorts LATER; as an instant it is EARLIER.
  assert.ok(offset > utc, 'string order');
  assert.ok(Date.parse(offset) < Date.parse(utc), 'instant order');

  const res = insertBackfilledPhases(item, [occ('blueprint', offset), occ('execute', utc)]);
  assert.equal(res.ok, true, JSON.stringify(res.reasons));
  assert.deepEqual(res.history.map((e) => e.phase), ['blueprint', 'execute', 'explore_design']);
});

test('appendPhaseHistory stamps live provenance, and normaliseOrigin reads absence as live', () => {
  const item = { lifecycle: { phaseHistory: [] } };
  appendPhaseHistory(item, { from: null, to: 'explore_design', outcome: null, timestamp: NOW });
  const [entry] = item.lifecycle.phaseHistory;
  assert.equal(entry.origin, 'live');
  assert.equal(entry.confidence, 1.0);
  assert.equal(entry.recordedAt, NOW);
  assert.equal(normaliseOrigin({}), 'live');
  assert.equal(normaliseOrigin({ origin: 'backfill' }), 'backfill');
  assert.equal(occurrenceKey({ phase: 'p', evidence: { ref: 'r' } }), `p${SEP}r`);
});
