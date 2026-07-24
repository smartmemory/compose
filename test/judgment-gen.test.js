/**
 * judgment-gen.test.js — coverage for lib/judgment-gen.js (T4/S04):
 * fixed-point regeneration, hand-edit overwrite, OKF frontmatter rules.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RecordsStore } from '../lib/judgment/store/records.js';
import { regenerateProjections, checkProjectionRoundtrip } from '../lib/judgment-gen.js';

const provenance = {
  actor: 'agent',
  session: null,
  written_at: '2026-07-22T12:00:00Z',
};

function trace(prior, correctedAt) {
  return {
    prior,
    corrected_at: correctedAt,
    provenance: { ...provenance, written_at: correctedAt },
  };
}

function removed(reason, at) {
  return {
    at,
    reason,
    provenance: { ...provenance, written_at: at },
  };
}

const MIGRATION_INTENT_ID = 'intent-goal-migration';

// Stands in for the legacy OBJECTIVE.md the migration captured. Held as a
// literal rather than generated: seededCwd() must leave the fixture
// UN-regenerated (the pruning and emits-all-files tests key off that
// precondition). Byte-verbatim capture is pinned against a real migration run
// in judgment-writer.test.js, not here.
const LEGACY_OBJECTIVE_PROJECTION = [
  '# Objective',
  '',
  '**Status:** live',
  '',
  '- Ship the judgment writer.',
  '',
].join('\n');

function seededCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'judgment-gen-'));
  const store = new RecordsStore(cwd);
  store.writePositionRevision({
    slug: 'objective',
    claims: [{ id: 'c1', text: 'Ship the judgment writer.', grounding: 'INT', supports: [] }],
    conviction: { level: 'high', source: 'stated' },
    provenance,
  });
  store.writePositionRevision({
    slug: 'old-take',
    claims: [{ id: 'c1', text: 'Markdown canon is fine.', grounding: 'AGENT', supports: [] }],
    conviction: { level: 'low', source: 'inferred' },
    provenance,
  });
  store.writePositionRevision({
    slug: 'provider-floor',
    claims: [{ id: 'c1', text: 'Tracked records are the v1 canon.', grounding: 'INT', supports: [] }],
    conviction: { level: 'high', source: 'stated' },
    rejected_alternatives: [{ what: 'vision store', why: 'gitignored' }],
    supersedes: 'old-take#r1',
    provenance,
  });
  store.writeJoint({
    slug: 'guard-predicate',
    question: 'Is ONE-UNDER-TEST expressible as a guard predicate?',
    branch_true: 'Register it upstream.',
    branch_false: 'Writer-local lock.',
    resolve_by: 'CONSTRUCT',
    cost: 'days',
    rank: 'high',
    state: 'open',
    provenance,
  });
  store.writeJoint({
    slug: 'okf-parse',
    question: 'Do emitted projections parse under the bridge codec?',
    branch_true: 'Obsidian reads canon natively.',
    branch_false: 'Fix the emitter.',
    resolve_by: 'EXT',
    ext: { sharpened_question: 'Does parseOkf accept them?', bar: 'zero parse errors', falsifier: 'any OkfParseError' },
    cost: 'hours',
    rank: 'medium',
    state: 'under_test',
    provenance,
  });
  store.appendLedgerEvent({
    kind: 'note',
    title: 'Register banner',
    body: 'This register is generated from records. Do not hand-edit.',
    anchor: 'register-header',
    provenance,
  });
  store.appendLedgerEvent({
    kind: 'note',
    title: 'Reading ceiling',
    body: 'This joint is at its reading ceiling.',
    anchor: 'joint:guard-predicate',
    provenance,
  });
  store.appendLedgerEvent({
    kind: 'decide',
    title: 'Pick the substrate',
    body: 'Tracked floor under docs/.',
    rejected: [{ what: 'vision store', why: 'gitignored' }],
    conviction: { level: 'high', source: 'stated' },
    provenance,
  });
  store.writePerson({
    slug: 'theo',
    display_name: 'Theo',
    facts: [],
    edges: [],
    open_fields: [],
    load_links: [],
    provenance,
  });
  store.writePerson({
    slug: 'maya',
    display_name: 'Maya',
    facts: [
      {
        id: 'f1',
        section: 'role',
        text: 'Maya owns the final review loop.',
        channel: 'secondhand',
        via: 'project lead',
        at: '2026-07-20',
        provenance,
        trace: [trace(
          { text: 'Maya owns the review loop.' },
          '2026-07-22T12:10:00Z',
        )],
      },
      {
        id: 'f2',
        section: 'stated',
        text: 'I own the release decision.',
        channel: 'said',
        at: '2026-07-21',
        diverges_with: 'f3',
        provenance,
        trace: [],
      },
      {
        id: 'f3',
        section: 'revealed',
        text: 'Release decisions still wait for committee review.',
        channel: 'observed',
        at: '2026-07-21',
        diverges_with: 'f2',
        provenance,
        trace: [],
      },
    ],
    edges: [
      {
        id: 'e1',
        to: 'theo',
        kind: 'works-with',
        provenance,
        removed: null,
      },
      {
        id: 'e2',
        to: 'theo',
        kind: 'reports-to',
        provenance,
        removed: removed('Reporting line corrected.', '2026-07-22T12:20:00Z'),
      },
    ],
    open_fields: [
      {
        id: 'of1',
        name: 'What makes the review complete?',
        status: 'open',
        provenance,
        trace: [
          trace({ status: 'open', filled_by: null }, '2026-07-22T12:30:00Z'),
          trace({ status: 'filled', filled_by: 'f2' }, '2026-07-22T12:40:00Z'),
        ],
      },
      {
        id: 'of2',
        name: 'Who owns the release decision?',
        status: 'filled',
        filled_by: 'f2',
        provenance,
        trace: [trace(
          { status: 'open', filled_by: null },
          '2026-07-22T12:50:00Z',
        )],
      },
    ],
    load_links: [
      {
        id: 'l1',
        fact: 'f2',
        carries: 'Release ownership.',
        provenance,
        removed: null,
      },
      {
        id: 'l2',
        fact: 'f3',
        carries: 'Committee dependency.',
        provenance,
        removed: removed('Dependency retired.', '2026-07-22T13:00:00Z'),
      },
    ],
    provenance,
  });
  store.writeSituationEntity({
    slug: 'alpha-system',
    display_name: 'Zulu System',
    facts: [],
    owed: [],
    load_links: [],
    provenance,
  });
  store.writeSituationEntity({
    slug: 'zeta-system',
    display_name: 'Alpha System',
    facts: [
      {
        id: 'f1',
        text: 'The cutover is atomic.',
        channel: 'observed',
        at: '2026-07-20',
        provenance,
        trace: [trace(
          { text: 'The cutover is nearly atomic.' },
          '2026-07-22T13:10:00Z',
        )],
      },
      {
        id: 'f2',
        text: 'The operator expects a repair-on-read path.',
        channel: 'secondhand',
        via: 'runbook owner',
        at: '2026-07-21',
        provenance,
        trace: [],
      },
    ],
    owed: [
      {
        id: 'o1',
        name: 'Crash-window proof',
        why_load_bearing: 'Publication safety depends on it.',
        status: 'open',
        provenance,
        trace: [
          trace({ status: 'open', filled_by: null }, '2026-07-22T13:20:00Z'),
          trace({ status: 'given', filled_by: 'f1' }, '2026-07-22T13:30:00Z'),
        ],
      },
      {
        id: 'o2',
        name: 'Atomic-write proof',
        why_load_bearing: 'Projection replacement depends on it.',
        status: 'given',
        filled_by: 'f1',
        provenance,
        trace: [trace(
          { status: 'open', filled_by: null },
          '2026-07-22T13:40:00Z',
        )],
      },
    ],
    load_links: [
      {
        id: 'l1',
        fact: 'f1',
        carries: 'Cutover safety.',
        provenance,
        removed: null,
      },
      {
        id: 'l2',
        fact: 'f1',
        carries: 'Old cutover claim.',
        provenance,
        removed: removed('Replaced by a narrower claim.', '2026-07-22T13:50:00Z'),
      },
    ],
    provenance,
  });
  store.appendLedgerEvent({
    kind: 'attest',
    title: 'Published transition intent',
    intent_id: 'intent-published',
    tool: 'judgment_transition',
    op: 'transition',
    provenance,
  });
  store.appendLedgerEvent({
    kind: 'decide',
    title: 'Commit resting on goal clauses',
    trigger: 'earned',
    rests_on: ['goal:v1#c1'],
    provenance,
  });

  // COMP-JUDGMENT-GOAL-MIGRATE C10 — the pending-migration intent under its
  // REAL tool and op (`judgment_goal_write`/`migrate` — `judgment_goal_migrate`
  // was overruled at design gate r1 and does not exist), with every payload key
  // populated by a final record rather than `{}`. The payload objects below ARE
  // what gets written, so payload and store are one source of truth.
  //
  // This is deliberately NOT byte-identical to an S1 migration output, and
  // cannot be: the goal state below carries a REMOVED association so the
  // generator's removed-association rendering is covered (asserted in "dual-read
  // matrix…"), whereas buildMigrationState always DROPS removed entries. Same
  // for the note — a distinctive hidden-note body is what proves note hiding.
  // Projection behavior against a genuinely S1-produced pending migration is
  // pinned where such a payload can exist: judgment-writer.test.js, "migration
  // records are atomic and projections repair after publication" (part A),
  // which drives the real writer through the C13 seam. What lives here is the
  // generator's own contract: an intent hides its artifacts until it clears.
  const hiddenProvenance = {
    ...provenance,
    written_at: '2026-07-22T14:00:00Z',
    via: 'migration',
    intent_id: MIGRATION_INTENT_ID,
  };
  const legacyObjective = store.readPositionRevision('objective', 1);
  const migrationTombstone = {
    slug: 'objective',
    claims: [],
    conviction: { level: 'high', source: 'stated' },
    retracted: true,
    provenance: hiddenProvenance,
    rev: 2,
  };
  const migrationGoalVersion = {
    version: 1,
    clauses: [{
      id: 'c1',
      text: 'Ship the migrated judgment writer.',
      channel: 'said',
      elicitation: {
        asked: 'What must ship?',
        answered_at: '2026-07-22T13:55:00Z',
        answer_ref: 'session:migration',
      },
      provenance: hiddenProvenance,
      trace: [],
    }],
    provocation: null,
    diff_note: 'Migrated from the legacy objective.',
    provenance: hiddenProvenance,
  };
  const migrationGoalState = {
    joints: [
      {
        id: 'gj1',
        joint: 'guard-predicate',
        provenance: hiddenProvenance,
        removed: null,
      },
      {
        id: 'gj2',
        joint: 'okf-parse',
        provenance: hiddenProvenance,
        removed: removed('No longer load-bearing.', '2026-07-22T14:05:00Z'),
      },
    ],
    load_links: [
      {
        id: 'gl1',
        clause: 'v1#c1',
        carries: 'The original migration bill.',
        provenance: hiddenProvenance,
        removed: null,
      },
    ],
    provenance: hiddenProvenance,
  };
  const migrationNote = {
    kind: 'note',
    title: 'Hidden migration note',
    body: 'This must not render before publication.',
    anchor: 'ledger-header',
    provenance: hiddenProvenance,
  };
  // The absorbed sidecar preimage: the same associations before the migration
  // re-stamped their provenance. `bytes` is the on-disk form the byte-drift
  // replay check compares against.
  const goalStatePreimageRecord = {
    joints: migrationGoalState.joints.map((entry) => ({ ...entry, provenance })),
    load_links: migrationGoalState.load_links.map((entry) => ({ ...entry, provenance })),
    provenance,
  };

  store.writePositionRevision(migrationTombstone);
  store.writeGoalVersion(migrationGoalVersion);
  store.writeGoalState(migrationGoalState);
  store.appendLedgerEvent(migrationNote);
  store.persistIntent({
    id: MIGRATION_INTENT_ID,
    kind: 'goal_migration',
    tool: 'judgment_goal_write',
    op: 'migrate',
    payload: {
      source: {
        objective_ref: 'objective#r1',
        objective: legacyObjective,
        legacy_projection: LEGACY_OBJECTIVE_PROJECTION,
      },
      goal_version: migrationGoalVersion,
      objective_tombstone: migrationTombstone,
      goal_state_preimage: {
        bytes: `${JSON.stringify(goalStatePreimageRecord, null, 2)}\n`,
        record: goalStatePreimageRecord,
      },
      goal_state: migrationGoalState,
      note: migrationNote,
    },
    created_at: '2026-07-22T14:00:00Z',
  });
  return cwd;
}

function postCutoverCwd() {
  const cwd = seededCwd();
  const store = new RecordsStore(cwd);
  store.clearIntent(MIGRATION_INTENT_ID);
  store.writeGoalVersion({
    version: 2,
    clauses: [
      {
        id: 'c1',
        text: 'Publish only after the durable boundary.',
        channel: 'said',
        elicitation: {
          asked: 'What is the publication boundary?',
          answered_at: '2026-07-23T09:00:00Z',
          answer_ref: 'session:goal-elicitation',
        },
        provenance,
        trace: [trace(
          { text: 'Publish after the boundary.' },
          '2026-07-23T09:10:00Z',
        )],
      },
      {
        id: 'c2',
        text: 'Keep the crash window repairable.',
        channel: 'secondhand',
        via: 'operations lead',
        elicitation: {
          asked: 'What must recovery preserve?',
          answered_at: '2026-07-23T09:02:00Z',
          answer_ref: 'session:goal-recovery',
        },
        provenance,
        trace: [],
      },
    ],
    provocation: {
      quote: 'The clear-to-regen window must heal on read.',
      at: '2026-07-23T08:55:00Z',
    },
    ratification: {
      asked: 'Does this wording cut the objective?',
      answered_at: '2026-07-23T09:05:00Z',
      answer_ref: 'session:goal-ratification',
      quote: 'Yes. Cut this objective.',
    },
    diff_note: 'Added the durable publication boundary.',
    provenance: { ...provenance, written_at: '2026-07-23T09:05:00Z' },
  });
  const state = store.readGoalState();
  state.load_links.push({
    id: 'gl2',
    clause: 'v2#c1',
    carries: 'The corrected publication rule.',
    provenance,
    removed: removed('Folded into the runbook.', '2026-07-23T09:15:00Z'),
  });
  store.writeGoalState(state);
  return cwd;
}

function legacyOnlyCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'judgment-gen-legacy-'));
  const store = new RecordsStore(cwd);
  store.writePositionRevision({
    slug: 'objective',
    claims: [{ id: 'c1', text: 'Legacy objective only.', grounding: 'INT', supports: [] }],
    conviction: { level: 'high', source: 'stated' },
    provenance,
  });
  return cwd;
}

function importedDraftCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'judgment-gen-draft-'));
  const store = new RecordsStore(cwd);
  store.writeGoalVersion({
    version: 1,
    clauses: [{
      id: 'c1',
      text: 'Imported draft clause.',
      channel: 'observed',
      elicitation: {
        asked: 'What did the old objective say?',
        answered_at: '2026-07-23T08:00:00Z',
        answer_ref: 'migration:legacy-objective',
      },
      provenance: { ...provenance, via: 'import' },
      trace: [],
    }],
    provocation: null,
    diff_note: 'Imported without ratification.',
    provenance: { ...provenance, via: 'import' },
  });
  return cwd;
}

const PROJECTIONS = [
  'docs/judgment/REGISTER.md',
  'docs/judgment/LEDGER.md',
  'docs/judgment/OBJECTIVE.md',
  'docs/judgment/SITUATION.md',
  'docs/judgment/index.md',
  'docs/judgment/people/maya.md',
  'docs/judgment/people/theo.md',
  'docs/judgment/positions/objective.md',
  'docs/judgment/positions/old-take.md',
  'docs/judgment/positions/provider-floor.md',
];

describe('regenerateProjections', () => {
  test('emits all projection files', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    for (const rel of PROJECTIONS) {
      assert.ok(existsSync(join(cwd, rel)), `${rel} should exist`);
    }
  });

  test('fixed point: second regen is byte-identical; roundtrip guard passes', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const before = PROJECTIONS.map((rel) => readFileSync(join(cwd, rel), 'utf8'));
    regenerateProjections(cwd);
    const after = PROJECTIONS.map((rel) => readFileSync(join(cwd, rel), 'utf8'));
    assert.deepEqual(after, before);
    const check = checkProjectionRoundtrip(cwd);
    assert.equal(check.fixedPoint, true, JSON.stringify(check.diffs));
  });

  test('hand-edit is detected by the roundtrip guard and overwritten by regen — no preserved sections', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const registerPath = join(cwd, 'docs', 'judgment', 'REGISTER.md');
    const original = readFileSync(registerPath, 'utf8');
    writeFileSync(registerPath, original + '\n<!-- PRESERVED -->\nsneaky hand edit\n');
    const check = checkProjectionRoundtrip(cwd);
    assert.equal(check.fixedPoint, false);
    assert.ok(check.diffs.some((d) => d.includes('REGISTER.md')));
    regenerateProjections(cwd);
    const regenerated = readFileSync(registerPath, 'utf8');
    assert.equal(regenerated, original);
    assert.ok(!regenerated.includes('sneaky hand edit'));
  });

  test('note records render at their anchors', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const register = readFileSync(join(cwd, 'docs', 'judgment', 'REGISTER.md'), 'utf8');
    assert.ok(register.includes('This register is generated from records.'));
    const jointIdx = register.indexOf('## guard-predicate');
    const noteIdx = register.indexOf('This joint is at its reading ceiling.');
    assert.ok(jointIdx >= 0 && noteIdx > jointIdx, 'joint note renders under its joint');
  });

  test('derived position status appears in projections, never in records', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const oldTake = readFileSync(join(cwd, 'docs', 'judgment', 'positions', 'old-take.md'), 'utf8');
    assert.match(oldTake, /superseded/);
    const raw = JSON.parse(readFileSync(join(cwd, 'docs', 'judgment', 'records', 'positions', 'old-take', 'r1.json'), 'utf8'));
    assert.equal(raw.status, undefined);
  });

  test('every new projection class is fixed-point and overwrites hand edits', () => {
    const cases = [
      { cwd: seededCwd(), rel: 'docs/judgment/people/maya.md' },
      { cwd: seededCwd(), rel: 'docs/judgment/SITUATION.md' },
      { cwd: postCutoverCwd(), rel: 'docs/judgment/OBJECTIVE.md' },
    ];
    for (const { cwd, rel } of cases) {
      regenerateProjections(cwd);
      const path = join(cwd, rel);
      const original = readFileSync(path, 'utf8');
      writeFileSync(path, `${original}\n<!-- hand edit -->\n`);
      const drift = checkProjectionRoundtrip(cwd);
      assert.equal(drift.fixedPoint, false, `${rel}: hand edit must be drift`);
      assert.ok(
        drift.diffs.some((diff) => diff.includes(rel) && diff.includes('drift')),
        `${rel}: content drift must be named`,
      );
      regenerateProjections(cwd);
      assert.equal(readFileSync(path, 'utf8'), original, `${rel}: regen overwrites edits`);
      regenerateProjections(cwd);
      assert.equal(readFileSync(path, 'utf8'), original, `${rel}: second regen is byte-identical`);
    }
  });
});

describe('S5 person and situation audit projections', () => {
  test('person files expose lifecycle, ordered sections, adjacent divergence, and complete history', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const person = readFileSync(join(cwd, 'docs', 'judgment', 'people', 'maya.md'), 'utf8');

    assert.match(person, /^# Maya$/m);
    assert.match(person, /^\*\*Lifecycle:\*\* spoken$/m);
    const sectionOffsets = ['## Role', '## Life', '## Stated', '## Revealed']
      .map((heading) => person.indexOf(heading));
    assert.ok(sectionOffsets.every((offset) => offset >= 0));
    assert.deepEqual([...sectionOffsets].sort((a, b) => a - b), sectionOffsets);

    assert.match(person, /- \*\*f1\*\* Maya owns the final review loop\./);
    assert.match(person, /channel: `secondhand`/);
    assert.match(person, /via: project lead/);
    assert.match(person, /at: 2026-07-20/);
    assert.match(person, /corrected from text="Maya owns the review loop\." at 2026-07-22T12:10:00Z/);

    const stated = person.indexOf('**f2**');
    const revealed = person.indexOf('**f3**');
    assert.ok(stated >= 0 && revealed > stated, 'stated/revealed pair renders together in pair order');
    assert.equal(
      person.match(/divergence pair: f2 ↔ f3/g)?.length,
      1,
      'the pair explanation is rendered once',
    );

    assert.match(person, /- \*\*e1\*\* `active` — works-with → \[theo\]\(theo\.md\)/);
    assert.match(person, /- \*\*e2\*\* `removed` — reports-to → \[theo\]\(theo\.md\)/);
    assert.match(person, /removed at 2026-07-22T12:20:00Z — Reporting line corrected\./);
    assert.match(person, /- \*\*of1\*\* `open` — What makes the review complete\?/);
    assert.match(person, /corrected from status="filled", filled_by="f2" at 2026-07-22T12:40:00Z/);
    assert.match(person, /- \*\*of2\*\* `filled` — Who owns the release decision\?/);
    assert.match(person, /filled_by: f2/);
    assert.match(person, /- \*\*l1\*\* `active` — fact f2 carries Release ownership\./);
    assert.match(person, /- \*\*l2\*\* `removed` — fact f3 carries Committee dependency\./);
    assert.match(person, /removed at 2026-07-22T13:00:00Z — Dependency retired\./);
  });

  test('situation groups deterministically and exposes fact, owed, and load-link audit state', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const situation = readFileSync(join(cwd, 'docs', 'judgment', 'SITUATION.md'), 'utf8');

    assert.ok(
      situation.indexOf('## Alpha System (`zeta-system`)')
        < situation.indexOf('## Zulu System (`alpha-system`)'),
      'entities sort by display name, then slug',
    );
    assert.match(situation, /- \*\*f1\*\* The cutover is atomic\./);
    assert.match(situation, /channel: `observed`/);
    assert.match(situation, /at: 2026-07-20/);
    assert.match(situation, /corrected from text="The cutover is nearly atomic\." at 2026-07-22T13:10:00Z/);
    assert.match(situation, /- \*\*f2\*\* The operator expects a repair-on-read path\./);
    assert.match(situation, /channel: `secondhand`/);
    assert.match(situation, /via: runbook owner/);

    assert.match(situation, /> \*\*OWED o1 · open\*\* Crash-window proof/);
    assert.match(situation, /> - filled_by: —/);
    assert.match(situation, /> - corrected from status="given", filled_by="f1" at 2026-07-22T13:30:00Z/);
    assert.match(situation, /> \*\*OWED o2 · given\*\* Atomic-write proof/);
    assert.match(situation, /> - filled_by: f1/);
    assert.match(situation, /- \*\*l1\*\* `active` — fact f1 carries Cutover safety\./);
    assert.match(situation, /- \*\*l2\*\* `removed` — fact f1 carries Old cutover claim\./);
    assert.match(situation, /removed at 2026-07-22T13:50:00Z — Replaced by a narrower claim\./);
  });

  test('ledger renders intent attestation attribution without payload dumps', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const ledger = readFileSync(join(cwd, 'docs', 'judgment', 'LEDGER.md'), 'utf8');
    assert.match(ledger, /intent_id: intent-published/);
    assert.match(ledger, /tool: judgment_transition/);
    assert.match(ledger, /op: transition/);
    assert.doesNotMatch(ledger, /payload:/);
    assert.doesNotMatch(ledger, /This must not render before publication\./);
  });

  test('ledger renders commit rests_on clause dependencies', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const ledger = readFileSync(join(cwd, 'docs', 'judgment', 'LEDGER.md'), 'utf8');
    assert.match(ledger, /rests_on: \["goal:v1#c1"\]/);
  });
});

describe('S5 OBJECTIVE dual-read and audit projection', () => {
  test('post-cutover objective exposes clauses, citations, associations, bill, and trajectory', () => {
    const cwd = postCutoverCwd();
    regenerateProjections(cwd);
    const objective = readFileSync(join(cwd, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8');

    assert.match(objective, /^\*\*Current version:\*\* v2$/m);
    assert.match(objective, /- \*\*c1\*\* Publish only after the durable boundary\./);
    assert.match(objective, /channel: `said`/);
    assert.match(objective, /elicitation: asked "What is the publication boundary\?"/);
    assert.match(objective, /answered 2026-07-23T09:00:00Z, ref session:goal-elicitation/);
    assert.match(objective, /corrected from text="Publish after the boundary\." at 2026-07-23T09:10:00Z/);
    assert.match(objective, /- \*\*c2\*\* Keep the crash window repairable\./);
    assert.match(objective, /channel: `secondhand`/);
    assert.match(objective, /via: operations lead/);

    assert.match(objective, /asked "Does this wording cut the objective\?"/);
    assert.match(objective, /quote: "Yes\. Cut this objective\."/);
    assert.match(objective, /answered 2026-07-23T09:05:00Z, ref session:goal-ratification/);
    assert.match(objective, /\[guard-predicate\]\(REGISTER\.md#guard-predicate\)/);
    assert.match(objective, /gj2.*`removed`.*\[okf-parse\]\(REGISTER\.md#okf-parse\)/);
    assert.match(objective, /removed at 2026-07-22T14:05:00Z — No longer load-bearing\./);

    assert.match(objective, /gl1.*`active`.*v1#c1.*`superseded version`.*The original migration bill\./);
    assert.match(objective, /gl2.*`removed`.*v2#c1.*The corrected publication rule\./);
    assert.match(objective, /removed at 2026-07-23T09:15:00Z — Folded into the runbook\./);
    assert.match(
      objective,
      /\| v1 \| 2026-07-22T14:00:00Z \| unknown \(migrated\) \| Migrated from the legacy objective\. \| no \|/,
    );
    assert.match(
      objective,
      /\| v2 \| 2026-07-23T09:05:00Z \| The clear-to-regen window must heal on read\. \| Added the durable publication boundary\. \| yes \|/,
    );
  });

  test('imported unratified current version renders a derived draft health warning', () => {
    const cwd = importedDraftCwd();
    regenerateProjections(cwd);
    const objective = readFileSync(join(cwd, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8');
    assert.match(objective, /\*\*DRAFT HEALTH WARNING:\*\*/);
    assert.match(objective, /imported\/migrated goal is not owner-ratified/i);
    assert.doesNotMatch(
      readFileSync(join(cwd, 'docs', 'judgment', 'records', 'goal', 'v1.json'), 'utf8'),
      /"draft"/,
      'draft is derived, never stored',
    );
  });

  test('dual-read matrix keeps legacy surfaces until effective cutover, then suppresses them', () => {
    const legacyCwd = legacyOnlyCwd();
    regenerateProjections(legacyCwd);
    const legacyObjective = readFileSync(
      join(legacyCwd, 'docs', 'judgment', 'OBJECTIVE.md'),
      'utf8',
    );
    const legacyIndex = readFileSync(join(legacyCwd, 'docs', 'judgment', 'index.md'), 'utf8');
    assert.match(legacyObjective, /Legacy objective only\./);
    assert.ok(existsSync(join(legacyCwd, 'docs', 'judgment', 'positions', 'objective.md')));
    assert.match(legacyIndex, /\[objective\]\(positions\/objective\.md\) — live/);

    const goalCwd = postCutoverCwd();
    regenerateProjections(goalCwd);
    const goalObjective = readFileSync(join(goalCwd, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8');
    const goalIndex = readFileSync(join(goalCwd, 'docs', 'judgment', 'index.md'), 'utf8');
    assert.match(goalObjective, /Publish only after the durable boundary\./);
    assert.ok(!existsSync(join(goalCwd, 'docs', 'judgment', 'positions', 'objective.md')));
    assert.doesNotMatch(goalIndex, /\(positions\/objective\.md\)/);

    const pendingCwd = seededCwd();
    regenerateProjections(pendingCwd);
    const pendingObjective = readFileSync(
      join(pendingCwd, 'docs', 'judgment', 'OBJECTIVE.md'),
      'utf8',
    );
    const pendingIndex = readFileSync(join(pendingCwd, 'docs', 'judgment', 'index.md'), 'utf8');
    assert.match(pendingObjective, /Ship the judgment writer\./);
    assert.doesNotMatch(pendingObjective, /Ship the migrated judgment writer\./);
    assert.ok(existsSync(join(pendingCwd, 'docs', 'judgment', 'positions', 'objective.md')));
    assert.match(pendingIndex, /\[objective\]\(positions\/objective\.md\) — live/);
  });

  test('real pending migration payload keeps legacy projections until clear', () => {
    const cwd = seededCwd();
    const store = new RecordsStore(cwd);

    // The fixture's intent is the real one: real tool/op, complete payload.
    const intent = store.readIntents().find((entry) => entry.id === MIGRATION_INTENT_ID);
    assert.equal(intent.tool, 'judgment_goal_write');
    assert.equal(intent.op, 'migrate');
    assert.equal(intent.kind, 'goal_migration');
    assert.deepEqual(
      Object.keys(intent.payload).sort(),
      ['goal_state', 'goal_state_preimage', 'goal_version', 'note', 'objective_tombstone', 'source'],
    );
    assert.equal(intent.payload.source.objective_ref, 'objective#r1');
    assert.equal(intent.payload.objective_tombstone.retracted, true);
    assert.equal(intent.payload.goal_version.provenance.intent_id, MIGRATION_INTENT_ID);

    // Before clear: every legacy surface still reads as pre-cutover.
    regenerateProjections(cwd);
    const objectiveBefore = readFileSync(join(cwd, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8');
    const positionBefore = readFileSync(
      join(cwd, 'docs', 'judgment', 'positions', 'objective.md'),
      'utf8',
    );
    const indexBefore = readFileSync(join(cwd, 'docs', 'judgment', 'index.md'), 'utf8');
    assert.match(objectiveBefore, /Ship the judgment writer\./);
    assert.doesNotMatch(objectiveBefore, /Ship the migrated judgment writer\./);
    assert.match(positionBefore, /\*\*Status:\*\* live/);
    assert.match(indexBefore, /\[objective\]\(positions\/objective\.md\) — live/);

    // Clearing the intent is the publication point: the same records become
    // effective, the goal objective renders, and the legacy surface is pruned.
    store.clearIntent(MIGRATION_INTENT_ID);
    regenerateProjections(cwd);
    const objectiveAfter = readFileSync(join(cwd, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8');
    const indexAfter = readFileSync(join(cwd, 'docs', 'judgment', 'index.md'), 'utf8');
    assert.match(objectiveAfter, /Ship the migrated judgment writer\./);
    assert.doesNotMatch(objectiveAfter, /Ship the judgment writer\.$/m);
    assert.ok(
      !existsSync(join(cwd, 'docs', 'judgment', 'positions', 'objective.md')),
      'the legacy position projection is pruned after clear',
    );
    assert.doesNotMatch(indexAfter, /\(positions\/objective\.md\)/);
    assert.equal(checkProjectionRoundtrip(cwd).fixedPoint, true);
  });

  test('a pending tombstone cannot retract the effective legacy objective', () => {
    const cwd = seededCwd();
    const store = new RecordsStore(cwd);
    assert.equal(store.readPositionChain('objective').at(-1).retracted, true, 'raw tombstone exists');
    regenerateProjections(cwd);
    const objective = readFileSync(
      join(cwd, 'docs', 'judgment', 'positions', 'objective.md'),
      'utf8',
    );
    assert.match(objective, /\*\*Status:\*\* live/);
    assert.doesNotMatch(objective, /\*\*Retracted\.\*\*/);
    assert.match(objective, /Ship the judgment writer\./);
  });
});

describe('S5 managed projection pruning', () => {
  test('roundtrip reports managed orphans without mutation; regen prunes only stale Markdown', () => {
    const cwd = postCutoverCwd();
    const peopleDir = join(cwd, 'docs', 'judgment', 'people');
    const positionsDir = join(cwd, 'docs', 'judgment', 'positions');
    mkdirSync(peopleDir, { recursive: true });
    mkdirSync(positionsDir, { recursive: true });
    const ghost = join(peopleDir, 'ghost.md');
    const oldObjective = join(positionsDir, 'objective.md');
    const peopleNote = join(peopleDir, 'keep.txt');
    const positionsNote = join(positionsDir, 'keep.json');
    writeFileSync(ghost, 'stale person\n');
    writeFileSync(oldObjective, 'stale legacy objective\n');
    writeFileSync(peopleNote, 'unmanaged\n');
    writeFileSync(positionsNote, '{}\n');

    const check = checkProjectionRoundtrip(cwd);
    assert.equal(check.fixedPoint, false);
    assert.ok(check.diffs.some((diff) => diff.includes('SITUATION.md') && diff.includes('missing')));
    assert.ok(check.diffs.some((diff) => diff.includes('people/ghost.md') && diff.includes('orphan')));
    assert.ok(check.diffs.some((diff) => diff.includes('positions/objective.md') && diff.includes('orphan')));
    assert.ok(existsSync(ghost), 'roundtrip never mutates a people orphan');
    assert.ok(existsSync(oldObjective), 'roundtrip never mutates a position orphan');

    regenerateProjections(cwd);
    assert.ok(!existsSync(ghost), 'regen prunes stale generated people Markdown');
    assert.ok(!existsSync(oldObjective), 'regen prunes post-cutover legacy objective Markdown');
    assert.ok(existsSync(peopleNote), 'unmanaged people files survive');
    assert.ok(existsSync(positionsNote), 'unmanaged position files survive');
    assert.equal(checkProjectionRoundtrip(cwd).fixedPoint, true);
  });
});

describe('OKF frontmatter', () => {
  test('per-item files carry deterministic OKF fields without invented resources', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    for (const { rel, type } of [
      { rel: 'docs/judgment/positions/objective.md', type: 'position' },
      { rel: 'docs/judgment/OBJECTIVE.md', type: 'position' },
      { rel: 'docs/judgment/people/maya.md', type: 'person' },
    ]) {
      const text = readFileSync(join(cwd, rel), 'utf8');
      assert.ok(text.startsWith('---\n'), `${rel}: opening fence`);
      const fm = text.split('---\n')[1];
      assert.match(fm, new RegExp(`^type: ${type}$`, 'm'));
      assert.match(fm, /^title: /m);
      assert.match(fm, /^timestamp: /m);
      assert.match(fm, /reference: true/);
      assert.match(fm, /origin: compose-projection/);
      assert.ok(!/^resource:/m.test(fm), `${rel}: resource must be omitted without a provider id`);
      assert.ok(!/^okf_version:/m.test(fm), `${rel}: okf_version is reserved for the bundle root`);
    }
  });

  test('frontmatter titles with YAML-hostile punctuation are quoted, safe titles stay plain', () => {
    const cwd = seededCwd();
    const store = new RecordsStore(cwd);
    store.writePerson({
      slug: 'jane',
      display_name: 'Jane: CEO, "the' + ' #1"',
      facts: [],
      edges: [],
      open_fields: [],
      load_links: [],
      provenance: {
        actor: 'seed', session: 'seed', written_at: '2026-07-23T09:00:00Z',
      },
    });
    regenerateProjections(cwd);
    const text = readFileSync(join(cwd, 'docs', 'judgment', 'people', 'jane.md'), 'utf8');
    const fm = text.split('---\n')[1];
    // JSON-quoted (valid YAML double-quote style) — a raw `title: Jane: CEO`
    // line would fail YAML parsing.
    assert.match(fm, /^title: "Jane: CEO, \\"the #1\\""$/m);
    // Safe titles remain unquoted plain scalars.
    const maya = readFileSync(join(cwd, 'docs', 'judgment', 'people', 'maya.md'), 'utf8')
      .split('---\n')[1];
    assert.match(maya, /^title: [^"]/m);
  });

  test('post-cutover OBJECTIVE is a goal item with no invented provider resource', () => {
    const cwd = postCutoverCwd();
    regenerateProjections(cwd);
    const fm = readFileSync(join(cwd, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8')
      .split('---\n')[1];
    assert.match(fm, /^type: goal$/m);
    assert.match(fm, /^title: Objective$/m);
    assert.match(fm, /^timestamp: "2026-07-23T09:05:00Z"$/m);
    assert.match(fm, /reference: true/);
    assert.match(fm, /origin: compose-projection/);
    assert.ok(!/^resource:/m.test(fm));
    assert.ok(!/^okf_version:/m.test(fm));
  });

  test('bundle root index.md carries okf_version and no type', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const fm = readFileSync(join(cwd, 'docs', 'judgment', 'index.md'), 'utf8').split('---\n')[1];
    assert.match(fm, /^okf_version: "0\.1"$/m);
    assert.ok(!/^type:/m.test(fm), 'bundle root must not carry type');
  });

  test('resource emitted only when provider id + workspace exist; item id has no literal slash', () => {
    const cwd = seededCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(
      join(cwd, '.compose', 'compose.json'),
      JSON.stringify({ judgment: { enrichment: { smartmemory: { team_id: 'team-xyz' } } } }),
    );
    const store = new RecordsStore(cwd);
    store.writePositionRevision({
      slug: 'enriched',
      claims: [{ id: 'c1', text: 't', grounding: 'INT', supports: [] }],
      conviction: { level: 'medium', source: 'inferred' },
      provider_ids: { smartmemory: 'mem_abc123' },
      provenance,
    });
    regenerateProjections(cwd);
    const fm = readFileSync(join(cwd, 'docs', 'judgment', 'positions', 'enriched.md'), 'utf8').split('---\n')[1];
    const m = /^resource: (.+)$/m.exec(fm);
    assert.ok(m, 'resource must be emitted when provider id + workspace exist');
    const uri = m[1].replace(/^"|"$/g, '');
    const parts = /^smartmemory:\/\/([^/]+)\/(.+)$/.exec(uri);
    assert.ok(parts, `resource must be a smartmemory:// URI, got ${uri}`);
    assert.equal(parts[1], 'team-xyz');
    assert.equal(parts[2], 'mem_abc123');
    assert.ok(!parts[2].includes('/'), 'item id must be a single path component');
  });
});
