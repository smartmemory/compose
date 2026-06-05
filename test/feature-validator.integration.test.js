import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProject } from '../lib/feature-validator.js';

function setupSeededFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fv-integ-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });

  // ROADMAP — 3 rows
  writeFileSync(join(root, 'ROADMAP.md'),
`# R

## Phase 1

| # | Feature | Description | Status |
|---|---|---|---|
| 1 | CLEAN-1 | clean feature | IN_PROGRESS |
| 2 | DRIFT-1 | drift feature | COMPLETE |
| 3 | PLANNED-1 | planned no folder | PLANNED |
`);

  // Vision state — DRIFT-1 disagrees, ORPHAN folder has no vision item
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [
      { id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'CLEAN-1', status: 'in_progress' },
      { id: '00000000-0000-0000-0000-000000000002', type: 'feature', featureCode: 'DRIFT-1', status: 'in_progress' }, // mismatch with ROADMAP COMPLETE
    ],
    connections: [],
    gates: [],
  }));

  // CLEAN-1 — no drift expected
  mkdirSync(join(root, 'docs', 'features', 'CLEAN-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'CLEAN-1', 'design.md'), '# d');
  writeFileSync(join(root, 'docs', 'features', 'CLEAN-1', 'plan.md'), '# p');
  writeFileSync(join(root, 'docs', 'features', 'CLEAN-1', 'feature.json'), JSON.stringify({
    code: 'CLEAN-1', status: 'IN_PROGRESS', description: 'clean feature',
  }));

  // DRIFT-1 — status mismatch ROADMAP/feature.json
  mkdirSync(join(root, 'docs', 'features', 'DRIFT-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'DRIFT-1', 'design.md'), '# d');
  writeFileSync(join(root, 'docs', 'features', 'DRIFT-1', 'feature.json'), JSON.stringify({
    code: 'DRIFT-1', status: 'IN_PROGRESS', // ROADMAP says COMPLETE
  }));

  // ORPHAN-1 — folder, no ROADMAP, no vision-state
  mkdirSync(join(root, 'docs', 'features', 'ORPHAN-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'ORPHAN-1', 'design.md'), '# d');

  // KILLED-1 — terminal feature, killed.md mentions successor without typed link
  mkdirSync(join(root, 'docs', 'features', 'KILLED-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'KILLED-1', 'killed.md'),
    '**KILLED (2026-04-01):** Superseded by NEWER-1; merged into that line.');
  writeFileSync(join(root, 'docs', 'features', 'KILLED-1', 'feature.json'), JSON.stringify({
    code: 'KILLED-1', status: 'KILLED',
  }));

  return root;
}

test('integration: validateProject finds the seeded drift kinds', async () => {
  const root = setupSeededFixture();
  const result = await validateProject(root);

  const kinds = new Set(result.findings.map((f) => f.kind));

  // Expected: DRIFT-1 status mismatch (multiple sources)
  assert.ok(kinds.has('STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON'),
    `kinds emitted: ${[...kinds].join(', ')}`);

  // Expected: PLANNED-1 row without folder (warning, not error)
  assert.ok(kinds.has('ROADMAP_ROW_WITHOUT_FOLDER'));

  // Expected: ORPHAN-1 folder
  assert.ok(kinds.has('ORPHAN_FOLDER'));

  // Expected: KILLED-1 successor not linked
  assert.ok(kinds.has('KILLED_SUCCESSOR_NOT_LINKED'));

  // CLEAN-1 should NOT contribute error findings
  const cleanErrors = result.findings.filter(
    (f) => f.feature_code === 'CLEAN-1' && f.severity === 'error'
  );
  assert.deepEqual(cleanErrors, [], `CLEAN-1 unexpected errors: ${JSON.stringify(cleanErrors)}`);
});

test('integration: validateProject performance under 1s on small fixture', async () => {
  const root = setupSeededFixture();
  const start = Date.now();
  await validateProject(root);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `expected <1s, got ${elapsed}ms`);
});

test('integration: result shape conforms to contract', async () => {
  const root = setupSeededFixture();
  const r = await validateProject(root);
  assert.equal(r.scope, 'project');
  assert.ok(typeof r.validated_at === 'string');
  assert.ok(Array.isArray(r.findings));
  for (const f of r.findings) {
    assert.ok(['error', 'warning', 'info'].includes(f.severity), `bad severity: ${f.severity}`);
    assert.ok(typeof f.kind === 'string');
    assert.ok(typeof f.detail === 'string');
  }
});

// ── CONTRADICTORY_PHASE_CLAIM regression (COMP-RESUME follow-up) ─────────────
// feature.json's top-level `phase` is the ROADMAP heading, not a lifecycle
// stage. The check must compare LIFECYCLE phase to LIFECYCLE phase, never the
// roadmap heading to the vision-state lifecycle phase (that false-fired ~40×).

test('CONTRADICTORY_PHASE_CLAIM: roadmap-heading phase does NOT false-fire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-rmh-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'RMH-1'), { recursive: true });
  // phase = roadmap heading; NO lifecycle block on feature.json.
  writeFileSync(join(root, 'docs', 'features', 'RMH-1', 'feature.json'),
    JSON.stringify({ code: 'RMH-1', status: 'COMPLETE', phase: 'Phase 7: MCP Writers' }));
  writeFileSync(join(root, 'docs', 'features', 'RMH-1', 'design.md'), '# d');
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [{ id: '00000000-0000-0000-0000-0000000000a1', type: 'feature', featureCode: 'RMH-1',
              status: 'complete', lifecycle: { featureCode: 'RMH-1', currentPhase: 'explore_design' } }],
    connections: [], gates: [],
  }));
  writeFileSync(join(root, 'ROADMAP.md'),
    '# R\n\n## Phase 7: MCP Writers\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | RMH-1 | x | COMPLETE |\n');
  const result = await validateProject(root);
  const claims = result.findings.filter((f) => f.kind === 'CONTRADICTORY_PHASE_CLAIM');
  assert.equal(claims.length, 0, `roadmap-heading phase must not trip the check; got ${JSON.stringify(claims)}`);
});

test('CONTRADICTORY_PHASE_CLAIM: a real lifecycle-vs-lifecycle mismatch DOES fire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-lcm-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'LCM-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'LCM-1', 'feature.json'),
    JSON.stringify({ code: 'LCM-1', status: 'IN_PROGRESS', lifecycle: { currentPhase: 'design' } }));
  writeFileSync(join(root, 'docs', 'features', 'LCM-1', 'design.md'), '# d');
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [{ id: '00000000-0000-0000-0000-0000000000b2', type: 'feature', featureCode: 'LCM-1',
              status: 'in_progress', lifecycle: { featureCode: 'LCM-1', currentPhase: 'implementation' } }],
    connections: [], gates: [],
  }));
  writeFileSync(join(root, 'ROADMAP.md'),
    '# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | LCM-1 | x | IN_PROGRESS |\n');
  const result = await validateProject(root);
  const claims = result.findings.filter((f) => f.kind === 'CONTRADICTORY_PHASE_CLAIM');
  assert.equal(claims.length, 1, `lifecycle design vs implementation must fire; kinds: ${JSON.stringify(result.findings.map((f) => f.kind))}`);
});

