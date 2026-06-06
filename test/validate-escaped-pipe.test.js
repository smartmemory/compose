import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateProject } from '../lib/feature-validator.js';
import { splitRoadmapCells } from '../lib/roadmap-parser.js';
import { scanRoadmapRows } from '../lib/feature-write-guard.js';

// COMP-MCP-VALIDATE-4: a `\|` in a ROADMAP description cell must not shift
// status-column detection and read prose as the row's "status".

test('splitRoadmapCells honors escaped pipes', () => {
  assert.deepEqual(
    splitRoadmapCells('| 1 | FEAT-1 | run with \\| flag | PLANNED |'),
    ['1', 'FEAT-1', 'run with | flag', 'PLANNED'],
  );
  // pipe-free rows behave exactly like a naive split
  assert.deepEqual(
    splitRoadmapCells('| 1 | FEAT-1 | plain desc | COMPLETE |'),
    ['1', 'FEAT-1', 'plain desc', 'COMPLETE'],
  );
});

function scaffold(roadmapStatusCell, descCell) {
  const root = mkdtempSync(join(tmpdir(), 'escpipe-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'FEAT-1'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  writeFileSync(join(root, 'docs', 'journal', 'README.md'), '# Journal\n');
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'design.md'), '# d');
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'feature.json'),
    JSON.stringify({ code: 'FEAT-1', status: 'PLANNED', description: descCell }));
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | ${descCell} | ${roadmapStatusCell} |\n`);
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items: [{ id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'planned' }], connections: [], gates: [] }));
  return root;
}

test('validator does NOT false-flag a row whose description contains \\| (the bug)', async () => {
  // ROADMAP status PLANNED == feature.json PLANNED; the only oddity is the \| in
  // the description. Pre-fix this produced false STATUS_MISMATCH (read "flag" as status).
  const root = scaffold('PLANNED', 'run with \\| flag');
  const r = await validateProject(root, {});
  const k = r.findings.filter((f) => f.feature_code === 'FEAT-1').map((f) => f.kind);
  assert.ok(!k.includes('STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON'), `unexpected: ${k}`);
  assert.ok(!k.includes('STATUS_MISMATCH_ROADMAP_VS_VISION_STATE'), `unexpected: ${k}`);
  assert.ok(!k.includes('ROADMAP_ROW_SCHEMA_VIOLATION'), `unexpected: ${k}`);
});

test('validator STILL detects a real status mismatch on a \\|-description row', async () => {
  // Description has \| but the status genuinely differs (ROADMAP COMPLETE vs fj PLANNED).
  const root = scaffold('COMPLETE', 'run with \\| flag');
  const r = await validateProject(root, {});
  const k = r.findings.filter((f) => f.feature_code === 'FEAT-1').map((f) => f.kind);
  assert.ok(k.includes('STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON'), `expected real mismatch, got: ${k}`);
});

test('scanRoadmapRows still finds the code on a \\|-description row', () => {
  const root = scaffold('PLANNED', 'run with \\| flag');
  const codes = scanRoadmapRows(join(root, 'ROADMAP.md'));
  assert.ok(codes.includes('FEAT-1'));
});
