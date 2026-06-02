/**
 * COMP-MCP-ENFORCE Slice 2 — lifecycle-as-truth: roadmap STATUS is a projection
 * of lifecycle phase, written through to feature.json when a guarded transition
 * applies. Off-lifecycle statuses (BLOCKED/PARKED/PARTIAL/SUPERSEDED) have no
 * phase and remain set_feature_status's domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = `${REPO_ROOT}/server`;

const {
  phaseToStatus, projectFeatureStatus,
  _testOnly_setStatusWriter, _testOnly_resetStatusWriter,
} = await import(`${SERVER_DIR}/lifecycle-guard.js`);

test('phaseToStatus: terminal phases map to terminal statuses', () => {
  assert.equal(phaseToStatus('complete'), 'COMPLETE');
  assert.equal(phaseToStatus('killed'), 'KILLED');
});

test('phaseToStatus: every active phase projects to IN_PROGRESS', () => {
  for (const p of ['explore_design', 'prd', 'architecture', 'blueprint', 'verification', 'plan', 'execute', 'report', 'docs', 'ship']) {
    assert.equal(phaseToStatus(p), 'IN_PROGRESS', `phase ${p}`);
  }
});

test('projectFeatureStatus: writes the projected status through to the feature store', async () => {
  const calls = [];
  _testOnly_setStatusWriter(async (cwd, args) => { calls.push({ cwd, args }); return { ...args, ok: true }; });

  const r = await projectFeatureStatus({ featureCode: 'FEAT-1', phase: 'killed', cwd: '/tmp/p' });
  assert.equal(r.status, 'KILLED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.code, 'FEAT-1');
  assert.equal(calls[0].args.status, 'KILLED');
  _testOnly_resetStatusWriter();
});

test('projectFeatureStatus: no-op (no throw) when featureCode is absent', async () => {
  const calls = [];
  _testOnly_setStatusWriter(async (cwd, args) => { calls.push(args); return {}; });
  const r = await projectFeatureStatus({ featureCode: undefined, phase: 'execute', cwd: '/tmp/p' });
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0);
  _testOnly_resetStatusWriter();
});

test('projectFeatureStatus: best-effort — a writer error is captured, not thrown', async () => {
  _testOnly_setStatusWriter(async () => { throw new Error('feature not found'); });
  const r = await projectFeatureStatus({ featureCode: 'GHOST', phase: 'execute', cwd: '/tmp/p' });
  assert.equal(r.status, 'IN_PROGRESS');
  assert.ok(r.error, 'error captured');
  _testOnly_resetStatusWriter();
});

test('projectFeatureStatus: real write-through flips feature.json + regenerates ROADMAP', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { writeFeature, readFeature } = await import(`${REPO_ROOT}/lib/feature-json.js`);

  _testOnly_resetStatusWriter();  // use the REAL setFeatureStatus
  const cwd = mkdtempSync(join(tmpdir(), 'proj-status-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  writeFeature(cwd, {
    code: 'PROJ-1', description: 'projection target', status: 'PLANNED',
    phase: 'Test', created: '2026-06-02', updated: '2026-06-02',
  });

  // explore_design (first advance) → IN_PROGRESS
  const r1 = await projectFeatureStatus({ featureCode: 'PROJ-1', phase: 'explore_design', cwd });
  assert.equal(r1.status, 'IN_PROGRESS');
  assert.equal(readFeature(cwd, 'PROJ-1').status, 'IN_PROGRESS', 'feature.json flipped to IN_PROGRESS');

  // killed → KILLED
  const r2 = await projectFeatureStatus({ featureCode: 'PROJ-1', phase: 'killed', cwd });
  assert.equal(r2.status, 'KILLED');
  assert.equal(readFeature(cwd, 'PROJ-1').status, 'KILLED', 'feature.json flipped to KILLED');
});

test('projectFeatureStatus: lifecycle is authoritative — projects across a table-illegal edge (PARKED→IN_PROGRESS)', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { writeFeature, readFeature } = await import(`${REPO_ROOT}/lib/feature-json.js`);

  _testOnly_resetStatusWriter();
  const cwd = mkdtempSync(join(tmpdir(), 'proj-parked-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  // PARKED → IN_PROGRESS is NOT in the roadmap TRANSITIONS table; lifecycle-as-truth
  // must still project it (derived bypass), not silently fail.
  writeFeature(cwd, {
    code: 'PARK-1', description: 'parked feature resumed', status: 'PARKED',
    phase: 'Test', created: '2026-06-02', updated: '2026-06-02',
  });

  const r = await projectFeatureStatus({ featureCode: 'PARK-1', phase: 'execute', cwd });
  assert.equal(r.status, 'IN_PROGRESS');
  assert.ok(!r.error, `should not silently fail: ${r.error}`);
  assert.equal(readFeature(cwd, 'PARK-1').status, 'IN_PROGRESS', 'PARKED→IN_PROGRESS projected');
});
