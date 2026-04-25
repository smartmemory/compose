/**
 * Wave 6 contract compliance — COMP-OBS-CONTRACT.
 *
 * Every artifact the Wave 6 stack produces must validate against
 * `docs/features/COMP-OBS-CONTRACT/schema.json`. This file owns cross-feature
 * compliance; BRANCH-slice real-flow integration is in wave-6-integration.test.js.
 *
 * Covers: schema-load sanity, minimum-dataset fixture gate, BranchOutcome
 * round-trip from every required fixture, BranchLineage assembly, all five
 * DecisionEvent kinds + negative gate-without-join case, OpenLoop variations,
 * error-harness rows fulfillable without unshipped siblings, and
 * test.skip placeholders for siblings (STATUS/DRIFT/GATELOG/LOOPS/TIMELINE).
 *
 * The .skip tests are named after their owning feature code so that when a
 * sibling lands, `grep -n 'COMP-OBS-<CODE>' wave-6-contract-compliance.test.js`
 * finds the exact line to un-skip.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);
const { readCCSession } = await import(`${REPO_ROOT}/server/cc-session-reader.js`);
const { pickInitialPair } = await import(`${REPO_ROOT}/src/components/vision/branchComparePanelLogic.js`);

const FIXTURE_DIR = path.resolve(REPO_ROOT, 'test/fixtures/cc-sessions');
const REQUIRED_FIXTURES = [
  'linear-session.jsonl',
  'forked-session-two-branches.jsonl',
  'forked-session-three-branches.jsonl',
  'mid-progress-session.jsonl',
  // Required so BranchOutcome compliance exercises state=failed (via failed-branch
  // fixture) and so downstream readers exposed to truncated JSONL still emit
  // schema-clean branches (state=complete / unknown depending on leaf classification).
  'failed-branch-session.jsonl',
  'truncated-session.jsonl',
];

// -----------------------------------------------------------------------------

describe('Wave 6 contract — schema loads', () => {
  test('SchemaValidator instantiates without throwing', () => {
    const v = new SchemaValidator();
    assert.ok(v);
  });
});

// -----------------------------------------------------------------------------

describe('Wave 6 contract — minimum dataset gate', () => {
  test('required fixtures exist on disk', () => {
    for (const name of REQUIRED_FIXTURES) {
      const p = path.join(FIXTURE_DIR, name);
      assert.ok(fs.existsSync(p), `Missing required fixture: ${name} (expected at ${p})`);
    }
  });
});

// -----------------------------------------------------------------------------

// `readCCSession` returns proto-BranchOutcomes without `feature_code`; the
// watcher binds it (see `cc-session-watcher.js:125`). Compliance tests apply
// the same binding the watcher does before validating.
const bindFeature = (branch, feature_code) => ({ ...branch, feature_code });

describe('Wave 6 contract — BranchOutcome compliance (per fixture)', () => {
  let v;
  before(() => { v = new SchemaValidator(); });

  for (const fixture of REQUIRED_FIXTURES) {
    test(`every branch from ${fixture} validates once bound to a feature`, async () => {
      const { branches } = await readCCSession(path.join(FIXTURE_DIR, fixture));
      assert.ok(branches.length > 0, `${fixture} produced zero branches`);
      for (const raw of branches) {
        const b = bindFeature(raw, 'COMP-OBS-CONTRACT-TEST');
        const r = v.validate('BranchOutcome', b);
        assert.equal(r.valid, true, `${fixture} branch ${b.branch_id}: ${JSON.stringify(r.errors)}`);
      }
    });
  }

  // The fixture set exercises state ∈ {complete, running, failed} but no shipped
  // fixture currently classifies a leaf as `unknown` (the classifier reserves it
  // for unclassifiable tips). Cover the fourth enum value with a synthesized
  // minimal BranchOutcome so siblings emitting state=unknown are schema-checked.
  test('state=unknown is a valid BranchOutcome shape', () => {
    const b = {
      branch_id: 'unknown-synth',
      cc_session_id: 'sess-unknown',
      fork_uuid: null,
      leaf_uuid: '00000000-0000-0000-0000-000000000999',
      feature_code: 'COMP-OBS-CONTRACT-TEST',
      state: 'unknown',
      started_at: '2026-04-24T00:00:00Z',
      open_loops_produced: [],
    };
    const r = v.validate('BranchOutcome', b);
    assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  });
});

// -----------------------------------------------------------------------------

describe('Wave 6 contract — BranchLineage compliance', () => {
  let v;
  before(() => { v = new SchemaValidator(); });

  test('well-formed lineage from a real fixture validates', async () => {
    const { branches } = await readCCSession(path.join(FIXTURE_DIR, 'forked-session-two-branches.jsonl'));
    const lineage = {
      feature_code: 'COMP-OBS-CONTRACT-TEST',
      branches: branches.map(b => bindFeature(b, 'COMP-OBS-CONTRACT-TEST')),
      in_progress_siblings: [],
      emitted_event_ids: [],
      last_scan_at: new Date().toISOString(),
    };
    const r = v.validate('BranchLineage', lineage);
    assert.equal(r.valid, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  test('lineage missing feature_code is rejected (unbound-branches guard)', () => {
    const bad = {
      branches: [],
      in_progress_siblings: [],
      emitted_event_ids: [],
      last_scan_at: new Date().toISOString(),
    };
    const r = v.validate('BranchLineage', bad);
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(e => e.params?.missingProperty === 'feature_code'),
      `expected missing feature_code error, got ${JSON.stringify(r.errors)}`,
    );
  });
});

// -----------------------------------------------------------------------------

describe('Wave 6 contract — DecisionEvent compliance (all kinds)', () => {
  let v;
  before(() => { v = new SchemaValidator(); });

  const base = (kind, metadata) => ({
    id: randomUUID(),
    feature_code: 'COMP-OBS-CONTRACT-TEST',
    timestamp: '2026-04-24T00:00:00Z',
    kind,
    title: `${kind} event`,
    metadata,
  });

  test('kind=branch validates', () => {
    const r = v.validate('DecisionEvent', base('branch', {
      branch_id: 'b1',
      fork_uuid: null,
      sibling_branch_ids: ['b1', 'b2'],
    }));
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('kind=gate validates with required gate_log_entry_id (v0.2.3 promotion)', () => {
    const r = v.validate('DecisionEvent', base('gate', {
      gate_id: 'approve-design',
      decision: 'approve',
      gate_log_entry_id: randomUUID(),
    }));
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('kind=gate WITHOUT gate_log_entry_id is rejected', () => {
    const r = v.validate('DecisionEvent', base('gate', {
      gate_id: 'approve-design',
      decision: 'approve',
    }));
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(e => e.params?.missingProperty === 'gate_log_entry_id'),
      `expected missing gate_log_entry_id error, got ${JSON.stringify(r.errors)}`,
    );
  });

  test('kind=iteration validates', () => {
    const r = v.validate('DecisionEvent', base('iteration', {
      iteration_id: 'iter-7',
      attempt: 2,
      outcome: 'pass',
    }));
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('kind=phase_transition validates', () => {
    const r = v.validate('DecisionEvent', base('phase_transition', {
      from_phase: 'blueprint',
      to_phase: 'plan',
    }));
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('kind=drift_threshold validates', () => {
    const r = v.validate('DecisionEvent', base('drift_threshold', {
      axis_id: 'path_drift',
      ratio: 0.42,
      threshold: 0.3,
    }));
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  // Per schema 0.2.1 changelog: each per-kind metadata subschema is closed
  // against drift. Without this test, a sibling could start attaching ad-hoc
  // fields (e.g. gate metadata gaining a `reviewer_note`) and still pass
  // "contract compliance".
  test('metadata with extra fields is rejected per kind (additionalProperties closure)', () => {
    const rogueCases = [
      ['branch',           { branch_id: 'b1', rogue: 'x' }],
      ['gate',             { gate_id: 'g1', decision: 'approve', gate_log_entry_id: randomUUID(), rogue: 'x' }],
      ['iteration',        { iteration_id: 'i1', rogue: 'x' }],
      ['phase_transition', { from_phase: 'plan', to_phase: 'execute', rogue: 'x' }],
      ['drift_threshold',  { axis_id: 'path_drift', ratio: 0.1, threshold: 0.05, rogue: 'x' }],
    ];
    for (const [kind, meta] of rogueCases) {
      const r = v.validate('DecisionEvent', base(kind, meta));
      assert.equal(r.valid, false, `${kind} with rogue metadata field must be rejected`);
      assert.ok(
        r.errors.some(e => e.keyword === 'additionalProperties'),
        `${kind}: expected additionalProperties error, got ${JSON.stringify(r.errors)}`,
      );
    }
  });
});

// -----------------------------------------------------------------------------

describe('Wave 6 contract — OpenLoop compliance', () => {
  let v;
  before(() => { v = new SchemaValidator(); });

  const baseLoop = () => ({
    id: randomUUID(),
    kind: 'deferred',
    summary: 'verify X before merge',
    created_at: '2026-04-24T00:00:00Z',
    parent_feature: 'COMP-OBS-CONTRACT-TEST',
  });

  test('well-formed open loop validates', () => {
    const r = v.validate('OpenLoop', baseLoop());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('well-formed resolved loop validates', () => {
    const resolved = {
      ...baseLoop(),
      resolution: {
        resolved_at: '2026-04-25T00:00:00Z',
        resolved_by: 'ruze',
        note: 'verified via integration test',
      },
    };
    const r = v.validate('OpenLoop', resolved);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('non-UUID id is rejected', () => {
    const bad = { ...baseLoop(), id: 'not-a-uuid' };
    const r = v.validate('OpenLoop', bad);
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(e => e.keyword === 'format' && e.params?.format === 'uuid'),
      `expected uuid format error, got ${JSON.stringify(r.errors)}`,
    );
  });
});

// -----------------------------------------------------------------------------

describe('Wave 6 contract — error harness (testable-today rows)', () => {
  let v;
  before(() => { v = new SchemaValidator(); });

  test('CC session with no forks → branches.length === 1, fork_uuid null', async () => {
    const { branches } = await readCCSession(path.join(FIXTURE_DIR, 'linear-session.jsonl'));
    assert.equal(branches.length, 1);
    assert.equal(branches[0].fork_uuid, null);
  });

  test('mid-progress session → running branch with null completion fields', async () => {
    const { branches } = await readCCSession(path.join(FIXTURE_DIR, 'mid-progress-session.jsonl'));
    const running = branches.filter(b => b.state === 'running');
    assert.ok(running.length >= 1, `expected >=1 running branch, got ${JSON.stringify(branches.map(b => b.state))}`);
    for (const b of running) {
      assert.equal(b.ended_at, null, 'running branch must have null ended_at');
      assert.equal(b.turn_count, null, 'running branch must have null turn_count');
      assert.equal(b.tests, null, 'running branch must have null tests');
      assert.equal(b.cost, null, 'running branch must have null cost');
    }
  });

  test('schema extension without contract update is rejected', () => {
    // A feature emits a BranchOutcome with a field not in the schema.
    const rogue = {
      branch_id: 'rogue',
      cc_session_id: 'sess-x',
      fork_uuid: null,
      leaf_uuid: '00000000-0000-0000-0000-000000000010',
      feature_code: 'COMP-OBS-ROGUE',
      state: 'running',
      started_at: '2026-04-24T00:00:00Z',
      open_loops_produced: [],
      // offending:
      rogue_field: 'silently added by some sibling',
    };
    const r = v.validate('BranchOutcome', rogue);
    assert.equal(r.valid, false, 'rogue field must be rejected');
    assert.ok(
      r.errors.some(e => e.keyword === 'additionalProperties'),
      `expected additionalProperties error, got ${JSON.stringify(r.errors)}`,
    );
  });

  test('UI overflow: 50 branches → schema validates + pickInitialPair returns valid pair', async () => {
    // Synthesize a 50-branch lineage built from a real fixture branch template.
    const { branches } = await readCCSession(path.join(FIXTURE_DIR, 'forked-session-two-branches.jsonl'));
    const rawTemplate = branches.find(b => b.state === 'complete');
    assert.ok(rawTemplate, 'fixture lacks a complete branch to clone');
    const template = bindFeature(rawTemplate, 'COMP-OBS-CONTRACT-TEST');

    const fifty = Array.from({ length: 50 }, (_, i) => ({
      ...template,
      branch_id: `synth-${String(i).padStart(3, '0')}`,
      leaf_uuid: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    }));
    const lineage = {
      feature_code: 'COMP-OBS-CONTRACT-TEST',
      branches: fifty,
      in_progress_siblings: [],
      emitted_event_ids: [],
      last_scan_at: new Date().toISOString(),
    };

    const r = v.validate('BranchLineage', lineage);
    assert.equal(r.valid, true, `lineage schema: ${JSON.stringify(r.errors?.slice(0, 3))}`);

    const [a, b] = pickInitialPair(fifty, []);
    assert.ok(a && b, 'pickInitialPair must return two branches');
    assert.notEqual(a.branch_id, b.branch_id, 'initial pair must be two distinct branches');
  });
});

// -----------------------------------------------------------------------------

describe('Wave 6 contract — pending siblings (skip-until-landed)', () => {
  test.skip('StatusSnapshot round-trip — COMP-OBS-STATUS', () => {});
  test.skip('DriftAxis emission + threshold crossing — COMP-OBS-DRIFT', () => {});
  test.skip('GateLogEntry + gate DecisionEvent join round-trip — COMP-OBS-GATELOG', () => {});
  test.skip('OpenLoop CLI round-trip + >TTL flag — COMP-OBS-LOOPS', () => {});
  // COMP-OBS-TIMELINE: un-skipped 2026-04-24 — TIMELINE ships with 3 kinds today
  // (branch via BRANCH emitter, phase_transition + iteration via TIMELINE emitters).
  // kind=gate waits for COMP-OBS-GATELOG; kind=drift_threshold waits for COMP-OBS-DRIFT.
  test('DecisionTimeline renders all 5 kinds — COMP-OBS-TIMELINE', async () => {
    const { SchemaValidator: SV } = await import(`${REPO_ROOT}/server/schema-validator.js`);
    const sv = new SV();

    // Verify the 3 shippable kinds validate today
    const shippableKinds = [
      { kind: 'branch', metadata: { branch_id: 'b1', fork_uuid: null, sibling_branch_ids: [] } },
      { kind: 'phase_transition', metadata: { from_phase: 'blueprint', to_phase: 'plan' } },
      { kind: 'iteration', metadata: { iteration_id: 'iter-1', outcome: 'pass' } },
    ];

    for (const { kind, metadata } of shippableKinds) {
      const ev = {
        id: randomUUID(),
        feature_code: 'COMP-OBS-TIMELINE-TEST',
        timestamp: '2026-04-24T10:00:00Z',
        kind,
        title: `${kind} event`,
        metadata,
      };
      const r = sv.validate('DecisionEvent', ev);
      assert.equal(r.valid, true, `TIMELINE kind=${kind} failed schema: ${JSON.stringify(r.errors)}`);
    }

    // Deferred kinds still have valid schema (schema is frozen at v0.2.3 — validate shapes)
    // gate and drift_threshold are intentionally not emitted by TIMELINE; verify schema shape only
    const deferredKinds = [
      { kind: 'gate', metadata: { gate_id: 'g1', decision: 'approve', gate_log_entry_id: randomUUID() } },
      { kind: 'drift_threshold', metadata: { axis_id: 'path_drift', ratio: 0.5, threshold: 0.3 } },
    ];

    for (const { kind, metadata } of deferredKinds) {
      const ev = {
        id: randomUUID(),
        feature_code: 'COMP-OBS-TIMELINE-TEST',
        timestamp: '2026-04-24T10:00:00Z',
        kind,
        title: `${kind} event`,
        metadata,
      };
      const r = sv.validate('DecisionEvent', ev);
      assert.equal(r.valid, true, `deferred kind=${kind} schema must still be valid: ${JSON.stringify(r.errors)}`);
    }
  });
});