test('CONTRADICTORY_PHASE_CLAIM: legacy board phase (no lifecycle on vision) does NOT false-fire', async () => {
  // vision item carries only the legacy board `phase` ("planning"), no
  // lifecycle.currentPhase. feature.json has a real lifecycle phase. The check
  // must NOT compare lifecycle-phase against the board taxonomy (Codex).
  const root = mkdtempSync(join(tmpdir(), 'fv-board-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'BRD-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'BRD-1', 'feature.json'),
    JSON.stringify({ code: 'BRD-1', status: 'IN_PROGRESS', lifecycle: { currentPhase: 'design' } }));
  writeFileSync(join(root, 'docs', 'features', 'BRD-1', 'design.md'), '# d');
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [{ id: '00000000-0000-0000-0000-0000000000c3', type: 'feature', featureCode: 'BRD-1',
              status: 'in_progress', phase: 'planning' }],   // legacy board phase, no lifecycle block
    connections: [], gates: [],
  }));
  writeFileSync(join(root, 'ROADMAP.md'),
    '# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | BRD-1 | x | IN_PROGRESS |\n');
  const result = await validateProject(root);
  const claims = result.findings.filter((f) => f.kind === 'CONTRADICTORY_PHASE_CLAIM');
  assert.equal(claims.length, 0, `legacy board phase must not be compared to lifecycle phase; got ${JSON.stringify(claims)}`);
});

