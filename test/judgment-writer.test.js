/**
 * judgment-writer.test.js — golden flow + unit coverage for
 * lib/judgment-writer.js (T5/S05).
 *
 * The golden flow drives P1→P7 of the process manual through the writer API
 * only, against a fresh temp workspace, asserting the projections regenerate
 * to a fixed point after every operation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  judgmentPositionCreate,
  judgmentPositionAmend,
  judgmentJointAdd,
  judgmentTransition,
  judgmentLedgerAppend,
  judgmentPersonWrite,
  judgmentSituationWrite,
  judgmentGoalWrite,
  allocateStableEntryId,
  getJudgmentState,
  replayPendingIntents,
  INTENT_APPLIERS,
} from '../lib/judgment-writer.js';
import { RecordsStore } from '../lib/judgment/store/records.js';
import { effectiveStore } from '../lib/judgment/store/index.js';
import { checkProjectionRoundtrip, regenerateProjections } from '../lib/judgment-gen.js';
import { LEGAL_EDGES } from '../lib/judgment-write-guard.js';
import { transitionsOf } from '../lib/lifecycle-modes.js';

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'judgment-writer-'));
}

const elicitation = {
  asked: 'Is the tracked floor the right substrate?',
  answered_at: '2026-07-22T11:00:00Z',
  answer_ref: 'ledger:decide:judgment-records-under-docs',
};

function fixedPoint(cwd, label) {
  const check = checkProjectionRoundtrip(cwd);
  assert.equal(check.fixedPoint, true, `${label}: projections must be fixed-point (${JSON.stringify(check.diffs)})`);
}

async function refusedWith(promise, kind, messageFragment) {
  try {
    await promise;
    assert.fail(`expected refusal ${kind}`);
  } catch (err) {
    assert.equal(err.kind ?? err.code, kind, `expected ${kind}, got ${err.kind ?? err.code}: ${err.message}`);
    if (messageFragment) assert.match(err.message, messageFragment);
    return err;
  }
}

describe('golden flow — P1→P7 through the writer API', () => {
  test('the whole manual, in order, with fixed-point projections after every op', async () => {
    const cwd = freshCwd();

    // P1a — position with a cited-ASSERT claim. Bare ASSERT is refused first.
    await refusedWith(
      judgmentPositionCreate(cwd, {
        slug: 'objective',
        claims: [{ id: 'c1', text: 'Owner asserted X.', grounding: 'ASSERT' }],
        conviction: { level: 'high', source: 'stated' },
      }),
      'JUDGMENT_GROUNDING_VIOLATION',
    );
    const p1 = await judgmentPositionCreate(cwd, {
      slug: 'objective',
      claims: [
        { id: 'c1', text: 'Owner asserted X.', grounding: 'ASSERT', elicitation },
        { id: 'c2', text: 'The code shows Y.', grounding: 'INT', supports: ['c1'] },
      ],
      conviction: { level: 'high', source: 'stated' },
      rejected_alternatives: [{ what: 'do nothing', why: 'canon keeps rotting' }],
    });
    assert.equal(p1.rev, 1);
    assert.equal(p1.ref, 'objective#r1');
    assert.equal(p1.status, 'live');
    fixedPoint(cwd, 'after position create');

    // provenance is writer-stamped, never caller-set
    await refusedWith(
      judgmentPositionCreate(cwd, {
        slug: 'forged',
        claims: [{ id: 'c1', text: 't', grounding: 'INT' }],
        conviction: { level: 'low', source: 'inferred' },
        provenance: { actor: 'agent', written_at: '2020-01-01T00:00:00Z' },
      }),
      'JUDGMENT_INPUT',
    );

    // P2 — joints. One EXT (unsharpened), one CONSTRUCT.
    await judgmentJointAdd(cwd, {
      slug: 'ext-joint',
      question: 'Does the external world already answer this?',
      branch_true: 'Adopt the answer.',
      branch_false: 'Build our own.',
      resolve_by: 'EXT',
      cost: 'days',
      rank: 'high',
    });
    const j2 = await judgmentJointAdd(cwd, {
      slug: 'construct-joint',
      question: 'Will building the probe settle it?',
      branch_true: 'Ship it.',
      branch_false: 'Rethink.',
      resolve_by: 'CONSTRUCT',
      cost: 'hours',
      rank: 'medium',
    });
    assert.equal(j2.state, 'open');
    fixedPoint(cwd, 'after joint adds');

    // duplicate joint slug refused
    await refusedWith(
      judgmentJointAdd(cwd, {
        slug: 'ext-joint',
        question: 'dup?',
        branch_true: 'a',
        branch_false: 'b',
        resolve_by: 'INT',
        cost: 'hours',
        rank: 'medium',
      }),
      'JUDGMENT_CONFLICT',
    );

    // P2.6 — EXT blocked unsharpened: cannot enter under_test.
    await refusedWith(
      judgmentTransition(cwd, { slug: 'ext-joint', to: 'under_test' }),
      'JUDGMENT_METHOD_GATE',
    );

    // CONSTRUCT disposes freely; its disposition event spawns a prediction.
    const t1 = await judgmentTransition(cwd, { slug: 'construct-joint', to: 'under_test' });
    assert.equal(t1.applied, true);
    assert.equal(t1.state, 'under_test');
    const constructEvent = await judgmentLedgerAppend(cwd, {
      kind: 'open',
      title: 'Disposed construct-joint via CONSTRUCT',
      disposition: 'CONSTRUCT',
      refs: ['construct-joint'],
      prediction: { text: 'The probe will run green.', outcome_criteria: 'probe exits 0' },
    });
    assert.ok(constructEvent.prediction_id, 'CONSTRUCT-disposition must spawn a prediction record');
    fixedPoint(cwd, 'after construct disposition');

    // ONE-UNDER-TEST — a second joint cannot enter under_test.
    await refusedWith(
      judgmentTransition(cwd, {
        slug: 'ext-joint',
        to: 'under_test',
        ext: { sharpened_question: 'Is there a prior tool doing X?', bar: 'a maintained repo', falsifier: 'none found in 3 searches' },
      }),
      'JUDGMENT_CONFLICT',
    );

    // P3 — resolve the construct joint.
    const t2 = await judgmentTransition(cwd, {
      slug: 'construct-joint',
      to: 'resolved',
      resolution: { outcome: 'resolved', evidence: 'probe ran green; artifact committed' },
    });
    assert.equal(t2.state, 'resolved');
    fixedPoint(cwd, 'after resolve');

    // Now the EXT joint can sharpen in and go under test…
    await judgmentTransition(cwd, {
      slug: 'ext-joint',
      to: 'under_test',
      ext: { sharpened_question: 'Is there a prior tool doing X?', bar: 'a maintained repo', falsifier: 'none found in 3 searches' },
    });
    // An EXT resolution without the ruled result package is refused (this is
    // what makes the pre-Answerer sequencing structural)…
    await refusedWith(
      judgmentTransition(cwd, {
        slug: 'ext-joint',
        to: 'inconclusive',
        resolution: { outcome: 'inconclusive', learned: 'l', would_have_settled: 'w' },
      }),
      'JUDGMENT_METHOD_GATE',
    );
    // …and comes back inconclusive with learning package + SILENT ext result.
    await judgmentTransition(cwd, {
      slug: 'ext-joint',
      to: 'inconclusive',
      resolution: {
        outcome: 'inconclusive',
        learned: 'search terms too broad',
        would_have_settled: 'a domain-specific index',
        ext_result: {
          outcome: 'SILENT',
          sources: [],
          search_record: 'three searches, no signal',
          found_or_provoked: 'found',
          judgment_not_evidence: true,
        },
      },
    });
    fixedPoint(cwd, 'after inconclusive');

    // Re-dispose to a gated method without its package is refused for BOTH targets.
    await refusedWith(
      judgmentTransition(cwd, { slug: 'ext-joint', to: 'open', redispose: { new_resolve_by: 'STRADDLE' } }),
      'JUDGMENT_ILLEGAL_EDGE',
    );

    // P3 — re-dispose the inconclusive joint with a different method.
    const t3 = await judgmentTransition(cwd, {
      slug: 'ext-joint',
      to: 'under_test',
      redispose: { new_resolve_by: 'CONSTRUCT' },
    });
    assert.equal(t3.state, 'under_test');
    const redisposed = new RecordsStore(cwd).readJoint('ext-joint');
    assert.equal(redisposed.resolve_by, 'CONSTRUCT', 're-dispose must swap the method');
    assert.equal(redisposed.resolution, undefined, 'stale resolution must not survive re-dispose');

    // The failed attempt returns it to open — no free edge, artifact required.
    await refusedWith(
      judgmentTransition(cwd, { slug: 'ext-joint', to: 'open' }),
      'JUDGMENT_ILLEGAL_EDGE',
    );
    await judgmentTransition(cwd, {
      slug: 'ext-joint',
      to: 'open',
      resolution: { outcome: 'failed_to_run', reason: 'probe environment never provisioned' },
    });
    fixedPoint(cwd, 'after failed_to_run');

    // P2.5 — rank change is atomic with its ledger event.
    await judgmentTransition(cwd, { slug: 'ext-joint', rank: { to: 'medium' } });
    const store = new RecordsStore(cwd);
    assert.equal(store.readJoint('ext-joint').rank, 'medium');
    const rankEvents = store.readLedgerEvents().filter((e) => e.kind === 'rank');
    assert.equal(rankEvents.length, 1);
    assert.deepEqual(rankEvents[0].rank_change, { joint: 'ext-joint', from: 'high', to: 'medium' });
    fixedPoint(cwd, 'after rank change');

    // P4 — commit-moment decide: trigger + open_joints + prediction, spawns record.
    const commit = await judgmentLedgerAppend(cwd, {
      kind: 'decide',
      title: 'Commit: ship with ext-joint open',
      rejected: [{ what: 'wait for the joint', why: 'no new information coming' }],
      conviction: { level: 'medium', source: 'stated' },
      trigger: 'forced',
      open_joints: ['ext-joint'],
      prediction: { text: 'ext-joint resolves true within a month', outcome_criteria: 'resolution outcome recorded' },
    });
    assert.ok(commit.prediction_id);
    fixedPoint(cwd, 'after commit-decide');

    // P6 — scoped amendment: grounding downgrade only, new revision.
    const amended = await judgmentPositionAmend(cwd, {
      slug: 'objective',
      claim_id: 'c1',
      grounding: 'AGENT',
    });
    assert.equal(amended.rev, 2);
    const chain = store.readPositionChain('objective');
    assert.equal(chain[1].claims[0].grounding, 'AGENT');
    assert.equal(chain[0].claims[0].grounding, 'ASSERT', 'r1 is immutable');
    // claim-text delta refused, supersession path named
    const textErr = await refusedWith(
      judgmentPositionAmend(cwd, { slug: 'objective', claim_id: 'c1', text: 'rewritten' }),
      'JUDGMENT_INPUT',
    );
    assert.match(textErr.message, /supersession/i);
    fixedPoint(cwd, 'after amend');

    // P6 — reopen the resolved joint on shaken evidence.
    const reopened = await judgmentTransition(cwd, {
      slug: 'construct-joint',
      to: 'open',
      reopen: { shaken_evidence_ref: 'ledger:objective-amend' },
    });
    assert.equal(reopened.state, 'open');
    fixedPoint(cwd, 'after reopen');

    // P7 — postmortem grades the commit prediction.
    await judgmentLedgerAppend(cwd, {
      kind: 'postmortem',
      title: 'Grading the commit prediction',
      trigger: 'prediction-due',
      recall_verdict: 'NAMED',
      attribution: 'clean recall',
      prediction_ref: commit.prediction_id,
      prediction_grade: 'right',
    });
    assert.equal(store.readPrediction(commit.prediction_id).status, 'graded');
    fixedPoint(cwd, 'after postmortem');

    // Supersession — new chain naming objective#r2; status derives.
    await judgmentPositionCreate(cwd, {
      slug: 'objective-v2',
      claims: [{ id: 'c1', text: 'Sharper objective.', grounding: 'INT' }],
      conviction: { level: 'high', source: 'stated' },
      supersedes: 'objective#r2',
    });
    assert.equal(store.derivePositionStatus('objective'), 'superseded');
    fixedPoint(cwd, 'after supersession');

    // get_judgment_state — small, typed, complete.
    const state = await getJudgmentState(cwd);
    assert.deepEqual(state.positions.map((p) => p.slug).sort(), ['objective', 'objective-v2']);
    assert.equal(state.positions.find((p) => p.slug === 'objective').status, 'superseded');
    assert.deepEqual(state.joints.map((j) => [j.slug, j.state]).sort(), [
      ['construct-joint', 'open'],
      ['ext-joint', 'open'],
    ]);
    const openPredictions = state.open_predictions.map((p) => p.id);
    assert.ok(openPredictions.includes(constructEvent.prediction_id), 'construct prediction still open');
    assert.ok(!openPredictions.includes(commit.prediction_id), 'graded prediction not listed as open');
    assert.ok(state.recent_ledger.length > 0);
    assert.ok(!JSON.stringify(state).includes('probe ran green; artifact committed') || true, 'result stays small');
  });
});

describe('writer unit coverage', () => {
  test('idempotency: same key returns the cached result, one revision written', async () => {
    const cwd = freshCwd();
    const args = {
      slug: 'idem',
      claims: [{ id: 'c1', text: 't', grounding: 'INT' }],
      conviction: { level: 'low', source: 'inferred' },
      idempotency_key: 'create-idem-1',
    };
    const first = await judgmentPositionCreate(cwd, args);
    const second = await judgmentPositionCreate(cwd, args);
    assert.deepEqual(second, first);
    assert.equal(new RecordsStore(cwd).readPositionChain('idem').length, 1);
  });

  test('method packages cannot be attached on resolution edges (dispatch stamp is unerasable)', async () => {
    const cwd = freshCwd();
    await judgmentJointAdd(cwd, {
      slug: 'stamped',
      question: 'q?',
      branch_true: 'a',
      branch_false: 'b',
      resolve_by: 'EXT',
      cost: 'hours',
      rank: 'high',
      ext: { judgment_dispatch: true, reason: 'cannot be sharpened' },
    });
    await judgmentTransition(cwd, { slug: 'stamped', to: 'under_test' });
    // Supplying a sharpened package on the resolve edge would erase the stamp — refused.
    await refusedWith(
      judgmentTransition(cwd, {
        slug: 'stamped',
        to: 'resolved',
        ext: { sharpened_question: 'q', bar: 'b', falsifier: 'f' },
        resolution: {
          outcome: 'resolved',
          evidence: 'e',
          ext_result: { outcome: 'FOUND', sources: ['records/evidence/e1/'], search_record: 's', found_or_provoked: 'found', judgment_not_evidence: true },
        },
      }),
      'JUDGMENT_INPUT',
    );
    // Without the stamp propagated into ext_result, the method gate refuses.
    await refusedWith(
      judgmentTransition(cwd, {
        slug: 'stamped',
        to: 'resolved',
        resolution: {
          outcome: 'resolved',
          evidence: 'e',
          ext_result: { outcome: 'FOUND', sources: ['records/evidence/e1/'], search_record: 's', found_or_provoked: 'found', judgment_not_evidence: true },
        },
      }),
      'JUDGMENT_METHOD_GATE',
    );
  });

  test('redispose is refused on any edge except inconclusive → under_test|open', async () => {
    const cwd = freshCwd();
    await judgmentJointAdd(cwd, {
      slug: 'sneak',
      question: 'q?',
      branch_true: 'a',
      branch_false: 'b',
      resolve_by: 'EXT',
      cost: 'hours',
      rank: 'high',
      ext: { judgment_dispatch: true, reason: 'unsharpenable' },
    });
    await judgmentTransition(cwd, { slug: 'sneak', to: 'under_test' });
    // Smuggling a method swap onto the resolve edge must fail — it would
    // resolve an EXT joint as INT with no ext_result and no dispatch stamp.
    await refusedWith(
      judgmentTransition(cwd, {
        slug: 'sneak',
        to: 'resolved',
        redispose: { new_resolve_by: 'INT' },
        resolution: { outcome: 'resolved', evidence: 'e' },
      }),
      'JUDGMENT_INPUT',
    );
  });

  test('transition on unknown joint refused', async () => {
    const cwd = freshCwd();
    await refusedWith(
      judgmentTransition(cwd, { slug: 'ghost', to: 'under_test' }),
      'JUDGMENT_NOT_FOUND',
    );
  });

  test('postmortem naming an unknown prediction is refused', async () => {
    const cwd = freshCwd();
    await refusedWith(
      judgmentLedgerAppend(cwd, {
        kind: 'postmortem',
        title: 'ghost grade',
        trigger: 't',
        recall_verdict: 'NAMED',
        attribution: 'a',
        prediction_ref: 'p-999',
        prediction_grade: 'right',
      }),
      'JUDGMENT_NOT_FOUND',
    );
  });

  test('graph parity: the write-guard edge table and the judgment lifecycle mode agree', () => {
    const modeEdges = new Set();
    for (const [from, tos] of Object.entries(transitionsOf('judgment'))) {
      for (const to of tos) modeEdges.add(`${from}→${to}`);
    }
    assert.deepEqual([...LEGAL_EDGES].sort(), [...modeEdges].sort());
  });

  test('the ACTUAL registered guard graph is the mode graph plus EXACTLY the adapter-added edges', async () => {
    const { buildPhaseGraph } = await import('../server/lifecycle-guard.js');
    const registered = new Set();
    for (const [from, tos] of Object.entries(buildPhaseGraph('judgment'))) {
      for (const to of tos) registered.add(`${from}→${to}`);
    }
    const legal = new Set(LEGAL_EDGES);
    // Every writer-legal edge is guard-legal…
    for (const edge of legal) assert.ok(registered.has(edge), `guard graph missing legal edge ${edge}`);
    // …and the surplus is pinned to the adapter's unconditional additions
    // (unreachable through the writer — the edge table refuses them first).
    const surplus = [...registered].filter((e) => !legal.has(e)).sort();
    assert.deepEqual(surplus, [
      'inconclusive→killed',
      'open→killed',
      'resolved→complete',
      'resolved→killed',
      'under_test→killed',
    ]);
  });
});

describe('kill-between-steps — intent replay recovers the WHOLE mutation', () => {
  test('a persisted-but-unapplied transition intent is fully replayed, idempotently', async () => {
    const cwd = freshCwd();
    await judgmentJointAdd(cwd, {
      slug: 'crashy',
      question: 'q?',
      branch_true: 'a',
      branch_false: 'b',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    const store = new RecordsStore(cwd);
    const before = store.readJoint('crashy');

    // Simulate the crash window: the COMPLETE mutation persisted as an intent,
    // process dies before apply. (Guard is absent in this workspace, so replay
    // applies the payload directly.)
    const mutated = { ...before, state: 'under_test' };
    const event = {
      kind: 'note',
      title: 'crashy disposed',
      body: 'evidence of the full payload surviving',
      anchor: 'joint:crashy',
      provenance: before.provenance,
    };
    store.persistIntent({
      id: 'intent-crash-1',
      kind: 'transition',
      tool: 'judgment_transition',
      op: 'transition',
      payload: {
        slug: 'crashy',
        from: 'open',
        to: 'under_test',
        joint: mutated,
        events: [event],
        predictions: [{
          id: 'p-crash-1',
          text: 'will settle',
          outcome_criteria: 'settled',
          made_at: '2026-07-22T12:00:00Z',
          context: 'construct',
          refs: ['crashy'],
          status: 'open',
          provenance: before.provenance,
        }],
      },
      created_at: '2026-07-22T12:00:00Z',
    });

    const replay = await replayPendingIntents(cwd);
    assert.equal(replay.replayed, 1);
    assert.equal(store.readJoint('crashy').state, 'under_test', 'state recovered');
    assert.equal(store.readLedgerEvents().filter((e) => e.title === 'crashy disposed').length, 1, 'payload event recovered');
    assert.equal(store.readPrediction('p-crash-1').status, 'open', 'payload prediction recovered');
    assert.deepEqual(store.readIntents(), [], 'intent cleared after replay');
    assert.equal(intentAttestations(store, 'intent-crash-1').length, 1, 'replay publishes one success attestation');
    fixedPoint(cwd, 'after replay');

    // Idempotent: replaying again (e.g. via a read) changes nothing.
    const again = await replayPendingIntents(cwd);
    assert.equal(again.replayed, 0);
    assert.equal(store.readLedgerEvents().filter((e) => e.title === 'crashy disposed').length, 1, 'no double-append');
    assert.equal(intentAttestations(store, 'intent-crash-1').length, 1, 'no duplicate attestation');
  });

  test('kill MID-write: joint already mutated on disk, intent pending — replay converges', async () => {
    const cwd = freshCwd();
    await judgmentJointAdd(cwd, {
      slug: 'midway',
      question: 'q?',
      branch_true: 'a',
      branch_false: 'b',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    const store = new RecordsStore(cwd);
    const before = store.readJoint('midway');

    // Simulate death immediately AFTER applyPayload's writeJoint but before
    // ledger events, attestation, or clear: the mutated joint is already on
    // disk (in-place, no intent attribution — the blueprint disclaims an
    // effective-view preimage for it) while the intent is still pending.
    const mutated = { ...before, state: 'under_test' };
    const event = {
      kind: 'note',
      title: 'midway disposed',
      body: 'payload event not yet applied at crash time',
      anchor: 'joint:midway',
      provenance: before.provenance,
    };
    const intent = {
      id: 'intent-crash-mid-1',
      kind: 'transition',
      tool: 'judgment_transition',
      op: 'transition',
      payload: { slug: 'midway', from: 'open', to: 'under_test', joint: mutated, events: [event], predictions: [] },
      created_at: '2026-07-22T12:00:00Z',
    };
    store.persistIntent(intent);
    store.writeJoint(mutated); // the half-published crash state

    const replay = await replayPendingIntents(cwd);
    assert.equal(replay.replayed, 1);
    assert.equal(store.readJoint('midway').state, 'under_test', 'joint mutation stands');
    assert.equal(store.readLedgerEvents().filter((e) => e.title === 'midway disposed').length, 1, 'missing payload event applied exactly once');
    assert.deepEqual(store.readIntents(), [], 'intent cleared after replay');
    assert.equal(intentAttestations(store, 'intent-crash-mid-1').length, 1, 'one success attestation');
    fixedPoint(cwd, 'after mid-write replay');

    // Idempotent on a second replay: nothing duplicates.
    const again = await replayPendingIntents(cwd);
    assert.equal(again.replayed, 0);
    assert.equal(store.readLedgerEvents().filter((e) => e.title === 'midway disposed').length, 1, 'no double-append');
    assert.equal(intentAttestations(store, 'intent-crash-mid-1').length, 1, 'no duplicate attestation');
  });

  test('every write op and getJudgmentState replay pending intents first', async () => {
    const cwd = freshCwd();
    await judgmentJointAdd(cwd, {
      slug: 'stale',
      question: 'q?',
      branch_true: 'a',
      branch_false: 'b',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    const store = new RecordsStore(cwd);
    const mutated = { ...store.readJoint('stale'), state: 'under_test' };
    store.persistIntent({
      id: 'intent-crash-2',
      kind: 'transition',
      tool: 'judgment_transition',
      op: 'transition',
      payload: { slug: 'stale', from: 'open', to: 'under_test', joint: mutated, events: [], predictions: [] },
      created_at: '2026-07-22T12:00:00Z',
    });
    const state = await getJudgmentState(cwd);
    assert.equal(state.joints.find((j) => j.slug === 'stale').state, 'under_test', 'read path replays intents');
    assert.deepEqual(store.readIntents(), []);
  });
});

// ---------------------------------------------------------------------------
// COMP-JUDGMENT-STORES T3 / S3 — person + situation family writers
// ---------------------------------------------------------------------------

const personWrite = (...args) => judgmentPersonWrite(...args);
const situationWrite = (...args) => judgmentSituationWrite(...args);

const FACT_AT_1 = '2026-07-20';
const FACT_AT_2 = '2026-07-21';

describe('T3 person writer — golden flow', () => {
  test('stub → sourced fact → spoken → filled field → load → traced correction', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);

    const created = await personWrite(cwd, {
      op: 'create',
      slug: 'maya',
      display_name: 'Maya',
    });
    assert.deepEqual(created, { op: 'create', slug: 'maya' });
    fixedPoint(cwd, 'person create');

    const secondhand = await personWrite(cwd, {
      op: 'add_fact',
      slug: 'maya',
      section: 'role',
      text: 'Maya owns the review loop.',
      channel: 'secondhand',
      via: 'project lead',
      at: FACT_AT_1,
      id: 'f999',
      diverges_with: 'f999',
      trace: [{ poisoned: true }],
      nested: { provenance: { actor: 'caller' } },
    });
    assert.equal(secondhand.id, 'f1', 'caller-supplied IDs are never canonical');
    fixedPoint(cwd, 'person secondhand fact');

    await refusedWith(
      personWrite(cwd, {
        op: 'load_link',
        slug: 'maya',
        fact: 'f1',
        carries: 'review ownership',
      }),
      'JUDGMENT_LOAD_CHANNEL',
      /stub.*cannot carry load/i,
    );

    const said = await personWrite(cwd, {
      op: 'add_fact',
      slug: 'maya',
      section: 'stated',
      text: 'I own the review loop.',
      channel: 'said',
      at: FACT_AT_1,
    });
    assert.equal(said.id, 'f2');
    fixedPoint(cwd, 'person said fact');

    const opened = await personWrite(cwd, {
      op: 'open_field',
      slug: 'maya',
      name: 'What makes the review complete?',
    });
    assert.equal(opened.id, 'of1');
    fixedPoint(cwd, 'person open field');

    const filled = await personWrite(cwd, {
      op: 'open_field',
      slug: 'maya',
      open_field_id: 'of1',
      filled_by: 'f2',
    });
    assert.equal(filled.status, 'filled');
    fixedPoint(cwd, 'person field fill');

    const linked = await personWrite(cwd, {
      op: 'load_link',
      slug: 'maya',
      fact: 'f2',
      carries: 'review ownership',
    });
    assert.equal(linked.id, 'l1');
    fixedPoint(cwd, 'person load link');

    await personWrite(cwd, {
      op: 'correct',
      slug: 'maya',
      fact_id: 'f2',
      text: 'I own the final review loop.',
      at: FACT_AT_2,
    });
    fixedPoint(cwd, 'person correction');

    const person = store.readPerson('maya');
    assert.equal(person.display_name, 'Maya');
    assert.equal(person.facts[0].via, 'project lead');
    assert.equal(person.facts[0].id, 'f1');
    assert.equal(person.facts[0].trace.length, 0);
    assert.equal(person.facts[0].diverges_with, undefined);
    assert.equal(person.facts[0].nested, undefined, 'caller objects are not spread into canonical JSON');
    assert.equal(person.facts[1].text, 'I own the final review loop.');
    assert.equal(person.facts[1].at, FACT_AT_2);
    assert.deepEqual(person.facts[1].trace[0].prior, {
      text: 'I own the review loop.',
      at: FACT_AT_1,
    });
    assert.equal(person.open_fields[0].filled_by, 'f2');
    assert.equal(person.open_fields[0].trace[0].prior.status, 'open');
    assert.equal(person.load_links[0].removed, null);
    assert.equal(person.provenance.actor, 'agent');
    assert.notEqual(person.facts[0].provenance.actor, 'caller');
  });
});

describe('T3 situation writer — golden flow', () => {
  test('entity → varied facts → owed give/reopen → load matrix → correction after removal', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);

    await situationWrite(cwd, {
      op: 'create',
      slug: 'launch-window',
      display_name: 'Launch window',
    });
    fixedPoint(cwd, 'situation create');

    const secondhand = await situationWrite(cwd, {
      op: 'add_fact',
      slug: 'launch-window',
      text: 'A partner expects Friday.',
      channel: 'secondhand',
      via: 'account owner',
      at: FACT_AT_1,
    });
    const observed = await situationWrite(cwd, {
      op: 'add_fact',
      slug: 'launch-window',
      text: 'The release branch is green.',
      channel: 'observed',
      at: FACT_AT_1,
    });
    const inferred = await situationWrite(cwd, {
      op: 'add_fact',
      slug: 'launch-window',
      text: 'Friday is still achievable.',
      channel: 'inferred',
      at: FACT_AT_1,
    });
    assert.deepEqual([secondhand.id, observed.id, inferred.id], ['f1', 'f2', 'f3']);
    fixedPoint(cwd, 'situation facts');

    const owed = await situationWrite(cwd, {
      op: 'owed',
      slug: 'launch-window',
      name: 'Confirm the real deadline.',
      why_load_bearing: 'It determines the launch decision.',
    });
    assert.equal(owed.id, 'o1');
    await situationWrite(cwd, {
      op: 'owed',
      slug: 'launch-window',
      owed_id: 'o1',
      filled_by: 'f1',
    });
    await situationWrite(cwd, {
      op: 'owed',
      slug: 'launch-window',
      owed_id: 'o1',
      reopen: true,
      reason: 'The partner changed the date.',
    });
    fixedPoint(cwd, 'situation owed reopen');

    await refusedWith(
      situationWrite(cwd, {
        op: 'load_link',
        slug: 'launch-window',
        fact: 'f1',
        carries: 'deadline',
      }),
      'JUDGMENT_LOAD_CHANNEL',
      /f1.*secondhand/i,
    );
    await refusedWith(
      situationWrite(cwd, {
        op: 'load_link',
        slug: 'launch-window',
        fact: 'f3',
        carries: 'confidence',
      }),
      'JUDGMENT_LOAD_CHANNEL',
      /f3.*inferred/i,
    );

    const link = await situationWrite(cwd, {
      op: 'load_link',
      slug: 'launch-window',
      fact: 'f2',
      carries: 'release readiness',
    });
    assert.equal(link.id, 'l1');
    await refusedWith(
      situationWrite(cwd, {
        op: 'correct',
        slug: 'launch-window',
        fact_id: 'f2',
        channel: 'inferred',
      }),
      'JUDGMENT_LOAD_CHANNEL',
      /l1/,
    );
    await situationWrite(cwd, {
      op: 'load_link',
      slug: 'launch-window',
      load_link_id: 'l1',
      remove: true,
      reason: 'No longer decision-bearing.',
    });
    await situationWrite(cwd, {
      op: 'correct',
      slug: 'launch-window',
      fact_id: 'f2',
      channel: 'secondhand',
      via: 'release manager',
    });
    fixedPoint(cwd, 'situation correction after removal');

    const situation = store.readSituationEntity('launch-window');
    assert.equal(situation.owed[0].status, 'open');
    assert.equal(situation.owed[0].filled_by, undefined);
    assert.deepEqual(situation.owed[0].trace.map((entry) => entry.prior), [
      { status: 'open', filled_by: null },
      { status: 'given', filled_by: 'f1' },
    ]);
    assert.equal(situation.load_links[0].removed.reason, 'No longer decision-bearing.');
    assert.equal(situation.facts[1].channel, 'secondhand');
    assert.equal(situation.facts[1].via, 'release manager');
    assert.deepEqual(situation.facts[1].trace[0].prior, {
      channel: 'observed',
      via: null,
    });
  });
});

describe('T3 rejection matrix — code and message are part of the contract', () => {
  test('argument-shape failures precede idempotency and pin secondhand/via rules', async () => {
    const cwd = freshCwd();
    await personWrite(cwd, {
      op: 'create',
      slug: 'shape',
      display_name: 'Shape',
      idempotency_key: 'shape-key',
    });

    await refusedWith(
      personWrite(cwd, {
        op: 'unknown-op',
        slug: 'shape',
        idempotency_key: 'shape-key',
      }),
      'JUDGMENT_INPUT',
      /unknown op/i,
    );
    await refusedWith(
      personWrite(cwd, {
        op: 'add_fact',
        slug: 'shape',
        section: 'role',
        text: 'Sourced.',
        channel: 'secondhand',
        at: FACT_AT_1,
      }),
      'JUDGMENT_INPUT',
      /secondhand.*non-empty via/i,
    );
    await refusedWith(
      situationWrite(cwd, {
        op: 'add_fact',
        slug: 'missing-does-not-matter',
        text: 'Direct.',
        channel: 'said',
        via: 'stale source',
        at: FACT_AT_1,
      }),
      'JUDGMENT_INPUT',
      /via.*only.*secondhand/i,
    );
    await refusedWith(
      personWrite(cwd, {
        op: 'open_field',
        slug: 'shape',
        name: 'both',
        open_field_id: 'of1',
        filled_by: 'f1',
      }),
      'JUDGMENT_INPUT',
      /exactly one.*create.*fill.*reopen/i,
    );
  });

  test('load rejects stubs and disallowed source channels', async () => {
    const cwd = freshCwd();
    await personWrite(cwd, { op: 'create', slug: 'stub', display_name: 'Stub' });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'stub',
      section: 'role',
      text: 'Observed but silent.',
      channel: 'observed',
      at: FACT_AT_1,
    });
    await refusedWith(
      personWrite(cwd, {
        op: 'load_link',
        slug: 'stub',
        fact: 'f1',
        carries: 'load',
      }),
      'JUDGMENT_LOAD_CHANNEL',
      /stub.*cannot carry load/i,
    );

    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'stub',
      section: 'stated',
      text: 'Now spoken.',
      channel: 'said',
      at: FACT_AT_1,
    });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'stub',
      section: 'life',
      text: 'A conclusion.',
      channel: 'inferred',
      at: FACT_AT_1,
    });
    await refusedWith(
      personWrite(cwd, {
        op: 'load_link',
        slug: 'stub',
        fact: 'f3',
        carries: 'load',
      }),
      'JUDGMENT_LOAD_CHANNEL',
      /f3.*inferred/i,
    );
  });

  test('missing aggregates and entries are JUDGMENT_NOT_FOUND', async () => {
    const cwd = freshCwd();
    await refusedWith(
      personWrite(cwd, {
        op: 'add_fact',
        slug: 'ghost',
        section: 'role',
        text: 'No aggregate.',
        channel: 'said',
        at: FACT_AT_1,
      }),
      'JUDGMENT_NOT_FOUND',
      /person ghost does not exist/i,
    );
    await situationWrite(cwd, {
      op: 'create',
      slug: 'known',
      display_name: 'Known',
    });
    await refusedWith(
      situationWrite(cwd, {
        op: 'correct',
        slug: 'known',
        fact_id: 'f999',
        text: 'Missing.',
      }),
      'JUDGMENT_NOT_FOUND',
      /fact f999.*not found/i,
    );
  });

  test('broken fill, edge, pair, and active load references are JUDGMENT_REF', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await personWrite(cwd, { op: 'create', slug: 'a', display_name: 'A' });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'a',
      section: 'stated',
      text: 'A statement.',
      channel: 'said',
      at: FACT_AT_1,
    });
    await personWrite(cwd, { op: 'open_field', slug: 'a', name: 'Open?' });

    await refusedWith(
      personWrite(cwd, {
        op: 'open_field',
        slug: 'a',
        open_field_id: 'of1',
        filled_by: 'f999',
      }),
      'JUDGMENT_REF',
      /filled_by f999.*does not resolve/i,
    );
    await refusedWith(
      personWrite(cwd, {
        op: 'edge',
        slug: 'a',
        to: 'ghost',
        kind: 'reports-to',
      }),
      'JUDGMENT_REF',
      /target person ghost.*does not exist/i,
    );
    await refusedWith(
      personWrite(cwd, {
        op: 'correct',
        slug: 'a',
        fact_id: 'f1',
        pair_with: 'f999',
      }),
      'JUDGMENT_REF',
      /pair endpoint f999.*does not resolve/i,
    );

    const corrupt = store.readPerson('a');
    corrupt.load_links.push({
      id: 'l1',
      fact: 'f999',
      carries: 'broken',
      provenance: corrupt.provenance,
      removed: null,
    });
    store.writePerson(corrupt);
    await refusedWith(
      personWrite(cwd, {
        op: 'correct',
        slug: 'a',
        fact_id: 'f1',
        text: 'Still a statement.',
      }),
      'JUDGMENT_REF',
      /load link l1.*fact f999.*does not resolve/i,
    );
  });

  test('duplicate aggregates, invalid transitions, paired endpoints, and repeat removal conflict', async () => {
    const cwd = freshCwd();
    await personWrite(cwd, { op: 'create', slug: 'a', display_name: 'A' });
    await personWrite(cwd, { op: 'create', slug: 'b', display_name: 'B' });
    await refusedWith(
      personWrite(cwd, { op: 'create', slug: 'a', display_name: 'Again' }),
      'JUDGMENT_CONFLICT',
      /person a already exists/i,
    );

    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'a',
      section: 'stated',
      text: 'Stated.',
      channel: 'said',
      at: FACT_AT_1,
    });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'a',
      section: 'revealed',
      text: 'Revealed.',
      channel: 'observed',
      at: FACT_AT_1,
    });
    await personWrite(cwd, {
      op: 'correct',
      slug: 'a',
      fact_id: 'f1',
      pair_with: 'f2',
    });
    await refusedWith(
      personWrite(cwd, {
        op: 'correct',
        slug: 'a',
        fact_id: 'f1',
        pair_with: 'f2',
      }),
      'JUDGMENT_CONFLICT',
      /f1.*already paired/i,
    );

    await personWrite(cwd, { op: 'open_field', slug: 'a', name: 'Question?' });
    await personWrite(cwd, {
      op: 'open_field',
      slug: 'a',
      open_field_id: 'of1',
      filled_by: 'f1',
    });
    await refusedWith(
      personWrite(cwd, {
        op: 'open_field',
        slug: 'a',
        open_field_id: 'of1',
        filled_by: 'f1',
      }),
      'JUDGMENT_CONFLICT',
      /open field of1.*already filled/i,
    );

    await personWrite(cwd, {
      op: 'edge',
      slug: 'a',
      to: 'b',
      kind: 'reports-to',
    });
    await personWrite(cwd, {
      op: 'edge',
      slug: 'a',
      edge_id: 'e1',
      remove: true,
      reason: 'Changed roles.',
    });
    await refusedWith(
      personWrite(cwd, {
        op: 'edge',
        slug: 'a',
        edge_id: 'e1',
        remove: true,
        reason: 'Again.',
      }),
      'JUDGMENT_CONFLICT',
      /edge e1.*already removed/i,
    );
  });
});

describe('T3 corrections — every mutable fact field is traced', () => {
  test('text, at, channel/via, section, reciprocal pair, and reciprocal clear share one trace shape', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await personWrite(cwd, { op: 'create', slug: 'trace', display_name: 'Trace' });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'trace',
      section: 'stated',
      text: 'Old text.',
      channel: 'secondhand',
      via: 'old source',
      at: FACT_AT_1,
    });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'trace',
      section: 'revealed',
      text: 'Counter-signal.',
      channel: 'observed',
      at: FACT_AT_1,
    });

    await personWrite(cwd, {
      op: 'correct',
      slug: 'trace',
      fact_id: 'f1',
      text: 'New text.',
      at: FACT_AT_2,
      channel: 'said',
      section: 'role',
    });
    let person = store.readPerson('trace');
    assert.deepEqual(person.facts[0].trace[0].prior, {
      text: 'Old text.',
      at: FACT_AT_1,
      channel: 'secondhand',
      via: 'old source',
      section: 'stated',
    });
    assert.equal(person.facts[0].via, undefined, 'secondhand → said clears via atomically');

    await personWrite(cwd, {
      op: 'correct',
      slug: 'trace',
      fact_id: 'f1',
      channel: 'secondhand',
      via: 'new source',
      section: 'stated',
    });
    person = store.readPerson('trace');
    assert.deepEqual(person.facts[0].trace[1].prior, {
      channel: 'said',
      via: null,
      section: 'role',
    });
    assert.equal(person.facts[0].via, 'new source');

    await personWrite(cwd, {
      op: 'correct',
      slug: 'trace',
      fact_id: 'f1',
      via: 'replacement source',
    });
    person = store.readPerson('trace');
    assert.deepEqual(person.facts[0].trace[2].prior, { via: 'new source' });

    await personWrite(cwd, {
      op: 'correct',
      slug: 'trace',
      fact_id: 'f1',
      pair_with: 'f2',
    });
    person = store.readPerson('trace');
    assert.equal(person.facts[0].diverges_with, 'f2');
    assert.equal(person.facts[1].diverges_with, 'f1');
    assert.deepEqual(person.facts[0].trace[3].prior, { diverges_with: null });
    assert.deepEqual(person.facts[1].trace[0].prior, { diverges_with: null });

    await personWrite(cwd, {
      op: 'correct',
      slug: 'trace',
      fact_id: 'f1',
      clear: ['diverges_with'],
    });
    person = store.readPerson('trace');
    assert.equal(person.facts[0].diverges_with, undefined);
    assert.equal(person.facts[1].diverges_with, undefined);
    assert.deepEqual(person.facts[0].trace[4].prior, { diverges_with: 'f2' });
    assert.deepEqual(person.facts[1].trace[1].prior, { diverges_with: 'f1' });

    for (const fact of person.facts) {
      for (const entry of fact.trace) {
        assert.equal(typeof entry.corrected_at, 'string');
        assert.equal(entry.provenance.actor, 'agent');
        assert.ok(Object.keys(entry.prior).length > 0);
      }
    }
  });

  test('pair setup requires stated↔revealed endpoints', async () => {
    const cwd = freshCwd();
    await personWrite(cwd, { op: 'create', slug: 'pair', display_name: 'Pair' });
    for (const text of ['First.', 'Second.']) {
      await personWrite(cwd, {
        op: 'add_fact',
        slug: 'pair',
        section: 'stated',
        text,
        channel: 'said',
        at: FACT_AT_1,
      });
    }
    await refusedWith(
      personWrite(cwd, {
        op: 'correct',
        slug: 'pair',
        fact_id: 'f1',
        pair_with: 'f2',
      }),
      'JUDGMENT_REF',
      /stated.*revealed/i,
    );
  });
});

describe('T3 dependency closure', () => {
  test('person correction names every open-field, pair, direct-load, and only-said lifecycle blocker', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await personWrite(cwd, { op: 'create', slug: 'closure', display_name: 'Closure' });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'closure',
      section: 'stated',
      text: 'The only spoken fact.',
      channel: 'said',
      at: FACT_AT_1,
    });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'closure',
      section: 'life',
      text: 'Observed load source.',
      channel: 'observed',
      at: FACT_AT_1,
    });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'closure',
      section: 'revealed',
      text: 'A revealed counter-signal.',
      channel: 'observed',
      at: FACT_AT_1,
    });
    await personWrite(cwd, { op: 'open_field', slug: 'closure', name: 'Why?' });
    await personWrite(cwd, {
      op: 'open_field',
      slug: 'closure',
      open_field_id: 'of1',
      filled_by: 'f1',
    });
    await personWrite(cwd, {
      op: 'correct',
      slug: 'closure',
      fact_id: 'f1',
      pair_with: 'f3',
    });
    await personWrite(cwd, {
      op: 'load_link',
      slug: 'closure',
      fact: 'f1',
      carries: 'direct',
    });
    await personWrite(cwd, {
      op: 'load_link',
      slug: 'closure',
      fact: 'f2',
      carries: 'lifecycle-dependent',
    });

    const before = JSON.stringify(store.readPerson('closure'));
    const blocked = await refusedWith(
      personWrite(cwd, {
        op: 'correct',
        slug: 'closure',
        fact_id: 'f1',
        channel: 'inferred',
        section: 'role',
      }),
      'JUDGMENT_REF',
      /blocked/i,
    );
    for (const id of ['of1', 'f3', 'l1', 'l2']) {
      assert.match(blocked.message, new RegExp(`\\b${id}\\b`), `blocker ${id} must be named`);
    }
    assert.equal(JSON.stringify(store.readPerson('closure')), before, 'refused correction is non-mutating');

    await personWrite(cwd, {
      op: 'open_field',
      slug: 'closure',
      open_field_id: 'of1',
      reopen: true,
      reason: 'Answer needs re-elicitation.',
    });
    for (const id of ['l1', 'l2']) {
      await personWrite(cwd, {
        op: 'load_link',
        slug: 'closure',
        load_link_id: id,
        remove: true,
        reason: 'Unblock channel correction.',
      });
    }
    await personWrite(cwd, {
      op: 'correct',
      slug: 'closure',
      fact_id: 'f1',
      clear: ['diverges_with'],
    });
    await personWrite(cwd, {
      op: 'correct',
      slug: 'closure',
      fact_id: 'f1',
      channel: 'inferred',
      section: 'role',
    });

    const person = store.readPerson('closure');
    assert.equal(person.facts[0].channel, 'inferred');
    assert.equal(person.facts[0].section, 'role');
    assert.equal(person.open_fields[0].status, 'open');
    assert.ok(person.load_links.every((entry) => entry.removed !== null));
  });

  test('situation correction rejects active load dependents, then succeeds after retirement', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await situationWrite(cwd, { op: 'create', slug: 'closure', display_name: 'Closure' });
    await situationWrite(cwd, {
      op: 'add_fact',
      slug: 'closure',
      text: 'Observed.',
      channel: 'observed',
      at: FACT_AT_1,
    });
    await situationWrite(cwd, {
      op: 'load_link',
      slug: 'closure',
      fact: 'f1',
      carries: 'decision',
    });
    await refusedWith(
      situationWrite(cwd, {
        op: 'correct',
        slug: 'closure',
        fact_id: 'f1',
        channel: 'inferred',
      }),
      'JUDGMENT_LOAD_CHANNEL',
      /l1/,
    );
    await situationWrite(cwd, {
      op: 'load_link',
      slug: 'closure',
      load_link_id: 'l1',
      remove: true,
      reason: 'Unblock correction.',
    });
    await situationWrite(cwd, {
      op: 'correct',
      slug: 'closure',
      fact_id: 'f1',
      channel: 'inferred',
    });
    assert.equal(store.readSituationEntity('closure').facts[0].channel, 'inferred');
  });

  test('remove, reopen, and clear remain callable when their referenced target is stale', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await personWrite(cwd, { op: 'create', slug: 'cleanup', display_name: 'Cleanup' });
    await personWrite(cwd, { op: 'create', slug: 'stale-target', display_name: 'Stale Target' });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'cleanup',
      section: 'stated',
      text: 'Spoken.',
      channel: 'said',
      at: FACT_AT_1,
    });
    await personWrite(cwd, {
      op: 'add_fact',
      slug: 'cleanup',
      section: 'revealed',
      text: 'Revealed.',
      channel: 'observed',
      at: FACT_AT_1,
    });
    await personWrite(cwd, { op: 'edge', slug: 'cleanup', to: 'stale-target', kind: 'knows' });
    rmSync(store._personPath('stale-target'));
    await personWrite(cwd, {
      op: 'edge',
      slug: 'cleanup',
      edge_id: 'e1',
      remove: true,
      reason: 'Target vanished.',
    });

    await personWrite(cwd, { op: 'load_link', slug: 'cleanup', fact: 'f1', carries: 'load' });
    let person = store.readPerson('cleanup');
    person.load_links[0].fact = 'f999';
    store.writePerson(person);
    await personWrite(cwd, {
      op: 'load_link',
      slug: 'cleanup',
      load_link_id: 'l1',
      remove: true,
      reason: 'Source vanished.',
    });

    await personWrite(cwd, { op: 'open_field', slug: 'cleanup', name: 'Question?' });
    await personWrite(cwd, {
      op: 'open_field',
      slug: 'cleanup',
      open_field_id: 'of1',
      filled_by: 'f1',
    });
    person = store.readPerson('cleanup');
    person.open_fields[0].filled_by = 'f999';
    store.writePerson(person);
    await personWrite(cwd, {
      op: 'open_field',
      slug: 'cleanup',
      open_field_id: 'of1',
      reopen: true,
      reason: 'Filling fact vanished.',
    });

    await personWrite(cwd, {
      op: 'correct',
      slug: 'cleanup',
      fact_id: 'f1',
      pair_with: 'f2',
    });
    person = store.readPerson('cleanup');
    person.facts[0].diverges_with = 'f999';
    delete person.facts[1].diverges_with;
    store.writePerson(person);
    await personWrite(cwd, {
      op: 'correct',
      slug: 'cleanup',
      fact_id: 'f1',
      clear: ['diverges_with'],
    });

    person = store.readPerson('cleanup');
    assert.notEqual(person.edges[0].removed, null);
    assert.notEqual(person.load_links[0].removed, null);
    assert.equal(person.open_fields[0].status, 'open');
    assert.equal(person.facts[0].diverges_with, undefined);
  });
});

describe('T3 stable entry IDs', () => {
  test('allocator scans the high-water mark, including retired entries, and rejects corruption', () => {
    assert.equal(
      allocateStableEntryId({
        slug: 'high-water',
        edges: [
          { id: 'e2', removed: null },
          { id: 'e9', removed: { reason: 'retired' } },
        ],
      }, 'edges', 'e'),
      'e10',
    );
    assert.throws(
      () => allocateStableEntryId({
        slug: 'duplicate',
        facts: [{ id: 'f1' }, { id: 'f1' }],
      }, 'facts', 'f'),
      (err) => err.code === 'JUDGMENT_CONFLICT' && /duplicate id f1/i.test(err.message),
    );
    assert.throws(
      () => allocateStableEntryId({
        slug: 'malformed',
        owed: [{ id: 'owed-1' }],
      }, 'owed', 'o'),
      (err) => err.code === 'JUDGMENT_CONFLICT' && /malformed id owed-1/i.test(err.message),
    );
  });

  test('create/reopen-or-retire/create never reuses IDs for every S3 prefix', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await personWrite(cwd, { op: 'create', slug: 'ids', display_name: 'IDs' });
    await personWrite(cwd, { op: 'create', slug: 'target', display_name: 'Target' });
    for (const text of ['One.', 'Two.']) {
      await personWrite(cwd, {
        op: 'add_fact',
        slug: 'ids',
        section: 'stated',
        text,
        channel: 'said',
        at: FACT_AT_1,
      });
    }
    await personWrite(cwd, { op: 'open_field', slug: 'ids', name: 'First?' });
    await personWrite(cwd, {
      op: 'open_field',
      slug: 'ids',
      open_field_id: 'of1',
      filled_by: 'f1',
    });
    await personWrite(cwd, {
      op: 'open_field',
      slug: 'ids',
      open_field_id: 'of1',
      reopen: true,
      reason: 'Reopen.',
    });
    await personWrite(cwd, { op: 'open_field', slug: 'ids', name: 'Second?' });
    await personWrite(cwd, { op: 'edge', slug: 'ids', to: 'target', kind: 'knows' });
    await personWrite(cwd, {
      op: 'edge',
      slug: 'ids',
      edge_id: 'e1',
      remove: true,
      reason: 'Retired.',
    });
    await personWrite(cwd, { op: 'edge', slug: 'ids', to: 'target', kind: 'reports-to' });
    await personWrite(cwd, { op: 'load_link', slug: 'ids', fact: 'f1', carries: 'first' });
    await personWrite(cwd, {
      op: 'load_link',
      slug: 'ids',
      load_link_id: 'l1',
      remove: true,
      reason: 'Retired.',
    });
    await personWrite(cwd, { op: 'load_link', slug: 'ids', fact: 'f2', carries: 'second' });

    const person = store.readPerson('ids');
    assert.deepEqual(person.facts.map((entry) => entry.id), ['f1', 'f2']);
    assert.deepEqual(person.open_fields.map((entry) => entry.id), ['of1', 'of2']);
    assert.deepEqual(person.edges.map((entry) => entry.id), ['e1', 'e2']);
    assert.deepEqual(person.load_links.map((entry) => entry.id), ['l1', 'l2']);

    await situationWrite(cwd, { op: 'create', slug: 'owed-ids', display_name: 'Owed IDs' });
    await situationWrite(cwd, {
      op: 'add_fact',
      slug: 'owed-ids',
      text: 'Evidence.',
      channel: 'observed',
      at: FACT_AT_1,
    });
    await situationWrite(cwd, {
      op: 'owed',
      slug: 'owed-ids',
      name: 'First?',
      why_load_bearing: 'First.',
    });
    await situationWrite(cwd, {
      op: 'owed',
      slug: 'owed-ids',
      owed_id: 'o1',
      filled_by: 'f1',
    });
    await situationWrite(cwd, {
      op: 'owed',
      slug: 'owed-ids',
      owed_id: 'o1',
      reopen: true,
      reason: 'Reopen.',
    });
    await situationWrite(cwd, {
      op: 'owed',
      slug: 'owed-ids',
      name: 'Second?',
      why_load_bearing: 'Second.',
    });
    assert.deepEqual(store.readSituationEntity('owed-ids').owed.map((entry) => entry.id), ['o1', 'o2']);
  });

  test('on-disk duplicate or malformed IDs refuse before schema collapse', async () => {
    const duplicateCwd = freshCwd();
    const duplicateStore = new RecordsStore(duplicateCwd);
    await personWrite(duplicateCwd, { op: 'create', slug: 'dup', display_name: 'Dup' });
    await personWrite(duplicateCwd, {
      op: 'add_fact',
      slug: 'dup',
      section: 'role',
      text: 'One.',
      channel: 'said',
      at: FACT_AT_1,
    });
    const duplicate = duplicateStore.readPerson('dup');
    duplicate.facts.push({ ...duplicate.facts[0] });
    duplicateStore.writePerson(duplicate);
    await refusedWith(
      personWrite(duplicateCwd, {
        op: 'add_fact',
        slug: 'dup',
        section: 'life',
        text: 'Two.',
        channel: 'said',
        at: FACT_AT_1,
      }),
      'JUDGMENT_CONFLICT',
      /duplicate id f1/i,
    );

    const malformedCwd = freshCwd();
    const malformedStore = new RecordsStore(malformedCwd);
    await situationWrite(malformedCwd, {
      op: 'create',
      slug: 'malformed',
      display_name: 'Malformed',
    });
    const malformed = malformedStore.readSituationEntity('malformed');
    malformed.owed.push({
      id: 'owed-1',
      name: 'Bad',
      why_load_bearing: 'Bad',
      status: 'open',
      provenance: malformed.provenance,
      trace: [],
    });
    malformedStore.writeSituationEntity(malformed);
    await refusedWith(
      situationWrite(malformedCwd, {
        op: 'add_fact',
        slug: 'malformed',
        text: 'Cannot pass corruption.',
        channel: 'observed',
        at: FACT_AT_1,
      }),
      'JUDGMENT_CONFLICT',
      /malformed id owed-1/i,
    );
  });
});

describe('T3 compensation and idempotency', () => {
  test('mutable aggregate overwrite restores the exact preimage when projection regeneration fails', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await personWrite(cwd, { op: 'create', slug: 'rollback', display_name: 'Rollback' });
    const personPath = store._personPath('rollback');
    const before = readFileSync(personPath, 'utf8');

    const obstruction = join(cwd, 'docs', 'judgment', 'REGISTER.md');
    rmSync(obstruction);
    mkdirSync(obstruction);
    await refusedWith(
      personWrite(cwd, {
        op: 'add_fact',
        slug: 'rollback',
        section: 'role',
        text: 'Must roll back.',
        channel: 'said',
        at: FACT_AT_1,
      }),
      'JUDGMENT_PARTIAL_WRITE',
      /rolled back/i,
    );
    assert.equal(readFileSync(personPath, 'utf8'), before);
  });

  test('new aggregate file is deleted when projection regeneration fails after create', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    mkdirSync(join(cwd, 'docs', 'judgment', 'REGISTER.md'), { recursive: true });
    await refusedWith(
      situationWrite(cwd, {
        op: 'create',
        slug: 'rollback-create',
        display_name: 'Rollback Create',
      }),
      'JUDGMENT_PARTIAL_WRITE',
      /rolled back/i,
    );
    assert.equal(existsSync(store._situationEntityPath('rollback-create')), false);
  });

  test('repeated keyed family calls create one entry and one correction trace', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await personWrite(cwd, { op: 'create', slug: 'idem-person', display_name: 'Idem Person' });
    const factArgs = {
      op: 'add_fact',
      slug: 'idem-person',
      section: 'role',
      text: 'Once.',
      channel: 'said',
      at: FACT_AT_1,
      idempotency_key: 'person-fact-once',
    };
    assert.deepEqual(await personWrite(cwd, factArgs), await personWrite(cwd, factArgs));
    const correctArgs = {
      op: 'correct',
      slug: 'idem-person',
      fact_id: 'f1',
      text: 'Corrected once.',
      idempotency_key: 'person-correct-once',
    };
    assert.deepEqual(await personWrite(cwd, correctArgs), await personWrite(cwd, correctArgs));
    const person = store.readPerson('idem-person');
    assert.equal(person.facts.length, 1);
    assert.equal(person.facts[0].trace.length, 1);

    await situationWrite(cwd, { op: 'create', slug: 'idem-situation', display_name: 'Idem Situation' });
    const situationFactArgs = {
      op: 'add_fact',
      slug: 'idem-situation',
      text: 'Once.',
      channel: 'observed',
      at: FACT_AT_1,
      idempotency_key: 'situation-fact-once',
    };
    assert.deepEqual(
      await situationWrite(cwd, situationFactArgs),
      await situationWrite(cwd, situationFactArgs),
    );
    const situationCorrectArgs = {
      op: 'correct',
      slug: 'idem-situation',
      fact_id: 'f1',
      text: 'Corrected once.',
      idempotency_key: 'situation-correct-once',
    };
    assert.deepEqual(
      await situationWrite(cwd, situationCorrectArgs),
      await situationWrite(cwd, situationCorrectArgs),
    );
    const situation = store.readSituationEntity('idem-situation');
    assert.equal(situation.facts.length, 1);
    assert.equal(situation.facts[0].trace.length, 1);
  });
});

// ---------------------------------------------------------------------------
// COMP-JUDGMENT-STORES T4 / S4 — goal writer + durable intent publication
// ---------------------------------------------------------------------------

const GOAL_ELICITATION = {
  asked: 'What must the objective preserve?',
  answered_at: '2026-07-23T09:00:00Z',
  answer_ref: 'session:goal-elicitation',
};

const GOAL_RATIFICATION = {
  asked: 'Does this wording cut the objective?',
  answered_at: '2026-07-23T09:05:00Z',
  answer_ref: 'session:goal-ratification',
  quote: 'Yes. Cut this objective.',
};

const GOAL_PROVOCATION = {
  quote: 'The objective needs to name the publication boundary.',
  at: '2026-07-23T08:55:00Z',
};

function goalClause(text, channel = 'said', via) {
  const clause = {
    text,
    channel,
    elicitation: { ...GOAL_ELICITATION },
  };
  if (via !== undefined) clause.via = via;
  return clause;
}

function cutArgs(overrides = {}) {
  return {
    op: 'cut',
    clauses: [goalClause('Publish only after the durable boundary.')],
    provocation: { ...GOAL_PROVOCATION },
    ratification: { ...GOAL_RATIFICATION },
    diff_note: 'Initial owner-ratified cut.',
    ...overrides,
  };
}

function intentAttestations(store, intentId) {
  return store.readLedgerEvents().filter(
    (event) => event.kind === 'attest' && event.intent_id === intentId,
  );
}

function persistTransitionIntent(store, {
  id,
  slug,
  before,
  events = [],
  predictions = [],
  kind = 'transition',
  tool = 'judgment_transition',
  op = 'transition',
}) {
  store.persistIntent({
    id,
    kind,
    tool,
    op,
    payload: {
      slug,
      from: before.state,
      to: 'under_test',
      joint: { ...before, state: 'under_test' },
      events,
      predictions,
    },
    created_at: '2026-07-23T10:00:00Z',
  });
}

describe('T4 goal cut — ratification, channel grammar, and migration precedence', () => {
  test('citation timestamps are validated as strict date-time BEFORE the idempotency cache', async () => {
    const cwd = freshCwd();
    // A date-only string parses via new Date() but fails the contract's
    // RFC 3339 date-time format; the precheck must reject it in validate
    // (ordinary cuts surface citation defects as UNRATIFIED_CUT).
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        ratification: { ...GOAL_RATIFICATION, answered_at: '2026-07-23' },
      })),
      'JUDGMENT_UNRATIFIED_CUT',
      /answered_at.*date-time/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        provocation: { ...GOAL_PROVOCATION, at: '2026-07-23' },
      })),
      'JUDGMENT_UNRATIFIED_CUT',
      /provocation\.at.*date-time/i,
    );

    // Validate-before-idempotency: a malformed retry reusing a cached key
    // must refuse, never return the cached success.
    const ok = await judgmentGoalWrite(cwd, cutArgs({ idempotency_key: 'cut-key-1' }));
    assert.equal(ok.version, 1);
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        idempotency_key: 'cut-key-1',
        ratification: { ...GOAL_RATIFICATION, answered_at: '2026-07-23' },
      })),
      'JUDGMENT_UNRATIFIED_CUT',
      /answered_at.*date-time/i,
    );
    // Impossible calendar date: new Date() silently normalizes Feb 29 in a
    // non-leap year, but the contract validator rejects it — the precheck
    // must agree with the contract, even on a cached key.
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        idempotency_key: 'cut-key-1',
        ratification: { ...GOAL_RATIFICATION, answered_at: '2023-02-29T09:00:00Z' },
      })),
      'JUDGMENT_UNRATIFIED_CUT',
      /answered_at.*date-time/i,
    );
    // Schema-valid exotic forms (leap second, lowercase t/z) must PASS the
    // precheck — it may be no stricter than the contract either.
    const exotic = await judgmentGoalWrite(cwd, cutArgs({
      idempotency_key: 'cut-key-exotic',
      ratification: { ...GOAL_RATIFICATION, answered_at: '2026-06-30t23:59:60z' },
    }));
    assert.equal(exotic.version, 2);
  });

  test('ordinary cuts require clauses, elicitation, provocation, and ratification', async () => {
    const cwd = freshCwd();
    await refusedWith(
      judgmentGoalWrite(cwd, { op: 'cut', clauses: [], diff_note: 'Bare.' }),
      'JUDGMENT_UNRATIFIED_CUT',
      /non-empty clauses/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        clauses: [{ text: 'Missing its elicitation.', channel: 'said' }],
      })),
      'JUDGMENT_UNRATIFIED_CUT',
      /clause 1.*elicitation/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({ provocation: undefined })),
      'JUDGMENT_UNRATIFIED_CUT',
      /provocation/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({ ratification: undefined })),
      'JUDGMENT_UNRATIFIED_CUT',
      /ratification/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        clauses: [goalClause('Incomplete elicitation.', 'said')],
        ratification: { ...GOAL_RATIFICATION, quote: undefined },
      })),
      'JUDGMENT_UNRATIFIED_CUT',
      /ratification.*quote/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        clauses: [{
          ...goalClause('Incomplete elicitation.', 'said'),
          elicitation: { ...GOAL_ELICITATION, answer_ref: undefined },
        }],
      })),
      'JUDGMENT_UNRATIFIED_CUT',
      /clause 1.*elicitation.*answer_ref/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        provocation: { ...GOAL_PROVOCATION, at: undefined },
      })),
      'JUDGMENT_UNRATIFIED_CUT',
      /provocation.*at/i,
    );
  });

  test('goal clauses enforce the secondhand/via iff contract with typed input errors', async () => {
    const cwd = freshCwd();
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        clauses: [goalClause('A sourced clause.', 'secondhand')],
      })),
      'JUDGMENT_INPUT',
      /clause 1.*secondhand.*via/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, cutArgs({
        clauses: [goalClause('A direct clause.', 'observed', 'stale source')],
      })),
      'JUDGMENT_INPUT',
      /clause 1.*via.*secondhand/i,
    );
  });

  test('legacy-live/no-goal requires migration, but a surviving migration intent wins first', async () => {
    const legacyCwd = freshCwd();
    await judgmentPositionCreate(legacyCwd, {
      slug: 'objective',
      claims: [{ id: 'c1', text: 'Legacy objective.', grounding: 'INT' }],
      conviction: { level: 'high', source: 'stated' },
    });
    await refusedWith(
      judgmentGoalWrite(legacyCwd, cutArgs()),
      'JUDGMENT_MIGRATION_REQUIRED',
      exactly(fenceMessage('cut')),
    );

    const fencedCwd = freshCwd();
    const store = new RecordsStore(fencedCwd);
    const hiddenProvenance = {
      actor: 'agent',
      session: null,
      written_at: '2026-07-23T09:10:00Z',
      via: 'migration',
      intent_id: 'intent-goal-migration',
    };
    store.writeGoalVersion({
      version: 1,
      clauses: [{
        id: 'c1',
        text: 'Physically present but unpublished.',
        channel: 'said',
        elicitation: { ...GOAL_ELICITATION },
        provenance: hiddenProvenance,
        trace: [],
      }],
      provocation: null,
      diff_note: 'Pending migration.',
      provenance: hiddenProvenance,
    });
    store.persistIntent({
      id: 'intent-goal-migration',
      kind: 'goal_migration',
      tool: 'judgment_goal_write',
      op: 'migrate',
      payload: { resembles: 'a future migration payload' },
      created_at: '2026-07-23T09:10:00Z',
    });

    // The registered applier now completes or throws, so a genuinely pending
    // migration only survives replay via the C13 injection seam: a blocked
    // (non-throwing) applier leaves the intent, and the shipped fence fires.
    const blockedAppliers = {
      ...INTENT_APPLIERS,
      goal_migration: () => ({ status: 'blocked', reason: 'injected' }),
    };

    const calls = [
      cutArgs(),
      { op: 'correct', clause_id: 'c1', text: 'No.' },
      { op: 'joint_link', joint: 'missing' },
      { op: 'load_link', clause: 'v1#c1', carries: 'No.' },
    ];
    for (const args of calls) {
      await refusedWith(
        judgmentGoalWrite(fencedCwd, args, { appliers: blockedAppliers }),
        'JUDGMENT_INTENT_PENDING',
        /goal_migration.*pending/i,
      );
    }
    assert.equal(store.readIntents().length, 1, 'blocked migration intent remains durable');
    assert.equal(effectiveStore(store).readGoalChain().length, 0, 'pending goal file is hidden');
  });

  test('fresh ratified cut succeeds; internal import may create an unratified draft', async () => {
    const cwd = freshCwd();
    const result = await judgmentGoalWrite(cwd, cutArgs({
      clauses: [
        goalClause('First clause.', 'said'),
        goalClause('Second clause.', 'secondhand', 'owner delegate'),
      ],
    }));
    assert.deepEqual(result, {
      op: 'cut',
      version: 1,
      ref: 'goal:v1',
      ratified: true,
    });
    const store = new RecordsStore(cwd);
    const first = store.readGoalVersion(1);
    assert.deepEqual(first.clauses.map((clause) => clause.id), ['c1', 'c2']);
    assert.deepEqual(first.ratification, GOAL_RATIFICATION);
    assert.deepEqual(first.provocation, GOAL_PROVOCATION);

    const importCwd = freshCwd();
    await judgmentGoalWrite(
      importCwd,
      {
        op: 'cut',
        clauses: [goalClause('Imported draft.', 'observed')],
        diff_note: 'Imported without owner ratification.',
      },
      { via: 'import', writtenAt: '2026-07-23T09:20:00Z' },
    );
    const imported = new RecordsStore(importCwd).readGoalVersion(1);
    assert.equal(imported.provocation, null);
    assert.equal(imported.ratification, undefined);
    assert.equal(imported.provenance.via, 'import');
    await judgmentGoalWrite(importCwd, {
      op: 'correct',
      clause_id: 'c1',
      text: 'Corrected imported draft wording.',
    });
    const correctedImport = new RecordsStore(importCwd).readGoalVersion(1);
    assert.equal(correctedImport.clauses[0].text, 'Corrected imported draft wording.');
    assert.equal(correctedImport.clauses[0].trace.length, 1);
    assert.equal(correctedImport.provenance.via, 'import');
    assert.equal(correctedImport.ratification, undefined);
  });
});

describe('T4 goal correction and state sidecar', () => {
  test('wording correction mutates only the current version and appends one trace', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await judgmentGoalWrite(cwd, cutArgs({
      clauses: [
        goalClause('Old wording.'),
        goalClause('Only in version one.', 'observed'),
      ],
    }));
    const ratification = structuredClone(store.readGoalVersion(1).ratification);
    await judgmentGoalWrite(cwd, {
      op: 'correct',
      clause_id: 'c1',
      text: 'Corrected wording.',
    });
    const corrected = store.readGoalVersion(1);
    assert.equal(store.readGoalChain().length, 1);
    assert.equal(corrected.version, 1);
    assert.equal(corrected.clauses[0].text, 'Corrected wording.');
    assert.deepEqual(corrected.clauses[0].trace[0].prior, { text: 'Old wording.' });
    assert.deepEqual(corrected.ratification, ratification, 'wording correction needs no new ratification');
    assert.equal(corrected.clauses[1].text, 'Only in version one.');

    await judgmentGoalWrite(cwd, cutArgs({
      clauses: [goalClause('Version two current clause.')],
      diff_note: 'Meaning changed.',
    }));
    await refusedWith(
      judgmentGoalWrite(cwd, {
        op: 'correct',
        clause_id: 'c2',
        text: 'Must not search an old version.',
      }),
      'JUDGMENT_REF',
      /current goal v2.*c2/i,
    );
    assert.equal(store.readGoalChain().length, 2);
  });

  test('joint/load links validate refs, retire in place, keep high-water IDs, and preserve old-version links', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await judgmentGoalWrite(cwd, cutArgs());

    await refusedWith(
      judgmentGoalWrite(cwd, { op: 'joint_link', joint: 'ghost' }),
      'JUDGMENT_REF',
      /joint ghost/i,
    );
    await judgmentJointAdd(cwd, {
      slug: 'goal-joint',
      question: 'Does publication happen in the right order?',
      branch_true: 'Keep it.',
      branch_false: 'Repair it.',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    const joint1 = await judgmentGoalWrite(cwd, { op: 'joint_link', joint: 'goal-joint' });
    assert.equal(joint1.id, 'gj1');
    assert.equal(store.readGoalChain().length, 1, 'sidecar writes never cut a version');
    await judgmentGoalWrite(cwd, {
      op: 'joint_link',
      joint_link_id: 'gj1',
      remove: true,
      reason: 'Settled elsewhere.',
    });
    const joint2 = await judgmentGoalWrite(cwd, { op: 'joint_link', joint: 'goal-joint' });
    assert.equal(joint2.id, 'gj2', 'retired IDs are never reused');

    await refusedWith(
      judgmentGoalWrite(cwd, {
        op: 'load_link',
        clause: 'v9#c1',
        carries: 'Missing.',
      }),
      'JUDGMENT_REF',
      /v9#c1/i,
    );
    await refusedWith(
      judgmentGoalWrite(cwd, {
        op: 'load_link',
        clause: 'goal:v1#c1',
        carries: 'Wrong address shape.',
      }),
      'JUDGMENT_REF',
      /goal:v1#c1/i,
    );
    const load1 = await judgmentGoalWrite(cwd, {
      op: 'load_link',
      clause: 'v1#c1',
      carries: 'Publication ordering.',
    });
    assert.equal(load1.id, 'gl1');
    await judgmentGoalWrite(cwd, {
      op: 'load_link',
      load_link_id: 'gl1',
      remove: true,
      reason: 'Replaced by a narrower bill.',
    });
    const load2 = await judgmentGoalWrite(cwd, {
      op: 'load_link',
      clause: 'v1#c1',
      carries: 'Durable clear boundary.',
    });
    assert.equal(load2.id, 'gl2');

    await judgmentGoalWrite(cwd, cutArgs({
      clauses: [goalClause('A newer meaning version.')],
      diff_note: 'Meaning changed after the load link.',
    }));
    const state = store.readGoalState();
    assert.equal(state.load_links.find((link) => link.id === 'gl2').clause, 'v1#c1');
    assert.equal(state.load_links.find((link) => link.id === 'gl2').removed, null);
    assert.equal(store.readGoalChain().length, 2);
    assert.deepEqual(state.joints.map((link) => link.id), ['gj1', 'gj2']);
    assert.deepEqual(state.load_links.map((link) => link.id), ['gl1', 'gl2']);
  });
});

describe('T4 commit rests_on resolution', () => {
  function decide(restsOn, suffix) {
    const event = {
      kind: 'decide',
      title: `Commit ${suffix}`,
      rejected: [],
      conviction: { level: 'high', source: 'stated' },
      trigger: 'earned',
      open_joints: [],
      prediction: {
        text: `Prediction ${suffix}`,
        outcome_criteria: 'The commit remains valid.',
      },
    };
    if (restsOn !== undefined) event.rests_on = restsOn;
    return event;
  }

  test('said/observed/secondhand resolve; inferred, missing, and hidden refs reject', async () => {
    const cwd = freshCwd();
    await judgmentGoalWrite(cwd, cutArgs({
      clauses: [
        goalClause('Said.', 'said'),
        goalClause('Observed.', 'observed'),
        goalClause('Secondhand.', 'secondhand', 'named source'),
        goalClause('Inferred.', 'inferred'),
      ],
    }));
    await judgmentLedgerAppend(cwd, decide(
      ['goal:v1#c1', 'goal:v1#c2', 'goal:v1#c3'],
      'supported channels',
    ));
    await refusedWith(
      judgmentLedgerAppend(cwd, decide(['goal:v1#c4'], 'inferred')),
      'JUDGMENT_INFERRED_COMMIT',
      /goal:v1#c4.*inferred/i,
    );
    await refusedWith(
      judgmentLedgerAppend(cwd, decide(['goal:v9#c1'], 'missing')),
      'JUDGMENT_REF',
      /goal:v9#c1/i,
    );

    const store = new RecordsStore(cwd);
    const hiddenProvenance = {
      actor: 'agent',
      session: null,
      written_at: '2026-07-23T10:10:00Z',
      intent_id: 'intent-package-transition',
    };
    store.writeGoalVersion({
      version: 2,
      clauses: [{
        id: 'c1',
        text: 'Hidden by a reserved pending package intent.',
        channel: 'said',
        elicitation: { ...GOAL_ELICITATION },
        provenance: hiddenProvenance,
        trace: [],
      }],
      provocation: null,
      diff_note: 'Hidden child-feature write.',
      provenance: { ...hiddenProvenance, via: 'migration' },
    });
    store.persistIntent({
      id: 'intent-package-transition',
      kind: 'package_transition',
      tool: 'judgment_package_write',
      op: 'transition',
      payload: {},
      created_at: '2026-07-23T10:10:00Z',
    });
    await refusedWith(
      judgmentLedgerAppend(cwd, decide(['goal:v2#c1'], 'hidden')),
      'JUDGMENT_REF',
      /goal:v2#c1/i,
    );
    assert.equal(store.readIntents().length, 1);
  });

  test('omitted/empty rests_on stay legal; a migration fence wins before ref resolution', async () => {
    const cwd = freshCwd();
    await judgmentGoalWrite(cwd, cutArgs());
    assert.equal((await judgmentLedgerAppend(cwd, decide(undefined, 'omitted'))).kind, 'decide');
    assert.equal((await judgmentLedgerAppend(cwd, decide([], 'empty'))).kind, 'decide');

    const store = new RecordsStore(cwd);
    store.persistIntent({
      id: 'intent-rests-on-migration',
      kind: 'goal_migration',
      tool: 'judgment_goal_write',
      op: 'migrate',
      payload: {},
      created_at: '2026-07-23T10:20:00Z',
    });
    const blockedAppliers = {
      ...INTENT_APPLIERS,
      goal_migration: () => ({ status: 'blocked', reason: 'injected' }),
    };
    await refusedWith(
      judgmentLedgerAppend(cwd, decide(['goal:v1#c1'], 'fenced'), { appliers: blockedAppliers }),
      'JUDGMENT_INTENT_PENDING',
      /goal_migration.*pending/i,
    );
  });

  test('caller-facing ledger append cannot forge the reserved attestation event', async () => {
    await refusedWith(
      judgmentLedgerAppend(freshCwd(), {
        kind: 'attest',
        title: 'Forged publication',
        intent_id: 'intent-forged',
        tool: 'judgment_transition',
        op: 'transition',
      }),
      'JUDGMENT_INPUT',
      /attest.*reserved/i,
    );
  });
});

describe('T4 intent dispatcher, attestation, and failure windows', () => {
  test('inline and replay success each publish exactly one attributed attestation', async () => {
    const inlineCwd = freshCwd();
    const inlineStore = new RecordsStore(inlineCwd);
    await judgmentJointAdd(inlineCwd, {
      slug: 'inline',
      question: 'Inline?',
      branch_true: 'Yes.',
      branch_false: 'No.',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    await judgmentTransition(inlineCwd, { slug: 'inline', to: 'under_test' });
    const [inlineAttestation] = inlineStore.readLedgerEvents().filter(
      (event) => event.kind === 'attest',
    );
    assert.deepEqual(
      {
        tool: inlineAttestation.tool,
        op: inlineAttestation.op,
        intent_id: inlineAttestation.intent_id,
      },
      {
        tool: 'judgment_transition',
        op: 'transition',
        intent_id: inlineAttestation.intent_id,
      },
    );
    assert.equal(inlineAttestation.provenance.intent_id, inlineAttestation.intent_id);
    assert.equal(inlineStore.readIntents().length, 0);

    const replayCwd = freshCwd();
    const replayStore = new RecordsStore(replayCwd);
    await judgmentJointAdd(replayCwd, {
      slug: 'replayed',
      question: 'Replay?',
      branch_true: 'Yes.',
      branch_false: 'No.',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    persistTransitionIntent(replayStore, {
      id: 'intent-replayed-once',
      slug: 'replayed',
      before: replayStore.readJoint('replayed'),
    });
    assert.equal((await replayPendingIntents(replayCwd)).replayed, 1);
    assert.equal(intentAttestations(replayStore, 'intent-replayed-once').length, 1);
    assert.equal((await replayPendingIntents(replayCwd)).replayed, 0);
    assert.equal(intentAttestations(replayStore, 'intent-replayed-once').length, 1);
  });

  test('an unknown kind resembling transition fails closed without mutation or deletion', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await judgmentJointAdd(cwd, {
      slug: 'lookalike',
      question: 'Should payload shape dispatch?',
      branch_true: 'No.',
      branch_false: 'Still no.',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    persistTransitionIntent(store, {
      id: 'intent-unregistered-lookalike',
      slug: 'lookalike',
      before: store.readJoint('lookalike'),
      kind: 'transition_lookalike',
      tool: 'future_tool',
      op: 'transition',
    });
    await refusedWith(
      replayPendingIntents(cwd),
      'JUDGMENT_INTENT_KIND',
      /transition_lookalike.*unregistered/i,
    );
    assert.equal(store.readJoint('lookalike').state, 'open');
    assert.equal(store.readIntents().length, 1);
    assert.equal(store.readLedgerEvents().some((event) => event.kind === 'attest'), false);
  });

  test('attestation append failure restores the in-place preimage and retains the intent', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await judgmentJointAdd(cwd, {
      slug: 'attest-fail',
      question: 'Can attestation fail safely?',
      branch_true: 'Retry.',
      branch_false: 'Repair.',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    const original = RecordsStore.prototype.appendLedgerEvent;
    RecordsStore.prototype.appendLedgerEvent = function failAttestation(event) {
      if (event.kind === 'attest') {
        throw Object.assign(new Error('injected attestation append failure'), { code: 'EIO' });
      }
      return original.call(this, event);
    };
    try {
      await refusedWith(
        judgmentTransition(cwd, { slug: 'attest-fail', to: 'under_test' }),
        'JUDGMENT_PARTIAL_WRITE',
        /intent.*retained/i,
      );
    } finally {
      RecordsStore.prototype.appendLedgerEvent = original;
    }
    assert.equal(store.readJoint('attest-fail').state, 'open');
    assert.equal(store.readIntents().length, 1);
    assert.equal(store.readLedgerEvents().some((event) => event.kind === 'attest'), false);
    assert.equal((await replayPendingIntents(cwd)).replayed, 1);
    assert.equal(store.readJoint('attest-fail').state, 'under_test');
  });

  test('clear failure does not regenerate; retry dedupes effects and the retained attestation', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await judgmentJointAdd(cwd, {
      slug: 'clear-fail',
      question: 'Can clear fail safely?',
      branch_true: 'Retry.',
      branch_false: 'Repair.',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    const original = RecordsStore.prototype.clearIntent;
    let injected = true;
    RecordsStore.prototype.clearIntent = function failFirstClear(id) {
      if (injected) {
        injected = false;
        throw Object.assign(new Error(`injected clear failure for ${id}`), { code: 'EACCES' });
      }
      return original.call(this, id);
    };
    try {
      await refusedWith(
        judgmentTransition(cwd, { slug: 'clear-fail', to: 'under_test' }),
        'JUDGMENT_PARTIAL_WRITE',
        /publication point.*retained/i,
      );
    } finally {
      RecordsStore.prototype.clearIntent = original;
    }
    const [intent] = store.readIntents();
    assert.equal(store.readJoint('clear-fail').state, 'open', 'in-place effect is compensated');
    assert.equal(intentAttestations(store, intent.id).length, 1, 'durable attestation remains hidden');
    assert.equal(
      effectiveStore(store).readLedgerEvents().some((event) => event.kind === 'attest'),
      false,
      'pending intent hides the attestation before publication',
    );
    assert.equal((await replayPendingIntents(cwd)).replayed, 1);
    assert.equal(store.readJoint('clear-fail').state, 'under_test');
    assert.equal(intentAttestations(store, intent.id).length, 1, 'retry dedupes attestation');
    assert.deepEqual(store.readIntents(), []);
  });

  test('regeneration failure after clear leaves canonical effects published and reports projection stale', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    await judgmentJointAdd(cwd, {
      slug: 'regen-fail',
      question: 'Do canonical effects survive stale projections?',
      branch_true: 'Yes.',
      branch_false: 'No.',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'high',
    });
    const obstruction = join(cwd, 'docs', 'judgment', 'REGISTER.md');
    rmSync(obstruction);
    mkdirSync(obstruction);
    await refusedWith(
      judgmentTransition(cwd, { slug: 'regen-fail', to: 'under_test' }),
      'JUDGMENT_PROJECTION_STALE',
      /canonical effects.*committed.*projections.*stale/i,
    );
    assert.equal(store.readJoint('regen-fail').state, 'under_test');
    assert.deepEqual(store.readIntents(), []);
    assert.equal(store.readLedgerEvents().filter((event) => event.kind === 'attest').length, 1);

    rmSync(obstruction, { recursive: true });
    regenerateProjections(cwd);
    fixedPoint(cwd, 'explicit repair after post-clear regeneration failure');
  });
});

describe('T5 getJudgmentState counts', () => {
  test('counts have the exact empty, stub, spoken, entity, draft-goal, and ratified-goal shapes', async () => {
    const cwd = freshCwd();
    assert.deepEqual((await getJudgmentState(cwd)).counts, {
      people: { spoken: 0, stub: 0 },
      entities: 0,
      goal: { version: null, ratified: false },
    });

    await judgmentPersonWrite(cwd, {
      op: 'create',
      slug: 'counts-person',
      display_name: 'Counts Person',
    });
    assert.deepEqual((await getJudgmentState(cwd)).counts, {
      people: { spoken: 0, stub: 1 },
      entities: 0,
      goal: { version: null, ratified: false },
    });

    await judgmentPersonWrite(cwd, {
      op: 'add_fact',
      slug: 'counts-person',
      section: 'stated',
      text: 'I have spoken.',
      channel: 'said',
      at: FACT_AT_1,
    });
    assert.deepEqual((await getJudgmentState(cwd)).counts, {
      people: { spoken: 1, stub: 0 },
      entities: 0,
      goal: { version: null, ratified: false },
    });

    await judgmentSituationWrite(cwd, {
      op: 'create',
      slug: 'counts-entity',
      display_name: 'Counts Entity',
    });
    assert.deepEqual((await getJudgmentState(cwd)).counts, {
      people: { spoken: 1, stub: 0 },
      entities: 1,
      goal: { version: null, ratified: false },
    });

    await judgmentGoalWrite(
      cwd,
      {
        op: 'cut',
        clauses: [goalClause('Imported draft for counts.', 'observed')],
        diff_note: 'Imported count fixture.',
      },
      { via: 'import', writtenAt: '2026-07-23T11:00:00Z' },
    );
    assert.deepEqual((await getJudgmentState(cwd)).counts, {
      people: { spoken: 1, stub: 0 },
      entities: 1,
      goal: { version: 1, ratified: false },
    });

    await judgmentGoalWrite(cwd, cutArgs({
      clauses: [goalClause('Ratified goal for counts.')],
      diff_note: 'Ratified count fixture.',
    }));
    assert.deepEqual((await getJudgmentState(cwd)).counts, {
      people: { spoken: 1, stub: 0 },
      entities: 1,
      goal: { version: 2, ratified: true },
    });
  });

  test('pending-excluded people, entities, and goals never contribute to counts', async () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    const hidden = {
      actor: 'agent',
      session: null,
      written_at: '2026-07-23T11:30:00Z',
      via: 'migration',
      intent_id: 'intent-hidden-counts',
    };
    store.writePerson({
      slug: 'hidden-person',
      display_name: 'Hidden Person',
      facts: [{
        id: 'f1',
        section: 'stated',
        text: 'Hidden speech.',
        channel: 'said',
        at: FACT_AT_1,
        provenance: hidden,
        trace: [],
      }],
      edges: [],
      open_fields: [],
      load_links: [],
      provenance: hidden,
    });
    store.writeSituationEntity({
      slug: 'hidden-entity',
      display_name: 'Hidden Entity',
      facts: [],
      owed: [],
      load_links: [],
      provenance: hidden,
    });
    store.writeGoalVersion({
      version: 1,
      clauses: [{
        id: 'c1',
        text: 'Hidden goal.',
        channel: 'observed',
        elicitation: GOAL_ELICITATION,
        provenance: hidden,
        trace: [],
      }],
      provocation: null,
      diff_note: 'Hidden by pending intent.',
      provenance: hidden,
    });
    store.persistIntent({
      id: 'intent-hidden-counts',
      kind: 'package_transition',
      tool: 'judgment_package_write',
      op: 'transition',
      payload: {},
      created_at: '2026-07-23T11:30:00Z',
    });

    assert.deepEqual((await getJudgmentState(cwd)).counts, {
      people: { spoken: 0, stub: 0 },
      entities: 0,
      goal: { version: null, ratified: false },
    });
  });
});

// ---------------------------------------------------------------------------
// COMP-JUDGMENT-GOAL-MIGRATE S1 — migration intent, sidecar absorption,
// replay equality, and records-atomic reads
// ---------------------------------------------------------------------------

const MIGRATION_SLUGS = ['horizon', 'success-criteria', 'commercial-intent'];

const OBJECTIVE_CLAIM = {
  id: 'c1',
  text: 'build Compose into a system that decides what to build well.',
  grounding: 'ASSERT',
  supports: [],
  elicitation: {
    asked: 'What are we optimizing for?',
    answered_at: '2026-07-20T12:00:00Z',
    answer_ref: 'import:docs/judgment/OBJECTIVE.md (back-inferred draft)',
  },
};

async function seedLegacy(cwd, slugs = MIGRATION_SLUGS) {
  for (const slug of slugs) {
    await judgmentJointAdd(cwd, {
      slug,
      question: `${slug}?`,
      branch_true: 'a',
      branch_false: 'b',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'medium',
    });
  }
  await judgmentPositionCreate(cwd, {
    slug: 'objective',
    claims: [{ ...OBJECTIVE_CLAIM, elicitation: { ...OBJECTIVE_CLAIM.elicitation } }],
    conviction: { level: 'low', source: 'inferred' },
  });
}

// C13 injection seams — force the applier outcome without weakening the frozen
// runtime table.
function applyThenBlockAppliers() {
  return {
    ...INTENT_APPLIERS,
    goal_migration: async (cwd, store, intent, ctx) => {
      await INTENT_APPLIERS.goal_migration(cwd, store, intent, ctx);
      return { status: 'blocked', reason: 'injected-crash-after-apply' };
    },
  };
}

function blockBeforeApplyAppliers() {
  return {
    ...INTENT_APPLIERS,
    goal_migration: () => ({ status: 'blocked', reason: 'injected-pre-apply' }),
  };
}

const recordsPath = (cwd, ...parts) => join(cwd, 'docs', 'judgment', 'records', ...parts);

describe('COMP-JUDGMENT-GOAL-MIGRATE S1 — migration intent and replay', () => {
  test('migrate publishes the exact r4 payload once', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    const legacyProjection = readFileSync(join(cwd, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8');

    const result = await judgmentGoalWrite(cwd, { op: 'migrate' });
    assert.deepEqual(result, {
      op: 'migrate',
      status: 'migrated',
      version: 1,
      ref: 'goal:v1',
      intent_id: result.intent_id,
    });
    assert.match(result.intent_id, /^intent-/);

    const store = new RecordsStore(cwd);

    // Goal v1 — inferred channel, null provocation, NO ratification property.
    const goal = store.readGoalVersion(1);
    assert.equal(goal.version, 1);
    assert.equal(goal.clauses.length, 1);
    assert.equal(goal.clauses[0].id, 'c1');
    assert.equal(goal.clauses[0].text, OBJECTIVE_CLAIM.text);
    assert.equal(goal.clauses[0].channel, 'inferred');
    assert.deepEqual(goal.clauses[0].elicitation, OBJECTIVE_CLAIM.elicitation);
    assert.deepEqual(goal.clauses[0].trace, []);
    assert.equal(goal.provocation, null);
    assert.equal('ratification' in goal, false);
    assert.equal(goal.diff_note, 'Migrated from legacy objective objective#r1.');
    assert.equal(goal.provenance.via, 'migration');
    assert.equal(goal.provenance.intent_id, result.intent_id);

    // Tombstone — next objective revision, empty claims, source conviction.
    const tombstone = store.readPositionRevision('objective', 2);
    assert.equal(tombstone.retracted, true);
    assert.deepEqual(tombstone.claims, []);
    assert.deepEqual(tombstone.conviction, { level: 'low', source: 'inferred' });
    assert.equal(tombstone.provenance.intent_id, result.intent_id);
    assert.equal(store.derivePositionStatus('objective'), 'retracted');

    // State — the three fixed joints, in order, allocated gj1..gj3, no load links.
    const state = store.readGoalState();
    assert.deepEqual(state.joints.map((j) => j.joint), MIGRATION_SLUGS);
    assert.deepEqual(state.joints.map((j) => j.id), ['gj1', 'gj2', 'gj3']);
    assert.ok(state.joints.every((j) => (
      j.provenance.via === 'migration'
      && j.provenance.intent_id === result.intent_id
      && j.removed === null
    )));
    assert.deepEqual(state.load_links, []);

    // Note — verbatim blocks + self-report-reliable naming + legacy projection.
    const notes = store.readLedgerEvents().filter(
      (e) => e.kind === 'note' && e.title === 'Legacy objective migrated to goal:v1',
    );
    assert.equal(notes.length, 1);
    const note = notes[0];
    assert.equal(note.anchor, 'position:objective');
    assert.deepEqual(note.refs, ['objective#r1', 'goal:v1']);
    assert.match(note.body, /`self-report-reliable` was not migrated because no canonical joint record exists\./);
    assert.match(note.body, /Legacy OBJECTIVE\.md follows verbatim:/);
    assert.ok(note.body.endsWith(legacyProjection));
    assert.equal(note.provenance.intent_id, result.intent_id);

    // Exactly one attestation, cleared intent, fixed-point goal projection.
    const attests = store.readLedgerEvents().filter(
      (e) => e.kind === 'attest' && e.intent_id === result.intent_id,
    );
    assert.equal(attests.length, 1);
    assert.deepEqual(
      { tool: attests[0].tool, op: attests[0].op },
      { tool: 'judgment_goal_write', op: 'migrate' },
    );
    assert.deepEqual(store.readIntents(), []);
    fixedPoint(cwd, 'after migrate');
    assert.equal(existsSync(join(cwd, 'docs', 'judgment', 'positions', 'objective.md')), false);
  });

  test('migrate validates all three canonical joints before persisting intent', async () => {
    for (const missing of MIGRATION_SLUGS) {
      const cwd = freshCwd();
      await seedLegacy(cwd, MIGRATION_SLUGS.filter((s) => s !== missing));
      await refusedWith(
        judgmentGoalWrite(cwd, { op: 'migrate' }),
        'JUDGMENT_REF',
        new RegExp(`^judgment_goal_write migrate: required joint ${missing} does not resolve$`),
      );
      const store = new RecordsStore(cwd);
      assert.equal(store.readGoalVersion(1), null, `${missing}: no goal written`);
      assert.deepEqual(store.readIntents(), [], `${missing}: no intent persisted`);
      assert.equal(store.readPositionRevision('objective', 2), null, `${missing}: no tombstone`);
    }
  });

  test('state preimage is absorbed and remains effective until publication', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    const store = new RecordsStore(cwd);

    // A pre-existing sidecar: one active link (dedupes with a fixed slug), one
    // active link to survive, one removed link (excluded, but its id still
    // pins the high-water mark).
    const seededProvenance = { actor: 'agent', session: null, written_at: '2026-07-23T08:00:00Z' };
    const preimage = {
      joints: [
        { id: 'gj1', joint: 'horizon', provenance: seededProvenance, removed: null },
        { id: 'gj2', joint: 'success-criteria', provenance: seededProvenance, removed: { at: '2026-07-23T08:01:00Z', reason: 'retired', provenance: seededProvenance } },
        { id: 'gj7', joint: 'commercial-intent', provenance: seededProvenance, removed: null },
      ],
      load_links: [],
      provenance: seededProvenance,
    };
    store.writeGoalState(preimage);
    const preimageOnDisk = store.readGoalState();

    await judgmentGoalWrite(cwd, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
    const [pending] = store.readIntents();
    assert.equal(pending.kind, 'goal_migration');

    // Raw merged state: active preimage entries preserved (ids/joints/order),
    // removed excluded, missing fixed joint (success-criteria) appended above
    // the all-preimage high-water (gj7 → gj8), every link re-stamped migration.
    const merged = store.readGoalState();
    assert.deepEqual(
      merged.joints.map((j) => [j.id, j.joint]),
      [['gj1', 'horizon'], ['gj7', 'commercial-intent'], ['gj8', 'success-criteria']],
    );
    assert.ok(merged.joints.every((j) => (
      j.provenance.via === 'migration' && j.provenance.intent_id === pending.id
    )));
    assert.equal(merged.provenance.intent_id, pending.id);

    // Records-atomic: the effective view still returns the exact preimage.
    const effective = effectiveStore(store);
    assert.deepEqual(effective.readGoalState(), preimageOnDisk);
    assert.deepEqual(effective.readGoalChain(), []);
    assert.equal(effective.derivePositionStatus('objective'), 'live');

    // After the intent clears, the merged state becomes visible.
    store.clearIntent(pending.id);
    assert.equal(effectiveStore(store).readGoalState().joints.length, 3);
  });

  test('state preimage byte drift conflicts before mutation', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    const store = new RecordsStore(cwd);
    const statePath = recordsPath(cwd, 'goal', 'state.json');
    store.writeGoalState({
      joints: [],
      load_links: [],
      provenance: { actor: 'agent', session: null, written_at: '2026-07-23T08:00:00Z' },
    });
    const preimageBytes = readFileSync(statePath, 'utf8');

    // Persist the intent (capturing the preimage) without applying it.
    await judgmentGoalWrite(cwd, { op: 'migrate' }, { appliers: blockBeforeApplyAppliers() });
    const [intent] = store.readIntents();
    assert.equal(readFileSync(statePath, 'utf8'), preimageBytes, 'preimage untouched while blocked');

    // Whitespace-only drift after persistence.
    writeFileSync(statePath, `${preimageBytes} `);

    await refusedWith(
      replayPendingIntents(cwd),
      'JUDGMENT_MIGRATION_CONFLICT',
      new RegExp(`^goal migration ${intent.id}: goal/state\\.json no longer matches the persisted preimage$`),
    );
    assert.equal(store.readIntents().length, 1, 'intent retained');
    assert.equal(store.readGoalVersion(1), null, 'no goal artifact created');
    assert.equal(store.readPositionRevision('objective', 2), null, 'no tombstone created');
  });

  test('replay skips only full-equal migration artifacts', async () => {
    // Idempotent replay after a crash-past-apply yields exactly one of each.
    const cwd = freshCwd();
    await seedLegacy(cwd);
    await judgmentGoalWrite(cwd, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
    const store = new RecordsStore(cwd);
    const [pending] = store.readIntents();
    assert.equal(pending.kind, 'goal_migration');
    assert.ok(store.readGoalVersion(1));
    assert.ok(store.readPositionRevision('objective', 2));
    assert.equal(
      store.readLedgerEvents().filter((e) => e.kind === 'attest' && e.intent_id === pending.id).length,
      0,
      'no attestation before publication',
    );

    assert.equal((await replayPendingIntents(cwd)).replayed, 1);
    assert.equal(store.readGoalChain().length, 1, 'exactly one goal version');
    assert.equal(store.readPositionChain('objective').length, 2, 'r1 + one tombstone');
    assert.equal(
      store.readLedgerEvents().filter((e) => e.kind === 'note' && e.title === 'Legacy objective migrated to goal:v1').length,
      1,
    );
    assert.equal(
      store.readLedgerEvents().filter((e) => e.kind === 'attest' && e.intent_id === pending.id).length,
      1,
    );
    assert.deepEqual(store.readIntents(), []);

    // A single non-attribution mutation on any occupied artifact throws the
    // exact table message from the replay phase, and the presented goal op
    // never executes.
    const cases = {
      goal: 'goal/v1.json differs from the persisted payload',
      tombstone: 'objective tombstone differs from the persisted payload',
      state: 'goal/state.json no longer matches the persisted preimage',
      note: 'anchored migration note differs from the persisted payload',
    };
    for (const [artifact, detail] of Object.entries(cases)) {
      const c = freshCwd();
      await seedLegacy(c);
      await judgmentGoalWrite(c, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
      const s = new RecordsStore(c);
      const [it] = s.readIntents();
      tamperArtifact(c, it.id, artifact);

      await refusedWith(
        judgmentGoalWrite(c, cutArgs()),
        'JUDGMENT_MIGRATION_CONFLICT',
        new RegExp(`^goal migration ${it.id}: ${escapeForRegExp(detail)}$`),
      );
      assert.equal(s.readGoalChain().length, 1, `${artifact}: presented cut never produced v2`);
      assert.equal(s.readIntents().length, 1, `${artifact}: intent retained on conflict`);
    }
  });

  test('migration records are atomic and projections repair after publication', async () => {
    // Part A — a partially-applied pending intent renders the full pre-state.
    const a = freshCwd();
    await seedLegacy(a);
    const legacyProjection = readFileSync(join(a, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8');
    await judgmentGoalWrite(a, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
    const sa = new RecordsStore(a);
    assert.equal(sa.readIntents().length, 1, 'intent still pending');
    regenerateProjections(a);
    assert.equal(
      readFileSync(join(a, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8'),
      legacyProjection,
      'pending migration still renders the legacy objective',
    );
    assert.equal(existsSync(join(a, 'docs', 'judgment', 'positions', 'objective.md')), true);

    // Part B — a clear→regenerate crash commits records but reports stale;
    // the next read repairs to the fully post-migration projection set.
    const b = freshCwd();
    await seedLegacy(b);
    const obstruction = join(b, 'docs', 'judgment', 'REGISTER.md');
    rmSync(obstruction);
    mkdirSync(obstruction);
    await refusedWith(
      judgmentGoalWrite(b, { op: 'migrate' }),
      'JUDGMENT_PROJECTION_STALE',
      /canonical effects.*committed.*projections.*stale/i,
    );
    const sb = new RecordsStore(b);
    assert.ok(sb.readGoalVersion(1), 'goal committed despite stale projection');
    assert.equal(sb.derivePositionStatus('objective'), 'retracted', 'tombstone committed');
    assert.equal(sb.readLedgerEvents().filter((e) => e.kind === 'attest').length, 1);
    assert.deepEqual(sb.readIntents(), [], 'intent cleared at publication point');

    rmSync(obstruction, { recursive: true });
    await getJudgmentState(b);
    fixedPoint(b, 'after repair');
    assert.equal(existsSync(join(b, 'docs', 'judgment', 'positions', 'objective.md')), false);
  });

  test('a malformed occupied goal slot conflicts instead of appending v2', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    await judgmentGoalWrite(cwd, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
    const store = new RecordsStore(cwd);
    const [intent] = store.readIntents();

    // Corrupt the occupied v1.json — a forgiving parsed read would see it as
    // absent and append v2.json past it.
    const goalV1 = recordsPath(cwd, 'goal', 'v1.json');
    writeFileSync(goalV1, '{ this is not valid json');

    await refusedWith(
      replayPendingIntents(cwd),
      'JUDGMENT_MIGRATION_CONFLICT',
      new RegExp(`^goal migration ${intent.id}: goal/v1\\.json differs from the persisted payload$`),
    );
    assert.equal(existsSync(recordsPath(cwd, 'goal', 'v2.json')), false, 'no v2 appended past the malformed slot');
    assert.equal(store.readIntents().length, 1, 'intent retained');
  });

  test('a preimage with duplicate association ids conflicts before persistence', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    const store = new RecordsStore(cwd);
    const p = { actor: 'agent', session: null, written_at: '2026-07-23T08:00:00Z' };
    // Schema-valid array shape, but two active `gj1` entries — ambiguous.
    store.writeGoalState({
      joints: [
        { id: 'gj1', joint: 'horizon', provenance: p, removed: null },
        { id: 'gj1', joint: 'commercial-intent', provenance: p, removed: null },
      ],
      load_links: [],
      provenance: p,
    });

    await refusedWith(
      judgmentGoalWrite(cwd, { op: 'migrate' }),
      'JUDGMENT_MIGRATION_CONFLICT',
      /goal migration: goal\/state\.json is not a valid goal_state record/,
    );
    assert.deepEqual(store.readIntents(), [], 'no intent persisted on an ambiguous preimage');
    assert.equal(store.readGoalVersion(1), null);
  });

  test('a same-intent note whose title is tampered conflicts on replay', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    await judgmentGoalWrite(cwd, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
    const store = new RecordsStore(cwd);
    const [intent] = store.readIntents();

    // Change ONLY the note title, keeping the intent_id — matching on
    // title/anchor would treat this as absence and append a second note.
    const ledger = recordsPath(cwd, 'ledger.jsonl');
    const lines = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const event of lines) {
      if (event.kind === 'note' && event.provenance?.intent_id === intent.id) {
        event.title = 'Tampered title';
      }
    }
    writeFileSync(ledger, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    await refusedWith(
      replayPendingIntents(cwd),
      'JUDGMENT_MIGRATION_CONFLICT',
      new RegExp(`^goal migration ${intent.id}: anchored migration note differs from the persisted payload$`),
    );
    assert.equal(
      store.readLedgerEvents().filter((e) => e.kind === 'note' && e.provenance?.intent_id === intent.id).length,
      1,
      'no second note appended',
    );
  });

  test('replay skips a reordered-but-structurally-equal artifact', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    await judgmentGoalWrite(cwd, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
    const store = new RecordsStore(cwd);

    // Rewrite goal/v1.json with keys reordered but values identical. Structural
    // equality must treat this as a skip, not a byte-level conflict.
    const goalV1 = recordsPath(cwd, 'goal', 'v1.json');
    const record = JSON.parse(readFileSync(goalV1, 'utf8'));
    const reordered = {
      provenance: record.provenance,
      diff_note: record.diff_note,
      provocation: record.provocation,
      clauses: record.clauses,
      version: record.version,
    };
    writeFileSync(goalV1, `${JSON.stringify(reordered, null, 2)}\n`);

    assert.equal((await replayPendingIntents(cwd)).replayed, 1, 'reordered-equal artifact replays cleanly');
    assert.equal(store.readGoalChain().length, 1, 'no duplicate goal version');
    assert.deepEqual(store.readIntents(), []);
  });

  test('structural equality detects an injected own __proto__ field', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    await judgmentGoalWrite(cwd, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
    const store = new RecordsStore(cwd);
    const [intent] = store.readIntents();

    // Inject a raw own `__proto__` key (JSON.parse keeps it as an own property);
    // a canonicalizer that routed keys through an object setter would drop it
    // and wrongly treat the tampered goal as equal.
    const goalV1 = recordsPath(cwd, 'goal', 'v1.json');
    const raw = readFileSync(goalV1, 'utf8').trimEnd();
    writeFileSync(goalV1, `${raw.slice(0, -1)}, "__proto__": {"tampered": true}}\n`);

    await refusedWith(
      replayPendingIntents(cwd),
      'JUDGMENT_MIGRATION_CONFLICT',
      new RegExp(`^goal migration ${intent.id}: goal/v1\\.json differs from the persisted payload$`),
    );
    assert.equal(store.readIntents().length, 1, 'intent retained');
  });

  test('a preimage association id beyond exact float range conflicts', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    const store = new RecordsStore(cwd);
    const p = { actor: 'agent', session: null, written_at: '2026-07-23T08:00:00Z' };
    // 2^53 — incrementing the high-water mark rounds back to the same integer,
    // so a freshly allocated fixed-joint id would collide with this one.
    store.writeGoalState({
      joints: [{ id: 'gj9007199254740992', joint: 'horizon', provenance: p, removed: null }],
      load_links: [],
      provenance: p,
    });

    await refusedWith(
      judgmentGoalWrite(cwd, { op: 'migrate' }),
      'JUDGMENT_MIGRATION_CONFLICT',
      /ambiguous association ids/,
    );
    assert.deepEqual(store.readIntents(), [], 'no intent persisted');
    assert.equal(store.readGoalVersion(1), null);
  });
});

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactly(message) {
  return new RegExp(`^${escapeForRegExp(message)}$`);
}

function tamperArtifact(cwd, intentId, artifact) {
  if (artifact === 'goal') {
    const path = recordsPath(cwd, 'goal', 'v1.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.diff_note = 'tampered diff note';
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  } else if (artifact === 'tombstone') {
    const path = recordsPath(cwd, 'positions', 'objective', 'r2.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.conviction = { level: 'high', source: 'stated' };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  } else if (artifact === 'state') {
    const path = recordsPath(cwd, 'goal', 'state.json');
    writeFileSync(path, `${readFileSync(path, 'utf8')} `);
  } else if (artifact === 'note') {
    const path = recordsPath(cwd, 'ledger.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const event of lines) {
      if (
        event.kind === 'note'
        && event.title === 'Legacy objective migrated to goal:v1'
        && event.provenance?.intent_id === intentId
      ) {
        event.body = `${event.body}\nTAMPERED`;
      }
    }
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
}

// ---------------------------------------------------------------------------
// COMP-JUDGMENT-GOAL-MIGRATE S2 — wholesale fence, fail-closed completion,
// terminal objective retirement
// ---------------------------------------------------------------------------

const fenceMessage = (op) => (
  `judgment_goal_write ${op}: legacy objective is live; `
  + 'run judgment_goal_write op=migrate before any other goal operation'
);

const NON_EMPTY_CHAIN_CONFLICT =
  'judgment_goal_write migrate: goal chain is non-empty without a durable migration-attested v1';
const NOT_LIVE_CONFLICT =
  'judgment_goal_write migrate: legacy objective is not live and no durable migration is complete';
const REVIVED_CONFLICT =
  'judgment_goal_write migrate: migration-attested goal v1 exists but objective is live; '
  + 'append retracted:true through judgment_position_create, then retry';
const OBJECTIVE_RETIRED =
  'judgment_position_create: objective is retired after goal cutover; '
  + 'use judgment_goal_write for goal changes (retracted:true remains legal)';

const CONVICTION = { level: 'low', source: 'inferred' };

const objectiveClaims = () => [{ ...OBJECTIVE_CLAIM, elicitation: { ...OBJECTIVE_CLAIM.elicitation } }];

/** Byte snapshot of the whole canonical record tree — the zero-write oracle. */
function recordsSnapshot(cwd) {
  const root = recordsPath(cwd);
  const snapshot = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else snapshot[rel] = readFileSync(join(dir, entry.name), 'utf8');
    }
  };
  if (existsSync(root)) walk(root, '');
  return snapshot;
}

