import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendEvent, readEvents } from '../lib/dispatch-ledger.js';

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'dispatch-ledger-'));
}

function ledgerPath(cwd) {
  return join(cwd, '.compose', 'data', 'dispatch-ledger.jsonl');
}

const validEvents = {
  dispatch: {
    kind: 'dispatch',
    dispatch_id: 'dispatch-1',
    site: 'build-step',
    agent: 'codex',
    outcome: 'ok',
    model: null,
    effort_intended: 'high',
    effort_executed: null,
    tokens_in: null,
    tokens_out: null,
    tokens_total: null,
    usd: null,
    duration_ms: null,
  },
  settlement: {
    kind: 'settlement',
    dispatch_id: 'dispatch-1',
    accepted: true,
  },
  'triage-estimate': {
    kind: 'triage-estimate',
    build_id: 'build-1',
    feature_code: 'COMP-TRIAGE-6',
    tier: 2,
    lane: 'standard',
    profile: { needs_design: true },
    estimate_source: 'fresh',
    confidence: 'medium',
  },
  'build-actuals': {
    kind: 'build-actuals',
    build_id: 'build-1',
    feature_code: 'COMP-TRIAGE-6',
    terminal_status: 'complete',
    files_changed_count: 2,
    files_source: 'ship',
    review_iterations: 0,
    escalations: 0,
    tokens_total: 101,
    usd: 0.12,
    test_count: null,
    pass_rate: null,
  },
};

describe('dispatch ledger writer', () => {
  test('appends each valid closed event shape with a stamped envelope', () => {
    const cwd = freshCwd();
    try {
      const rows = Object.values(validEvents).map((event) => appendEvent(cwd, event));
      assert.equal(rows.length, 4);
      for (const [index, row] of rows.entries()) {
        assert.equal(row.v, 1);
        assert.equal(typeof row.ts, 'string');
        assert.ok(!Number.isNaN(Date.parse(row.ts)));
        assert.equal(row._seq, index + 1);
      }
      assert.deepEqual(readEvents(cwd).map((row) => row.kind), Object.keys(validEvents));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('rejects unknown, missing, wrong-type, and invalid-enum fields', () => {
    const cwd = freshCwd();
    try {
      assert.throws(() => appendEvent(cwd, { ...validEvents.dispatch, extra: true }), /unknown field/i);
      assert.throws(() => appendEvent(cwd, { ...validEvents.dispatch, agent: undefined }), /required field/i);
      assert.throws(() => appendEvent(cwd, { ...validEvents.dispatch, tokens_total: '12' }), /tokens_total/);
      assert.throws(() => appendEvent(cwd, { ...validEvents.dispatch, site: 'other' }), /site/);
      assert.throws(() => appendEvent(cwd, { ...validEvents.settlement, accepted: 'yes' }), /accepted/);
      assert.throws(() => appendEvent(cwd, { ...validEvents['triage-estimate'], profile: [] }), /profile/);
      assert.throws(() => appendEvent(cwd, { ...validEvents['triage-estimate'], confidence: 'certain' }), /confidence/);
      assert.throws(() => appendEvent(cwd, { ...validEvents['build-actuals'], terminal_status: 'pending' }), /terminal_status/);
      assert.throws(() => appendEvent(cwd, { kind: 'future-event' }), /unknown kind/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('allocates monotonic sequence values and seeds from valid existing rows', () => {
    const cwd = freshCwd();
    try {
      const path = ledgerPath(cwd);
      mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
      writeFileSync(path, [
        JSON.stringify({ ...validEvents.dispatch, v: 1, ts: '2026-01-01T00:00:00.000Z', _seq: 7 }),
        JSON.stringify({ kind: 'future-event', v: 1, ts: '2026-01-01T00:00:00.000Z', _seq: 99 }),
        'not json',
      ].join('\n') + '\n');

      assert.equal(appendEvent(cwd, validEvents.settlement)._seq, 8);
      assert.equal(appendEvent(cwd, validEvents.settlement)._seq, 9);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('dispatch ledger reader', () => {
  test('skips malformed and unknown rows while tolerating future fields on valid known rows', () => {
    const cwd = freshCwd();
    try {
      const path = ledgerPath(cwd);
      mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
      writeFileSync(path, [
        'torn json',
        JSON.stringify({ kind: 'future-event', v: 1, ts: '2026-01-01T00:00:00.000Z', _seq: 1 }),
        JSON.stringify({ ...validEvents.dispatch, v: 1, ts: '2026-01-02T00:00:00.000Z', _seq: 2, future_field: { retained: true } }),
        JSON.stringify({ ...validEvents.settlement, v: 1, ts: 'not-a-date', _seq: 3 }),
      ].join('\n') + '\n');

      const rows = readEvents(cwd);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].future_field, { retained: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('returns [] for a missing ledger', () => {
    const cwd = freshCwd();
    try {
      assert.equal(existsSync(ledgerPath(cwd)), false);
      assert.deepEqual(readEvents(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('filters valid rows by kind, feature, ISO since, and duration since', () => {
    const cwd = freshCwd();
    const originalNow = Date.now;
    try {
      const path = ledgerPath(cwd);
      mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
      writeFileSync(path, [
        JSON.stringify({ ...validEvents.dispatch, v: 1, ts: '2026-01-01T00:00:00.000Z', _seq: 1, feature_code: 'COMP-OLD' }),
        JSON.stringify({ ...validEvents.dispatch, v: 1, ts: '2026-01-03T00:00:00.000Z', _seq: 2, feature_code: 'COMP-NEW' }),
        JSON.stringify({ ...validEvents['triage-estimate'], v: 1, ts: '2026-01-03T00:00:00.000Z', _seq: 3 }),
      ].join('\n') + '\n');

      assert.equal(readEvents(cwd, { kind: 'dispatch', feature: 'COMP-NEW' }).length, 1);
      assert.equal(readEvents(cwd, { since: '2026-01-02T00:00:00.000Z' }).length, 2);
      Date.now = () => Date.parse('2026-01-03T01:00:00.000Z');
      assert.equal(readEvents(cwd, { since: '2h' }).length, 2);
    } finally {
      Date.now = originalNow;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