// ── STATUS_MISMATCH vs vision-state: PARTIAL vocabulary projection ────────────
// vision-state's status enum has no PARTIAL (planned|in_progress|complete|…). A
// tracker status of PARTIAL is the SAME lifecycle reality as vision's IN_PROGRESS
// (partially shipped = still in progress), so the *_VS_VISION_STATE checks must
// project PARTIAL→IN_PROGRESS before comparing. Tracker↔tracker comparisons keep
// the full vocabulary — PARTIAL there is a real distinction.

function visionMismatches(findings, code) {
  return findings.filter((f) => f.feature_code === code &&
    (f.kind === 'STATUS_MISMATCH_ROADMAP_VS_VISION_STATE' ||
     f.kind === 'STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE'));
}

test('STATUS_MISMATCH vs vision: tracker PARTIAL ≡ vision in_progress does NOT fire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-piv-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'PIV-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'PIV-1', 'feature.json'),
    JSON.stringify({ code: 'PIV-1', status: 'PARTIAL', description: 'x' }));
  writeFileSync(join(root, 'docs', 'features', 'PIV-1', 'design.md'), '# d');
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [{ id: '00000000-0000-0000-0000-0000000000d4', type: 'feature', featureCode: 'PIV-1',
              status: 'in_progress' }],
    connections: [], gates: [],
  }));
  writeFileSync(join(root, 'ROADMAP.md'),
    '# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | PIV-1 | x | PARTIAL |\n');
  const result = await validateProject(root);
  const vis = visionMismatches(result.findings, 'PIV-1');
  assert.equal(vis.length, 0,
    `PARTIAL↔in_progress is a vocabulary match, not drift; got ${JSON.stringify(vis.map((f) => f.detail))}`);
});

test('STATUS_MISMATCH vs vision: tracker PARTIAL vs vision complete IS real drift and fires', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-pvc-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'PVC-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'PVC-1', 'feature.json'),
    JSON.stringify({ code: 'PVC-1', status: 'PARTIAL', description: 'x' }));
  writeFileSync(join(root, 'docs', 'features', 'PVC-1', 'design.md'), '# d');
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [{ id: '00000000-0000-0000-0000-0000000000e5', type: 'feature', featureCode: 'PVC-1',
              status: 'complete' }],
    connections: [], gates: [],
  }));
  writeFileSync(join(root, 'ROADMAP.md'),
    '# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | PVC-1 | x | PARTIAL |\n');
  const result = await validateProject(root);
  const vis = visionMismatches(result.findings, 'PVC-1');
  assert.equal(vis.length, 2,
    `PARTIAL vs complete must fire both vision mismatches; got ${JSON.stringify(vis.map((f) => f.kind))}`);
  assert.ok(vis.every((f) => f.severity === 'error'), 'both should be error severity (neither side PLANNED)');
});

