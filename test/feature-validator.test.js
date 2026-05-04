import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFeature, validateProject } from '../lib/feature-validator.js';

function newFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fv-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  return root;
}

function writeFeatureFolder(root, code, files = {}, featureJson = null) {
  const dir = join(root, 'docs', 'features', code);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  if (featureJson) writeFileSync(join(dir, 'feature.json'), JSON.stringify(featureJson, null, 2));
  return dir;
}

function writeRoadmap(root, rows) {
  const lines = [
    '# Roadmap',
    '',
    '## Phase 1',
    '',
    '| # | Feature | Description | Status |',
    '|---|---------|-------------|--------|',
  ];
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.code} | ${r.description || 'desc'} | ${r.status} |`);
  });
  writeFileSync(join(root, 'ROADMAP.md'), lines.join('\n') + '\n');
}

function writeVisionState(root, items) {
  writeFileSync(
    join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items, connections: [], gates: [] }, null, 2)
  );
}

// ---------------------------------------------------------------------------
// Per-finding-kind tests
// ---------------------------------------------------------------------------

test('FEATURE_NOT_FOUND: returns single finding for unknown code', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeVisionState(root, []);
  const result = await validateFeature(root, 'NOTHING-1');
  assert.equal(result.scope, 'feature');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, 'FEATURE_NOT_FOUND');
  assert.equal(result.findings[0].severity, 'error');
});

test('FEATURE_NOT_FOUND: invalid code throws INVALID_INPUT', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  await assert.rejects(() => validateFeature(root, 'lowercase-bad'), (err) => err.code === 'INVALID_INPUT');
});

test('STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'COMPLETE' }]);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': '# d' }, {
    code: 'FEAT-1', status: 'IN_PROGRESS', description: 'desc',
  });
  writeVisionState(root, []);
  const r = await validateFeature(root, 'FEAT-1');
  assert.ok(r.findings.some((f) => f.kind === 'STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON'));
});

test('STATUS_MISMATCH_ROADMAP_VS_VISION_STATE', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'COMPLETE' }]);
  writeVisionState(root, [{ id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'in_progress' }]);
  const r = await validateFeature(root, 'FEAT-1');
  assert.ok(r.findings.some((f) => f.kind === 'STATUS_MISMATCH_ROADMAP_VS_VISION_STATE'));
});

test('STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': '# d' }, {
    code: 'FEAT-1', status: 'COMPLETE', description: 'd',
  });
  writeVisionState(root, [{ id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'in_progress' }]);
  const r = await validateFeature(root, 'FEAT-1');
  assert.ok(r.findings.some((f) => f.kind === 'STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE'));
});

test('FOLDER_WITHOUT_ROADMAP_ROW (warning)', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' }, { code: 'FEAT-1' });
  const r = await validateFeature(root, 'FEAT-1');
  const f = r.findings.find((x) => x.kind === 'FOLDER_WITHOUT_ROADMAP_ROW');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

test('ROADMAP_ROW_WITHOUT_FOLDER: PLANNED is warning', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'PLANNED' }]);
  const r = await validateFeature(root, 'FEAT-1');
  const f = r.findings.find((x) => x.kind === 'ROADMAP_ROW_WITHOUT_FOLDER');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

test('ROADMAP_ROW_WITHOUT_FOLDER: IN_PROGRESS is error (active work)', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'IN_PROGRESS' }]);
  const r = await validateFeature(root, 'FEAT-1');
  const f = r.findings.find((x) => x.kind === 'ROADMAP_ROW_WITHOUT_FOLDER');
  assert.ok(f);
  assert.equal(f.severity, 'error');
});

test('ROADMAP_ROW_WITHOUT_FOLDER: COMPLETE is warning (legacy baseline)', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'COMPLETE' }]);
  const r = await validateFeature(root, 'FEAT-1');
  const f = r.findings.find((x) => x.kind === 'ROADMAP_ROW_WITHOUT_FOLDER');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

test('ROADMAP_ROW_WITHOUT_FOLDER: PARTIAL is warning (sub-tickets may live elsewhere)', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'PARTIAL' }]);
  const r = await validateFeature(root, 'FEAT-1');
  const f = r.findings.find((x) => x.kind === 'ROADMAP_ROW_WITHOUT_FOLDER');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

test('FOLDER_WITHOUT_FEATURE_JSON (info)', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'IN_PROGRESS' }]);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' });
  const r = await validateFeature(root, 'FEAT-1');
  const f = r.findings.find((x) => x.kind === 'FOLDER_WITHOUT_FEATURE_JSON');
  assert.ok(f);
  assert.equal(f.severity, 'info');
});

test('MISSING_DESIGN_ARTIFACT (error, IN_PROGRESS)', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'IN_PROGRESS' }]);
  writeFeatureFolder(root, 'FEAT-1', { 'plan.md': 'x' }, {
    code: 'FEAT-1', status: 'IN_PROGRESS',
  });
  const r = await validateFeature(root, 'FEAT-1');
  const f = r.findings.find((x) => x.kind === 'MISSING_DESIGN_ARTIFACT');
  assert.ok(f);
  assert.equal(f.severity, 'error');
});

test('MISSING_COMPLETION_REPORT (warning, COMPLETE)', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'COMPLETE' }]);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' }, {
    code: 'FEAT-1', status: 'COMPLETE',
  });
  const r = await validateFeature(root, 'FEAT-1');
  const f = r.findings.find((x) => x.kind === 'MISSING_COMPLETION_REPORT');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

test('DANGLING_ARTIFACT_LINK (error)', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' }, {
    code: 'FEAT-1',
    status: 'IN_PROGRESS',
    artifacts: [{ type: 'snapshot', path: 'docs/snapshots/missing.md' }],
  });
  const r = await validateFeature(root, 'FEAT-1');
  assert.ok(r.findings.some((f) => f.kind === 'DANGLING_ARTIFACT_LINK'));
});

test('ARTIFACT_OUTSIDE_FEATURE_FOLDER (error)', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  // Create an unrelated path inside the project but outside the feature folder.
  mkdirSync(join(root, 'docs', 'other'), { recursive: true });
  writeFileSync(join(root, 'docs', 'other', 'plan.md'), 'x');
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' }, {
    code: 'FEAT-1',
    status: 'IN_PROGRESS',
    artifacts: [{ type: 'plan', path: 'docs/other/plan.md' }],
  });
  const r = await validateFeature(root, 'FEAT-1');
  assert.ok(r.findings.some((f) => f.kind === 'ARTIFACT_OUTSIDE_FEATURE_FOLDER'));
});

test('ARTIFACT_OUTSIDE_FEATURE_FOLDER detects .. escape (boundary-aware normalize)', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' });
  writeFeatureFolder(root, 'FEAT-2', { 'plan.md': 'x' });
  // Write feature.json for FEAT-1 with an artifact path that uses .. to escape.
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'feature.json'), JSON.stringify({
    code: 'FEAT-1',
    status: 'IN_PROGRESS',
    artifacts: [{ type: 'plan', path: 'docs/features/FEAT-1/../FEAT-2/plan.md' }],
  }));
  const r = await validateFeature(root, 'FEAT-1');
  assert.ok(
    r.findings.some((f) => f.kind === 'ARTIFACT_OUTSIDE_FEATURE_FOLDER'),
    `path with .. escape must be flagged; findings: ${JSON.stringify(r.findings.map((f) => f.kind))}`
  );
});

test('ARTIFACT_OUTSIDE_FEATURE_FOLDER does not false-positive on FEAT-1 vs FEAT-10 prefix', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' });
  writeFeatureFolder(root, 'FEAT-10', { 'plan.md': 'x' });
  // FEAT-10 has artifact correctly under its own folder
  writeFileSync(join(root, 'docs', 'features', 'FEAT-10', 'feature.json'), JSON.stringify({
    code: 'FEAT-10',
    status: 'IN_PROGRESS',
    artifacts: [{ type: 'plan', path: 'docs/features/FEAT-10/plan.md' }],
  }));
  const r = await validateFeature(root, 'FEAT-10');
  assert.ok(
    !r.findings.some((f) => f.kind === 'ARTIFACT_OUTSIDE_FEATURE_FOLDER'),
    `FEAT-10 artifact in own folder must not be flagged; findings: ${JSON.stringify(r.findings)}`
  );
});

test('DANGLING_LINK_FEATURES_TARGET (error)', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' }, {
    code: 'FEAT-1', status: 'IN_PROGRESS',
    links: [{ kind: 'depends_on', to_code: 'NONEXISTENT-9' }],
  });
  const r = await validateFeature(root, 'FEAT-1');
  assert.ok(r.findings.some((f) => f.kind === 'DANGLING_LINK_FEATURES_TARGET'));
});

test('CHANGELOG_MENTIONS_MISSING_FEATURE (project, error)', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeFileSync(join(root, 'CHANGELOG.md'),
    `# Changelog\n\n## 2026-05-04\n\n### NOT-A-FEATURE — header for a code that doesn't exist\n\nbody\n`);
  const r = await validateProject(root);
  assert.ok(r.findings.some((f) => f.kind === 'CHANGELOG_MENTIONS_MISSING_FEATURE' && f.feature_code === 'NOT-A-FEATURE'));
});

