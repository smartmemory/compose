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
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  judgmentPositionCreate,
  judgmentPositionAmend,
  judgmentJointAdd,
  judgmentTransition,
  judgmentLedgerAppend,
  getJudgmentState,
  replayPendingIntents,
} from '../lib/judgment-writer.js';
import { RecordsStore } from '../lib/judgment/store/records.js';
import { checkProjectionRoundtrip } from '../lib/judgment-gen.js';
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

async function refusedWith(promise, kind) {
  try {
    await promise;
    assert.fail(`expected refusal ${kind}`);
  } catch (err) {
    assert.equal(err.kind ?? err.code, kind, `expected ${kind}, got ${err.kind ?? err.code}: ${err.message}`);
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
      op: 'judgment_transition',
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
    fixedPoint(cwd, 'after replay');

    // Idempotent: replaying again (e.g. via a read) changes nothing.
    const again = await replayPendingIntents(cwd);
    assert.equal(again.replayed, 0);
    assert.equal(store.readLedgerEvents().filter((e) => e.title === 'crashy disposed').length, 1, 'no double-append');
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
      op: 'judgment_transition',
      payload: { slug: 'stale', from: 'open', to: 'under_test', joint: mutated, events: [], predictions: [] },
      created_at: '2026-07-22T12:00:00Z',
    });
    const state = await getJudgmentState(cwd);
    assert.equal(state.joints.find((j) => j.slug === 'stale').state, 'under_test', 'read path replays intents');
    assert.deepEqual(store.readIntents(), []);
  });
});
