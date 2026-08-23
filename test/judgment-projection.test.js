/**
 * test/judgment-projection.test.js — GOV-COMPOSE-SEAM-1 step 1 P4.
 *
 * D1 says SmartMemory owns the canon and `docs/judgment/LEDGER.md` is a
 * generated projection. That claim is only true if a decision can be turned
 * back into the ledger event the generator renders. These tests assert it
 * against THIS repo's real ledger, through the real renderer — not a fixture
 * and not a reimplementation of the rendering rules, because a mirror of
 * EVENT_DETAIL_KEYS would drift silently the moment the renderer changed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateFromRecords, loadSnapshot } from '../lib/judgment-gen.js';
import {
  DECISION_KINDS,
  decisionToLedgerEntry,
  ledgerEntryToDecision,
} from '../lib/judgment-decisions.js';

const LEDGER_REL = 'docs/judgment/LEDGER.md';

function realSnapshot() {
  return loadSnapshot(process.cwd());
}

/** Round-trip every decision-shaped event; pass the rest through untouched. */
function reconstructedLedger(snapshot) {
  return snapshot.ledger.map((event, i) => {
    if (!DECISION_KINDS.has(event.kind)) return event;
    const decision = ledgerEntryToDecision(event, i + 1);
    const back = decisionToLedgerEntry(decision);
    assert.ok(back, `seq ${i + 1} did not map back to a ledger entry`);
    assert.equal(back.seq, i + 1, 'the sequence number survives the round trip');
    return back.entry;
  });
}

test('LEDGER.md is byte-identical when every decision is rebuilt from its decision record', () => {
  const snapshot = realSnapshot();
  const decisions = snapshot.ledger.filter((e) => DECISION_KINDS.has(e.kind));
  assert.ok(decisions.length > 0, 'this repo has decision-shaped ledger entries to test');

  const want = generateFromRecords(snapshot)[LEDGER_REL];
  const got = generateFromRecords({ ...snapshot, ledger: reconstructedLedger(snapshot) })[LEDGER_REL];

  assert.equal(got, want, 'the projection must not change when decisions are the source');
});

test('refs survive the round trip — they RENDER, so dropping them broke the projection', () => {
  const snapshot = realSnapshot();
  const withRefs = snapshot.ledger
    .map((e, i) => ({ e, seq: i + 1 }))
    .filter(({ e }) => DECISION_KINDS.has(e.kind) && Array.isArray(e.refs) && e.refs.length);
  assert.ok(withRefs.length > 0, 'this repo has decisions carrying refs');

  for (const { e, seq } of withRefs) {
    const back = decisionToLedgerEntry(ledgerEntryToDecision(e, seq));
    assert.deepEqual(back.entry.refs, e.refs, `seq ${seq} lost its refs`);
  }
});

test('rejected alternatives survive structurally — the flattened string cannot be split back', () => {
  const snapshot = realSnapshot();
  const rejecting = snapshot.ledger
    .map((e, i) => ({ e, seq: i + 1 }))
    .filter(({ e }) => DECISION_KINDS.has(e.kind) && Array.isArray(e.rejected) && e.rejected.length);
  assert.ok(rejecting.length > 0, 'this repo has decisions with rejected alternatives');

  // At least one `what` contains the very separator flattenRejected joins on —
  // that is the case a split-based inverse gets wrong, and the reason the
  // structured list travels in context_snapshot.
  const ambiguous = rejecting.filter(({ e }) => e.rejected.some((r) => (r?.what ?? '').includes(' — ')));
  assert.ok(ambiguous.length > 0, 'the ambiguous case is present in the real ledger');

  for (const { e, seq } of rejecting) {
    const back = decisionToLedgerEntry(ledgerEntryToDecision(e, seq));
    assert.deepEqual(back.entry.rejected, e.rejected, `seq ${seq} lost its rejected alternatives`);
  }
});

test('a non-decision kind maps back to nothing — D3, not an oversight', () => {
  assert.equal(decisionToLedgerEntry({ context_snapshot: { ledger_kind: 'note' } }), null);
  assert.equal(decisionToLedgerEntry({ context_snapshot: {} }), null);
  assert.equal(decisionToLedgerEntry({}), null);
  assert.equal(decisionToLedgerEntry(null), null);
});

test('the projection is NOT complete from decisions alone, and the gap is measurable', () => {
  const snapshot = realSnapshot();
  const total = snapshot.ledger.length;
  const fromDecisions = snapshot.ledger.filter((e) => DECISION_KINDS.has(e.kind)).length;

  // Recorded as a test rather than prose so the day someone migrates the other
  // kinds, this fails and says so instead of the claim quietly going stale.
  assert.ok(
    fromDecisions < total,
    'if every ledger kind is now a decision, P4 can claim whole-file regeneration — update this',
  );
});
