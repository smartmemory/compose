/**
 * test/judgment-decision-write.test.js — GOV-COMPOSE-SEAM-1 step 1 P2.
 *
 * The three properties that distinguish this path from ingest: it is gated, it
 * is idempotent, and it FAILS CLOSED. Ingest may drop an event; a dropped
 * decision leaves a build governed by a rule set missing the thing just decided.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  provenanceLanded,
  readSidecar,
  sidecarPath,
  writeJudgmentDecision,
} from '../lib/judgment-decision-write.js';

const ON = { enabled: true, baseUrl: 'http://localhost:9001' };

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'jdw-'));
}

function decision(over = {}) {
  return {
    idempotency_key: 'compose-ledger-abc123',
    content: 'a decision',
    decision_type: 'choice',
    confidence: 0.55,
    source_type: 'inferred',
    domain: 'compose',
    tags: ['compose-judgment'],
    rejected_alternatives: [],
    context_snapshot: { ledger_seq: 9 },
    ...over,
  };
}

/** A client that echoes what it was sent, as a correct service would. */
function goodClient(calls = []) {
  return {
    calls,
    async createDecision(payload) {
      calls.push(payload);
      return { decision_id: 'dec_written1' };
    },
    async getDecision() {
      return {
        decision_id: 'dec_written1',
        source_type: calls[0].source_type,
        context_snapshot: calls[0].context_snapshot,
      };
    },
  };
}

// ── gated ─────────────────────────────────────────────────────────────────

test('does nothing when the coupling is off', async () => {
  const cwd = freshCwd();
  const client = {
    async createDecision() { throw new Error('must not be called'); },
    async getDecision() { throw new Error('must not be called'); },
  };

  const out = await writeJudgmentDecision(cwd, decision(), { client, config: { enabled: false } });

  assert.equal(out, null);
  assert.equal(existsSync(sidecarPath(cwd)), false, 'no sidecar when disabled');
});

// ── fail-closed ───────────────────────────────────────────────────────────

test('a failed write THROWS — it does not warn and continue', async () => {
  const cwd = freshCwd();
  const client = {
    async createDecision() { throw new Error('smartmemory: createDecision request failed'); },
    async getDecision() { return null; },
  };

  await assert.rejects(
    () => writeJudgmentDecision(cwd, decision(), { client, config: ON }),
    /createDecision request failed/,
  );
  assert.equal(existsSync(sidecarPath(cwd)), false, 'a failed write records nothing');
});

test('a 200 whose provenance did NOT land is treated as a failure', async () => {
  // The real case: a service predating the 2026-08-22 field addition. FastAPI
  // ignores unknown fields silently, so the 200 says nothing about source_type.
  const cwd = freshCwd();
  const client = {
    async createDecision() { return { decision_id: 'dec_x' }; },
    async getDecision() { return { decision_id: 'dec_x' }; }, // no source_type
  };

  await assert.rejects(
    () => writeJudgmentDecision(cwd, decision(), { client, config: ON }),
    /provenance did not land/,
  );
  assert.equal(existsSync(sidecarPath(cwd)), false);
});

test('a decision with no idempotency key is refused', async () => {
  await assert.rejects(
    () => writeJudgmentDecision(freshCwd(), decision({ idempotency_key: undefined }), {
      client: goodClient(), config: ON,
    }),
    /no idempotency_key/,
  );
});

// ── idempotent ────────────────────────────────────────────────────────────

test('a second write of the same entry does not hit the service', async () => {
  const cwd = freshCwd();
  const calls = [];
  const client = goodClient(calls);

  const first = await writeJudgmentDecision(cwd, decision(), { client, config: ON });
  const second = await writeJudgmentDecision(cwd, decision(), { client, config: ON });

  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.decision_id, first.decision_id);
  assert.equal(calls.length, 1, 'the service saw exactly one create');
});

test('the sidecar records key -> decision_id and survives a reread', async () => {
  const cwd = freshCwd();
  await writeJudgmentDecision(cwd, decision(), { client: goodClient(), config: ON });

  assert.deepEqual(readSidecar(cwd), { 'compose-ledger-abc123': 'dec_written1' });
});

test('a corrupt sidecar refuses rather than reading as empty', async () => {
  // Reading it as empty would re-write every decision already stored.
  const cwd = freshCwd();
  mkdirSync(join(cwd, 'docs', 'judgment', 'records'), { recursive: true });
  writeFileSync(sidecarPath(cwd), '{not json');

  await assert.rejects(
    () => writeJudgmentDecision(cwd, decision(), { client: goodClient(), config: ON }),
    /unreadable/,
  );
});

// ── payload shape ─────────────────────────────────────────────────────────

