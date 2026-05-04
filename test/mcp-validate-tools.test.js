import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolValidateFeature, toolValidateProject } from '../server/compose-mcp-tools.js';
import { switchProject } from '../server/project-root.js';

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fv-mcp-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'FEAT-1'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  writeFileSync(join(root, 'ROADMAP.md'),
`# R

## Phase 1

| # | Feature | Description | Status |
|---|---|---|---|
| 1 | FEAT-1 | desc | IN_PROGRESS |
`);
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items: [], connections: [], gates: [] }));
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'design.md'), '# d');
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'feature.json'),
    JSON.stringify({ code: 'FEAT-1', status: 'IN_PROGRESS', description: 'desc' }));
  return root;
}

test('toolValidateFeature returns canonical shape', async () => {
  const root = setupFixture();
  switchProject(root);
  const result = await toolValidateFeature({ feature_code: 'FEAT-1' });
  assert.equal(result.scope, 'feature');
  assert.equal(result.feature_code, 'FEAT-1');
  assert.ok(typeof result.validated_at === 'string');
  assert.ok(Array.isArray(result.findings));
});

test('toolValidateFeature: invalid code throws INVALID_INPUT', async () => {
  const root = setupFixture();
  switchProject(root);
  await assert.rejects(
    () => toolValidateFeature({ feature_code: 'lowercase-bad' }),
    (err) => err.code === 'INVALID_INPUT'
  );
});

test('toolValidateFeature: unknown but valid code returns FEATURE_NOT_FOUND finding (does not throw)', async () => {
  const root = setupFixture();
  switchProject(root);
  const result = await toolValidateFeature({ feature_code: 'NONEXISTENT-9' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, 'FEATURE_NOT_FOUND');
  assert.equal(result.findings[0].severity, 'error');
});

test('toolValidateProject returns canonical shape', async () => {
  const root = setupFixture();
  switchProject(root);
  const result = await toolValidateProject({});
  assert.equal(result.scope, 'project');
  assert.ok(typeof result.validated_at === 'string');
  assert.ok(Array.isArray(result.findings));
});

test('toolValidateProject respects external_prefixes option', async () => {
  const root = setupFixture();
  // Add an orphan with STRAT- prefix
  mkdirSync(join(root, 'docs', 'features', 'STRAT-99'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'STRAT-99', 'design.md'), 'x');
  switchProject(root);

  const withoutPrefix = await toolValidateProject({});
  const orphanWithoutPrefix = withoutPrefix.findings.find(
    (f) => f.kind === 'ORPHAN_FOLDER' && f.feature_code === 'STRAT-99'
  );
  assert.equal(orphanWithoutPrefix.severity, 'warning');

  const withPrefix = await toolValidateProject({ external_prefixes: ['STRAT-'] });
  const orphanWithPrefix = withPrefix.findings.find(
    (f) => f.kind === 'ORPHAN_FOLDER' && f.feature_code === 'STRAT-99'
  );
  assert.equal(orphanWithPrefix.severity, 'info');
});
