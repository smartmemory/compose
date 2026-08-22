/**
 * test/judgment-decisions.test.js — GOV-COMPOSE-SEAM-1 step 1 P1.
 *
 * Asserts the D3 kind mapping, the D4 inferred-vs-stated separation (which is
 * an acceptance criterion, not a convention), the D5 three-signal classifier,
 * and the idempotency key the backfill will rely on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIDENCE,
  CONFIDENCE_UNSTATED,
  applyConvictionReview,
  applyReviewFile,
  classifyEnforceable,
  decideSubtype,
  ledgerEntryToDecision,
  mapLedger,
  splitTitle,
  stableEntryKey,
} from '../lib/judgment-decisions.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function entry(over = {}) {
  return {
    kind: 'decide',
    title: 'some-slug — a statement of what was decided',
    body: 'because of a reason',
    provenance: { actor: 'agent', written_at: '2026-07-20T12:00:00Z', via: 'import' },
    ...over,
  };
}

// ── D3: which kinds become decisions ──────────────────────────────────────

test('D3: decide/kill/open/correct map to decisions', () => {
  for (const kind of ['decide', 'kill', 'open', 'correct']) {
    assert.ok(ledgerEntryToDecision(entry({ kind }), 1), `${kind} should map`);
  }
});

test('D3: note/escalate/override/attest/calibrate are not decisions', () => {
  for (const kind of ['note', 'escalate', 'override', 'attest', 'calibrate']) {
    assert.equal(ledgerEntryToDecision(entry({ kind }), 1), null, `${kind} must not map`);
  }
});

test('D3: a kill stays active and records the killed option as rejected', () => {
  const d = ledgerEntryToDecision(entry({
    kind: 'kill',
    title: 'exhaust-as-idea-source — build exhaust as the source of ideas',
    reason: 'closed loop',
  }), 5);
  // Not `abandoned`: a kill is a live decision NOT to do something.
  assert.equal(d.status, 'active');
  assert.match(d.content, /^Do not: build exhaust/);
  // `rejected_alternatives` is array<string> on the wire (service
  // CreateDecisionRequest) — the reason is flattened into the same string
  // rather than dropped, because a rejected option without its reason is the
  // least useful half.
  assert.equal(
    d.rejected_alternatives[0],
    'build exhaust as the source of ideas — closed loop',
  );
  assert.ok(d.rejected_alternatives.every((r) => typeof r === 'string'));
});

test('D3: an open entry is a pending decision', () => {
  assert.equal(ledgerEntryToDecision(entry({ kind: 'open' }), 1).status, 'pending');
});

test('D3: a correct entry carries the slug it supersedes', () => {
  const d = ledgerEntryToDecision(entry({ kind: 'correct', title: 'foo-bar — restated' }), 1);
  assert.equal(d.supersedes_slug, 'foo-bar');
});

test('D3: policy vs choice splits on forward-going language only', () => {
  assert.equal(decideSubtype(entry({ body: 'every new route must carry a delegate' })), 'policy');
  assert.equal(decideSubtype(entry({ body: 'we picked FalkorDB over Neo4j' })), 'choice');
});

// ── D4: inferred convictions must not read as stated ──────────────────────

test('D4: an inferred conviction is distinguishable from a stated one', () => {
  const inferred = ledgerEntryToDecision(entry({ conviction: { level: 'high', source: 'inferred' } }), 1);
  const stated = ledgerEntryToDecision(entry({ conviction: { level: 'high', source: 'stated' } }), 1);

  assert.notEqual(inferred.confidence, stated.confidence);
  assert.equal(inferred.source_type, 'inferred');
  assert.equal(stated.source_type, 'explicit');
  assert.equal(inferred.context_snapshot.conviction_review_required, true);
  assert.equal(stated.context_snapshot.conviction_review_required, false);
});

test('D4: an inferred high ranks below a stated medium', () => {
  // Deliberate: better to act on something the owner actually said with
  // middling conviction than on something we decided he probably meant.
  assert.ok(CONFIDENCE.inferred.high < CONFIDENCE.stated.medium);
});

test('D4: a decision-shaped entry with no conviction needs no review', () => {
  const d = ledgerEntryToDecision(entry({ conviction: undefined }), 1);
  assert.equal(d.confidence, CONFIDENCE_UNSTATED);
  assert.equal(d.source_type, 'imported');
  assert.equal(d.context_snapshot.conviction_review_required, false);
});

// ── D5: the enforceability classifier proposes, it never counts ───────────

test('D5: all three signals are required for a candidate', () => {
  const yes = classifyEnforceable(entry({
    title: 'x — every review step must show a passing test count before merge',
    body: '',
  }));
  assert.equal(yes.verdict, 'candidate');
  assert.deepEqual(yes.signals, { namesStep: true, namesObservable: true, violable: true });

  // Names a step but no observable.
  const noObs = classifyEnforceable(entry({ title: 'x — reviews happen sooner', body: '' }));
  assert.equal(noObs.signals.namesObservable, false);
  assert.equal(noObs.verdict, 'historical');
});

test('D5: a claim true by construction is not violable', () => {
  const c = classifyEnforceable(entry({
    title: 'x — the product is a testable ledger of commits',
    body: '',
  }));
  assert.equal(c.signals.violable, false);
  assert.equal(c.verdict, 'historical');
});

test('D5: a candidate is never pre-adjudicated', () => {
  assert.equal(classifyEnforceable(entry()).adjudicated, null);
});

// ── identity ──────────────────────────────────────────────────────────────

test('stableEntryKey is deterministic and content-sensitive', () => {
  const e = entry();
  assert.equal(stableEntryKey(e, 3), stableEntryKey(e, 3));
  assert.notEqual(stableEntryKey(e, 3), stableEntryKey(e, 4));
  assert.notEqual(stableEntryKey(e, 3), stableEntryKey(entry({ title: 'other — thing' }), 3));
});

test('splitTitle handles a title with no slug separator', () => {
  assert.deepEqual(splitTitle('just a statement'), { slug: null, statement: 'just a statement' });
});

// ── the real ledger (this is the spike's denominator) ─────────────────────

test('the committed ledger maps to 43 decision-shaped entries, 15 needing review', () => {
  const events = readFileSync(join(repoRoot, 'docs/judgment/records/ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { decisions, skipped } = mapLedger(events);

  assert.equal(decisions.length + skipped.length, events.length, 'every entry is accounted for');
  assert.equal(decisions.length, 43, 'the spike denominator is 43, not 116');

  const inferred = decisions.filter((d) => d.decision.context_snapshot.conviction_review_required);
  assert.equal(inferred.length, 15, 'P2.5 review batch is 15 entries');
});

// ── P2.5: the owner's inferred-conviction review gate (D4) ────────────────

function inferredDecision(level = 'high') {
  return ledgerEntryToDecision(entry({ conviction: { level, source: 'inferred' } }), 7);
}

test('P2.5: an unreviewed inferred conviction REFUSES, it does not warn', () => {
  assert.throws(
    () => applyConvictionReview(inferredDecision(), undefined),
    /no owner verdict/,
    'the gate must throw — a warning in a backfill log is not a gate',
  );
});

test('P2.5: an unrecognised verdict also refuses', () => {
  assert.throws(() => applyConvictionReview(inferredDecision(), { verdict: 'looks-fine' }), /no owner verdict/);
});

test('P2.5 group A: promoted reaches the stated scale and explicit source', () => {
  const d = applyConvictionReview(inferredDecision('high'), { group: 'A', verdict: 'promoted' });
  assert.equal(d.confidence, CONFIDENCE.stated.high);
  assert.equal(d.source_type, 'explicit');
  assert.equal(d.context_snapshot.conviction_review_required, false);
});

test('P2.5 group B: the choice is kept, the guessed strength is dropped', () => {
  const d = applyConvictionReview(inferredDecision('high'), {
    group: 'B', verdict: 'choice_kept_strength_dropped',
  });
  // The owner made the decision, so the source is explicit...
  assert.equal(d.source_type, 'explicit');
  // ...but the agent's reading of how firmly is discarded.
  assert.equal(d.confidence, CONFIDENCE_UNSTATED);
  assert.equal(d.context_snapshot.conviction_strength_dropped, true);
  assert.ok(d.confidence < CONFIDENCE.stated.high, 'a dropped strength must not survive as a stated high');
});

test('P2.5 group C: unrated is marked, and may not back an enforceable rule', () => {
  const d = applyConvictionReview(inferredDecision('high'), { group: 'C', verdict: 'unrated' });
  assert.equal(d.source_type, 'inferred');
  assert.equal(d.context_snapshot.conviction_unrated, true);
  assert.equal(d.context_snapshot.enforceable_eligible, false);
  // Decision.confidence is a non-optional float upstream, so "unrated" cannot
  // be null. The marker is what downstream branches on, never the number.
  assert.equal(d.confidence, CONFIDENCE_UNSTATED);
});

test('P2.5: a stated conviction is untouched by the gate', () => {
  const d = ledgerEntryToDecision(entry({ conviction: { level: 'high', source: 'stated' } }), 7);
  const out = applyConvictionReview(d, undefined);
  assert.equal(out.confidence, CONFIDENCE.stated.high, 'no verdict needed, and none applied');
});

test('P2.5: the committed verdict file rules on every inferred entry', () => {
  const review = JSON.parse(readFileSync(
    join(repoRoot, 'docs/features/GOV-COMPOSE-SEAM-1/conviction-review.json'), 'utf8',
  ));
  const events = readFileSync(join(repoRoot, 'docs/judgment/records/ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const mapped = mapLedger(events);

  // Throws if any inferred entry is missing a verdict — this is the gate.
  applyReviewFile(mapped, review);

  const snaps = mapped.decisions.map((d) => d.decision.context_snapshot);
  assert.equal(snaps.filter((s) => s.conviction_review_required).length, 0, 'no entry left unreviewed');
  assert.equal(snaps.filter((s) => s.conviction_review?.group === 'A').length, 4);
  assert.equal(snaps.filter((s) => s.conviction_review?.group === 'B').length, 7);
  assert.equal(snaps.filter((s) => s.conviction_review?.group === 'C').length, 4);
});