test('STATUS_MISMATCH: PARTIAL vs IN_PROGRESS between ROADMAP and feature.json still fires (tracker keeps full vocab)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-ptt-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'PTT-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'PTT-1', 'feature.json'),
    JSON.stringify({ code: 'PTT-1', status: 'IN_PROGRESS', description: 'x' }));
  writeFileSync(join(root, 'docs', 'features', 'PTT-1', 'design.md'), '# d');
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [{ id: '00000000-0000-0000-0000-0000000000f6', type: 'feature', featureCode: 'PTT-1',
              status: 'in_progress' }],
    connections: [], gates: [],
  }));
  writeFileSync(join(root, 'ROADMAP.md'),
    '# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | PTT-1 | x | PARTIAL |\n');
  const result = await validateProject(root);
  const rf = result.findings.filter((f) => f.feature_code === 'PTT-1' &&
    f.kind === 'STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON');
  assert.equal(rf.length, 1,
    `ROADMAP PARTIAL vs feature.json IN_PROGRESS must still fire; got ${JSON.stringify(result.findings.filter((f) => f.feature_code === 'PTT-1').map((f) => f.kind))}`);
  // ROADMAP PARTIAL projects to IN_PROGRESS; feature.json IN_PROGRESS; vision in_progress → no vision drift
  assert.equal(visionMismatches(result.findings, 'PTT-1').length, 0,
    'projected PARTIAL↔in_progress must not fire vision drift');
});

test('STATUS_MISMATCH vs vision: malformed vision status "partial" still aligns with tracker PARTIAL (no false drift)', async () => {
  // vision status "partial" is schema-INVALID (the enum has no partial). The
  // VISION_STATE_SCHEMA_VIOLATION is reported separately, but the projection must
  // be symmetric so a malformed "partial" does not ALSO false-fire a status
  // mismatch against a tracker that legitimately says PARTIAL.
  const root = mkdtempSync(join(tmpdir(), 'fv-vpart-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'VPART-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'VPART-1', 'feature.json'),
    JSON.stringify({ code: 'VPART-1', status: 'PARTIAL', description: 'x' }));
  writeFileSync(join(root, 'docs', 'features', 'VPART-1', 'design.md'), '# d');
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [{ id: '00000000-0000-0000-0000-00000000a7b8', type: 'feature', featureCode: 'VPART-1',
              status: 'partial' }],
    connections: [], gates: [],
  }));
  writeFileSync(join(root, 'ROADMAP.md'),
    '# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | VPART-1 | x | PARTIAL |\n');
  const result = await validateProject(root);
  assert.equal(visionMismatches(result.findings, 'VPART-1').length, 0,
    `malformed vision 'partial' aligns with tracker PARTIAL — no status drift; got ${JSON.stringify(visionMismatches(result.findings, 'VPART-1').map((f) => f.detail))}`);
  // the real issue (invalid enum) must still be surfaced elsewhere
  assert.ok(result.findings.some((f) => f.feature_code === 'VPART-1' && f.kind === 'VISION_STATE_SCHEMA_VIOLATION'),
    'the schema violation for vision status "partial" must still be reported');
});

test('STATUS_MISMATCH vs vision: feature SUPERSEDED aligns with vision "superseded" (COMP-MCP-VALIDATE-3)', async () => {
  // The write-side projection maps SUPERSEDED → 'superseded'; the validator now
  // shares that mapping, so a feature whose vision status was projected from a
  // SUPERSEDED feature must NOT false-fire a status mismatch.
  const root = mkdtempSync(join(tmpdir(), 'fv-vsup-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'VSUP-1'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'VSUP-1', 'feature.json'),
    JSON.stringify({ code: 'VSUP-1', status: 'SUPERSEDED', description: 'x' }));
  writeFileSync(join(root, 'docs', 'features', 'VSUP-1', 'design.md'), '# d');
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [{ id: '00000000-0000-0000-0000-00000000a7c9', type: 'feature', featureCode: 'VSUP-1',
              status: 'superseded' }],
    connections: [], gates: [],
  }));
  writeFileSync(join(root, 'ROADMAP.md'),
    '# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | VSUP-1 | x | SUPERSEDED |\n');
  const result = await validateProject(root);
  assert.equal(visionMismatches(result.findings, 'VSUP-1').length, 0,
    `feature SUPERSEDED aligns with vision 'superseded' — no status drift; got ${JSON.stringify(visionMismatches(result.findings, 'VSUP-1').map((f) => f.detail))}`);
});
