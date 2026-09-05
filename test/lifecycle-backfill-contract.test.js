/**
 * test/lifecycle-backfill-contract.test.js — COMP-LIFECYCLE-BACKFILL blueprint §2.
 *
 * The load-bearing test is R3-3: an intent whose `write_plan.history[0]` is the
 * LITERAL record `appendPhaseHistory` produces for a lifecycle start must
 * validate. The first draft's schema required `BackfilledOccurrence` of every
 * history entry, so no item that had ever run a lifecycle could produce a valid
 * intent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SchemaValidator } from '../server/schema-validator.js';
import { appendPhaseHistory } from '../server/lifecycle-phase-history.js';
import { CONFIDENCE_BY_KIND } from '../lib/backfill-evidence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, '..', 'contracts', 'lifecycle-backfill.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// The PRODUCTION validator, not a privately configured Ajv (Codex r2 #1). The
// round-1 fix pinned expected_policy_checksum with an Ajv `$data` reference and
// then tested it through a local instance built with `{$data:true}`; the shared
// validator had no such option, so in production the `$data` object was compared
// as a LITERAL and the schema rejected every intent, valid ones included. Using
// the real validator here is what makes that class of gap visible.
const validators = new SchemaValidator(SCHEMA_PATH);

/** A boolean validator for one definition, carrying its own error explainer. */
function validator(def) {
  const fn = (doc) => validators.validate(def, doc).valid;
  fn.why = (doc) => JSON.stringify(validators.validate(def, doc).errors);
  return fn;
}

const OP = '11111111-2222-4333-8444-555555555555';
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const CHECKSUM = 'c'.repeat(64);

/**
 * The literal record ALREADY ON DISK for a lifecycle start (R3-3). Taken from a
 * real store rather than from `appendPhaseHistory`, because the writer gains
 * `recordedAt`/`origin`/`confidence` on NEW writes (design.md:475) while nothing
 * migrates the records written before it did — and those are exactly the records
 * `write_plan.history` has to accept.
 */
function genesisRecord(timestamp = '2026-09-01T00:00:00.000Z') {
  return {
    phase: 'explore_design',
    step: 'explore_design',
    enteredAt: timestamp,
    exitedAt: null,
    from: null,
    to: 'explore_design',
    outcome: null,
    timestamp,
  };
}

/** What `appendPhaseHistory` writes TODAY, for the same lifecycle start. */
function liveGenesisRecord(timestamp = '2026-09-01T00:00:00.000Z') {
  const item = { lifecycle: { phaseHistory: [] } };
  appendPhaseHistory(item, { from: null, to: 'explore_design', outcome: null, timestamp });
  return item.lifecycle.phaseHistory[0];
}

function backfilledOccurrence(over = {}) {
  return {
    phase: 'blueprint',
    step: 'blueprint',
    enteredAt: '2026-06-01T00:00:00.000Z',
    exitedAt: '2026-07-01T00:00:00.000Z',
    from: null,
    to: 'blueprint',
    outcome: 'backfilled',
    timestamp: '2026-06-01T00:00:00.000Z',
    recordedAt: '2026-09-05T00:00:00.000Z',
    origin: 'backfill',
    confidence: 0.9,
    episode: 1,
    evidence: {
      kind: 'commit',
      ref: SHA,
      verifiedAt: '2026-09-05T00:00:00.000Z',
      observedTime: '2026-06-01T00:00:00.000Z',
      observedEpochMs: Date.parse('2026-06-01T00:00:00.000Z'),
    },
    ...over,
  };
}

function terminalOccurrence() {
  return backfilledOccurrence({
    phase: 'complete_backfilled',
    step: 'complete_backfilled',
    to: 'complete_backfilled',
    from: 'ship',
    enteredAt: '2026-09-05T00:00:00.000Z',
    timestamp: '2026-09-05T00:00:00.000Z',
    exitedAt: null,
    origin: 'live',
    confidence: 1.0,
    episode: 2,
    operation_id: OP,
    evidence: {
      kind: 'commit',
      ref: SHA,
      verifiedAt: '2026-09-05T00:00:00.000Z',
      observedTime: '2026-09-05T00:00:00.000Z',
      observedEpochMs: Date.parse('2026-09-05T00:00:00.000Z'),
    },
  });
}

