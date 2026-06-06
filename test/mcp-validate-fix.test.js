import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolValidateProject } from '../server/compose-mcp-tools.js';
import { switchProject } from '../server/project-root.js';
import { writeFeature } from '../lib/feature-json.js';

function setupDrift() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-fix-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  writeFileSync(join(root, 'docs', 'journal', 'README.md'), '# Journal\n');
  for (const code of ['FEAT-1', 'FEAT-2']) {
    const dir = join(root, 'docs', 'features', code);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'design.md'), '# d');
  }
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'feature.json'),
    JSON.stringify({ code: 'FEAT-1', status: 'IN_PROGRESS', description: 'd' }));
  writeFileSync(join(root, 'docs', 'features', 'FEAT-2', 'feature.json'),
    JSON.stringify({ code: 'FEAT-2', status: 'IN_PROGRESS', description: 'd',
      links: [{ kind: 'blocks', to_code: 'GHOST-9' }] }));
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | d | IN_PROGRESS |\n| 2 | FEAT-2 | d | IN_PROGRESS |\n`);
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [
      { id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'in_progress' },
      { id: '00000000-0000-0000-0000-000000000002', type: 'feature', featureCode: 'FEAT-2', status: 'in_progress' },
    ], connections: [], gates: [],
  }));
  return root;
}

test('toolValidateProject without fix returns plain findings (no reconcile)', async () => {
  const root = setupDrift();
  switchProject(root);
  const res = await toolValidateProject({});
  assert.equal(res.reconcile, undefined);
  assert.ok(Array.isArray(res.findings));
});

test('toolValidateProject fix:true returns a dry-run plan, no writes', async () => {
  const root = setupDrift();
  switchProject(root);
  const res = await toolValidateProject({ fix: true });
  assert.ok(res.reconcile);
  assert.equal(res.reconcile.dry_run, true);
  const fj = JSON.parse(readFileSync(join(root, 'docs', 'features', 'FEAT-2', 'feature.json'), 'utf8'));
  assert.deepEqual(fj.links, [{ kind: 'blocks', to_code: 'GHOST-9' }]);
});

test('toolValidateProject fix:true apply:true heals drift and re-validates', async () => {
  const root = setupDrift();
  switchProject(root);
  const res = await toolValidateProject({ fix: true, apply: true });
  assert.equal(res.reconcile.dry_run, false);
  const fj = JSON.parse(readFileSync(join(root, 'docs', 'features', 'FEAT-2', 'feature.json'), 'utf8'));
  assert.deepEqual(fj.links, []);
  // returned findings reflect post-fix state
  assert.ok(!res.findings.some((f) => f.feature_code === 'FEAT-2' && f.kind === 'DANGLING_LINK_FEATURES_TARGET'));
});

test('writeFeature is atomic: round-trips and leaves no .tmp behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-'));
  writeFeature(root, { code: 'FEAT-9', status: 'PLANNED', description: 'x' }, 'docs/features', { validate: false });
  const dir = join(root, 'docs', 'features', 'FEAT-9');
  const got = JSON.parse(readFileSync(join(dir, 'feature.json'), 'utf8'));
  assert.equal(got.code, 'FEAT-9');
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp')), 'no leftover tmp file');
});
