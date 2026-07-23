/**
 * judgment-guard-integration.test.js — guard-enabled transition + reconciler
 * semantics against an injected fake Stratum guard client:
 *   - guarded transition happy path (verdict surfaced)
 *   - crash-window roll-forward (guard advanced, apply lost → replay applies
 *     the WHOLE payload)
 *   - genuine refusal (intent dropped DURABLY — ledger note survives)
 *   - guard error keeps the intent for the next replay
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  judgmentJointAdd,
  judgmentTransition,
  replayPendingIntents,
  getJudgmentState,
} from '../lib/judgment-writer.js';
import { RecordsStore } from '../lib/judgment/store/records.js';
import {
  _testOnly_setGuardClient,
  _testOnly_resetGuardCache,
} from '../server/lifecycle-guard.js';

function guardedCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'judgment-guard-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ capabilities: { guard: true } }));
  return cwd;
}

async function seedJoint(cwd, slug) {
  await judgmentJointAdd(cwd, {
    slug,
    question: 'q?',
    branch_true: 'a',
    branch_false: 'b',
    resolve_by: 'CONSTRUCT',
    cost: 'hours',
    rank: 'high',
  });
  return new RecordsStore(cwd);
}

function fakeClient(transitionImpl) {
  return {
    register: async () => ({ status: 'registered' }),
    transition: transitionImpl,
  };
}

function craftIntent(store, slug, before) {
  const mutated = { ...before, state: 'under_test' };
  store.persistIntent({
    id: `intent-${slug}`,
    kind: 'transition',
    tool: 'judgment_transition',
    op: 'transition',
    payload: {
      slug,
      from: 'open',
      to: 'under_test',
      joint: mutated,
      events: [{
        kind: 'note',
        title: `${slug} payload note`,
        body: 'full payload must survive',
        anchor: `joint:${slug}`,
        provenance: before.provenance,
      }],
      predictions: [],
    },
    created_at: '2026-07-22T12:00:00Z',
  });
}

function attestations(store, intentId) {
  return store.readLedgerEvents().filter(
    (event) => event.kind === 'attest' && event.intent_id === intentId,
  );
}

describe('guard-enabled judgment transitions', () => {
  before(() => _testOnly_resetGuardCache());

  test('happy path: guard verdict is surfaced on the result', async () => {
    const cwd = guardedCwd();
    await seedJoint(cwd, 'happy');
    _testOnly_setGuardClient(fakeClient(async ({ toState }) => ({
      status: 'applied', verdict: { ok: true }, ledger_ref: 'lr-1', current_state: toState,
    })));
    const result = await judgmentTransition(cwd, { slug: 'happy', to: 'under_test' });
    assert.equal(result.applied, true);
    assert.equal(result.guard.ledgerRef, 'lr-1');
    assert.equal(result.guard.currentState, 'under_test');
    const [attestation] = storeAttestation(cwd);
    assert.equal(attestation.tool, 'judgment_transition');
    assert.equal(attestation.op, 'transition');
    assert.equal(attestation.provenance.intent_id, attestation.intent_id);
  });

  test('crash window: guard already advanced → replay rolls the WHOLE payload forward', async () => {
    const cwd = guardedCwd();
    const store = await seedJoint(cwd, 'crashy');
    craftIntent(store, 'crashy', store.readJoint('crashy'));
    // Re-issuing the edge is refused because current_state already sits at the target.
    _testOnly_setGuardClient(fakeClient(async () => ({
      status: 'refused', verdict: { reason: 'from_state mismatch' }, current_state: 'under_test',
    })));
    const replay = await replayPendingIntents(cwd);
    assert.equal(replay.replayed, 1);
    assert.equal(store.readJoint('crashy').state, 'under_test');
    assert.equal(store.readLedgerEvents().filter((e) => e.title === 'crashy payload note').length, 1);
    assert.equal(attestations(store, 'intent-crashy').length, 1);
    assert.deepEqual(store.readIntents(), []);
  });

  test('genuine refusal: intent dropped durably — divergence note lands in the ledger', async () => {
    const cwd = guardedCwd();
    const store = await seedJoint(cwd, 'refused');
    craftIntent(store, 'refused', store.readJoint('refused'));
    _testOnly_setGuardClient(fakeClient(async () => ({
      status: 'refused', verdict: { reason: 'predicate failed' }, current_state: 'open',
    })));
    const replay = await replayPendingIntents(cwd);
    assert.equal(replay.replayed, 0);
    assert.equal(replay.divergences.length, 1);
    assert.equal(store.readJoint('refused').state, 'open', 'payload NOT applied on refusal');
    const dropNotes = store.readLedgerEvents().filter((e) => e.kind === 'note' && /intent dropped \(intent-refused\).*refused by guard/.test(e.title));
    assert.equal(dropNotes.length, 1, 'refusal is durable, not just in the transient result');
    assert.equal(attestations(store, 'intent-refused').length, 0, 'refusal is not success');
    assert.deepEqual(store.readIntents(), []);
  });

  test('stacked intents cannot roll ONE-UNDER-TEST past one', async () => {
    const cwd = guardedCwd();
    const store = await seedJoint(cwd, 'first');
    await seedJoint(cwd, 'second');

    // Guard down: dispatching `first` fails closed but keeps its intent…
    _testOnly_setGuardClient(fakeClient(async () => { throw new Error('unreachable'); }));
    await assert.rejects(() => judgmentTransition(cwd, { slug: 'first', to: 'under_test' }));
    assert.equal(store.readIntents().length, 1);

    // …and while the guard stays down, the pending intent occupies the
    // under-test slot for live writes (replay can't resolve it yet).
    await assert.rejects(
      () => judgmentTransition(cwd, { slug: 'second', to: 'under_test' }),
      (err) => err.code === 'JUDGMENT_CONFLICT' && /pending intent/.test(err.message),
    );

    // Guard back: recovery applies exactly one occupant, and a fresh attempt
    // on `second` is refused by the disk-state check.
    _testOnly_setGuardClient(fakeClient(async ({ toState }) => ({
      status: 'applied', verdict: {}, ledger_ref: 'lr', current_state: toState,
    })));
    const state = await getJudgmentState(cwd);
    assert.deepEqual(state.under_test, ['first']);
    await assert.rejects(
      () => judgmentTransition(cwd, { slug: 'second', to: 'under_test' }),
      (err) => err.code === 'JUDGMENT_CONFLICT' && /already under test/.test(err.message),
    );
  });

  test('replay re-checks ONE-UNDER-TEST and drops the loser durably', async () => {
    const cwd = guardedCwd();
    const store = await seedJoint(cwd, 'alpha');
    await seedJoint(cwd, 'beta');
    craftIntent(store, 'alpha', store.readJoint('alpha'));
    craftIntent(store, 'beta', store.readJoint('beta'));
    _testOnly_setGuardClient(fakeClient(async ({ toState }) => ({
      status: 'applied', verdict: {}, ledger_ref: 'lr', current_state: toState,
    })));
    const replay = await replayPendingIntents(cwd);
    assert.equal(replay.replayed, 1, 'exactly one intent applies');
    assert.equal(replay.divergences.length, 1, 'the loser surfaces as a divergence');
    const underTest = store.listJoints().filter((j) => j.state === 'under_test');
    assert.equal(underTest.length, 1);
    assert.ok(
      store.readLedgerEvents().some((e) => e.kind === 'note' && /ONE-UNDER-TEST refused on replay/.test(e.title)),
      'the dropped intent left a durable ledger note',
    );
    assert.deepEqual(store.readIntents(), []);
  });

  test('live refusal is durable too — ledger note lands before the transient result returns', async () => {
    const cwd = guardedCwd();
    const store = await seedJoint(cwd, 'vetoed');
    _testOnly_setGuardClient(fakeClient(async () => ({
      status: 'refused', verdict: { reason: 'edge predicate failed' }, current_state: 'open',
    })));
    const result = await judgmentTransition(cwd, { slug: 'vetoed', to: 'under_test' });
    assert.equal(result.applied, false);
    assert.equal(result.refused, true);
    assert.ok(
      store.readLedgerEvents().some((e) => e.kind === 'note' && /refused by guard/.test(e.title) && /vetoed/.test(e.title)),
      'live refusal must leave a durable ledger note',
    );
    assert.equal(store.readLedgerEvents().some((event) => event.kind === 'attest'), false);
    assert.deepEqual(store.readIntents(), []);
  });

  test('guard error: live transition fails closed but KEEPS the intent; recovery applies it', async () => {
    const cwd = guardedCwd();
    const store = await seedJoint(cwd, 'flaky');
    _testOnly_setGuardClient(fakeClient(async () => { throw new Error('stratum unreachable'); }));
    await assert.rejects(
      () => judgmentTransition(cwd, { slug: 'flaky', to: 'under_test' }),
      (err) => err.code === 'JUDGMENT_GUARD_UNAVAILABLE',
    );
    assert.equal(store.readJoint('flaky').state, 'open', 'no mutation while guard unreachable');
    assert.equal(store.readIntents().length, 1, 'intent kept for replay');

    // Guard comes back healthy → the next read reconciles and applies.
    _testOnly_setGuardClient(fakeClient(async ({ toState }) => ({
      status: 'applied', verdict: {}, ledger_ref: 'lr-2', current_state: toState,
    })));
    const state = await getJudgmentState(cwd);
    assert.equal(state.intents_replayed, 1);
    assert.equal(store.readJoint('flaky').state, 'under_test', 'intent rolled forward once guard returned');
    const [published] = store.readLedgerEvents().filter((event) => event.kind === 'attest');
    assert.equal(published.tool, 'judgment_transition');
    assert.equal(published.op, 'transition');
    assert.deepEqual(store.readIntents(), []);
  });

  test('success attestation is durable before clear publishes the intent', async () => {
    const cwd = guardedCwd();
    await seedJoint(cwd, 'ordered');
    _testOnly_setGuardClient(fakeClient(async ({ toState }) => ({
      status: 'applied', verdict: {}, ledger_ref: 'lr-order', current_state: toState,
    })));
    const original = RecordsStore.prototype.clearIntent;
    let attestedBeforeClear = false;
    RecordsStore.prototype.clearIntent = function observeClear(id) {
      attestedBeforeClear = this.readLedgerEvents().some(
        (event) => (
          event.kind === 'attest'
          && event.intent_id === id
          && event.tool === 'judgment_transition'
          && event.op === 'transition'
        ),
      );
      return original.call(this, id);
    };
    try {
      await judgmentTransition(cwd, { slug: 'ordered', to: 'under_test' });
    } finally {
      RecordsStore.prototype.clearIntent = original;
    }
    assert.equal(attestedBeforeClear, true);
  });

  test('mismatched pre-existing attestation conflicts and preserves the intent', async () => {
    const cwd = guardedCwd();
    const store = await seedJoint(cwd, 'mismatch');
    const before = store.readJoint('mismatch');
    craftIntent(store, 'mismatch', before);
    store.appendLedgerEvent({
      kind: 'attest',
      title: 'Mismatched prior attestation',
      intent_id: 'intent-mismatch',
      tool: 'different_tool',
      op: 'different_op',
      provenance: {
        ...before.provenance,
        intent_id: 'intent-mismatch',
      },
    });
    _testOnly_setGuardClient(fakeClient(async ({ toState }) => ({
      status: 'applied', verdict: {}, ledger_ref: 'lr-mismatch', current_state: toState,
    })));
    await assert.rejects(
      () => replayPendingIntents(cwd),
      (err) => err.code === 'JUDGMENT_CONFLICT' && /intent-mismatch.*attribution/i.test(err.message),
    );
    assert.equal(store.readJoint('mismatch').state, 'open', 'failed publication restores the joint');
    assert.equal(store.readIntents().length, 1, 'conflicting intent remains for operator repair');
    assert.equal(attestations(store, 'intent-mismatch').length, 1, 'mismatched evidence is preserved');
  });
});

function storeAttestation(cwd) {
  return new RecordsStore(cwd).readLedgerEvents().filter((event) => event.kind === 'attest');
}
