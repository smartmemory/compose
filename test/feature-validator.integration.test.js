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