test('JOURNAL_INDEX_VS_FILES_DRIFT (project, error)', async () => {
  const root = newFixture();
  writeFileSync(join(root, 'docs', 'journal', 'README.md'),
    `# Journal\n\n| Date | Entry | Summary |\n|---|---|---|\n| 2026-05-04 | [Session 1](2026-05-04-session-1-missing.md) | x |\n`);
  // file referenced in index does not exist
  writeRoadmap(root, []);
  const r = await validateProject(root);
  assert.ok(r.findings.some((f) => f.kind === 'JOURNAL_INDEX_VS_FILES_DRIFT'));
});

test('ORPHAN_FOLDER (project, warning)', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeVisionState(root, []);
  writeFeatureFolder(root, 'ORPHAN-1', { 'design.md': 'x' });
  const r = await validateProject(root);
  const f = r.findings.find((x) => x.kind === 'ORPHAN_FOLDER' && x.feature_code === 'ORPHAN-1');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

test('ORPHAN_FOLDER downgrades to info for externalPrefixes', async () => {
  const root = newFixture();
  writeRoadmap(root, []);
  writeFeatureFolder(root, 'STRAT-99', { 'design.md': 'x' });
  const r = await validateProject(root, { externalPrefixes: ['STRAT-'] });
  const f = r.findings.find((x) => x.kind === 'ORPHAN_FOLDER' && x.feature_code === 'STRAT-99');
  assert.ok(f);
  assert.equal(f.severity, 'info');
});

// Killed-mode tests

test('killed mode: skips most checks, runs only terminal-invariant ones', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'KILL-1', status: 'KILLED' }]);
  writeFeatureFolder(root, 'KILL-1', {
    'killed.md': '**KILLED (2026-04-01):** superseded by NEWER-1',
    // Deliberately no design.md, no report.md — these would normally trigger findings
  }, { code: 'KILL-1', status: 'KILLED' });
  const r = await validateFeature(root, 'KILL-1');
  // Should NOT have MISSING_DESIGN_ARTIFACT etc.
  assert.ok(!r.findings.some((f) => f.kind === 'MISSING_DESIGN_ARTIFACT'));
  // SHOULD have KILLED_SUCCESSOR_NOT_LINKED (mentions NEWER-1, no supersedes link)
  assert.ok(r.findings.some((f) => f.kind === 'KILLED_SUCCESSOR_NOT_LINKED'));
});

