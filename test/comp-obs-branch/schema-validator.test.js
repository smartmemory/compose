import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaValidator } from '../../server/schema-validator.js';

const minimalBranchOutcome = {
  branch_id: 'abc123',
  cc_session_id: 'sess-1',
  fork_uuid: null,
  leaf_uuid: '00000000-0000-0000-0000-000000000001',
  feature_code: 'COMP-OBS-BRANCH',
  state: 'running',
  started_at: '2026-04-20T00:00:00Z',
  open_loops_produced: [],
};

const completeBranchOutcome = {
  ...minimalBranchOutcome,
  state: 'complete',
  ended_at: '2026-04-20T01:00:00Z',
  turn_count: 7,
  files_touched: [{ path: 'server/foo.js', turns_modified: 2 }],
  tests: { passed: 3, failed: 0, skipped: 0, run_ids: ['r1'] },
  cost: { tokens_in: 100, tokens_out: 50, usd: 0, wall_clock_ms: 3600000 },
  final_artifact: { path: 'docs/features/X/plan.md', kind: 'plan', snapshot: null },
};

const minimalDecisionEventBranch = {
  id: '00000000-0000-0000-0000-000000000002',
  feature_code: 'COMP-OBS-BRANCH',
  timestamp: '2026-04-20T00:00:00Z',
  kind: 'branch',
  title: 'New fork detected',
  metadata: {
    branch_id: 'abc123',
    fork_uuid: '00000000-0000-0000-0000-000000000003',
    sibling_branch_ids: ['abc123', 'def456'],
  },
};

const minimalOpenLoop = {
  id: '00000000-0000-0000-0000-000000000004',
  kind: 'deferred',
  summary: 'deferred thing',
  created_at: '2026-04-20T00:00:00Z',
  parent_feature: 'COMP-OBS-BRANCH',
};

describe('SchemaValidator', () => {
  let v;
  before(() => { v = new SchemaValidator(); });

  it('accepts a running BranchOutcome with required fields only', () => {
    const r = v.validate('BranchOutcome', minimalBranchOutcome);
    assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
    assert.deepEqual(r.errors, []);
  });

  it('accepts a complete BranchOutcome with all optional fields', () => {
    const r = v.validate('BranchOutcome', completeBranchOutcome);
    assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  it('rejects BranchOutcome missing required state', () => {
    const { state, ...rest } = minimalBranchOutcome;
    const r = v.validate('BranchOutcome', rest);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.params?.missingProperty === 'state'),
      `expected missing-state error, got ${JSON.stringify(r.errors)}`);
  });

  it('rejects BranchOutcome with invalid state enum value', () => {
    const r = v.validate('BranchOutcome', { ...minimalBranchOutcome, state: 'bogus' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.keyword === 'enum'));
  });

  it('rejects BranchOutcome with extra top-level field (additionalProperties)', () => {
    const r = v.validate('BranchOutcome', { ...minimalBranchOutcome, extra: 'nope' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.keyword === 'additionalProperties'));
  });

  it('accepts a DecisionEvent with kind=branch and correct metadata', () => {
    const r = v.validate('DecisionEvent', minimalDecisionEventBranch);
    assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  it('rejects a DecisionEvent with kind=branch missing branch_id in metadata', () => {
    const bad = { ...minimalDecisionEventBranch, metadata: { fork_uuid: null, sibling_branch_ids: [] } };
    const r = v.validate('DecisionEvent', bad);
    assert.equal(r.valid, false);
  });

  it('rejects a DecisionEvent with kind=branch and extra metadata field', () => {
    const bad = { ...minimalDecisionEventBranch, metadata: { ...minimalDecisionEventBranch.metadata, bonus: 1 } };
    const r = v.validate('DecisionEvent', bad);
    assert.equal(r.valid, false);
  });

  it('accepts a minimal OpenLoop', () => {
    const r = v.validate('OpenLoop', minimalOpenLoop);
    assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  it('accepts a BranchLineage with feature_code only', () => {
    const r = v.validate('BranchLineage', { feature_code: 'COMP-OBS-BRANCH' });
    assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  it('accepts a full BranchLineage with branches + emitted_event_ids', () => {
    const r = v.validate('BranchLineage', {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [minimalBranchOutcome],
      in_progress_siblings: ['abc123'],
      emitted_event_ids: ['00000000-0000-0000-0000-000000000002'],
      last_scan_at: '2026-04-20T00:00:00Z',
    });
    assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  it('throws on unknown definition name', () => {
    assert.throws(() => v.validate('NopeDoesNotExist', {}), /unknown/i);
  });

  it('validates DriftAxis (producer side for later COMP-OBS-DRIFT)', () => {
    const r = v.validate('DriftAxis', {
      axis_id: 'path_drift',
      numerator: 3, denominator: 10, ratio: 0.3,
      computed_at: '2026-04-20T00:00:00Z',
    });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('validates StatusSnapshot (for COMP-OBS-STATUS)', () => {
    const r = v.validate('StatusSnapshot', {
      sentence: 'Everything fine.',
      computed_at: '2026-04-20T00:00:00Z',
    });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('validates GateLogEntry (for COMP-OBS-GATELOG)', () => {
    const r = v.validate('GateLogEntry', {
      id: '00000000-0000-0000-0000-000000000005',
      gate_id: 'gate-review',
      decision: 'approve',
      timestamp: '2026-04-20T00:00:00Z',
    });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('caches validators across multiple calls (no re-compile)', () => {
    const v2 = new SchemaValidator();
    const a = v2._getValidator('BranchOutcome');
    const b = v2._getValidator('BranchOutcome');
    assert.strictEqual(a, b);
  });
});
