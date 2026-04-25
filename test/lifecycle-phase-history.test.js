/**
 * lifecycle-phase-history.test.js — appendPhaseHistory unit tests.
 *
 * COMP-OBS-TIMELINE: plugs project_lifecycle_phasehistory_gap memory.
 * appendPhaseHistory is the sole writer for lifecycle.phaseHistory[].
 *
 * Run: node --test test/lifecycle-phase-history.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { appendPhaseHistory } = await import(`${REPO_ROOT}/server/lifecycle-phase-history.js`);

function makeItem(overrides = {}) {
  return {
    id: 'item-1',
    lifecycle: {
      currentPhase: 'blueprint',
      featureCode: 'TEST-1',
      ...overrides,
    },
  };
}

describe('appendPhaseHistory', () => {
  test('creates phaseHistory when absent', () => {
    const item = makeItem();
    assert.equal(item.lifecycle.phaseHistory, undefined);
    appendPhaseHistory(item, { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' });
    assert.ok(Array.isArray(item.lifecycle.phaseHistory));
    assert.equal(item.lifecycle.phaseHistory.length, 1);
  });

  test('appends to existing phaseHistory', () => {
    const item = makeItem();
    appendPhaseHistory(item, { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' });
    appendPhaseHistory(item, { from: 'explore_design', to: 'prd', outcome: 'approved', timestamp: '2026-04-24T11:00:00Z' });
    assert.equal(item.lifecycle.phaseHistory.length, 2);
  });

  test('each entry has the expected shape', () => {
    const item = makeItem();
    appendPhaseHistory(item, { from: 'blueprint', to: 'plan', outcome: 'approved', timestamp: '2026-04-24T12:00:00Z' });
    const entry = item.lifecycle.phaseHistory[0];
    assert.equal(entry.from, 'blueprint');
    assert.equal(entry.to, 'plan');
    assert.equal(entry.outcome, 'approved');
    assert.equal(entry.timestamp, '2026-04-24T12:00:00Z');
  });

  test('null from is stored (lifecycle start case)', () => {
    const item = makeItem();
    appendPhaseHistory(item, { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' });
    assert.equal(item.lifecycle.phaseHistory[0].from, null);
  });

  test('preserves prior entries on subsequent appends', () => {
    const item = makeItem();
    appendPhaseHistory(item, { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' });
    appendPhaseHistory(item, { from: 'explore_design', to: 'prd', outcome: 'approved', timestamp: '2026-04-24T11:00:00Z' });
    appendPhaseHistory(item, { from: 'prd', to: 'blueprint', outcome: 'approved', timestamp: '2026-04-24T12:00:00Z' });
    assert.equal(item.lifecycle.phaseHistory.length, 3);
    assert.equal(item.lifecycle.phaseHistory[0].to, 'explore_design');
    assert.equal(item.lifecycle.phaseHistory[1].to, 'prd');
    assert.equal(item.lifecycle.phaseHistory[2].to, 'blueprint');
  });

  test('idempotent on duplicate timestamp: appends again (caller controls dedup)', () => {
    // appendPhaseHistory is append-only; dedup is handled at call site or via deterministic event ids
    const item = makeItem();
    const entry = { from: 'blueprint', to: 'plan', outcome: 'approved', timestamp: '2026-04-24T12:00:00Z' };
    appendPhaseHistory(item, entry);
    appendPhaseHistory(item, entry);
    // Two entries — callers should only call once per transition
    assert.equal(item.lifecycle.phaseHistory.length, 2);
  });

  test('works when lifecycle.phaseHistory is explicitly set to []', () => {
    const item = makeItem();
    item.lifecycle.phaseHistory = [];
    appendPhaseHistory(item, { from: 'plan', to: 'execute', outcome: null, timestamp: '2026-04-24T13:00:00Z' });
    assert.equal(item.lifecycle.phaseHistory.length, 1);
  });

  test('does not mutate other lifecycle fields', () => {
    const item = makeItem();
    const phaseBefore = item.lifecycle.currentPhase;
    const fcBefore = item.lifecycle.featureCode;
    appendPhaseHistory(item, { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' });
    assert.equal(item.lifecycle.currentPhase, phaseBefore);
    assert.equal(item.lifecycle.featureCode, fcBefore);
  });

  test('entries carry legacy shape so existing readers work (phase, step, enteredAt, exitedAt)', () => {
    // Existing readers in ItemDetailPanel.jsx, ContextPipelineDots.jsx, and
    // session-routes.js dereference entry.phase/step/enteredAt/exitedAt. The
    // writer must populate those fields alongside the new from/to shape.
    const item = makeItem();
    appendPhaseHistory(item, { from: 'blueprint', to: 'plan', outcome: 'approved', timestamp: '2026-04-24T12:00:00Z' });
    const entry = item.lifecycle.phaseHistory[0];
    assert.equal(entry.phase, 'plan');
    assert.equal(entry.step, 'plan');
    assert.equal(entry.enteredAt, '2026-04-24T12:00:00Z');
    assert.equal(entry.exitedAt, null);
  });

  test('appending a successor closes out the prior entry (sets exitedAt)', () => {
    const item = makeItem();
    appendPhaseHistory(item, { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' });
    appendPhaseHistory(item, { from: 'explore_design', to: 'prd', outcome: 'approved', timestamp: '2026-04-24T11:00:00Z' });
    const [first, second] = item.lifecycle.phaseHistory;
    assert.equal(first.exitedAt, '2026-04-24T11:00:00Z', 'prior phase should exit when its successor begins');
    assert.equal(second.exitedAt, null, 'newest entry stays open');
  });
});
