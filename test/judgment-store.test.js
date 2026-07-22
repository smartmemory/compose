/**
 * judgment-store.test.js — coverage for lib/judgment/store/ (T2/S02):
 * records store (revision chains, joints, predictions, ledger, intents,
 * atomic writes) + provider registry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RecordsStore } from '../lib/judgment/store/records.js';
import { createJudgmentStore } from '../lib/judgment/store/index.js';

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
    const p = {
      id: 'p1',
      text: 't',
      outcome_criteria: 'c',
      made_at: '2026-07-22T12:00:00Z',
      context: 'commit',
      refs: [],
      status: 'open',
      provenance,
    };
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
    const intent = {
      id: 'i1',
      op: 'judgment_transition',
      payload: { slug: 'j-one', to: 'under_test' },
      created_at: '2026-07-22T12:00:00Z',
    };
    store.persistIntent(intent);
    assert.deepEqual(store.readIntents().map((i) => i.id), ['i1']);
    store.clearIntent('i1');
    assert.deepEqual(store.readIntents(), []);
    store.clearIntent('i1'); // idempotent
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
});

describe('createJudgmentStore registry', () => {
  test('defaults to records provider with empty enrichment capabilities', () => {
    const cwd = freshCwd();
    const store = createJudgmentStore(cwd);
    assert.ok(store instanceof RecordsStore);
    assert.equal(store.capabilities().size, 0);
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