test('KILLED_STATUS_NOT_TERMINAL (error)', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'KILL-1', status: 'IN_PROGRESS' }]); // not terminal
  writeFeatureFolder(root, 'KILL-1', { 'killed.md': '**KILLED:** x' });
  const r = await validateFeature(root, 'KILL-1');
  assert.ok(r.findings.some((f) => f.kind === 'KILLED_STATUS_NOT_TERMINAL'));
});

// False-positive guardrails

test('false positive: PLANNED feature without folder is not error', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'PLANNED' }]);
  const r = await validateFeature(root, 'FEAT-1');
  // Has the warning but should NOT have any error-severity findings
  assert.ok(!r.findings.some((f) => f.severity === 'error'));
});

test('false positive: clean feature produces only baseline findings', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'IN_PROGRESS', description: 'd' }]);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': '# d', 'plan.md': '# p' }, {
    code: 'FEAT-1', status: 'IN_PROGRESS', description: 'd',
  });
  writeVisionState(root, [{ id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'in_progress' }]);
  const r = await validateFeature(root, 'FEAT-1');
  // No error findings
  assert.deepEqual(r.findings.filter((f) => f.severity === 'error'), [],
    `unexpected errors: ${JSON.stringify(r.findings.filter((f) => f.severity === 'error'))}`);
});

test('false positive: anonymous _anon_* rows are filtered before validation', async () => {
  const root = newFixture();
  // Write a malformed row that the parser will tag _anon_*
  writeFileSync(join(root, 'ROADMAP.md'),
    `# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | (no code) | x | PLANNED |\n`);
  writeVisionState(root, []);
  const r = await validateProject(root);
  // The _anon_* code must not appear in any finding
  assert.ok(!r.findings.some((f) => f.feature_code && f.feature_code.startsWith('_anon')));
});

test('false positive: vision-state with top-level featureCode emits no legacy-key finding', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'IN_PROGRESS' }]);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' }, { code: 'FEAT-1', status: 'IN_PROGRESS' });
  writeVisionState(root, [{ id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'in_progress' }]);
  const r = await validateFeature(root, 'FEAT-1');
  assert.ok(!r.findings.some((f) => f.kind === 'VISION_STATE_LEGACY_KEY'));
});

test('false positive: legacy mode skips feature.json checks', async () => {
  const root = newFixture();
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'IN_PROGRESS' }]);
  writeFeatureFolder(root, 'FEAT-1', { 'design.md': 'x' }); // no feature.json
  const r = await validateFeature(root, 'FEAT-1', { featureJsonMode: false });
  assert.ok(!r.findings.some((f) => f.kind === 'FOLDER_WITHOUT_FEATURE_JSON'));
});
