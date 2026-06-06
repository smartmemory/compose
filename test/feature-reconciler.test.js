import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reconcileProject,
  defaultClasses,
  nearestLinkKind,
  FIX_CLASSES,
} from '../lib/feature-reconciler.js';
import { validateProject } from '../lib/feature-validator.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function scaffold(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  writeFileSync(join(root, 'docs', 'journal', 'README.md'),
    '# Journal\n\n| Date | Entry | Summary |\n|---|---|---|\n');
  if (opts.narrative) {
    writeFileSync(join(root, '.compose', 'compose.json'),
      JSON.stringify({ roadmap: { narrative: true } }));
  }
  return root;
}

function addFeature(root, code, { status, links, artifacts, docs = ['design.md'], roadmapStatus } = {}) {
  const dir = join(root, 'docs', 'features', code);
  mkdirSync(dir, { recursive: true });
  for (const d of docs) writeFileSync(join(dir, d), `# ${d}`);
  const fj = { code, status, description: `${code} desc` };
  if (links) fj.links = links;
  if (artifacts) fj.artifacts = artifacts;
  writeFileSync(join(dir, 'feature.json'), JSON.stringify(fj, null, 2));
  return { dir, roadmapStatus: roadmapStatus ?? status };
}

function writeRoadmap(root, rows) {
  // rows: [{code, desc, status}]
  let body = '# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n';
  rows.forEach((r, i) => { body += `| ${i + 1} | ${r.code} | ${r.desc ?? 'desc'} | ${r.status} |\n`; });
  writeFileSync(join(root, 'ROADMAP.md'), body);
}

function writeVision(root, items) {
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items, connections: [], gates: [] }, null, 2));
}

function visionItem(code, status, n = 1) {
  return {
    id: `00000000-0000-0000-0000-00000000000${n}`,
    type: 'feature',
    featureCode: code,
    status,
  };
}

function readFeatureJson(root, code) {
  return JSON.parse(readFileSync(join(root, 'docs', 'features', code, 'feature.json'), 'utf8'));
}

function kinds(findings, code) {
  return findings.filter((f) => f.feature_code === code).map((f) => f.kind);
}

// ---------------------------------------------------------------------------
// nearestLinkKind unit
// ---------------------------------------------------------------------------

test('nearestLinkKind repairs a close typo, rejects far/ambiguous', () => {
  assert.equal(nearestLinkKind('dependson'), 'depends_on'); // distance 1
  assert.equal(nearestLinkKind('blocks'), 'blocks');        // exact
  assert.equal(nearestLinkKind('relted'), 'related');       // distance 1
  assert.equal(nearestLinkKind('xyz'), null);               // too far
  assert.equal(nearestLinkKind(''), null);
  assert.equal(nearestLinkKind('external'), null);          // not a repair target
});

test('defaultClasses excludes destructive/heuristic opt-ins', () => {
  const d = new Set(defaultClasses());
  assert.ok(d.has('dangling_link'));
  assert.ok(d.has('invalid_link_kind'));
  assert.ok(d.has('status_fj_vision'));
  assert.ok(!d.has('partial_age'));
  assert.ok(!d.has('roadmap_status_rewrite'));
  assert.ok(!d.has('invalid_link_kind_repair'));
  // registry sanity
  assert.equal(FIX_CLASSES.partial_age.mutatesFeatureJson, true);
  assert.equal(FIX_CLASSES.status_fj_vision.mutatesFeatureJson, false);
});

// ---------------------------------------------------------------------------
// Dry-run writes nothing
// ---------------------------------------------------------------------------

test('dry-run produces a plan and writes nothing', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', {
    status: 'IN_PROGRESS',
    links: [{ kind: 'depends_on', to_code: 'GHOST-9' }], // dangling
  });
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'IN_PROGRESS' }]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress')]);

  const before = readFeatureJson(root, 'FEAT-1');
  const res = await reconcileProject(root, { apply: false });
  assert.equal(res.dry_run, true);
  assert.ok(res.plan.length >= 1);
  assert.deepEqual(readFeatureJson(root, 'FEAT-1'), before); // untouched
});

// ---------------------------------------------------------------------------
// Dangling link → drop (default class), and convergence with a second bad link
// ---------------------------------------------------------------------------

