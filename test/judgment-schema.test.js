/**
 * judgment-schema.test.js — contract coverage for
 * contracts/judgment-record.schema.json via lib/judgment/schema.js (T1/S01).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

const ratification = {
  ...elicitation,
  quote: 'Yes, that is the goal.',
};

const provocation = {
  quote: 'We need one objective that prices every flip.',
  at: '2026-07-22T11:00:00Z',
};

function writerProvenance(overrides = {}) {
  return { ...provenance, ...overrides };
}

function correctionTrace(overrides = {}) {
  return {
    prior: { text: 'old wording' },
    corrected_at: '2026-07-22T12:30:00Z',
    provenance: writerProvenance(),
    ...overrides,
  };
}

function removedBlock(overrides = {}) {
  return {
    at: '2026-07-22T12:30:00Z',
    reason: 'no longer load-bearing',
    provenance: writerProvenance(),
    ...overrides,
  };
}

function personFact(overrides = {}) {
  return {
    id: 'f1',
    section: 'stated',
    text: 'Jane wants the decision surface to stay inspectable.',
    channel: 'said',
    at: '2026-07-22',
    provenance: writerProvenance(),
    trace: [],
    ...overrides,
  };
}

function situationFact(overrides = {}) {
  return {
    id: 'f1',
    text: 'The current register is at its reading ceiling.',
    channel: 'observed',
    at: '2026-07-22',
    provenance: writerProvenance(),
    trace: [],
    ...overrides,
  };
}

function personEdge(overrides = {}) {
  return {
    id: 'e1',
    to: 'sam',
    kind: 'works-with',
    provenance: writerProvenance(),
    removed: null,
    ...overrides,
  };
}

function factLoadLink(overrides = {}) {
  return {
    id: 'l1',
    fact: 'f1',
    carries: 'The rollout plan assumes this fact remains true.',
    provenance: writerProvenance(),
    removed: null,
    ...overrides,
  };
}

function openField(overrides = {}) {
  return {
    id: 'of1',
    name: 'Jane\'s actual yes',
    status: 'open',
    provenance: writerProvenance(),
    trace: [],
    ...overrides,
  };
}

function owed(overrides = {}) {
  return {
    id: 'o1',
    name: 'monthly revenue number',
    why_load_bearing: 'The runway decision changes at this threshold.',
    status: 'open',
    provenance: writerProvenance(),
    trace: [],
    ...overrides,
  };
}

function goalClause(overrides = {}) {
  return {
    id: 'c1',
    text: 'Keep every load-bearing claim inspectable.',
    channel: 'said',
    elicitation: { ...elicitation },
    provenance: writerProvenance(),
    trace: [],
    ...overrides,
  };
}

function goalJointLink(overrides = {}) {
  return {
    id: 'gj1',
    joint: 'guard-predicate-expressible',
    provenance: writerProvenance(),
    removed: null,
    ...overrides,
  };
}

function goalLoadLink(overrides = {}) {
  return {
    id: 'gl1',
    clause: 'v1#c1',
    carries: 'The implementation plan rests on this clause.',
    provenance: writerProvenance(),
    removed: null,
    ...overrides,
  };
}

function personRecord(overrides = {}) {
  return {
    slug: 'jane',
    display_name: 'Jane',
    facts: [personFact()],
    edges: [personEdge()],
    open_fields: [openField()],
    load_links: [factLoadLink()],
    provenance: writerProvenance(),
    ...overrides,
  };
}

function situationRecord(overrides = {}) {
  return {
    slug: 'trustflow',
    display_name: 'TrustFlow',
    facts: [situationFact()],
    owed: [owed()],
    load_links: [factLoadLink()],
    provenance: writerProvenance(),
    ...overrides,
  };
}

function goalVersion(overrides = {}) {
  return {
    version: 1,
    clauses: [goalClause()],
    provocation: { ...provocation },
    ratification: { ...ratification },
    diff_note: 'Initial owner-ratified cut.',
    provenance: writerProvenance(),
    ...overrides,
  };
}

function goalState(overrides = {}) {
  return {
    joints: [goalJointLink()],
    load_links: [goalLoadLink()],
    provenance: writerProvenance(),
    ...overrides,
  };
}

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
    kind: 'transition',
    tool: 'judgment_transition',
    op: 'transition',
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

const NEW_OBJECT_SHAPES = [
  {
    definition: 'correction_trace',
    build: correctionTrace,
    required: ['prior', 'corrected_at', 'provenance'],
    invalidate: (value) => { value.corrected_at = 'yesterday'; },
  },
  {
    definition: 'removed_block',
    build: removedBlock,
    required: ['at', 'reason', 'provenance'],
    invalidate: (value) => { value.reason = ''; },
  },
  {
    definition: 'ratification',
    build: () => ({ ...ratification }),
    required: ['asked', 'answered_at', 'answer_ref', 'quote'],
    invalidate: (value) => { value.quote = ''; },
  },
  {
    definition: 'provocation',
    build: () => ({ ...provocation }),
    required: ['quote', 'at'],
    invalidate: (value) => { value.at = 'not-a-timestamp'; },
  },
  {
    definition: 'person_fact',
    build: personFact,
    required: ['id', 'section', 'text', 'channel', 'at', 'provenance', 'trace'],
    invalidate: (value) => { value.section = 'psychometric-score'; },
  },
  {
    definition: 'situation_fact',
    build: situationFact,
    required: ['id', 'text', 'channel', 'at', 'provenance', 'trace'],
    invalidate: (value) => { value.channel = 'rumor'; },
  },
  {
    definition: 'person_edge',
    build: personEdge,
    required: ['id', 'to', 'kind', 'provenance', 'removed'],
    invalidate: (value) => { value.id = 'edge-1'; },
  },
  {
    definition: 'fact_load_link',
    build: factLoadLink,
    required: ['id', 'fact', 'carries', 'provenance', 'removed'],
    invalidate: (value) => { value.fact = 'fact-1'; },
  },
  {
    definition: 'open_field',
    build: openField,
    required: ['id', 'name', 'status', 'provenance', 'trace'],
    invalidate: (value) => { value.status = 'unknown'; },
  },
  {
    definition: 'owed',
    build: owed,
    required: ['id', 'name', 'why_load_bearing', 'status', 'provenance', 'trace'],
    invalidate: (value) => { value.id = 'owed-1'; },
  },
  {
    definition: 'goal_clause',
    build: goalClause,
    required: ['id', 'text', 'channel', 'elicitation', 'provenance', 'trace'],
    invalidate: (value) => { value.id = 'clause-1'; },
  },
  {
    definition: 'goal_joint_link',
    build: goalJointLink,
    required: ['id', 'joint', 'provenance', 'removed'],
    invalidate: (value) => { value.id = 'joint-1'; },
  },
  {
    definition: 'goal_load_link',
    build: goalLoadLink,
    required: ['id', 'clause', 'carries', 'provenance', 'removed'],
    invalidate: (value) => { value.clause = 'goal:v1#c1'; },
  },
  {
    definition: 'person',
    build: personRecord,
    required: ['slug', 'display_name', 'facts', 'edges', 'open_fields', 'load_links', 'provenance'],
    invalidate: (value) => { value.slug = 'Jane Doe'; },
  },
  {
    definition: 'situation_entity',
    build: situationRecord,
    required: ['slug', 'display_name', 'facts', 'owed', 'load_links', 'provenance'],
    invalidate: (value) => { value.slug = '_trustflow'; },
  },
  {
    definition: 'goal_version',
    build: goalVersion,
    required: ['version', 'clauses', 'provocation', 'ratification', 'diff_note', 'provenance'],
    invalidate: (value) => { value.version = 0; },
  },
  {
    definition: 'goal_state',
    build: goalState,
    required: ['joints', 'load_links', 'provenance'],
    invalidate: (value) => { value.joints[0].id = 'gj0'; },
  },
];

describe('COMP-JUDGMENT-STORES object contracts', () => {
  for (const { definition, build, required, invalidate } of NEW_OBJECT_SHAPES) {
    test(`${definition}: valid, closed, required, and constrained`, () => {
      const value = build();
      const { valid, errors } = check(definition, value);
      assert.equal(valid, true, `${definition}: ${JSON.stringify(errors)}`);

      for (const field of required) {
        const missing = structuredClone(value);
        delete missing[field];
        assert.equal(
          check(definition, missing).valid,
          false,
          `${definition} must require ${field}`,
        );
      }

      const unknown = structuredClone(value);
      unknown.caller_supplied = true;
      assert.equal(check(definition, unknown).valid, false, `${definition} must be closed`);

      const invalid = structuredClone(value);
      invalidate(invalid);
      assert.equal(check(definition, invalid).valid, false, `${definition} must reject its invalid enum/pattern`);
    });
  }

  test('writer provenance remains closed at every new nested record level', () => {
    const provenanceShapes = NEW_OBJECT_SHAPES.filter(({ build }) => 'provenance' in build());
    for (const { definition, build } of provenanceShapes) {
      const value = build();
      value.provenance.caller = 'forged';
      assert.equal(check(definition, value).valid, false, `${definition} accepted caller provenance garbage`);
    }

    const nestedRoots = [
      ['person', personRecord(), (value) => value.facts[0].provenance],
      ['situation_entity', situationRecord(), (value) => value.facts[0].provenance],
      ['goal_version', goalVersion(), (value) => value.clauses[0].provenance],
      ['goal_state', goalState(), (value) => value.joints[0].provenance],
    ];
    for (const [definition, value, nestedProvenance] of nestedRoots) {
      nestedProvenance(value).caller = 'forged';
      assert.equal(check(definition, value).valid, false, `${definition} accepted nested caller provenance garbage`);
    }
  });
});

describe('stable ids and goal clause refs', () => {
  const cases = [
    ['entry_id', 'f1', 'x1'],
    ['fact_id', 'f1', 'f0'],
    ['edge_id', 'e1', 'e01'],
    ['open_field_id', 'of1', 'of0'],
    ['owed_id', 'o1', 'o-1'],
    ['load_link_id', 'l1', 'gl1'],
    ['clause_id', 'c1', 'c0'],
    ['goal_joint_id', 'gj1', 'gj01'],
    ['goal_load_link_id', 'gl1', 'gl0'],
    ['goal_clause_ref', 'goal:v12#c3', 'v12#c3'],
  ];

  for (const [definition, validValue, invalidValue] of cases) {
    test(`${definition} accepts only its strict address pattern`, () => {
      assert.equal(check(definition, validValue).valid, true);
      assert.equal(check(definition, invalidValue).valid, false);
    });
  }
});

describe('fact and lifecycle conditional contracts', () => {
  test('person_fact and situation_fact keep identical shared base-property refs', () => {
    const schema = JSON.parse(readFileSync(JUDGMENT_SCHEMA_PATH, 'utf8'));
    const personProperties = schema.definitions.person_fact.properties;
    const situationProperties = schema.definitions.situation_fact.properties;
    const personOnly = new Set(['section', 'diverges_with']);
    const personBaseKeys = Object.keys(personProperties).filter((key) => !personOnly.has(key)).sort();
    const situationBaseKeys = Object.keys(situationProperties).sort();
    const personRequiredBase = schema.definitions.person_fact.required
      .filter((key) => !personOnly.has(key))
      .sort();
    const situationRequired = [...schema.definitions.situation_fact.required].sort();

    assert.deepEqual(personBaseKeys, situationBaseKeys);
    assert.deepEqual(personRequiredBase, situationRequired);
    for (const key of personBaseKeys) {
      assert.deepEqual(
        personProperties[key],
        situationProperties[key],
        `${key} must use the same property-level definition`,
      );
      assert.equal(typeof personProperties[key].$ref, 'string', `${key} must be a shared property-level $ref`);
    }
    assert.ok('section' in personProperties);
    assert.ok('diverges_with' in personProperties);
    assert.equal('section' in situationProperties, false);
    assert.equal('diverges_with' in situationProperties, false);
  });

  for (const [definition, build] of [
    ['person_fact', personFact],
    ['situation_fact', situationFact],
    ['goal_clause', goalClause],
  ]) {
    test(`${definition}: secondhand requires non-empty via and every other channel forbids it`, () => {
      assert.equal(check(definition, build({ channel: 'secondhand' })).valid, false);
      assert.equal(check(definition, build({ channel: 'secondhand', via: '' })).valid, false);
      const { valid, errors } = check(definition, build({ channel: 'secondhand', via: 'owner interview' }));
      assert.equal(valid, true, JSON.stringify(errors));
      assert.equal(check(definition, build({ channel: 'said', via: 'stale source' })).valid, false);
    });
  }

  test('filled open fields require filled_by while open fields reject it', () => {
    const filled = openField({ status: 'filled', filled_by: 'f1' });
    assert.equal(check('open_field', filled).valid, true);
    const missing = openField({ status: 'filled' });
    assert.equal(check('open_field', missing).valid, false);
    assert.equal(check('open_field', openField({ filled_by: 'f1' })).valid, false);
  });

  test('given owed entries require filled_by while open entries reject it', () => {
    const given = owed({ status: 'given', filled_by: 'f1' });
    assert.equal(check('owed', given).valid, true);
    assert.equal(check('owed', owed({ status: 'given' })).valid, false);
    assert.equal(check('owed', owed({ filled_by: 'f1' })).valid, false);
  });

  test('all removable entries require removed and accept a closed removal block', () => {
    for (const [definition, build] of [
      ['person_edge', personEdge],
      ['fact_load_link', factLoadLink],
      ['goal_joint_link', goalJointLink],
      ['goal_load_link', goalLoadLink],
    ]) {
      const absent = build();
      delete absent.removed;
      assert.equal(check(definition, absent).valid, false, `${definition} must carry removed`);
      assert.equal(check(definition, build({ removed: removedBlock() })).valid, true);
      assert.equal(
        check(definition, build({ removed: removedBlock({ caller: 'garbage' }) })).valid,
        false,
        `${definition} removal must be closed`,
      );
    }
  });

  test('trace entries require non-empty scalar prior values and are closed', () => {
    assert.equal(check('correction_trace', correctionTrace({ prior: {} })).valid, false);
    assert.equal(
      check('correction_trace', correctionTrace({ prior: { text: { caller: 'garbage' } } })).valid,
      false,
    );
    assert.equal(check('correction_trace', correctionTrace({ caller: 'garbage' })).valid, false);

    const fact = personFact({ trace: [correctionTrace()] });
    assert.equal(check('person_fact', fact).valid, true);
    fact.trace[0].caller = 'garbage';
    assert.equal(check('person_fact', fact).valid, false);
  });
});

describe('goal citation and draft contracts', () => {
  test('ordinary goal versions require non-null provocation and ratification citations', () => {
    assert.equal(check('goal_version', goalVersion()).valid, true);
    assert.equal(check('goal_version', goalVersion({ provocation: null })).valid, false);
    const noRatification = goalVersion();
    delete noRatification.ratification;
    assert.equal(check('goal_version', noRatification).valid, false);
    assert.equal(check('goal_version', goalVersion({ ratification: null })).valid, false);
  });

  for (const via of ['import', 'migration']) {
    test(`${via} goal drafts may use null provocation and omit ratification`, () => {
      const draft = goalVersion({
        provocation: null,
        provenance: writerProvenance({ via }),
      });
      delete draft.ratification;
      const { valid, errors } = check('goal_version', draft);
      assert.equal(valid, true, JSON.stringify(errors));
      assert.equal(check('goal_version', { ...draft, ratification: null }).valid, true);
    });
  }

  test('goal versions require a non-empty clause list and diff note', () => {
    assert.equal(check('goal_version', goalVersion({ clauses: [] })).valid, false);
    assert.equal(check('goal_version', goalVersion({ diff_note: '' })).valid, false);
  });
});

describe('provenance extensions', () => {
  test('via is restricted to import or migration', () => {
    assert.equal(check('provenance', writerProvenance({ via: 'import' })).valid, true);
    assert.equal(check('provenance', writerProvenance({ via: 'migration' })).valid, true);
    assert.equal(check('provenance', writerProvenance({ via: 'caller' })).valid, false);
  });

  test('optional intent_id must be non-empty and provenance stays closed', () => {
    assert.equal(check('provenance', writerProvenance({ intent_id: 'intent-01' })).valid, true);
    assert.equal(check('provenance', writerProvenance({ intent_id: '' })).valid, false);
    assert.equal(check('provenance', writerProvenance({ payload: 'forged' })).valid, false);
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

  test('commit rests_on accepts only strict goal:v<N>#c<N> refs', () => {
    const commitDecide = {
      kind: 'decide',
      title: 'Commit: ship the writer',
      rejected: [{ what: 'wait', why: 'no new information coming' }],
      conviction: { level: 'medium', source: 'stated' },
      trigger: 'earned',
      open_joints: [],
      prediction: { text: 'suite stays green', outcome_criteria: 'focused gate remains green' },
      rests_on: ['goal:v1#c1', 'goal:v12#c3'],
      provenance,
    };
    const { valid, errors } = check('ledger_event', commitDecide);
    assert.equal(valid, true, JSON.stringify(errors));
    assert.equal(check('ledger_event', { ...commitDecide, rests_on: ['v1#c1'] }).valid, false);
    assert.equal(check('ledger_event', { ...commitDecide, rests_on: ['goal:v0#c1'] }).valid, false);
  });

  test('reserved attest events require the complete intent attribution triple', () => {
    const attestation = {
      kind: 'attest',
      title: 'Intent applied',
      intent_id: 'intent-01',
      tool: 'judgment_transition',
      op: 'transition',
      provenance: writerProvenance({ intent_id: 'intent-01' }),
    };
    const { valid, errors } = check('ledger_event', attestation);
    assert.equal(valid, true, JSON.stringify(errors));
    for (const field of ['intent_id', 'tool', 'op']) {
      const missing = { ...attestation };
      delete missing[field];
      assert.equal(check('ledger_event', missing).valid, false, `attest must require ${field}`);
    }
    assert.equal(check('ledger_event', { ...attestation, intent_id: '' }).valid, false);
    assert.equal(check('ledger_event', { ...attestation, tool: '' }).valid, false);
    assert.equal(check('ledger_event', { ...attestation, op: '' }).valid, false);
  });

  test('ordinary caller events forbid every reserved attestation field', () => {
    for (const field of ['intent_id', 'tool', 'op']) {
      assert.equal(
        check('ledger_event', ledgerEvent({ [field]: 'forged' })).valid,
        false,
        `ordinary event accepted ${field}`,
      );
    }
    assert.equal(
      check('ledger_event', ledgerEvent({
        intent_id: 'intent-01',
        tool: 'judgment_transition',
        op: 'transition',
      })).valid,
      false,
    );
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

  test('kind, tool, and op are separately required non-empty fields', () => {
    for (const field of ['kind', 'tool', 'op']) {
      const missing = pendingIntent();
      delete missing[field];
      assert.equal(check('pending_intent', missing).valid, false, `intent must require ${field}`);
      assert.equal(check('pending_intent', pendingIntent({ [field]: '' })).valid, false, `${field} must be non-empty`);
    }
  });

  test('intent envelope is closed', () => {
    assert.equal(check('pending_intent', pendingIntent({ provenance: writerProvenance() })).valid, false);
  });
});