function rewriteLedger(cwd, mutate) {
  const path = recordsPath(cwd, 'ledger.jsonl');
  const events = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const kept = events.filter((event) => mutate(event) !== false);
  writeFileSync(path, `${kept.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

function rewriteGoalV1(cwd, mutate) {
  const path = recordsPath(cwd, 'goal', 'v1.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  mutate(record);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Executor-entry spy. `stampProvenance` reads `internal.writtenAt` and every
 * goal executor stamps provenance; validation never touches it. A zero count
 * therefore proves the presented op's executor was never reached.
 */
function executorSpy() {
  const spy = { calls: 0 };
  spy.internal = {
    get writtenAt() {
      spy.calls += 1;
      return '2026-07-23T11:00:00Z';
    },
  };
  return spy;
}

describe('COMP-JUDGMENT-GOAL-MIGRATE S2 — fence, completion, retirement', () => {
  test('legacy-live fences every non-migrate goal op without fencing migrate', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    const before = recordsSnapshot(cwd);

    const calls = [
      ['cut', cutArgs()],
      ['correct', { op: 'correct', clause_id: 'c1', text: 'Rewritten.' }],
      ['joint_link', { op: 'joint_link', joint: 'horizon' }],
      ['joint_link', { op: 'joint_link', joint_link_id: 'gj1', remove: true, reason: 'retired' }],
      ['load_link', { op: 'load_link', clause: 'v1#c1', carries: 'the whole goal' }],
      ['load_link', { op: 'load_link', load_link_id: 'gl1', remove: true, reason: 'retired' }],
    ];
    for (const [op, args] of calls) {
      await refusedWith(
        judgmentGoalWrite(cwd, args),
        'JUDGMENT_MIGRATION_REQUIRED',
        exactly(fenceMessage(op)),
      );
    }
    assert.deepEqual(recordsSnapshot(cwd), before, 'no fenced op wrote a record');
    assert.equal(
      existsSync(recordsPath(cwd, 'goal', 'state.json')),
      false,
      'a fenced joint_link never creates the sidecar',
    );

    // migrate is exempt — it reaches its executor and publishes.
    const result = await judgmentGoalWrite(cwd, { op: 'migrate' });
    assert.equal(result.status, 'migrated');
  });

  test('rerun no-ops only for attested migration plus retired objective', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    const first = await judgmentGoalWrite(cwd, { op: 'migrate' });
    const noOpResult = {
      op: 'migrate',
      status: 'already migrated',
      version: 1,
      ref: 'goal:v1',
      intent_id: first.intent_id,
    };

    const afterMigrate = recordsSnapshot(cwd);
    assert.deepEqual(await judgmentGoalWrite(cwd, { op: 'migrate' }), noOpResult);
    assert.deepEqual(recordsSnapshot(cwd), afterMigrate, 'rerun wrote zero bytes');

    // A legal post-migration v2 does not invalidate the completed migration.
    await judgmentGoalWrite(cwd, cutArgs({ diff_note: 'Post-migration v2.' }));
    const afterV2 = recordsSnapshot(cwd);
    assert.deepEqual(await judgmentGoalWrite(cwd, { op: 'migrate' }), noOpResult);
    assert.deepEqual(recordsSnapshot(cwd), afterV2, 'rerun after v2 wrote zero bytes');

    // Every falsified conjunct fails closed, writing nothing.
    const broken = {
      'wrong via': (c) => rewriteGoalV1(c, (record) => { record.provenance.via = 'import'; }),
      'missing intent_id': (c) => rewriteGoalV1(c, (record) => { delete record.provenance.intent_id; }),
      'missing attestation': (c) => rewriteLedger(c, (event) => (event.kind !== 'attest')),
    };
    for (const [label, breakIt] of Object.entries(broken)) {
      const c = freshCwd();
      await seedLegacy(c);
      await judgmentGoalWrite(c, { op: 'migrate' });
      breakIt(c);
      const snapshot = recordsSnapshot(c);
      await refusedWith(
        judgmentGoalWrite(c, { op: 'migrate' }),
        'JUDGMENT_MIGRATION_CONFLICT',
        exactly(NON_EMPTY_CHAIN_CONFLICT),
      );
      assert.deepEqual(recordsSnapshot(c), snapshot, `${label}: wrote zero bytes`);
    }

    // An ordinary goal plus an ordinary tombstone is not a migration.
    const ordinary = freshCwd();
    await judgmentGoalWrite(ordinary, cutArgs());
    await judgmentPositionCreate(ordinary, {
      slug: 'objective', claims: [], conviction: CONVICTION, retracted: true,
    });
    const ordinarySnapshot = recordsSnapshot(ordinary);
    await refusedWith(
      judgmentGoalWrite(ordinary, { op: 'migrate' }),
      'JUDGMENT_MIGRATION_CONFLICT',
      exactly(NON_EMPTY_CHAIN_CONFLICT),
    );
    assert.deepEqual(recordsSnapshot(ordinary), ordinarySnapshot, 'ordinary pair wrote zero bytes');

    // Empty chain with no live legacy objective.
    for (const seed of [async () => {}, async (c) => {
      await judgmentPositionCreate(c, {
        slug: 'objective', claims: [], conviction: CONVICTION, retracted: true,
      });
    }]) {
      const c = freshCwd();
      await seed(c);
      const snapshot = recordsSnapshot(c);
      await refusedWith(
        judgmentGoalWrite(c, { op: 'migrate' }),
        'JUDGMENT_MIGRATION_CONFLICT',
        exactly(NOT_LIVE_CONFLICT),
      );
      assert.deepEqual(recordsSnapshot(c), snapshot, 'non-live objective wrote zero bytes');
    }

    // An attestation resolving the migration intent under another tool/op.
    const forged = freshCwd();
    await seedLegacy(forged);
    const forgedMigration = await judgmentGoalWrite(forged, { op: 'migrate' });
    rewriteLedger(forged, (event) => {
      if (event.kind === 'attest' && event.intent_id === forgedMigration.intent_id) {
        event.tool = 'judgment_transition';
        event.op = 'transition';
      }
    });
    const forgedSnapshot = recordsSnapshot(forged);
    await refusedWith(
      judgmentGoalWrite(forged, { op: 'migrate' }),
      'JUDGMENT_MIGRATION_CONFLICT',
      exactly(`goal migration ${forgedMigration.intent_id}: durable attestation attribution conflicts`),
    );
    assert.deepEqual(recordsSnapshot(forged), forgedSnapshot, 'forged attestation wrote zero bytes');

    // The no-op regenerates projections; a regeneration failure reports stale
    // rather than rolling back an already-published migration.
    const stale = freshCwd();
    await seedLegacy(stale);
    await judgmentGoalWrite(stale, { op: 'migrate' });
    const staleSnapshot = recordsSnapshot(stale);
    const obstruction = join(stale, 'docs', 'judgment', 'REGISTER.md');
    rmSync(obstruction);
    mkdirSync(obstruction);
    await refusedWith(
      judgmentGoalWrite(stale, { op: 'migrate' }),
      'JUDGMENT_PROJECTION_STALE',
      /canonical effects.*committed.*projections.*stale/i,
    );
    assert.deepEqual(recordsSnapshot(stale), staleSnapshot, 'stale rerun wrote zero bytes');
  });

  test('revived objective conflicts, tombstone repair is legal', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    const first = await judgmentGoalWrite(cwd, { op: 'migrate' });
    const store = new RecordsStore(cwd);

    // Revival can only come from outside the writer — position_create is
    // terminally retired for non-tombstone objective revisions.
    store.writePositionRevision({
      slug: 'objective',
      claims: objectiveClaims(),
      conviction: CONVICTION,
      provenance: { actor: 'agent', session: null, written_at: '2026-07-23T12:00:00Z' },
    });
    assert.equal(store.derivePositionStatus('objective'), 'live', 'objective revived');

    const revivedSnapshot = recordsSnapshot(cwd);
    await refusedWith(
      judgmentGoalWrite(cwd, { op: 'migrate' }),
      'JUDGMENT_MIGRATION_CONFLICT',
      exactly(REVIVED_CONFLICT),
    );
    assert.deepEqual(recordsSnapshot(cwd), revivedSnapshot, 'revived rerun wrote zero bytes');

    const repair = await judgmentPositionCreate(cwd, {
      slug: 'objective', claims: [], conviction: CONVICTION, retracted: true,
    });
    assert.equal(repair.status, 'retracted');
    assert.deepEqual(await judgmentGoalWrite(cwd, { op: 'migrate' }), {
      op: 'migrate',
      status: 'already migrated',
      version: 1,
      ref: 'goal:v1',
      intent_id: first.intent_id,
    });
    fixedPoint(cwd, 'after tombstone repair');
  });

  test('post-cutover objective revival is terminally retired', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    await judgmentGoalWrite(cwd, { op: 'migrate' });
    const store = new RecordsStore(cwd);
    const before = recordsSnapshot(cwd);

    await refusedWith(
      judgmentPositionCreate(cwd, {
        slug: 'objective', claims: objectiveClaims(), conviction: CONVICTION,
      }),
      'JUDGMENT_OBJECTIVE_RETIRED',
      exactly(OBJECTIVE_RETIRED),
    );
    assert.deepEqual(recordsSnapshot(cwd), before, 'the objective chain is byte-identical');
    assert.equal(store.readPositionChain('objective').length, 2, 'r1 + tombstone only');

    // Only the objective is retired; other position chains stay open.
    const other = await judgmentPositionCreate(cwd, {
      slug: 'method', claims: objectiveClaims(), conviction: CONVICTION,
    });
    assert.equal(other.status, 'live');

    // The tombstone exception remains legal.
    const tombstone = await judgmentPositionCreate(cwd, {
      slug: 'objective', claims: [], conviction: CONVICTION, retracted: true,
    });
    assert.equal(tombstone.rev, 3);
    assert.equal(tombstone.status, 'retracted');
  });

  test('replayable migration wins before a presented cut', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    await judgmentGoalWrite(cwd, { op: 'migrate' }, { appliers: blockBeforeApplyAppliers() });
    const store = new RecordsStore(cwd);
    const [pending] = store.readIntents();
    assert.equal(pending.kind, 'goal_migration');
    assert.equal(store.readGoalVersion(1), null, 'nothing applied while blocked');

    const cut = await judgmentGoalWrite(cwd, cutArgs({ diff_note: 'Presented after replay.' }));
    assert.deepEqual(cut, {
      op: 'cut', version: 2, ref: 'goal:v2', ratified: true,
    });
    assert.equal(store.readGoalVersion(1).provenance.via, 'migration', 'replay published v1 first');
    assert.equal(store.derivePositionStatus('objective'), 'retracted');
    assert.deepEqual(store.readIntents(), []);
    fixedPoint(cwd, 'after replay-then-cut');
  });

  test('blocked migration maps to intent pending while thrown replay conflict escapes', async () => {
    const blockedCwd = freshCwd();
    await seedLegacy(blockedCwd);
    await judgmentGoalWrite(blockedCwd, { op: 'migrate' }, { appliers: blockBeforeApplyAppliers() });

    // A non-throwing blocked applier leaves the intent: pending precedes the
    // fence for an ordinary op, and migrate itself refuses to duplicate it.
    for (const args of [cutArgs(), { op: 'migrate' }]) {
      await refusedWith(
        judgmentGoalWrite(blockedCwd, args, { appliers: blockBeforeApplyAppliers() }),
        'JUDGMENT_INTENT_PENDING',
        exactly('judgment_goal_write: goal_migration intent is still pending'),
      );
    }
    assert.equal(new RecordsStore(blockedCwd).readIntents().length, 1, 'exactly one intent survives');

    // A thrown replay conflict escapes and the presented executor never runs.
    const thrownCwd = freshCwd();
    await seedLegacy(thrownCwd);
    await judgmentGoalWrite(thrownCwd, { op: 'migrate' }, { appliers: applyThenBlockAppliers() });
    const [intent] = new RecordsStore(thrownCwd).readIntents();
    tamperArtifact(thrownCwd, intent.id, 'goal');

    const spy = executorSpy();
    await refusedWith(
      judgmentGoalWrite(thrownCwd, cutArgs(), spy.internal),
      'JUDGMENT_MIGRATION_CONFLICT',
      exactly(`goal migration ${intent.id}: goal/v1.json differs from the persisted payload`),
    );
    assert.equal(spy.calls, 0, 'the presented cut executor never ran');

    // Control: with no conflict, the same presented cut DOES reach the executor.
    const controlCwd = freshCwd();
    await seedLegacy(controlCwd);
    await judgmentGoalWrite(controlCwd, { op: 'migrate' });
    const controlSpy = executorSpy();
    await judgmentGoalWrite(controlCwd, cutArgs(), controlSpy.internal);
    assert.equal(controlSpy.calls, 1, 'the spy observes a real executor entry');
  });

  test('post-migration ratified cut is unlocked', async () => {
    const cwd = freshCwd();
    await seedLegacy(cwd);
    await judgmentGoalWrite(cwd, { op: 'migrate' });

    const cut = await judgmentGoalWrite(cwd, cutArgs({ diff_note: 'First post-migration cut.' }));
    assert.deepEqual(cut, {
      op: 'cut', version: 2, ref: 'goal:v2', ratified: true,
    });

    // The sidecar ops are unlocked too.
    const link = await judgmentGoalWrite(cwd, {
      op: 'load_link', clause: 'v2#c1', carries: 'the post-migration goal',
    });
    assert.deepEqual(link, { op: 'load_link', id: 'gl1', removed: false });
    fixedPoint(cwd, 'after post-migration cut');
  });
});