test('apply drops a dangling link AND repairs/drops an invalid kind in one write (convergence)', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', { status: 'IN_PROGRESS' });
  addFeature(root, 'FEAT-2', {
    status: 'IN_PROGRESS',
    links: [
      { kind: 'depends_on', to_code: 'FEAT-1' },   // valid, keep
      { kind: 'blocks', to_code: 'GHOST-9' },       // dangling, drop
      { kind: 'dependson', to_code: 'FEAT-1' },     // invalid kind, drop (no repair class)
    ],
  });
  writeRoadmap(root, [
    { code: 'FEAT-1', status: 'IN_PROGRESS' },
    { code: 'FEAT-2', status: 'IN_PROGRESS' },
  ]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress', 1), visionItem('FEAT-2', 'in_progress', 2)]);

  const res = await reconcileProject(root, { apply: true });
  assert.equal(res.dry_run, false);
  assert.ok(res.applied.every((a) => a.ok), JSON.stringify(res.applied));

  const fj = readFeatureJson(root, 'FEAT-2');
  assert.deepEqual(fj.links, [{ kind: 'depends_on', to_code: 'FEAT-1' }]);

  // closed loop: the dangling finding is gone
  const after = await validateProject(root, {});
  assert.ok(!kinds(after.findings, 'FEAT-2').includes('DANGLING_LINK_FEATURES_TARGET'));
});

test('invalid_link_kind_repair (opt-in) repairs to nearest instead of dropping', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', { status: 'IN_PROGRESS' });
  addFeature(root, 'FEAT-2', {
    status: 'IN_PROGRESS',
    links: [{ kind: 'dependson', to_code: 'FEAT-1' }],
  });
  writeRoadmap(root, [
    { code: 'FEAT-1', status: 'IN_PROGRESS' },
    { code: 'FEAT-2', status: 'IN_PROGRESS' },
  ]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress', 1), visionItem('FEAT-2', 'in_progress', 2)]);

  await reconcileProject(root, {
    apply: true,
    classes: ['invalid_link_kind', 'invalid_link_kind_repair'],
  });
  const fj = readFeatureJson(root, 'FEAT-2');
  assert.deepEqual(fj.links, [{ kind: 'depends_on', to_code: 'FEAT-1' }]);
});

// ---------------------------------------------------------------------------
// status_fj_vision → reproject (default class, survives narrative)
// ---------------------------------------------------------------------------

test('apply reprojects vision-state status from canonical feature.json', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', { status: 'COMPLETE', docs: ['design.md', 'report.md'] });
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'COMPLETE' }]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress')]); // drifted

  const before = await validateProject(root, {});
  assert.ok(kinds(before.findings, 'FEAT-1').includes('STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE'));

  const res = await reconcileProject(root, { apply: true });
  assert.ok(res.applied.every((a) => a.ok), JSON.stringify(res.applied));

  const vision = JSON.parse(readFileSync(join(root, '.compose', 'data', 'vision-state.json'), 'utf8'));
  assert.equal(vision.items[0].status, 'complete');

  const after = await validateProject(root, {});
  assert.ok(!kinds(after.findings, 'FEAT-1').includes('STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE'));
});

// ---------------------------------------------------------------------------
// partial_age (opt-in) → PLANNED only when no evidence
// ---------------------------------------------------------------------------

test('partial_age ages an evidence-free PARTIAL feature to PLANNED', async () => {
  const root = scaffold();
  // PARTIAL, no canonical docs, no artifacts, no changelog
  addFeature(root, 'FEAT-1', { status: 'PARTIAL', docs: [] });
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'PARTIAL' }]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress')]);

  const res = await reconcileProject(root, { apply: true, classes: ['partial_age'] });
  assert.ok(res.applied.every((a) => a.ok), JSON.stringify(res.applied));
  assert.equal(readFeatureJson(root, 'FEAT-1').status, 'PLANNED');
});

test('partial_age does NOT fire when artifacts[] evidence exists', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', {
    status: 'PARTIAL',
    docs: [],
    artifacts: [{ type: 'snapshot', path: 'docs/features/FEAT-1/snap.md' }],
  });
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'snap.md'), '# snap');
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'PARTIAL' }]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress')]);

  const res = await reconcileProject(root, { apply: false, classes: ['partial_age'] });
  assert.equal(res.plan.length, 0);
});

// ---------------------------------------------------------------------------
// roadmap_status_rewrite (opt-in) — narrative suppression is the guard
// ---------------------------------------------------------------------------

test('roadmap_status_rewrite plans a surgical cell edit on a non-narrative workspace', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', { status: 'IN_PROGRESS' });
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'COMPLETE' }]); // row drifts from feature.json
  writeVision(root, [visionItem('FEAT-1', 'in_progress')]);

  const res = await reconcileProject(root, { apply: false, classes: ['roadmap_status_rewrite'] });
  const entry = res.plan.find((e) => e.action === 'set_roadmap_row_status');
  assert.ok(entry, 'expected a set_roadmap_row_status entry');
  assert.equal(entry.feature_code, 'FEAT-1');
  assert.equal(entry.after, 'IN_PROGRESS');
});

