/**
 * build-history.test.js — COMP-COCKPIT-3 run history writer/reader.
 *
 * Golden flow: append build records to build-history.jsonl, read them back
 * most-recent-first, bounded. Plus resilience: missing file, malformed lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBuildHistory, readBuildHistory } from '../lib/build-history.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'build-history-'));
}

test('appendBuildHistory creates the file and round-trips a record', () => {
  const dir = freshDir();
  try {
    const rec = {
      featureCode: 'FEAT-1', mode: 'feature', status: 'complete',
      startedAt: '2026-06-08T00:00:00.000Z', completedAt: '2026-06-08T00:01:00.000Z',
      durationMs: 60000, cost_usd: 0.12, input_tokens: 100, output_tokens: 50,
      stepCount: 4, failureReason: null, itemId: 'abc',
    };
    appendBuildHistory(dir, rec);
    assert.ok(existsSync(join(dir, 'build-history.jsonl')));
    const out = readBuildHistory(dir);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], rec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBuildHistory returns most-recent-first and honors limit', () => {
  const dir = freshDir();
  try {
    for (let i = 0; i < 5; i++) {
      appendBuildHistory(dir, { featureCode: `F${i}`, status: 'complete' });
    }
    const all = readBuildHistory(dir);
    assert.equal(all.length, 5);
    assert.equal(all[0].featureCode, 'F4', 'newest first');
    assert.equal(all[4].featureCode, 'F0', 'oldest last');

    const limited = readBuildHistory(dir, { limit: 2 });
    assert.equal(limited.length, 2);
    assert.equal(limited[0].featureCode, 'F4');
    assert.equal(limited[1].featureCode, 'F3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBuildHistory returns [] when file is missing', () => {
  const dir = freshDir();
  try {
    assert.deepEqual(readBuildHistory(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBuildHistory skips malformed lines', () => {
  const dir = freshDir();
  try {
    const path = join(dir, 'build-history.jsonl');
    writeFileSync(path,
      JSON.stringify({ featureCode: 'OK1', status: 'complete' }) + '\n' +
      'not-json-garbage\n' +
      JSON.stringify({ featureCode: 'OK2', status: 'failed' }) + '\n');
    const out = readBuildHistory(dir);
    assert.equal(out.length, 2);
    assert.equal(out[0].featureCode, 'OK2');
    assert.equal(out[1].featureCode, 'OK1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendBuildHistory never throws on a bad dir (build path safety)', () => {
  // A non-existent nested path should be created; an impossible path should not throw.
  assert.doesNotThrow(() => appendBuildHistory('/dev/null/cannot/exist', { featureCode: 'X' }));
});

// ── COMP-MOBILE-1-1: per-step projection + health-gate downgrade persistence ──

test('stepOutcomeToStatus maps every outcome to the UI vocabulary', async () => {
  const { stepOutcomeToStatus } = await import('../lib/build-history.js');
  assert.equal(stepOutcomeToStatus('complete'), 'done');
  assert.equal(stepOutcomeToStatus('approve'), 'done');
  assert.equal(stepOutcomeToStatus('failed'), 'failed');
  assert.equal(stepOutcomeToStatus('revise'), 'revised');
  assert.equal(stepOutcomeToStatus('kill'), 'killed');
  assert.equal(stepOutcomeToStatus('custom'), 'custom');
  assert.equal(stepOutcomeToStatus(undefined), 'done');
});

test('projectHistorySteps projects compact steps; summary only on failed', async () => {
  const { projectHistorySteps } = await import('../lib/build-history.js');
  const out = projectHistorySteps([
    { stepId: 'execute', outcome: 'complete', agent: 'claude', durationMs: 1200, summary: 'ok fine' },
    { stepId: 'review', outcome: 'failed', agent: 'codex', durationMs: 900, summary: 'tests red' },
    { stepId: 'mystery' },
  ]);
  assert.deepEqual(out, [
    { id: 'execute', status: 'done', agent: 'claude', durationMs: 1200 },
    { id: 'review', status: 'failed', agent: 'codex', durationMs: 900, summary: 'tests red' },
    { id: 'mystery', status: 'done', agent: null, durationMs: null },
  ]);
});

test('projectHistorySteps tolerates non-array input', async () => {
  const { projectHistorySteps } = await import('../lib/build-history.js');
  assert.deepEqual(projectHistorySteps(null), []);
  assert.deepEqual(projectHistorySteps(undefined), []);
});

test('history record round-trips steps[] (new contract field)', () => {
  const dir = freshDir();
  try {
    const steps = [{ id: 'execute', status: 'failed', agent: 'claude', durationMs: 5, summary: 'boom' }];
    appendBuildHistory(dir, { featureCode: 'F-1', status: 'failed', steps });
    assert.deepEqual(readBuildHistory(dir)[0].steps, steps);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistHealthGateDowngrade rewrites active-build.json to failed (triggers re-broadcast)', async () => {
  const { persistHealthGateDowngrade } = await import('../lib/build.js');
  const dir = freshDir();
  try {
    writeFileSync(join(dir, 'active-build.json'), JSON.stringify({
      featureCode: 'F-1', flowId: 'flow-1', status: 'complete',
      completedAt: '2026-06-11T00:00:00.000Z', steps: [],
    }));
    const written = persistHealthGateDowngrade(dir, { score: 42, threshold: 70 });
    assert.equal(written.status, 'failed');
    const onDisk = JSON.parse(readFileSync(join(dir, 'active-build.json'), 'utf-8'));
    assert.equal(onDisk.status, 'failed');
    assert.equal(onDisk.failureReason, 'Health score 42 below threshold 70');
    assert.deepEqual(onDisk.healthDowngrade, { score: 42, threshold: 70 });
    assert.equal(onDisk.completedAt, '2026-06-11T00:00:00.000Z'); // preserved
    assert.equal(onDisk.flowId, 'flow-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistHealthGateDowngrade no-ops when already failed or file missing', async () => {
  const { persistHealthGateDowngrade } = await import('../lib/build.js');
  const dir = freshDir();
  try {
    assert.equal(persistHealthGateDowngrade(dir, { score: 1, threshold: 2 }), null);
    writeFileSync(join(dir, 'active-build.json'), JSON.stringify({ status: 'failed', failureReason: 'orig' }));
    assert.equal(persistHealthGateDowngrade(dir, { score: 1, threshold: 2 }), null);
    const onDisk = JSON.parse(readFileSync(join(dir, 'active-build.json'), 'utf-8'));
    assert.equal(onDisk.failureReason, 'orig'); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistHealthGateDowngrade identity guard: no-ops when flowId/featureCode mismatch', async () => {
  const { persistHealthGateDowngrade } = await import('../lib/build.js');
  const dir = freshDir();
  try {
    const state = { featureCode: 'F-OTHER', flowId: 'flow-other', status: 'complete', steps: [] };
    writeFileSync(join(dir, 'active-build.json'), JSON.stringify(state));
    // flowId mismatch → untouched
    assert.equal(persistHealthGateDowngrade(dir, { score: 1, threshold: 2, flowId: 'flow-mine' }), null);
    assert.equal(JSON.parse(readFileSync(join(dir, 'active-build.json'), 'utf-8')).status, 'complete');
    // no flowId, featureCode mismatch → untouched
    assert.equal(persistHealthGateDowngrade(dir, { score: 1, threshold: 2, featureCode: 'F-MINE' }), null);
    assert.equal(JSON.parse(readFileSync(join(dir, 'active-build.json'), 'utf-8')).status, 'complete');
    // matching flowId → downgrade applies
    const written = persistHealthGateDowngrade(dir, { score: 1, threshold: 2, flowId: 'flow-other' });
    assert.equal(written.status, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistHealthGateDowngrade guard: legacy state without flowId but different featureCode is untouched', async () => {
  const { persistHealthGateDowngrade } = await import('../lib/build.js');
  const dir = freshDir();
  try {
    // Legacy writer: no flowId on disk, different feature
    writeFileSync(join(dir, 'active-build.json'), JSON.stringify({ featureCode: 'F-OTHER', status: 'complete' }));
    assert.equal(
      persistHealthGateDowngrade(dir, { score: 1, threshold: 2, flowId: 'flow-mine', featureCode: 'F-MINE' }),
      null
    );
    assert.equal(JSON.parse(readFileSync(join(dir, 'active-build.json'), 'utf-8')).status, 'complete');
    // Same feature, no flowId on disk → downgrade applies
    const written = persistHealthGateDowngrade(dir, { score: 1, threshold: 2, flowId: 'flow-mine', featureCode: 'F-OTHER' });
    assert.equal(written.status, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
