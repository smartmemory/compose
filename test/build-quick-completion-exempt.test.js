/**
 * COMP-BUILD-QUICK-1 — quick-built features are exempt from MISSING_COMPLETION_REPORT.
 *
 * The `compose build --quick` lifecycle omits the report phase by design and
 * stamps `built_via: 'build-quick'` onto feature.json at ship (via
 * recordCompletion). The validator must treat a missing report.md on such a
 * feature as expected, not as completion debt — while still flagging normal
 * COMPLETE features that lack a report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProject } from '../lib/feature-validator.js';
import { recordCompletion } from '../lib/completion-writer.js';
import { readFeature, writeFeature } from '../lib/feature-json.js';

function seedProject() {
  const root = mkdtempSync(join(tmpdir(), 'bq-exempt-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });

  writeFileSync(join(root, 'ROADMAP.md'),
`# R

## Phase 1

| # | Feature | Description | Status |
|---|---|---|---|
| 1 | QUICK-1 | quick-built feature | COMPLETE |
| 2 | NORMAL-1 | normally-built feature | COMPLETE |
`);

  // Both COMPLETE, both lack report.md. QUICK-1 carries the built_via marker.
  mkdirSync(join(root, 'docs', 'features', 'QUICK-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'QUICK-1', 'design.md'), '# d');
  writeFileSync(join(root, 'docs', 'features', 'QUICK-1', 'feature.json'), JSON.stringify({
    code: 'QUICK-1', status: 'COMPLETE', description: 'quick-built feature',
    built_via: 'build-quick',
  }));

  mkdirSync(join(root, 'docs', 'features', 'NORMAL-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'NORMAL-1', 'design.md'), '# d');
  writeFileSync(join(root, 'docs', 'features', 'NORMAL-1', 'feature.json'), JSON.stringify({
    code: 'NORMAL-1', status: 'COMPLETE', description: 'normally-built feature',
  }));

  return root;
}

function reportFindingsFor(findings, code) {
  return findings.filter((f) => f.kind === 'MISSING_COMPLETION_REPORT' && f.feature_code === code);
}

test('quick-built feature (built_via=build-quick) is exempt from MISSING_COMPLETION_REPORT', async () => {
  const root = seedProject();
  const { findings } = await validateProject(root);

  assert.equal(
    reportFindingsFor(findings, 'QUICK-1').length, 0,
    'QUICK-1 carries built_via:build-quick and should NOT be flagged for a missing report',
  );
  assert.equal(
    reportFindingsFor(findings, 'NORMAL-1').length, 1,
    'NORMAL-1 has no marker and SHOULD still be flagged for a missing report',
  );
});

test('recordCompletion stamps built_via onto feature.json (and omits it without)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bq-bv-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  const base = { created: '2026-06-17', updated: '2026-06-17', phase: 'Phase 1', position: 1, description: 'd' };

  writeFeature(cwd, { ...base, code: 'BV-1', status: 'IN_PROGRESS' });
  await recordCompletion(cwd, { feature_code: 'BV-1', tests_pass: true, files_changed: [], built_via: 'build-quick' });
  assert.equal(readFeature(cwd, 'BV-1').built_via, 'build-quick', 'built_via is persisted when provided');

  writeFeature(cwd, { ...base, code: 'BV-2', status: 'IN_PROGRESS' });
  await recordCompletion(cwd, { feature_code: 'BV-2', tests_pass: true, files_changed: [] });
  assert.equal(readFeature(cwd, 'BV-2').built_via, undefined, 'built_via is absent for normal builds');
});

test('recordCompletion rejects a malformed built_via', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bq-bvbad-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  writeFeature(cwd, { created: '2026-06-17', updated: '2026-06-17', phase: 'Phase 1', position: 1, description: 'd', code: 'BV-3', status: 'IN_PROGRESS' });
  await assert.rejects(
    () => recordCompletion(cwd, { feature_code: 'BV-3', tests_pass: true, files_changed: [], built_via: 'Build Quick!' }),
    /built_via must be a lowercase template slug/,
  );
});