test('roadmap_status_rewrite --apply edits ONLY the status cell (no duplicate rows, converges)', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', { status: 'IN_PROGRESS' });
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'COMPLETE' }]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress')]);

  const before = await validateProject(root, {});
  assert.ok(kinds(before.findings, 'FEAT-1').includes('STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON'));

  await reconcileProject(root, { apply: true, classes: ['roadmap_status_rewrite'] });

  const roadmap = readFileSync(join(root, 'ROADMAP.md'), 'utf8');
  // exactly one FEAT-1 row, now IN_PROGRESS, no appended generated section
  const featRows = roadmap.split('\n').filter((l) => /\bFEAT-1\b/.test(l));
  assert.equal(featRows.length, 1, roadmap);
  assert.match(featRows[0], /IN_PROGRESS/);
  assert.ok(!roadmap.includes('## Features'), 'no generated section appended');

  const after = await validateProject(root, {});
  assert.ok(!kinds(after.findings, 'FEAT-1').includes('STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON'));
});

test('dangling-link drop converges with the validator for a malformed external link', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', {
    status: 'IN_PROGRESS',
    // malformed external link carrying an unresolved to_code — the validator
    // flags it DANGLING; reconcile must also drop it (no external exclusion).
    links: [{ kind: 'external', to_code: 'GHOST-9' }],
  });
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'IN_PROGRESS' }]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress')]);

  const before = await validateProject(root, {});
  assert.ok(kinds(before.findings, 'FEAT-1').includes('DANGLING_LINK_FEATURES_TARGET'));

  await reconcileProject(root, { apply: true, classes: ['dangling_link'] });
  const after = await validateProject(root, {});
  assert.ok(!kinds(after.findings, 'FEAT-1').includes('DANGLING_LINK_FEATURES_TARGET'));
  assert.deepEqual(readFeatureJson(root, 'FEAT-1').links, []);
});

test('roadmap_status_rewrite is suppressed on a narrative-owned workspace', async () => {
  const root = scaffold({ narrative: true });
  addFeature(root, 'FEAT-1', { status: 'IN_PROGRESS' });
  writeRoadmap(root, [{ code: 'FEAT-1', status: 'COMPLETE' }]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress')]);

  const res = await reconcileProject(root, { apply: false, classes: ['roadmap_status_rewrite'] });
  assert.equal(res.plan.filter((e) => e.action === 'set_roadmap_row_status').length, 0);
});

// ---------------------------------------------------------------------------
// Mode guard: featureJsonMode:false drops feature.json-mutating classes
// ---------------------------------------------------------------------------

test('featureJsonMode:false drops feature.json-mutating classes with a reason', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', { status: 'IN_PROGRESS' });
  addFeature(root, 'FEAT-2', {
    status: 'IN_PROGRESS',
    links: [{ kind: 'blocks', to_code: 'GHOST-9' }],
  });
  writeRoadmap(root, [
    { code: 'FEAT-1', status: 'IN_PROGRESS' },
    { code: 'FEAT-2', status: 'IN_PROGRESS' },
  ]);
  writeVision(root, [visionItem('FEAT-1', 'in_progress', 1), visionItem('FEAT-2', 'in_progress', 2)]);

  const res = await reconcileProject(root, {
    apply: false,
    classes: ['dangling_link'],
    featureJsonMode: false,
  });
  assert.equal(res.plan.length, 0);
  assert.ok(res.skipped_classes.some((s) => s.class === 'dangling_link' && s.reason === 'feature_json_mode_off'));
});

// ---------------------------------------------------------------------------
// Golden closed loop — all classes, drift in → fixed → re-validate clears
// ---------------------------------------------------------------------------

