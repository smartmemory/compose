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
  assert.equal(d.rejected_alternatives[0].option, 'build exhaust as the source of ideas');
  assert.equal(d.rejected_alternatives[0].reason, 'closed loop');
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
