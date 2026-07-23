/**
 * judgment-store.test.js — coverage for lib/judgment/store/ (T2/S02):
 * records store (revision chains, aggregates, goal state, joints, predictions,
 * ledger, intents, atomic writes) + effective reads + provider registry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RecordsStore } from '../lib/judgment/store/records.js';
import {
  createJudgmentStore,
  effectiveStore,
  goalCutoverComplete,
} from '../lib/judgment/store/index.js';

const provenance = {
  actor: 'agent',
  session: null,
  written_at: '2026-07-22T12:00:00Z',
};

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'judgment-store-'));
}

function positionRevision(slug, overrides = {}) {
  return {
    slug,
    claims: [{ id: 'c1', text: 'claim text', grounding: 'INT', supports: [] }],
    conviction: { level: 'high', source: 'stated' },
    provenance,
    ...overrides,
  };
}

function joint(slug, overrides = {}) {
  return {
    slug,
    question: 'q?',
    branch_true: 'a',
    branch_false: 'b',
    resolve_by: 'INT',
    cost: 'days',
    rank: 'high',
    state: 'open',
    provenance,
    ...overrides,
  };
}

function person(slug, overrides = {}) {
  return {
    slug,
    display_name: slug,
    facts: [],
    edges: [],
    open_fields: [],
    load_links: [],
    provenance,
    ...overrides,
  };
}

function situationEntity(slug, overrides = {}) {
  return {
    slug,
    display_name: slug,
    facts: [],
    owed: [],
    load_links: [],
    provenance,
    ...overrides,
  };
}

function goalVersion(overrides = {}) {
  return {
    clauses: [],
    provocation: null,
    ratification: null,
    diff_note: 'initial cut',
    provenance,
    ...overrides,
  };
}

function goalState(overrides = {}) {
  return {
    joints: [],
    load_links: [],
    provenance,
    ...overrides,
  };
}

function prediction(id, overrides = {}) {
  return {
    id,
    text: 't',
    outcome_criteria: 'c',
    made_at: '2026-07-22T12:00:00Z',
    context: 'commit',
    refs: [],
    status: 'open',
    provenance,
    ...overrides,
  };
}

function pendingIntent(id, overrides = {}) {
  return {
    id,
    kind: 'transition',
    tool: 'judgment_transition',
    op: 'transition',
    payload: { slug: 'j-one', to: 'under_test' },
    created_at: '2026-07-22T12:00:00Z',
    ...overrides,
  };
}

describe('RecordsStore positions', () => {
  test('appends revisions r1, r2, … and reads the chain back in order', () => {
    const store = new RecordsStore(freshCwd());
    const w1 = store.writePositionRevision(positionRevision('alpha'));
    assert.equal(w1.rev, 1);
    assert.equal(w1.ref, 'alpha#r1');
    const w2 = store.writePositionRevision(positionRevision('alpha'));
    assert.equal(w2.rev, 2);
    const chain = store.readPositionChain('alpha');
    assert.equal(chain.length, 2);
    assert.deepEqual(chain.map((r) => r.rev), [1, 2]);
    assert.equal(store.readPositionRevision('alpha', 2).rev, 2);
    assert.equal(store.readPositionRevision('alpha', 3), null);
    assert.deepEqual(store.listPositionSlugs(), ['alpha']);
  });

  test('derived status: live / superseded / retracted, never stored', () => {
    const store = new RecordsStore(freshCwd());
    store.writePositionRevision(positionRevision('old'));
    assert.equal(store.derivePositionStatus('old'), 'live');

    // a live revision elsewhere naming old#r1 supersedes the old chain
    store.writePositionRevision(positionRevision('new', { supersedes: 'old#r1' }));
    assert.equal(store.derivePositionStatus('old'), 'superseded');
    assert.equal(store.derivePositionStatus('new'), 'live');

    // tombstone revision retracts its own chain…
    store.writePositionRevision(positionRevision('new', { retracted: true, claims: [] }));
    assert.equal(store.derivePositionStatus('new'), 'retracted');
    // …and its supersedes claim no longer binds
    assert.equal(store.derivePositionStatus('old'), 'live');

    assert.equal(store.derivePositionStatus('nonexistent'), null);
  });
});

describe('RecordsStore goal chain and state', () => {
  test('appends v1/v2 in order, ignores state.json, never overwrites, and replaces explicitly', () => {
    const store = new RecordsStore(freshCwd());

    const w1 = store.writeGoalVersion(goalVersion({ diff_note: 'first' }));
    assert.deepEqual(
      { version: w1.version, ref: w1.ref },
      { version: 1, ref: 'goal:v1' },
    );
    store.writeGoalState(goalState({ joints: [{ id: 'gj1' }] }));
    const w2 = store.writeGoalVersion(goalVersion({ version: 1, diff_note: 'second' }));

    assert.equal(w2.version, 2);
    assert.deepEqual(store.readGoalChain().map((record) => record.version), [1, 2]);
    assert.equal(store.readGoalVersion(1).diff_note, 'first', 'append must not overwrite v1');
    assert.equal(store.readGoalVersion(3), null);
    assert.equal(store.latestGoalVersion().version, 2);

    const replacement = goalVersion({ version: 999, diff_note: 'wording fix' });
    const replaced = store.replaceGoalVersion(2, replacement);
    assert.deepEqual(
      { version: replaced.version, ref: replaced.ref },
      { version: 2, ref: 'goal:v2' },
    );
    assert.equal(store.readGoalVersion(2).version, 2);
    assert.equal(store.readGoalVersion(2).diff_note, 'wording fix');
    assert.equal(store.readGoalVersion(1).diff_note, 'first');
    assert.deepEqual(store.readGoalChain().map((record) => record.version), [1, 2]);
  });

  test('goal state creates, reads, and replaces without advancing the goal chain', () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    assert.equal(store.readGoalState(), null);
    assert.equal(
      store._goalStatePath(),
      join(cwd, 'docs', 'judgment', 'records', 'goal', 'state.json'),
    );

    store.writeGoalVersion(goalVersion());
    store.writeGoalState(goalState({
      joints: [{ id: 'gj1', joint: 'j-one', removed: null }],
      load_links: [{ id: 'gl1', ref: 'goal:v1#c1', removed: null }],
    }));
    assert.deepEqual(store.readGoalState().joints.map((item) => item.id), ['gj1']);
    assert.deepEqual(store.readGoalState().load_links.map((item) => item.id), ['gl1']);

    store.writeGoalState(goalState({
      joints: [],
      load_links: [{ id: 'gl1', ref: 'goal:v1#c1', removed: { reason: 'retired' } }],
    }));
    assert.deepEqual(store.readGoalState().joints, []);
    assert.ok(store.readGoalState().load_links[0].removed);
    assert.deepEqual(store.readGoalChain().map((record) => record.version), [1]);
  });
});

describe('RecordsStore people and situation aggregates', () => {
  test('people create/update atomically, list in slug order, and return null when missing', () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    assert.equal(store.readPerson('missing'), null);
    assert.equal(
      store._personPath('alpha'),
      join(cwd, 'docs', 'judgment', 'records', 'people', 'alpha.json'),
    );

    store.writePerson(person('zeta'));
    store.writePerson(person('alpha'));
    store.writePerson(person('zeta', { display_name: 'Zeta Updated' }));

    assert.equal(store.readPerson('zeta').display_name, 'Zeta Updated');
    assert.deepEqual(store.listPeople().map((record) => record.slug), ['alpha', 'zeta']);
  });

  test('situation entities create/update atomically, list in slug order, and return null when missing', () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    assert.equal(store.readSituationEntity('missing'), null);
    assert.equal(
      store._situationEntityPath('alpha'),
      join(cwd, 'docs', 'judgment', 'records', 'situation', 'alpha.json'),
    );

    store.writeSituationEntity(situationEntity('zeta'));
    store.writeSituationEntity(situationEntity('alpha'));
    store.writeSituationEntity(situationEntity('zeta', { display_name: 'Zeta Updated' }));

    assert.equal(store.readSituationEntity('zeta').display_name, 'Zeta Updated');
    assert.deepEqual(
      store.listSituationEntities().map((record) => record.slug),
      ['alpha', 'zeta'],
    );
  });
});

describe('RecordsStore joints / predictions / ledger / intents', () => {
  test('joint write/read/list', () => {
    const store = new RecordsStore(freshCwd());
    store.writeJoint(joint('j-one'));
    store.writeJoint(joint('j-two', { rank: 'medium' }));
    assert.equal(store.readJoint('j-one').slug, 'j-one');
    assert.equal(store.readJoint('missing'), null);
    assert.deepEqual(store.listJoints().map((j) => j.slug).sort(), ['j-one', 'j-two']);
  });

  test('prediction write/read/list with status filter', () => {
    const store = new RecordsStore(freshCwd());
    const p = prediction('p1');
    store.writePrediction(p);
    store.writePrediction({ ...p, id: 'p2', status: 'graded', grade: 'right' });
    assert.equal(store.readPrediction('p1').id, 'p1');
    assert.equal(store.readPrediction('nope'), null);
    assert.deepEqual(store.listPredictions({ status: 'open' }).map((x) => x.id), ['p1']);
    assert.equal(store.listPredictions().length, 2);
  });

  test('ledger is append-only JSONL, read back in order', () => {
    const store = new RecordsStore(freshCwd());
    store.appendLedgerEvent({ kind: 'note', title: 'first', anchor: 'register-header', provenance });
    store.appendLedgerEvent({ kind: 'note', title: 'second', anchor: 'register-header', provenance });
    const events = store.readLedgerEvents();
    assert.deepEqual(events.map((e) => e.title), ['first', 'second']);
  });

  test('intents persist, list, clear', () => {
    const store = new RecordsStore(freshCwd());
    const intent = pendingIntent('i1');
    store.persistIntent(intent);
    assert.deepEqual(store.readIntents().map((i) => i.id), ['i1']);
    store.clearIntent('i1');
    assert.deepEqual(store.readIntents(), []);
    store.clearIntent('i1'); // idempotent
  });

  test('clearIntent propagates every unlink failure except ENOENT', () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    store.clearIntent('absent'); // ENOENT is idempotent

    const blockedPath = join(cwd, 'docs', 'judgment', 'records', 'intents', 'blocked.json');
    mkdirSync(blockedPath, { recursive: true });
    assert.throws(
      () => store.clearIntent('blocked'),
      (err) => err?.code !== 'ENOENT',
    );
  });
});

describe('effectiveStore', () => {
  test('takes one pending snapshot and filters whole artifacts across every store family', () => {
    const raw = new RecordsStore(freshCwd());
    const pendingProvenance = { ...provenance, intent_id: 'i1' };
    raw.persistIntent(pendingIntent('i1', { kind: 'goal_migration' }));
    raw.writePositionRevision(positionRevision('hidden-position', {
      provenance: pendingProvenance,
    }));
    raw.writeJoint(joint('hidden-joint', { provenance: pendingProvenance }));
    raw.writePrediction(prediction('hidden-prediction', { provenance: pendingProvenance }));
    raw.writePerson(person('hidden-person', { provenance: pendingProvenance }));
    raw.writeSituationEntity(situationEntity('hidden-entity', {
      provenance: pendingProvenance,
    }));
    raw.writeGoalVersion(goalVersion({ provenance: pendingProvenance }));
    raw.writeGoalState(goalState({ provenance: pendingProvenance }));
    raw.appendLedgerEvent({
      kind: 'note',
      title: 'hidden-ledger',
      anchor: 'register-header',
      provenance: pendingProvenance,
    });

    const effective = effectiveStore(raw);
    assert.equal(effective.readPositionRevision('hidden-position', 1), null);
    assert.deepEqual(effective.readPositionChain('hidden-position'), []);
    assert.equal(effective.latestPositionRevision('hidden-position'), null);
    assert.deepEqual(effective.listPositionSlugs(), []);
    assert.equal(effective.derivePositionStatus('hidden-position'), null);
    assert.equal(effective.readJoint('hidden-joint'), null);
    assert.deepEqual(effective.listJoints(), []);
    assert.equal(effective.readPrediction('hidden-prediction'), null);
    assert.deepEqual(effective.listPredictions(), []);
    assert.equal(effective.readPerson('hidden-person'), null);
    assert.deepEqual(effective.listPeople(), []);
    assert.equal(effective.readSituationEntity('hidden-entity'), null);
    assert.deepEqual(effective.listSituationEntities(), []);
    assert.equal(effective.readGoalVersion(1), null);
    assert.deepEqual(effective.readGoalChain(), []);
    assert.equal(effective.latestGoalVersion(), null);
    assert.equal(effective.readGoalState(), null);
    assert.deepEqual(effective.readLedgerEvents(), []);
    assert.equal(effective.hasPendingIntentKind('goal_migration'), true);

    raw.clearIntent('i1');
    assert.equal(
      effective.readPerson('hidden-person'),
      null,
      'an existing adapter retains its coherent pending snapshot',
    );

    const published = effectiveStore(raw);
    assert.equal(published.readPositionRevision('hidden-position', 1).slug, 'hidden-position');
    assert.equal(published.readJoint('hidden-joint').slug, 'hidden-joint');
    assert.equal(published.readPrediction('hidden-prediction').id, 'hidden-prediction');
    assert.equal(published.readPerson('hidden-person').slug, 'hidden-person');
    assert.equal(published.readSituationEntity('hidden-entity').slug, 'hidden-entity');
    assert.equal(published.readGoalVersion(1).version, 1);
    assert.ok(published.readGoalState());
    assert.deepEqual(published.readLedgerEvents().map((event) => event.title), ['hidden-ledger']);
    assert.equal(published.hasPendingIntentKind('goal_migration'), false);
  });

  test('keeps unrelated and nested-only intent IDs visible', () => {
    const raw = new RecordsStore(freshCwd());
    raw.persistIntent(pendingIntent('i1'));
    raw.writePerson(person('unrelated', {
      provenance: { ...provenance, intent_id: 'other-intent' },
    }));
    raw.writePerson(person('nested-only', {
      facts: [{
        id: 'f1',
        text: 'nested provenance is not a whole-artifact attribution',
        provenance: { ...provenance, intent_id: 'i1' },
      }],
    }));
    raw.appendLedgerEvent({
      kind: 'note',
      title: 'unrelated',
      anchor: 'register-header',
      provenance: { ...provenance, intent_id: 'other-intent' },
    });
    raw.appendLedgerEvent({
      kind: 'note',
      title: 'nested-only',
      anchor: 'register-header',
      details: { provenance: { ...provenance, intent_id: 'i1' } },
      provenance,
    });

    const effective = effectiveStore(raw);
    assert.deepEqual(
      effective.listPeople().map((record) => record.slug),
      ['nested-only', 'unrelated'],
    );
    assert.deepEqual(
      effective.readLedgerEvents().map((event) => event.title),
      ['unrelated', 'nested-only'],
    );
  });

  test('derives legacy position status only through filtered adapter reads', () => {
    const raw = new RecordsStore(freshCwd());
    raw.writePositionRevision(positionRevision('objective'));
    raw.persistIntent(pendingIntent('i1'));
    raw.writePositionRevision(positionRevision('objective', {
      retracted: true,
      claims: [],
      provenance: { ...provenance, intent_id: 'i1' },
    }));

    assert.equal(raw.derivePositionStatus('objective'), 'retracted');
    const effective = effectiveStore(raw);
    assert.equal(effective.latestPositionRevision('objective').rev, 1);
    assert.equal(effective.derivePositionStatus('objective'), 'live');
  });

  test('exposes read-only pending metadata and no mutation surface', () => {
    const raw = new RecordsStore(freshCwd());
    raw.persistIntent(pendingIntent('i1', { kind: 'goal_migration' }));
    const effective = effectiveStore(raw);

    assert.equal(effective.hasPendingIntentKind('goal_migration'), true);
    for (const method of [
      'writePositionRevision',
      'writeJoint',
      'writePrediction',
      'appendLedgerEvent',
      'persistIntent',
      'clearIntent',
      'writePerson',
      'writeSituationEntity',
      'writeGoalVersion',
      'replaceGoalVersion',
      'writeGoalState',
    ]) {
      assert.equal(effective[method], undefined, `${method} must not be exposed`);
    }
  });

  test('substitutes the captured preimage for a pending migration\'s own state write (C3)', () => {
    const raw = new RecordsStore(freshCwd());
    const preimageRecord = goalState({ joints: [{ id: 'gj1', joint: 'horizon', provenance, removed: null }] });
    const preimageBytes = `${JSON.stringify(preimageRecord, null, 2)}\n`;
    raw.persistIntent(pendingIntent('mig-1', {
      kind: 'goal_migration',
      tool: 'judgment_goal_write',
      op: 'migrate',
      payload: { goal_state_preimage: { bytes: preimageBytes, record: preimageRecord } },
    }));
    // The migration's own merged state, attributed to the pending intent.
    raw.writeGoalState(goalState({
      joints: [{ id: 'gj1', joint: 'horizon', provenance: { ...provenance, via: 'migration', intent_id: 'mig-1' }, removed: null }],
      provenance: { ...provenance, via: 'migration', intent_id: 'mig-1' },
    }));

    // Records-atomic: readers see the pre-migration preimage, never absence.
    assert.deepEqual(effectiveStore(raw).readGoalState(), preimageRecord);

    raw.clearIntent('mig-1');
    assert.equal(effectiveStore(raw).readGoalState().provenance.intent_id, 'mig-1');
  });

  test('substitutes null when a pending migration captured no preimage (C3)', () => {
    const raw = new RecordsStore(freshCwd());
    raw.persistIntent(pendingIntent('mig-2', {
      kind: 'goal_migration',
      tool: 'judgment_goal_write',
      op: 'migrate',
      payload: { goal_state_preimage: null },
    }));
    raw.writeGoalState(goalState({ provenance: { ...provenance, via: 'migration', intent_id: 'mig-2' } }));
    assert.equal(effectiveStore(raw).readGoalState(), null);
  });
});

describe('goalCutoverComplete', () => {
  test('requires an effective goal version and no pending goal migration', () => {
    const raw = new RecordsStore(freshCwd());
    assert.equal(goalCutoverComplete(raw), false);

    raw.persistIntent(pendingIntent('migration-1', { kind: 'goal_migration' }));
    raw.writeGoalVersion(goalVersion({
      provenance: { ...provenance, intent_id: 'migration-1' },
    }));
    assert.equal(goalCutoverComplete(raw), false, 'raw-but-hidden v1 cannot complete cutover');

    raw.writeGoalVersion(goalVersion());
    assert.equal(
      goalCutoverComplete(raw),
      false,
      'a pending goal migration fences cutover even with an unrelated visible version',
    );

    raw.clearIntent('migration-1');
    const effective = effectiveStore(raw);
    assert.equal(goalCutoverComplete(effective), true);
  });
});

describe('RecordsStore atomicity', () => {
  test('injected rename failure leaves no tmp file behind', () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    // Pre-create the target path as a DIRECTORY so rename fails after the tmp write.
    const jointsDir = join(cwd, 'docs', 'judgment', 'records', 'joints');
    mkdirSync(join(jointsDir, 'trap.json'), { recursive: true });
    assert.throws(() => store.writeJoint(joint('trap')));
    const leftovers = readdirSync(jointsDir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftovers, [], 'tmp file must be cleaned up on failure');
  });

  test('rename failures clean temp files for a new aggregate and goal state', () => {
    const cwd = freshCwd();
    const store = new RecordsStore(cwd);
    const peopleDir = join(cwd, 'docs', 'judgment', 'records', 'people');
    const goalDir = join(cwd, 'docs', 'judgment', 'records', 'goal');
    mkdirSync(join(peopleDir, 'trap.json'), { recursive: true });
    mkdirSync(join(goalDir, 'state.json'), { recursive: true });

    assert.throws(() => store.writePerson(person('trap')));
    assert.throws(() => store.writeGoalState(goalState()));
    assert.deepEqual(
      readdirSync(peopleDir).filter((file) => file.includes('.tmp.')),
      [],
      'person tmp file must be cleaned up on failure',
    );
    assert.deepEqual(
      readdirSync(goalDir).filter((file) => file.includes('.tmp.')),
      [],
      'goal-state tmp file must be cleaned up on failure',
    );
  });
});

describe('createJudgmentStore registry', () => {
  test('defaults to records provider with empty enrichment capabilities', () => {
    const cwd = freshCwd();
    const store = createJudgmentStore(cwd);
    assert.ok(store instanceof RecordsStore);
    assert.equal(store.capabilities().size, 0);
    assert.equal(effectiveStore(store).capabilities().size, 0);
    assert.equal(goalCutoverComplete(store), false);
  });

  test('reads judgment.provider from .compose/compose.json', () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ judgment: { provider: 'records' } }));
    assert.ok(createJudgmentStore(cwd) instanceof RecordsStore);
  });

  test("'smartmemory' provider throws NOT_IMPLEMENTED at selection — no stub object", () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ judgment: { provider: 'smartmemory' } }));
    assert.throws(() => createJudgmentStore(cwd), (err) => err.code === 'NOT_IMPLEMENTED');
  });

  test('unknown provider throws with valid ids named', () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ judgment: { provider: 'sqlite' } }));
    assert.throws(() => createJudgmentStore(cwd), /records/);
  });
});
