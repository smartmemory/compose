import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEvent } from '../lib/dispatch-ledger.js';
import { collectDispatchMetrics, renderDispatchMetrics } from '../lib/dispatch-metrics.js';

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'dispatch-metrics-'));
}

function dispatch(dispatch_id, fields = {}) {
  return {
    kind: 'dispatch', dispatch_id, site: 'build-step', agent: 'codex', outcome: 'ok',
    feature_code: 'COMP-METRICS',
    model: 'model-a', effort_intended: 'high', effort_executed: 'high',
    tokens_in: null, tokens_out: null, tokens_total: 10, usd: 1, duration_ms: 100,
    ...fields,
  };
}

function estimate(build_id, fields = {}) {
  return {
    kind: 'triage-estimate', build_id, feature_code: 'COMP-METRICS', tier: 2,
    lane: 'standard', profile: {}, estimate_source: 'fresh', confidence: 'high', ...fields,
  };
}

function actual(build_id, fields = {}) {
  return {
    kind: 'build-actuals', build_id, feature_code: 'COMP-METRICS', terminal_status: 'complete',
    files_changed_count: 3, files_source: 'ship', review_iterations: 1, escalations: 0,
    tokens_total: 100, usd: 0.1, test_count: null, pass_rate: null, ...fields,
  };
}

function seedFixture(cwd) {
  appendEvent(cwd, dispatch('d-1'));
  appendEvent(cwd, { kind: 'settlement', dispatch_id: 'd-1', accepted: true });
  appendEvent(cwd, { kind: 'settlement', dispatch_id: 'd-1', accepted: false }); // latest wins
  appendEvent(cwd, dispatch('d-2', {
    outcome: 'error', tokens_total: 20, duration_ms: 200, usd: 2, attempt: 2,
  }));
  appendEvent(cwd, { kind: 'settlement', dispatch_id: 'd-2', accepted: true });
  appendEvent(cwd, dispatch('d-3', {
    site: 'unattributed', effort_executed: null, effort_intended: 'low',
    tokens_total: null, duration_ms: null, usd: null,
  }));
  appendEvent(cwd, dispatch('d-4', {
    site: 'gsd', model: null, effort_executed: null, effort_intended: 'high',
    tokens_total: 3, duration_ms: 30, usd: 0.3,
  }));

  appendEvent(cwd, estimate('build-1'));
  appendEvent(cwd, actual('build-1', { terminal_status: 'failed' }));
  appendEvent(cwd, actual('build-1', { files_changed_count: 2, review_iterations: 0 }));
  appendEvent(cwd, estimate('build-2', { lane: 'trivial', estimate_source: 'escalated' }));
  appendEvent(cwd, actual('build-2', { files_changed_count: 6 }));
  appendEvent(cwd, estimate('build-pending'));
  appendEvent(cwd, actual('build-unpaired', { terminal_status: 'aborted' }));
}

describe('dispatch metrics', () => {
  test('buckets model and effort, preserves nulls, and separates completion from acceptance', () => {
    const cwd = freshCwd();
    try {
      seedFixture(cwd);
      const report = collectDispatchMetrics(cwd, { feature: 'COMP-METRICS' });

      assert.deepEqual(Object.keys(report), [
        'v', 'filters', 'coverage', 'model_effort', 'sites', 'acrr', 'known_limitations',
      ]);
      assert.deepEqual(report.filters, { since: null, feature: 'COMP-METRICS' });
      assert.deepEqual(report.coverage, { dispatch_count: 4, unattributed_count: 1, null_usage_count: 1 });

      const executed = report.model_effort.find((row) => row.model === 'model-a' && row.effort_executed === 'high');
      assert.equal(executed.effort_intended_when_unknown, null);
      assert.equal(executed.dispatch_count, 2);
      assert.equal(executed.median_tokens, 20, 'uses upper-middle median');
      assert.equal(executed.median_duration_ms, 200, 'uses upper-middle median');
      assert.deepEqual(executed.completion, { ok: 1, total: 2, rate: 0.5 });
      assert.deepEqual(executed.acceptance, { accepted: 1, settled: 2, rate: 0.5, note: null });
      assert.deepEqual(executed.retry, {
        retries: 1, eligible: 1, rate: 1, note: 'known undercount: child flows',
      });
      assert.equal(executed.usd_total, 3);

      const intendedLow = report.model_effort.find((row) => row.model === 'model-a' && row.effort_intended_when_unknown === 'low');
      assert.deepEqual(
        { effort_executed: intendedLow.effort_executed, dispatch_count: intendedLow.dispatch_count, median_tokens: intendedLow.median_tokens },
        { effort_executed: null, dispatch_count: 1, median_tokens: null },
      );
      const unknownModel = report.model_effort.find((row) => row.model === null);
      assert.equal(unknownModel.effort_intended_when_unknown, 'high');
      assert.equal(unknownModel.model, null, 'JSON never invents an unknown model string');
      assert.equal(report.sites.find((row) => row.site === 'unattributed').null_usage_count, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('uses first-match realized lanes and tracks complete-only ACRR cohorts and attrition', () => {
    const cwd = freshCwd();
    try {
      seedFixture(cwd);
      const { acrr } = collectDispatchMetrics(cwd, { feature: 'COMP-METRICS' });
      const byBuild = new Map(acrr.rows.map((row) => [row.build_id, row]));

      assert.equal(byBuild.get('build-1').realized_lane, 'trivial');
      assert.equal(byBuild.get('build-1').matched, false);
      assert.equal(byBuild.get('build-2').realized_lane, 'complex');
      assert.equal(byBuild.get('build-2').matched, false);
      assert.equal(byBuild.get('build-pending').terminal_status, null);
      assert.equal(byBuild.get('build-pending').realized_lane, null);
      assert.deepEqual(acrr.eligible, { matched: 0, total: 1, rate: 0 });
      assert.deepEqual(acrr.escalated, { matched: 0, total: 1, rate: 0 });
      assert.equal(acrr.failed_attempts, 1);
      assert.equal(acrr.aborted_attempts, 1);
      assert.equal(acrr.attrition_count, 2);
      assert.equal(acrr.pending_count, 1);
      assert.equal(acrr.unpaired_count, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('applies filters after reading the full since-filtered ledger and renders GSD explicitly', () => {
    const cwd = freshCwd();
    try {
      seedFixture(cwd);
      appendEvent(cwd, dispatch('other', { feature_code: 'COMP-OTHER', model: 'other' }));
      const report = collectDispatchMetrics(cwd, { feature: 'COMP-METRICS' });
      assert.equal(report.coverage.dispatch_count, 4);
      assert.equal(report.model_effort.some((row) => row.model === 'other'), false);
      const rendered = renderDispatchMetrics(report);
      assert.match(rendered, /Model × executed effort/);
      assert.match(rendered, /\(model: unknown\)/);
      assert.match(rendered, /n\/a \(not instrumented\)/);
      assert.match(rendered, /Known limitations/);
      assert.equal(rendered.endsWith('\n'), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
