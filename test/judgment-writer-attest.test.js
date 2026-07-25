import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getJudgmentState,
  judgmentGoalWrite,
  judgmentJointAdd,
  judgmentLedgerAppend,
  judgmentPersonWrite,
  judgmentPositionAmend,
  judgmentPositionCreate,
  judgmentSituationWrite,
  judgmentTransition,
} from '../lib/judgment-writer.js';
import { regenerateProjections } from '../lib/judgment-gen.js';
import { RecordsStore } from '../lib/judgment/store/records.js';
import { readManifest, syncManifest } from '../lib/judgment-attest.js';
import { verifyJudgmentCanon } from '../lib/judgment-verify.js';
import {
  _testOnly_resetGuardCache,
  _testOnly_setGuardClient,
} from '../server/lifecycle-guard.js';

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'judgment-writer-attest-'));
}

function freshGuardedCwd() {
  const cwd = freshCwd();
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(
    join(cwd, '.compose', 'compose.json'),
    JSON.stringify({ capabilities: { guard: true } }),
  );
  return cwd;
}

function manifestPath(cwd) {
  return join(cwd, '.compose', 'judgment-attest.json');
}

function guardClient(transition) {
  return {
    register: async () => ({ status: 'registered' }),
    transition,
  };
}

function positionArgs(slug) {
  return {
    slug,
    claims: [{ id: 'c1', text: `${slug} claim`, grounding: 'INT' }],
    conviction: { level: 'medium', source: 'inferred' },
  };
}

function jointArgs(slug) {
  return {
    slug,
    question: `Will ${slug} settle the issue?`,
    branch_true: 'Proceed.',
    branch_false: 'Reconsider.',
    resolve_by: 'CONSTRUCT',
    cost: 'hours',
    rank: 'medium',
  };
}

function goalCutArgs() {
  return {
    op: 'cut',
    clauses: [{
      text: 'Keep the record manifest synchronized.',
      channel: 'said',
      elicitation: {
        asked: 'What must the durability boundary preserve?',
        answered_at: '2026-07-25T09:00:00Z',
        answer_ref: 'session:manifest-sync',
      },
    }],
    provocation: {
      quote: 'A legitimate write must not report false drift.',
      at: '2026-07-25T08:55:00Z',
    },
    ratification: {
      asked: 'Is this the goal to cut?',
      answered_at: '2026-07-25T09:05:00Z',
      answer_ref: 'session:manifest-ratification',
      quote: 'Yes. Cut it.',
    },
    diff_note: 'Initial manifest synchronization goal.',
  };
}

async function assertCanonClean(cwd, label) {
  const verification = await verifyJudgmentCanon(cwd);
  assert.equal(
    verification.ok,
    true,
    `${label}: expected clean judgment canon, got ${JSON.stringify(verification)}`,
  );
}

test('syncManifest accepts absolute and relative record paths and ignores projections', () => {
  const cwd = freshCwd();
  const recordPath = join(
    cwd,
    'docs',
    'judgment',
    'records',
    'joints',
    'sync-target.json',
  );
  const projectionPath = join(cwd, 'docs', 'judgment', 'REGISTER.md');
  mkdirSync(join(recordPath, '..'), { recursive: true });
  writeFileSync(recordPath, '{"id":"sync-target"}\n');
  writeFileSync(projectionPath, 'projection bytes must not be attested\n');

  syncManifest(cwd, [
    recordPath,
    'docs/judgment/REGISTER.md',
    // the manifest must never attest itself
    '.compose/judgment-attest.json',
  ]);
  assert.deepEqual(Object.keys(readManifest(cwd)), [
    'docs/judgment/records/joints/sync-target.json',
  ]);

  rmSync(recordPath);
  syncManifest(cwd, ['docs/judgment/records/joints/sync-target.json']);
  assert.deepEqual(readManifest(cwd), {});
});

describe('legitimate writer operations synchronize record attestation', () => {
  const cases = [
    {
      name: 'judgment_position_create',
      run: (cwd) => judgmentPositionCreate(cwd, positionArgs('create-record')),
    },
    {
      name: 'judgment_position_amend',
      run: async (cwd) => {
        await judgmentPositionCreate(cwd, positionArgs('amend-record'));
        await judgmentPositionAmend(cwd, {
          slug: 'amend-record',
          claim_id: 'c1',
          grounding: 'AGENT',
        });
      },
    },
    {
      name: 'judgment_joint_add',
      run: (cwd) => judgmentJointAdd(cwd, jointArgs('joint-record')),
    },
    {
      name: 'judgment_transition',
      run: async (cwd) => {
        await judgmentJointAdd(cwd, jointArgs('transition-record'));
        await judgmentTransition(cwd, {
          slug: 'transition-record',
          to: 'under_test',
        });
      },
    },
    {
      name: 'judgment_person_write',
      run: (cwd) => judgmentPersonWrite(cwd, {
        op: 'create',
        slug: 'person-record',
        display_name: 'Person Record',
      }),
    },
    {
      name: 'judgment_situation_write',
      run: (cwd) => judgmentSituationWrite(cwd, {
        op: 'create',
        slug: 'situation-record',
        display_name: 'Situation Record',
      }),
    },
    {
      name: 'judgment_goal_write',
      run: (cwd) => judgmentGoalWrite(cwd, goalCutArgs()),
    },
    {
      name: 'judgment_ledger_append',
      run: async (cwd) => {
        await judgmentJointAdd(cwd, jointArgs('ledger-anchor'));
        await judgmentLedgerAppend(cwd, {
          kind: 'note',
          title: 'Manifest synchronization recorded',
          body: 'The ledger durability boundary updates its attestation.',
          anchor: 'joint:ledger-anchor',
        });
      },
    },
  ];

  for (const operation of cases) {
    test(`${operation.name} leaves verification green`, async () => {
      const cwd = freshCwd();
      await operation.run(cwd);
      await assertCanonClean(cwd, operation.name);
    });
  }
});