test('mapper-internal fields are stripped, and the key travels in the snapshot', async () => {
  const cwd = freshCwd();
  const calls = [];
  await writeJudgmentDecision(cwd, decision({ supersedes_slug: 'old-thing' }), {
    client: goodClient(calls), config: ON,
  });

  const sent = calls[0];
  assert.equal(sent.idempotency_key, undefined, 'not a field on the create contract');
  assert.equal(sent.supersedes_slug, undefined, 'mapper-internal, resolved by the backfill');
  assert.equal(sent.context_snapshot.idempotency_key, 'compose-ledger-abc123');
  assert.equal(sent.context_snapshot.ledger_seq, 9, 'existing snapshot keys are preserved');
});

// ── the verification predicate ────────────────────────────────────────────

test('provenanceLanded tolerates lifecycle-added snapshot keys', () => {
  // CORE-SUPERSEDE-NOTE-1: the lifecycle owns three reserved slots inside
  // context_snapshot, so a strict deep-equal would fail a correct write.
  const sent = { source_type: 'inferred', context_snapshot: { ledger_seq: 9 } };
  const stored = {
    source_type: 'inferred',
    context_snapshot: { ledger_seq: 9, superseded_reason: null },
  };
  assert.equal(provenanceLanded(stored, sent), true);
});

test('provenanceLanded rejects a changed value and a missing snapshot', () => {
  const sent = { source_type: 'inferred', context_snapshot: { ledger_seq: 9 } };
  assert.equal(provenanceLanded({ source_type: 'explicit', context_snapshot: { ledger_seq: 9 } }, sent), false);
  assert.equal(provenanceLanded({ source_type: 'inferred' }, sent), false);
  assert.equal(provenanceLanded(null, sent), false);
});

// ── the wiring actually fires (mechanism, not outcome) ────────────────────

test('judgment_ledger_append FAILS when the coupling is on and the write cannot land', async () => {
  // Asserts the mechanism, not the happy path: with the coupling enabled and
  // the service unreachable, the tool call must FAIL rather than commit locally
  // and leave a decision that exists in the projection and nowhere else.
  const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf, existsSync: ex } = await import('node:fs');
  const { judgmentLedgerAppend } = await import('../lib/judgment-writer.js');
  const { createJudgmentStore } = await import('../lib/judgment/store/index.js');

  const cwd = mk(join(tmpdir(), 'jdw-wire-'));
  md(join(cwd, '.compose'), { recursive: true });
  wf(join(cwd, '.compose', 'compose.json'), JSON.stringify({
    smartmemory: {
      enabled: true,
      // A port nothing is listening on: the write cannot land.
      baseUrl: 'http://127.0.0.1:9',
      apiKeyEnv: 'JDW_TEST_KEY',
      timeoutMs: 500,
    },
  }));
  process.env.JDW_TEST_KEY = 'sm_live_not-a-real-key';

  await assert.rejects(
    () => judgmentLedgerAppend(cwd, {
      kind: 'decide',
      title: 'wire-check — a decision that must reach SmartMemory',
      body: 'if this commits locally while the remote write failed, the canon is a lie',
      rejected: [{ what: 'committing locally first', why: 'leaves a decision in the projection only' }],
      conviction: { level: 'medium', source: 'stated' },
    }),
    (err) => {
      assert.match(String(err.message), /smartmemory|provenance did not land/i);
      return true;
    },
  );

  // Nothing was committed locally — that is the fail-closed guarantee.
  const events = createJudgmentStore(cwd).readLedgerEvents();
  assert.equal(events.length, 0, 'a failed decision write must leave no local ledger entry');
  assert.equal(ex(sidecarPath(cwd)), false, 'and no sidecar entry');

  delete process.env.JDW_TEST_KEY;
});

test('a non-decision ledger kind commits locally without any remote write', async () => {
  // `note` is not a decision (D3), so the coupling must not be consulted at all
  // — an unreachable service cannot block an annotation.
  const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf } = await import('node:fs');
  const { judgmentLedgerAppend } = await import('../lib/judgment-writer.js');
  const { createJudgmentStore } = await import('../lib/judgment/store/index.js');

  const cwd = mk(join(tmpdir(), 'jdw-note-'));
  md(join(cwd, '.compose'), { recursive: true });
  wf(join(cwd, '.compose', 'compose.json'), JSON.stringify({
    smartmemory: { enabled: true, baseUrl: 'http://127.0.0.1:9', apiKeyEnv: 'JDW_TEST_KEY', timeoutMs: 500 },
  }));
  process.env.JDW_TEST_KEY = 'sm_live_not-a-real-key';

  await judgmentLedgerAppend(cwd, {
    kind: 'note', title: 'just an annotation', body: 'no decision here', anchor: 'jdw-note',
  });

  const events = createJudgmentStore(cwd).readLedgerEvents();
  assert.equal(events.length, 1, 'a note commits regardless of the coupling');

  delete process.env.JDW_TEST_KEY;
});

// ── one ledger, shared with the backfill ──────────────────────────────────