test('GOLDEN: reconcile --apply (all classes) clears the targeted findings', async () => {
  const root = scaffold();
  // FEAT-1: clean anchor target
  addFeature(root, 'FEAT-1', { status: 'COMPLETE', docs: ['design.md', 'report.md'] });
  // FEAT-2: dangling link + invalid kind + fj/vision status drift
  addFeature(root, 'FEAT-2', {
    status: 'COMPLETE',
    docs: ['design.md', 'report.md'],
    links: [
      { kind: 'depends_on', to_code: 'FEAT-1' },
      { kind: 'blocks', to_code: 'GHOST-9' },
      { kind: 'dependson', to_code: 'FEAT-1' },
    ],
  });
  writeRoadmap(root, [
    { code: 'FEAT-1', status: 'COMPLETE' },
    { code: 'FEAT-2', status: 'COMPLETE' },
  ]);
  writeVision(root, [
    visionItem('FEAT-1', 'complete', 1),
    visionItem('FEAT-2', 'in_progress', 2), // drift vs COMPLETE
  ]);

  const res = await reconcileProject(root, {
    apply: true,
    classes: ['dangling_link', 'invalid_link_kind', 'status_fj_vision'],
  });
  assert.ok(res.applied.every((a) => a.ok), JSON.stringify(res.applied));

  const after = await validateProject(root, {});
  const k2 = kinds(after.findings, 'FEAT-2');
  assert.ok(!k2.includes('DANGLING_LINK_FEATURES_TARGET'), 'dangling cleared');
  assert.ok(!k2.includes('STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE'), 'status cleared');
  // links reduced to the one valid entry
  assert.deepEqual(readFeatureJson(root, 'FEAT-2').links, [{ kind: 'depends_on', to_code: 'FEAT-1' }]);
});

// ---------------------------------------------------------------------------
// setRoadmapRowStatus surgical-edit edge cases (Codex impl-review iter 2)
// ---------------------------------------------------------------------------

import { setRoadmapRowStatus } from '../lib/feature-writer.js';

test('setRoadmapRowStatus patches the LAST duplicate row (validator last-wins)', async () => {
  const root = scaffold();
  // Two FEAT-1 rows; validator's roadmapByCode keeps the last.
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | d | COMPLETE |\n| 2 | FEAT-1 | d | COMPLETE |\n`);
  const res = await setRoadmapRowStatus(root, { code: 'FEAT-1', status: 'IN_PROGRESS' });
  assert.equal(res.changed, true);
  const lines = readFileSync(join(root, 'ROADMAP.md'), 'utf8').split('\n').filter((l) => /FEAT-1/.test(l));
  assert.match(lines[0], /COMPLETE/);     // first untouched
  assert.match(lines[1], /IN_PROGRESS/);  // last patched
});

test('setRoadmapRowStatus skips an ambiguous non-alpha status cell', async () => {
  const root = scaffold();
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | d | 42 |\n`);
  const res = await setRoadmapRowStatus(root, { code: 'FEAT-1', status: 'IN_PROGRESS' });
  assert.equal(res.changed, false);
  assert.match(readFileSync(join(root, 'ROADMAP.md'), 'utf8'), /\| 42 \|/); // untouched
});

test('setRoadmapRowStatus converges on a non-canonical ALPHA status (e.g. Done)', async () => {
  const root = scaffold();
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | d | Done |\n`);
  const res = await setRoadmapRowStatus(root, { code: 'FEAT-1', status: 'IN_PROGRESS' });
  assert.equal(res.changed, true);
  assert.match(readFileSync(join(root, 'ROADMAP.md'), 'utf8'), /IN_PROGRESS/);
});

test('setRoadmapRowStatus refuses a row containing an escaped pipe (corruption guard)', async () => {
  const root = scaffold();
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | a \\| b | COMPLETE |\n`);
  const res = await setRoadmapRowStatus(root, { code: 'FEAT-1', status: 'IN_PROGRESS' });
  assert.equal(res.changed, false);
  const out = readFileSync(join(root, 'ROADMAP.md'), 'utf8');
  assert.match(out, /a \\\| b/);   // description untouched
  assert.match(out, /COMPLETE/);   // status untouched
});

test('setRoadmapRowStatus preserves emphasis markers in the cell', async () => {
  const root = scaffold();
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | d | **COMPLETE** |\n`);
  await setRoadmapRowStatus(root, { code: 'FEAT-1', status: 'IN_PROGRESS' });
  assert.match(readFileSync(join(root, 'ROADMAP.md'), 'utf8'), /\*\*IN_PROGRESS\*\*/);
});

test('roadmap_status_rewrite does NOT plan a fix for a row whose status mis-parses to prose', async () => {
  const root = scaffold();
  addFeature(root, 'FEAT-1', { status: 'PLANNED' });
  // Description contains an escaped pipe → the validator parses prose into the
  // status column. The planner must skip it (the surgical writer would refuse).
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | use a \\| b flag | PLANNED |\n`);
  writeVision(root, [visionItem('FEAT-1', 'planned')]);

  const res = await reconcileProject(root, { apply: false, classes: ['roadmap_status_rewrite'] });
  assert.equal(res.plan.filter((e) => e.action === 'set_roadmap_row_status').length, 0);
});
