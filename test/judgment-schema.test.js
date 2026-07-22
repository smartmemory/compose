/**
 * judgment-schema.test.js — contract coverage for
 * contracts/judgment-record.schema.json via lib/judgment/schema.js (T1/S01).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { JUDGMENT_SCHEMA_PATH, getJudgmentValidator } from '../lib/judgment/schema.js';

const provenance = {
  actor: 'agent',
  session: null,
  written_at: '2026-07-22T12:00:00Z',
};

const elicitation = {
  asked: 'Should the floor live under docs/?',
  answered_at: '2026-07-22T11:00:00Z',
  answer_ref: 'ledger:decide:judgment-records-under-docs',
};

function claim(overrides = {}) {
  return {
    id: 'c1',
    text: 'The tracked floor is the v1 canon provider.',
    grounding: 'INT',
    supports: [],
    ...overrides,
  };
}

function positionRevision(overrides = {}) {
  return {
    slug: 'provider-substrate',
    claims: [claim()],
    conviction: { level: 'high', source: 'stated' },
    rejected_alternatives: [{ what: 'vision store', why: 'gitignored' }],
    provenance,
    ...overrides,
  };
}

function joint(overrides = {}) {
  return {
    slug: 'guard-predicate-expressible',
    question: 'Can ONE-UNDER-TEST be expressed as a guard predicate?',
    branch_true: 'Register the predicate upstream.',
    branch_false: 'Writer-local advisory-lock enforcement.',
    resolve_by: 'INT',
    cost: 'days',
    rank: 'high',
    state: 'open',
    provenance,
    ...overrides,
  };
}

function prediction(overrides = {}) {
  return {
    id: 'p-2026-07-22-01',
    text: 'The predicate will be expressible.',
    outcome_criteria: 'guard_register accepts a population invariant.',
    made_at: '2026-07-22T12:00:00Z',
    context: 'construct',
    refs: [],
    status: 'open',
    provenance,
    ...overrides,
  };
}

function ledgerEvent(overrides = {}) {
  return {
    kind: 'note',
    title: 'Reading ceiling',
    body: 'Register is at its reading ceiling.',
    anchor: 'register-header',
    provenance,
    ...overrides,
  };
}

function pendingIntent(overrides = {}) {
  return {
    id: 'intent-01',
    op: 'judgment_transition',
    payload: { slug: 'guard-predicate-expressible', to: 'under_test' },
    created_at: '2026-07-22T12:00:00Z',
    ...overrides,
  };
}

function check(defName, obj) {
  return getJudgmentValidator().validate(defName, obj);
}

describe('schema loader', () => {
  test('exports a path and a memoized validator', () => {
    assert.ok(JUDGMENT_SCHEMA_PATH.endsWith('contracts/judgment-record.schema.json'));
    assert.equal(getJudgmentValidator(), getJudgmentValidator());
  });
});

describe('position_revision', () => {
  test('valid revision passes', () => {
    const { valid, errors } = check('position_revision', positionRevision());
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('ASSERT claim WITH elicitation passes', () => {
    const rev = positionRevision({
      claims: [claim({ grounding: 'ASSERT', elicitation })],
    });
    const { valid, errors } = check('position_revision', rev);
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('MUST: ASSERT claim without elicitation is invalid', () => {
    const rev = positionRevision({ claims: [claim({ grounding: 'ASSERT' })] });
    assert.equal(check('position_revision', rev).valid, false);
  });

  test('MUST: owner-locked grounding is invalid everywhere', () => {
    const rev = positionRevision({ claims: [claim({ grounding: 'owner-locked' })] });
    assert.equal(check('position_revision', rev).valid, false);
    // ...including as a joint resolve_by and a resolution evidence grounding
    assert.equal(check('joint', joint({ resolve_by: 'owner-locked' })).valid, false);
  });

  test('supersedes must be a <slug>#r<N> address', () => {
    assert.equal(check('position_revision', positionRevision({ supersedes: 'other-slug#r2' })).valid, true);
    assert.equal(check('position_revision', positionRevision({ supersedes: 'other-slug@2' })).valid, false);
    assert.equal(check('position_revision', positionRevision({ supersedes: 'other-slug' })).valid, false);
  });

  test('tombstone revision (retracted) may carry empty claims', () => {
    const rev = positionRevision({ retracted: true, claims: [] });
    const { valid, errors } = check('position_revision', rev);
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('non-tombstone revision requires at least one claim', () => {
    assert.equal(check('position_revision', positionRevision({ claims: [] })).valid, false);
  });

  test('caller cannot forge provenance actor', () => {
    const rev = positionRevision({ provenance: { ...provenance, actor: 'owner' } });
    assert.equal(check('position_revision', rev).valid, false);
  });
});

describe('joint', () => {
  test('valid joint passes', () => {
    const { valid, errors } = check('joint', joint());
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('MUST: minutes cost is invalid (COARSE-BUCKETS)', () => {
    assert.equal(check('joint', joint({ cost: 'minutes' })).valid, false);
  });

  test('MUST: single-branch joint is invalid', () => {
    const j = joint();
    delete j.branch_false;
    assert.equal(check('joint', j).valid, false);
  });

  test('MUST: resolution outcome "dissolved" is invalid — dissolution is its own artifact', () => {
    const j = joint({
      state: 'dissolved',
      resolution: { outcome: 'dissolved' },
    });
    assert.equal(check('joint', j).valid, false);
    // the legal form: dissolution artifact, no resolution
    const ok = joint({
      state: 'dissolved',
      dissolution: { decomposed_into: ['smaller-joint-a', 'smaller-joint-b'] },
    });
    const { valid, errors } = check('joint', ok);
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('per-outcome required packages', () => {
    const base = { state: 'resolved' };
    assert.equal(check('joint', joint({ ...base, resolution: { outcome: 'resolved' } })).valid, false);
    assert.equal(
      check('joint', joint({ ...base, resolution: { outcome: 'resolved', evidence: 'probe ran; predicate accepted' } })).valid,
      true,
    );
    assert.equal(check('joint', joint({ state: 'inconclusive', resolution: { outcome: 'inconclusive', learned: 'x' } })).valid, false);
    assert.equal(
      check('joint', joint({
        state: 'inconclusive',
        resolution: { outcome: 'inconclusive', learned: 'x', would_have_settled: 'y' },
      })).valid,
      true,
    );
    assert.equal(check('joint', joint({ state: 'open', resolution: { outcome: 'failed_to_run' } })).valid, false);
    assert.equal(
      check('joint', joint({ state: 'open', resolution: { outcome: 'failed_to_run', reason: 'env never provisioned' } })).valid,
      true,
    );
    assert.equal(check('joint', joint({ state: 'superseded', resolution: { outcome: 'superseded' } })).valid, false);
    assert.equal(
      check('joint', joint({ state: 'superseded', resolution: { outcome: 'superseded', why: 'question dissolved upstream' } })).valid,
      true,
    );
  });

  test('ext package: sharpened XOR judgment-dispatch', () => {
    const sharpened = joint({
      resolve_by: 'EXT',
      ext: { sharpened_question: 'q', bar: 'b', falsifier: 'f' },
    });
    assert.equal(check('joint', sharpened).valid, true, 'sharpened package should pass');
    const dispatch = joint({
      resolve_by: 'EXT',
      ext: { judgment_dispatch: true, reason: 'cannot honestly be sharpened' },
    });
    assert.equal(check('joint', dispatch).valid, true, 'judgment-dispatch should pass');
    const partial = joint({ resolve_by: 'EXT', ext: { sharpened_question: 'q' } });
    assert.equal(check('joint', partial).valid, false, 'partial package must fail');
  });

  test('straddle package requires signal + kill criteria', () => {
    assert.equal(
      check('joint', joint({ resolve_by: 'STRADDLE', straddle: { discriminating_signal: 's', kill_criteria: 'k' } })).valid,
      true,
    );
    assert.equal(
      check('joint', joint({ resolve_by: 'STRADDLE', straddle: { discriminating_signal: 's' } })).valid,
      false,
    );
  });

  test('ASSERT-resolved joint requires elicitation on the resolution', () => {
    const noElicit = joint({
      resolve_by: 'ASSERT',
      state: 'resolved',
      resolution: { outcome: 'resolved', evidence: 'owner said so' },
    });
    assert.equal(check('joint', noElicit).valid, false);
    const withElicit = joint({
      resolve_by: 'ASSERT',
      state: 'resolved',
      resolution: { outcome: 'resolved', evidence: 'owner ruling', elicitation },
    });
    const { valid, errors } = check('joint', withElicit);
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('ext_result outcome vocabulary is the ruled four', () => {
    const res = (extOutcome) => joint({
      resolve_by: 'EXT',
      ext: { sharpened_question: 'q', bar: 'b', falsifier: 'f' },
      state: 'resolved',
      resolution: {
        outcome: 'resolved',
        evidence: 'found it',
        ext_result: {
          outcome: extOutcome,
          sources: ['records/evidence/e1/'],
          search_record: 'searched X, Y',
          found_or_provoked: 'found',
          judgment_not_evidence: false,
        },
      },
    });
    for (const ok of ['FOUND', 'CONTRARY', 'SILENT', 'UNREACHABLE']) {
      const { valid, errors } = check('joint', res(ok));
      assert.equal(valid, true, `${ok}: ${JSON.stringify(errors)}`);
    }
    assert.equal(check('joint', res('MAYBE')).valid, false);
  });
});

describe('prediction', () => {
  test('valid open prediction passes', () => {
    const { valid, errors } = check('prediction', prediction());
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('graded prediction requires a grade', () => {
    assert.equal(check('prediction', prediction({ status: 'graded' })).valid, false);
    assert.equal(check('prediction', prediction({ status: 'graded', grade: 'right-wrong-reason' })).valid, true);
  });

  test('context is construct|commit only', () => {
    assert.equal(check('prediction', prediction({ context: 'vibes' })).valid, false);
  });
});

describe('ledger_event', () => {
  test('valid note with anchor passes', () => {
    const { valid, errors } = check('ledger_event', ledgerEvent());
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('note without anchor is invalid', () => {
    const ev = ledgerEvent();
    delete ev.anchor;
    assert.equal(check('ledger_event', ev).valid, false);
  });

  test('decide requires rejected[] + conviction', () => {
    const bare = ledgerEvent({ kind: 'decide', anchor: undefined });
    delete bare.anchor;
    assert.equal(check('ledger_event', bare).valid, false);
    const ok = {
      kind: 'decide',
      title: 'Pick the substrate',
      rejected: [{ what: 'markdown-canon', why: 'unvalidatable' }],
      conviction: { level: 'high', source: 'stated' },
      provenance,
    };
    const { valid, errors } = check('ledger_event', ok);
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('MUST: commit-moment decide requires trigger + open_joints + prediction', () => {
    const commitDecide = {
      kind: 'decide',
      title: 'Commit: ship the writer',
      rejected: [{ what: 'wait', why: 'no new information coming' }],
      conviction: { level: 'medium', source: 'stated' },
      trigger: 'forced',
      open_joints: ['guard-predicate-expressible'],
      prediction: { text: 'suite stays green', outcome_criteria: 'npm test green in 30d' },
      provenance,
    };
    const { valid, errors } = check('ledger_event', commitDecide);
    assert.equal(valid, true, JSON.stringify(errors));

    const missingPrediction = { ...commitDecide };
    delete missingPrediction.prediction;
    assert.equal(check('ledger_event', missingPrediction).valid, false);

    const missingJoints = { ...commitDecide };
    delete missingJoints.open_joints;
    assert.equal(check('ledger_event', missingJoints).valid, false);

    // forced/exhausted may not have empty open_joints; earned may
    assert.equal(check('ledger_event', { ...commitDecide, open_joints: [] }).valid, false);
    const earned = { ...commitDecide, trigger: 'earned', open_joints: [] };
    assert.equal(check('ledger_event', earned).valid, true);

    assert.equal(check('ledger_event', { ...commitDecide, trigger: 'bored' }).valid, false);
  });

  test('MUST: CONSTRUCT-disposition event requires an embedded prediction', () => {
    const ev = ledgerEvent({ kind: 'open', anchor: undefined, disposition: 'CONSTRUCT' });
    delete ev.anchor;
    assert.equal(check('ledger_event', ev).valid, false);
    const ok = { ...ev, prediction: { text: 'building it will settle it', outcome_criteria: 'artifact exists' } };
    const { valid, errors } = check('ledger_event', ok);
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('MUST: postmortem requires trigger + recall_verdict + attribution', () => {
    const bare = { kind: 'postmortem', title: 'Q3 look-back', provenance };
    assert.equal(check('ledger_event', bare).valid, false);
    const ok = {
      ...bare,
      trigger: 'surprise-outcome',
      recall_verdict: 'NAMED-BUT-MISRANKED',
      attribution: 'EXT questions under-searched',
    };
    const { valid, errors } = check('ledger_event', ok);
    assert.equal(valid, true, JSON.stringify(errors));
    assert.equal(check('ledger_event', { ...ok, recall_verdict: 'SORTA' }).valid, false);
  });

  test('postmortem with a prediction ref requires prediction_grade', () => {
    const base = {
      kind: 'postmortem',
      title: 'Grading the commit prediction',
      trigger: 'prediction-due',
      recall_verdict: 'NAMED',
      attribution: 'none — clean recall',
      prediction_ref: 'p-2026-07-22-01',
      provenance,
    };
    assert.equal(check('ledger_event', base).valid, false);
    assert.equal(check('ledger_event', { ...base, prediction_grade: 'right' }).valid, true);
  });

  test('MUST: override requires a non-empty reason', () => {
    const bare = { kind: 'override', title: 'Forcing the tag', provenance };
    assert.equal(check('ledger_event', bare).valid, false);
    assert.equal(check('ledger_event', { ...bare, reason: '' }).valid, false);
    assert.equal(check('ledger_event', { ...bare, reason: 'owner instructed in session' }).valid, true);
  });

  test('unknown kind rejected', () => {
    const ev = ledgerEvent({ kind: 'vibe-check' });
    assert.equal(check('ledger_event', ev).valid, false);
  });
});

describe('pending_intent', () => {
  test('valid intent passes', () => {
    const { valid, errors } = check('pending_intent', pendingIntent());
    assert.equal(valid, true, JSON.stringify(errors));
  });

  test('payload is required — an intent must carry the COMPLETE mutation', () => {
    const i = pendingIntent();
    delete i.payload;
    assert.equal(check('pending_intent', i).valid, false);
  });
});