function intent(over = {}) {
  return {
    operation_id: OP,
    feature_code: 'BF-1',
    mode: 'build',
    intent: 'backfill',
    request_digest: DIGEST,
    reason: 'built before the lifecycle existed',
    commit_sha: SHA,
    files_changed: ['lib/a.js'],
    notes: null,
    tests_attested: true,
    started_at: '2026-09-05T00:00:00.000Z',
    guarded: true,
    occurrences: [backfilledOccurrence()],
    terminal_occurrence: terminalOccurrence(),
    write_plan: {
      history: [genesisRecord(), backfilledOccurrence(), terminalOccurrence()],
      written: ['blueprint\u001f' + SHA],
      skipped: [],
    },
    guard_initial: null,
    upgrade: null,
    policy_checksum: CHECKSUM,
    envelope: {
      from: 'ship',
      to: 'complete_backfilled',
      artifacts: { operation_id: OP },
      modified_files: [],
      resolved_by: 'agent',
      idempotency_key: OP,
      expected_policy_checksum: CHECKSUM,
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------

test('R3-3: an intent whose write_plan.history[0] is the LITERAL stored genesis record validates', () => {
  const genesis = genesisRecord();
  assert.deepEqual(Object.keys(genesis).sort(), [
    'enteredAt', 'exitedAt', 'from', 'outcome', 'phase', 'step', 'timestamp', 'to',
  ]);
  for (const absent of ['origin', 'recordedAt', 'confidence', 'episode', 'evidence']) {
    assert.equal(genesis[absent], undefined, `stored records carry no ${absent}`);
  }

  const validate = validator('BackfillIntent');
  assert.equal(validate(intent()), true, validate.why(intent()));
});

test('a live record written by appendPhaseHistory TODAY also validates in write_plan.history', () => {
  const live = liveGenesisRecord();
  assert.equal(live.origin, 'live');
  assert.equal(live.confidence, 1.0);
  assert.equal(live.recordedAt, live.enteredAt);

  const stored = validator('StoredHistoryEntry');
  assert.equal(stored(live), true, stored.why(live));

  const validate = validator('BackfillIntent');
  const doc = intent();
  doc.write_plan.history[0] = live;
  assert.equal(validate(doc), true, validate.why(doc));
});

test('the same history array validates its backfilled and terminal entries', () => {
  const validate = validator('BackfilledOccurrence');
  assert.equal(validate(backfilledOccurrence()), true, validate.why(backfilledOccurrence()));
  assert.equal(validate(terminalOccurrence()), true, validate.why(terminalOccurrence()));

  const stored = validator('StoredHistoryEntry');
  // A backfilled entry satisfies BOTH branches by construction — this is why the
  // union is anyOf and not oneOf.
  assert.equal(stored(backfilledOccurrence()), true, stored.why(backfilledOccurrence()));
  assert.equal(stored(genesisRecord()), true, stored.why(genesisRecord()));
});

test('an entry with an unknown property is rejected under BOTH union branches', () => {
  const validate = validator('BackfillIntent');
  const doc = intent();
  doc.write_plan.history.push({ ...genesisRecord(), surprise: 1 });
  assert.equal(validate(doc), false);

  const occ = validator('BackfilledOccurrence');
  assert.equal(occ({ ...backfilledOccurrence(), surprise: 1 }), false);
  const stored = validator('StoredHistoryEntry');
  assert.equal(stored({ ...genesisRecord(), surprise: 1 }), false);
});

test('occurrences and terminal_occurrence still require the FULL BackfilledOccurrence', () => {
  const validate = validator('BackfillIntent');
  assert.equal(validate(intent({ occurrences: [genesisRecord()] })), false);
  assert.equal(validate(intent({ terminal_occurrence: genesisRecord() })), false);
});

test('R3-4: notes, guard_initial, upgrade and policy_checksum are REQUIRED though nullable', () => {
  const validate = validator('BackfillIntent');
  for (const field of ['notes', 'guard_initial', 'upgrade', 'policy_checksum']) {
    const doc = intent();
    delete doc[field];
    assert.equal(validate(doc), false, `${field} must be required`);
  }
  // …and null is accepted for each. `policy_checksum` is nullable only on an
  // UNGUARDED intent, which is the only operation that has no policy to pin.
  assert.equal(
    validate(intent({ notes: null, guard_initial: null, upgrade: null })),
    true,
    'schema validation failed',
  );
  const unguarded = intent({
    notes: null, guard_initial: null, upgrade: null, guarded: false, policy_checksum: null,
  });
  delete unguarded.envelope.expected_policy_checksum;
  assert.equal(validate(unguarded), true, validate.why(unguarded));
});

test('R4-1: the PRODUCTION validator rejects every guarded intent whose checksums do not line up', () => {
  const validate = validator('BackfillIntent');

  // A guarded intent with the envelope key missing.
  const missing = intent();
  delete missing.envelope.expected_policy_checksum;
  assert.equal(validate(missing), false, 'a guarded intent must carry expected_policy_checksum');

  // A guarded intent whose two checksums DISAGREE.
  const disagreeing = intent();
  disagreeing.envelope.expected_policy_checksum = 'd'.repeat(64);
  assert.equal(validate(disagreeing), false, 'the two checksums must be equal');

  // A guarded intent with a NULL policy_checksum.
  const nulled = intent({ policy_checksum: null });
  assert.equal(validate(nulled), false, 'a guarded intent may not have a null policy_checksum');

  // …and the well-formed guarded intent still validates.
  assert.equal(validate(intent()), true, validate.why(intent()));

  // An UNGUARDED intent legitimately carries neither…
  const unguarded = intent({ guarded: false, policy_checksum: null });
  delete unguarded.envelope.expected_policy_checksum;
  assert.equal(validate(unguarded), true, validate.why(unguarded));
  // …and may not smuggle one in.
  const smuggled = intent({ guarded: false, policy_checksum: null });
  assert.equal(validate(smuggled), false, 'an unguarded intent may not pin a policy');
});

test('BackfillRequest rejects a caller-supplied confidence and a non-hex commit_sha', () => {
  const validate = validator('BackfillRequest');
  const base = {
    feature_code: 'BF-1', commit_sha: SHA, tests_pass: true,
    files_changed: [], reason: 'why',
    occurrences: [{ phase: 'blueprint', evidence: { kind: 'commit', ref: SHA } }],
  };
  assert.equal(validate(base), true, validate.why(base));
  assert.equal(validate({ ...base, confidence: 0.99 }), false);
  assert.equal(validate({ ...base, commit_sha: 'nope' }), false);
  assert.equal(validate({ ...base, reason: '' }), false);
  // Occurrence evidence may not carry a confidence either.
  assert.equal(validate({
    ...base,
    occurrences: [{ phase: 'blueprint', evidence: { kind: 'commit', ref: SHA, confidence: 0.9 } }],
  }), false);
});

test('BackfillRecord: state is pending|finalized and occurrenceKeys use UNIT SEPARATOR', () => {
  const validate = validator('BackfillRecord');
  const rec = {
    operation_id: OP, request_digest: DIGEST, state: 'pending', reason: 'why',
    recordedAt: '2026-09-05T00:00:00.000Z',
    completionEvidence: { commit_sha: SHA, tests_attested: true, verified_at: '2026-09-05T00:00:00.000Z' },
    guardRef: null, guard_initial: null, upgrade: null,
    actor: 'agent:rest',
    occurrenceKeys: [`blueprint\u001f${SHA}`],
  };
  assert.equal(validate(rec), true, validate.why(rec));
  assert.equal(validate({ ...rec, state: 'done' }), false);
  assert.ok(!rec.occurrenceKeys[0].includes('\u0000'), 'never a NUL byte — it breaks grep');
  assert.equal(validate({
    ...rec, upgrade: { descriptor_id: 'backfill-build-abc123', status: 'applied', ledger_ref: null },
  }), true, validate.why({
    ...rec, upgrade: { descriptor_id: 'backfill-build-abc123', status: 'applied', ledger_ref: null },
  }));
  assert.equal(validate({ ...rec, upgrade: { descriptor_id: 'x', status: 'migrated' } }), false);
});

test('the confidence table lives in exactly one place', () => {
  assert.deepEqual({ ...CONFIDENCE_BY_KIND }, { commit: 0.9, path: 0.6 });
  assert.ok(Object.isFrozen(CONFIDENCE_BY_KIND));
  const validate = validator('BackfilledOccurrence');
  for (const value of Object.values(CONFIDENCE_BY_KIND)) {
    assert.equal(validate(backfilledOccurrence({ confidence: value })), true);
  }
  assert.equal(validate(backfilledOccurrence({ confidence: 1.0 })), true, 'live is 1.0');
  assert.equal(validate(backfilledOccurrence({ confidence: 1.5 })), false);
});
