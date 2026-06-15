/**
 * paths-external.test.js — golden flow: a workspace whose artifacts live in an
 * EXTERNAL dir (COMP-PATHS-EXTERNAL). Asserts artifacts land outside cwd and
 * the workspace root stays clean. (S2 golden gate; S3 cases added later.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFeature, readFeature, listFeatures } from '../../lib/feature-json.js';
import { resolveFeaturesPath, resolveRoadmapPath } from '../../lib/project-paths.js';

function extWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'pe-cwd-'));
  const docs = mkdtempSync(join(tmpdir(), 'pe-docs-'));   // the "smart-memory-docs" stand-in
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({
    paths: { roadmap: join(docs, 'ROADMAP.md'), features: join(docs, 'features') },
  }));
  return { cwd, docs };
}

test('GOLDEN: resolvers point outside cwd', () => {
  const { cwd, docs } = extWorkspace();
  assert.equal(resolveFeaturesPath(cwd), join(docs, 'features'));
  assert.equal(resolveRoadmapPath(cwd), join(docs, 'ROADMAP.md'));
});

test('GOLDEN: validate flags an unreachable external parent, not a not-yet-created leaf', async () => {
  const { validateProject } = await import('../../lib/feature-validator.js');

  // (a) external features dir whose PARENT does not exist → CONFIGURED_PATH_UNREACHABLE
  const badCwd = mkdtempSync(join(tmpdir(), 'pe-bad-'));
  mkdirSync(join(badCwd, '.compose'), { recursive: true });
  writeFileSync(join(badCwd, '.compose/compose.json'), JSON.stringify({
    paths: { features: '/no/such/root/features' },
  }));
  const bad = await validateProject(badCwd);
  assert.ok(bad.findings.some(f => f.kind === 'CONFIGURED_PATH_UNREACHABLE'),
    'unreachable external parent should be flagged');

  // (b) external features dir not-yet-created but parent EXISTS → no such finding
  const okCwd = mkdtempSync(join(tmpdir(), 'pe-ok-'));
  const docs = mkdtempSync(join(tmpdir(), 'pe-okdocs-'));   // parent exists, leaf does not
  mkdirSync(join(okCwd, '.compose'), { recursive: true });
  writeFileSync(join(okCwd, '.compose/compose.json'), JSON.stringify({
    paths: { features: join(docs, 'features') },
  }));
  const ok = await validateProject(okCwd);
  assert.ok(!ok.findings.some(f => f.kind === 'CONFIGURED_PATH_UNREACHABLE'),
    'a not-yet-created leaf under an existing parent must NOT be flagged');
});

test('GOLDEN: scaffold → read → list all land in the external dir, root stays clean', () => {
  const { cwd, docs } = extWorkspace();
  const fdir = resolveFeaturesPath(cwd);
  writeFeature(cwd, { code: 'EXT-1', description: 'd', status: 'PLANNED' }, fdir);
  assert.ok(existsSync(join(docs, 'features/EXT-1/feature.json')), 'feature in external dir');
  assert.ok(!existsSync(join(cwd, 'docs/features')), 'workspace root has NO docs/features');
  assert.equal(readFeature(cwd, 'EXT-1', fdir)?.status, 'PLANNED');
  assert.deepEqual(listFeatures(cwd, fdir).map(f => f.code), ['EXT-1']);
  // .compose state stays at root (D4)
  assert.ok(existsSync(join(cwd, '.compose/compose.json')));
});