test('compensation synchronizes the manifest to the restored record state', async () => {
  const cwd = freshCwd();
  const store = new RecordsStore(cwd);
  await judgmentPersonWrite(cwd, {
    op: 'create',
    slug: 'rollback-record',
    display_name: 'Rollback Record',
  });
  const personPath = store._personPath('rollback-record');
  const before = readFileSync(personPath, 'utf8');

  const obstruction = join(cwd, 'docs', 'judgment', 'REGISTER.md');
  rmSync(obstruction);
  mkdirSync(obstruction);
  await assert.rejects(
    judgmentPersonWrite(cwd, {
      op: 'add_fact',
      slug: 'rollback-record',
      section: 'role',
      text: 'This write must be compensated.',
      channel: 'said',
      at: '2026-07-25',
    }),
    (error) => error.code === 'JUDGMENT_PARTIAL_WRITE',
  );
  assert.equal(readFileSync(personPath, 'utf8'), before);

  rmSync(obstruction, { recursive: true });
  regenerateProjections(cwd);
  await assertCanonClean(cwd, 'compensated person write');
});

test('getJudgmentState without pending intents leaves the manifest byte-identical', async () => {
  const cwd = freshCwd();
  await judgmentPositionCreate(cwd, positionArgs('read-only-state'));
  const before = readFileSync(manifestPath(cwd), 'utf8');

  await getJudgmentState(cwd);

  assert.equal(readFileSync(manifestPath(cwd), 'utf8'), before);
});

test('getJudgmentState publishes a pending intent and leaves verification green', async () => {
  const cwd = freshGuardedCwd();
  await judgmentJointAdd(cwd, jointArgs('replay-on-read'));
  _testOnly_resetGuardCache();
  _testOnly_setGuardClient(guardClient(async () => {
    throw new Error('injected pending intent');
  }));

  await assert.rejects(
    judgmentTransition(cwd, { slug: 'replay-on-read', to: 'under_test' }),
    (error) => error.code === 'JUDGMENT_GUARD_UNAVAILABLE',
  );

  const store = new RecordsStore(cwd);
  const [pending] = store.readIntents();
  const intentRelPath = `docs/judgment/records/intents/${pending.id}.json`;
  assert.ok(readManifest(cwd)[intentRelPath]);
  const before = readFileSync(manifestPath(cwd), 'utf8');

  _testOnly_setGuardClient(guardClient(async ({ toState }) => ({
    status: 'applied',
    verdict: {},
    ledger_ref: 'manifest-test',
    current_state: toState,
  })));
  const state = await getJudgmentState(cwd);

  assert.equal(state.intents_replayed, 1);
  assert.deepEqual(store.readIntents(), []);
  assert.equal(readManifest(cwd)[intentRelPath], undefined);
  assert.notEqual(readFileSync(manifestPath(cwd), 'utf8'), before);
  await assertCanonClean(cwd, 'pending-intent replay from getJudgmentState');
});

test('a refused transition removes the intent from the manifest', async () => {
  const cwd = freshGuardedCwd();
  await judgmentJointAdd(cwd, jointArgs('refused-transition'));
  const store = new RecordsStore(cwd);
  let intentPath;
  let intentRelPath;
  _testOnly_resetGuardCache();
  _testOnly_setGuardClient(guardClient(async () => {
    const [pending] = store.readIntents();
    intentPath = store._intentPath(pending.id);
    intentRelPath = `docs/judgment/records/intents/${pending.id}.json`;
    assert.ok(readManifest(cwd)[intentRelPath]);
    return {
      status: 'refused',
      verdict: { reason: 'injected refusal' },
      current_state: 'open',
    };
  }));

  const result = await judgmentTransition(cwd, {
    slug: 'refused-transition',
    to: 'under_test',
  });

  assert.deepEqual(result, {
    applied: false,
    refused: true,
    slug: 'refused-transition',
    from: 'open',
    to: 'under_test',
    guard: {
      verdict: { reason: 'injected refusal' },
      ledgerRef: null,
      currentState: 'open',
    },
    divergence: true,
  });
  assert.equal(existsSync(intentPath), false);
  assert.deepEqual(store.readIntents(), []);
  assert.equal(readManifest(cwd)[intentRelPath], undefined);
  await assertCanonClean(cwd, 'refused transition');
});

test('a legitimate write does not launder a raw edit to an unrelated record', async () => {
  const cwd = freshCwd();
  await judgmentPositionCreate(cwd, positionArgs('tampered-a'));
  await judgmentPositionCreate(cwd, positionArgs('legitimate-b'));

  const tamperedPath = join(
    cwd,
    'docs',
    'judgment',
    'records',
    'positions',
    'tampered-a',
    'r1.json',
  );
  const tampered = JSON.parse(readFileSync(tamperedPath, 'utf8'));
  tampered.claims[0].text = 'Raw hand edit that must remain drift.';
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);

  await judgmentPositionAmend(cwd, {
    slug: 'legitimate-b',
    claim_id: 'c1',
    grounding: 'AGENT',
  });

  const verification = await verifyJudgmentCanon(cwd);
  assert.equal(verification.ok, false);
  assert.ok(verification.recordDrift.some(
    (entry) => (
      entry.kind === 'modified'
      && entry.path === 'docs/judgment/records/positions/tampered-a/r1.json'
    ),
  ));
});