test('verify-before-skip: a ledger entry the service has lost is rewritten', async () => {
  // A drifted ledger (restored backup, deleted decision, wrong workspace) must
  // not silently skip a write that never landed — the gap would be invisible
  // forever after.
  const cwd = freshCwd();
  const calls = [];
  const client = {
    async createDecision(p) { calls.push(p); return { decision_id: 'dec_new' }; },
    async getDecision(id) {
      if (id === 'dec_gone') return null;          // the service lost it
      return { decision_id: id, source_type: calls[0].source_type, context_snapshot: calls[0].context_snapshot };
    },
  };
  mkdirSync(join(cwd, 'docs', 'judgment', 'records'), { recursive: true });
  writeFileSync(sidecarPath(cwd), JSON.stringify({ 'compose-ledger-abc123': 'dec_gone' }));

  const out = await writeJudgmentDecision(cwd, decision(), { client, config: ON });

  assert.equal(out.skipped, false, 'a lost decision is rewritten, not skipped');
  assert.equal(out.decision_id, 'dec_new');
  assert.equal(readSidecar(cwd)['compose-ledger-abc123'], 'dec_new', 'the ledger is corrected');
});

test('the backfill and the live path share ONE ledger', async () => {
  // Two ledgers keyed identically but read separately would double-write any
  // decision recorded live and then backfilled; the create endpoint has no
  // server-side idempotency to catch it. Asserted here rather than trusted.
  const src = readFileSync(new URL('../bin/judgment-migrate.js', import.meta.url), 'utf8');

  assert.match(src, /writeJudgmentDecision/, 'the backfill delegates to the shared writer');
  assert.doesNotMatch(src, /judgment-migration-state\.json/, 'no private resume file');
  assert.doesNotMatch(src, /function saveState|function loadState/, 'no private state helpers');
});

test('a legacy backfill resume file is adopted, not ignored', async () => {
  // Ignoring it would re-write every decision the earlier backfill stored.
  const cwd = freshCwd();
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(
    join(cwd, '.compose', 'data', 'judgment-migration-state.json'),
    JSON.stringify({ version: 1, written: { 'compose-ledger-abc123': 'dec_from_legacy' } }),
  );

  assert.deepEqual(readSidecar(cwd), { 'compose-ledger-abc123': 'dec_from_legacy' });
});

// ── measured against the real service, 2026-08-22 (P3 backfill) ───────────

test('a sent null is not a lost write: the store drops null snapshot keys', () => {
  // Measured: a 13-key context_snapshot round-tripped with exactly one key
  // missing — `ledger_anchor`, the only null. The store cannot represent the
  // difference between null and absent, so treating them as different failed
  // 43 correct writes.
  const sent = { context_snapshot: { ledger_slug: 'x', ledger_anchor: null } };
  const stored = { context_snapshot: { ledger_slug: 'x' } };
  assert.equal(provenanceLanded(stored, sent), true);
});

test('a sent null does NOT excuse a non-null value going missing', () => {
  const sent = { context_snapshot: { ledger_slug: 'x', ledger_anchor: null } };
  const stored = { context_snapshot: { ledger_anchor: null } };
  assert.equal(provenanceLanded(stored, sent), false);
});

test('an unwritable status is recorded on the record, never dropped', async () => {
  // `status` is not on the create contract and `/decisions/pending/create`
  // takes no provenance, so a `pending` decision lands `active` either way.
  // Provenance wins and the divergence is made visible on the record itself.
  const cwd = freshCwd();
  const calls = [];
  await writeJudgmentDecision(cwd, decision({ status: 'pending' }), {
    client: goodClient(calls),
    config: ON,
  });
  assert.equal(calls[0].status, undefined, 'status is not a create-contract field');
  assert.equal(calls[0].context_snapshot.intended_status, 'pending');
  assert.equal(calls[0].context_snapshot.status_diverged, true);
});

test('an active decision carries no divergence marker', async () => {
  const cwd = freshCwd();
  const calls = [];
  await writeJudgmentDecision(cwd, decision({ status: 'active' }), {
    client: goodClient(calls),
    config: ON,
  });
  assert.equal(calls[0].context_snapshot.status_diverged, undefined);
  assert.equal(calls[0].context_snapshot.intended_status, undefined);
});

test('a created-but-unverified decision is recorded as an orphan', async () => {
  // It exists server-side and will NOT be in the sidecar, so without this a
  // re-run writes a second copy of the same ledger entry and nobody notices.
  const cwd = freshCwd();
  const badClient = {
    async createDecision() { return { decision_id: 'dec_orphan1' }; },
    async getDecision() { return { decision_id: 'dec_orphan1' }; }, // no provenance
  };
  await assert.rejects(
    () => writeJudgmentDecision(cwd, decision(), { client: badClient, config: ON }),
    /provenance did not land/,
  );
  const p = join(cwd, 'docs', 'judgment', 'records', 'decision-orphans.json');
  assert.ok(existsSync(p), 'the orphan must be recorded');
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(rec.orphans[0].decision_id, 'dec_orphan1');
  assert.equal(rec.orphans[0].key, 'compose-ledger-abc123');
});
