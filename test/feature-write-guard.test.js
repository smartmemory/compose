/**
 * Tests for COMP-MCP-VALIDATE-1 — write-time feature.json validation.
 * Real temp-dir fixtures, no mocking (mirrors test/feature-validator.test.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertValidLinkShape,
  assertLinkTargetsExist,
  knownFeatureCodes,
  scanRoadmapRows,
  FeatureWriteValidationError,
} from '../lib/feature-write-guard.js';
import { writeFeature, readFeature } from '../lib/feature-json.js';
import { linkFeatures } from '../lib/feature-writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function newFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fwg-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  return root;
}
function writeFolder(root, code, featureJson) {
  const dir = join(root, 'docs', 'features', code);
  mkdirSync(dir, { recursive: true });
  if (featureJson) writeFileSync(join(dir, 'feature.json'), JSON.stringify(featureJson, null, 2));
  return dir;
}
function writeRoadmap(root, codes) {
  const lines = ['# Roadmap', '', '## Phase 1', '', '| # | Feature | Description | Status |', '|---|---------|-------------|--------|'];
  codes.forEach((c, i) => lines.push(`| ${i + 1} | ${c} | desc | PLANNED |`));
  writeFileSync(join(root, 'ROADMAP.md'), lines.join('\n') + '\n');
}
function writeVision(root, codes) {
  const items = codes.map((c) => ({ id: c, featureCode: c }));
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({ items }, null, 2));
}
const base = (code, extra = {}) => ({ code, description: 'x', status: 'PLANNED', ...extra });

describe('assertValidLinkShape', () => {
  test('valid feature passes', () => {
    assert.doesNotThrow(() => assertValidLinkShape(base('COMP-A')));
  });
  test('valid feature with a depends_on link passes', () => {
    assert.doesNotThrow(() => assertValidLinkShape(base('COMP-A', { links: [{ kind: 'depends_on', to_code: 'COMP-B' }] })));
  });
  test('invalid link kind throws SCHEMA_VIOLATION', () => {
    assert.throws(
      () => assertValidLinkShape(base('COMP-A', { links: [{ kind: 'informs', to_code: 'COMP-B' }] })),
      (e) => e instanceof FeatureWriteValidationError && e.kind === 'FEATURE_JSON_SCHEMA_VIOLATION',
    );
  });
  test('non-external link missing to_code throws', () => {
    assert.throws(
      () => assertValidLinkShape(base('COMP-A', { links: [{ kind: 'depends_on' }] })),
      (e) => e instanceof FeatureWriteValidationError && e.kind === 'FEATURE_JSON_SCHEMA_VIOLATION',
    );
  });
  test('external local link with repo+to_code passes', () => {
    assert.doesNotThrow(() => assertValidLinkShape(base('COMP-A', {
      links: [{ kind: 'external', provider: 'local', repo: 'smart-memory', to_code: 'META-GRAPH-1' }],
    })));
  });
  test('out-of-scope violations (complexity/artifacts) are NOT enforced here', () => {
    // SCHEMA-TIGHTEN territory — -1 only gates /links.
    assert.doesNotThrow(() => assertValidLinkShape(base('COMP-A', { complexity: 'not-a-tier' })));
    assert.doesNotThrow(() => assertValidLinkShape(base('COMP-A', { artifacts: [{ type: 'finding', path: 'x.md' }] })));
  });
});

describe('scanRoadmapRows + knownFeatureCodes', () => {
  test('scanRoadmapRows extracts strict codes only', () => {
    const root = newFixture();
    writeRoadmap(root, ['COMP-A', 'COMP-MCP-VALIDATE-1']);
    const codes = scanRoadmapRows(join(root, 'ROADMAP.md'));
    assert.ok(codes.includes('COMP-A'));
    assert.ok(codes.includes('COMP-MCP-VALIDATE-1'));
  });
  test('union counts a folder-only, roadmap-only, and vision-only code each as existing', () => {
    const root = newFixture();
    writeFolder(root, 'COMP-FOLDER', base('COMP-FOLDER'));
    writeRoadmap(root, ['COMP-ROADMAP']);
    writeVision(root, ['COMP-VISION']);
    const known = knownFeatureCodes(root);
    assert.ok(known.has('COMP-FOLDER'));
    assert.ok(known.has('COMP-ROADMAP'));
    assert.ok(known.has('COMP-VISION'));
    assert.ok(!known.has('COMP-NOPE'));
  });
  test('missing ROADMAP/vision degrade quietly (folders still apply)', () => {
    const root = newFixture();
    writeFolder(root, 'COMP-ONLY', base('COMP-ONLY'));
    const known = knownFeatureCodes(root);
    assert.deepEqual([...known], ['COMP-ONLY']);
  });
});

describe('assertLinkTargetsExist', () => {
  test('cheap path: no non-external links → no throw even with no ROADMAP/vision', () => {
    const root = newFixture();
    assert.doesNotThrow(() => assertLinkTargetsExist(root, base('COMP-A')));
    assert.doesNotThrow(() => assertLinkTargetsExist(root, base('COMP-A', {
      links: [{ kind: 'external', provider: 'local', repo: 'r', to_code: 'EXT-1' }],
    })));
  });
  test('existing target passes', () => {
    const root = newFixture();
    writeFolder(root, 'COMP-B', base('COMP-B'));
    assert.doesNotThrow(() => assertLinkTargetsExist(root, base('COMP-A', { links: [{ kind: 'depends_on', to_code: 'COMP-B' }] })));
  });
  test('dangling target throws DANGLING', () => {
    const root = newFixture();
    assert.throws(
      () => assertLinkTargetsExist(root, base('COMP-A', { links: [{ kind: 'depends_on', to_code: 'COMP-GONE' }] })),
      (e) => e instanceof FeatureWriteValidationError && e.kind === 'DANGLING_LINK_FEATURES_TARGET' && /COMP-GONE/.test(e.violations[0]),
    );
  });
  test('allowForwardRefs bypasses the existence check', () => {
    const root = newFixture();
    assert.doesNotThrow(() => assertLinkTargetsExist(root, base('COMP-A', { links: [{ kind: 'depends_on', to_code: 'COMP-GONE' }] }), { allowForwardRefs: true }));
  });
  test('self-reference (to_code === feature.code) is not dangling', () => {
    const root = newFixture();
    assert.doesNotThrow(() => assertLinkTargetsExist(root, base('COMP-A', { links: [{ kind: 'related', to_code: 'COMP-A' }] })));
  });
});

describe('writeFeature integration', () => {
  test('valid feature writes to disk', () => {
    const root = newFixture();
    writeFeature(root, base('COMP-A'));
    assert.ok(existsSync(join(root, 'docs', 'features', 'COMP-A', 'feature.json')));
  });
  test('invalid shape throws and does not write', () => {
    const root = newFixture();
    assert.throws(() => writeFeature(root, base('COMP-A', { links: [{ kind: 'informs', to_code: 'COMP-B' }] })), FeatureWriteValidationError);
    assert.ok(!existsSync(join(root, 'docs', 'features', 'COMP-A', 'feature.json')));
  });
  test('dangling link throws at the chokepoint', () => {
    const root = newFixture();
    assert.throws(
      () => writeFeature(root, base('COMP-A', { links: [{ kind: 'depends_on', to_code: 'COMP-GONE' }] })),
      (e) => e instanceof FeatureWriteValidationError && e.kind === 'DANGLING_LINK_FEATURES_TARGET',
    );
  });
  test('validate:false bypasses all guarding (migration path)', () => {
    const root = newFixture();
    writeFeature(root, base('COMP-A', { links: [{ kind: 'informs', to_code: 'COMP-GONE' }] }), 'docs/features', { validate: false });
    assert.ok(existsSync(join(root, 'docs', 'features', 'COMP-A', 'feature.json')));
  });
  test('allowForwardRefs lets a forward-ref link through', () => {
    const root = newFixture();
    writeFeature(root, base('COMP-A', { links: [{ kind: 'depends_on', to_code: 'COMP-LATER' }] }), 'docs/features', { allowForwardRefs: true });
    const f = readFeature(root, 'COMP-A');
    assert.equal(f.links[0].to_code, 'COMP-LATER');
  });
  test('a forced forward-ref survives later unrelated writes; new dangling still caught (delta-aware)', async () => {
    const root = newFixture();
    writeFeature(root, base('COMP-A'));
    await linkFeatures(root, { from_code: 'COMP-A', to_code: 'COMP-GONE', kind: 'depends_on', force: true });
    // Later unrelated write (status change) to the same feature must NOT re-block
    // on the already-persisted dangling link.
    assert.doesNotThrow(() => writeFeature(root, { ...readFeature(root, 'COMP-A'), status: 'IN_PROGRESS' }));
    // But a write that INTRODUCES a new dangling link is still rejected.
    assert.throws(
      () => {
        const f = readFeature(root, 'COMP-A');
        writeFeature(root, { ...f, links: [...f.links, { kind: 'related', to_code: 'COMP-NEWGONE' }] });
      },
      (e) => e instanceof FeatureWriteValidationError && e.kind === 'DANGLING_LINK_FEATURES_TARGET',
    );
  });
});

describe('linkFeatures integration', () => {
  test('link to existing target succeeds', async () => {
    const root = newFixture();
    writeFeature(root, base('COMP-A'));
    writeFeature(root, base('COMP-B'));
    await linkFeatures(root, { from_code: 'COMP-A', to_code: 'COMP-B', kind: 'depends_on' });
    const f = readFeature(root, 'COMP-A');
    assert.equal(f.links[0].to_code, 'COMP-B');
  });
  test('link to dangling target throws without force', async () => {
    const root = newFixture();
    writeFeature(root, base('COMP-A'));
    await assert.rejects(
      () => linkFeatures(root, { from_code: 'COMP-A', to_code: 'COMP-GONE', kind: 'depends_on' }),
      (e) => e instanceof FeatureWriteValidationError && e.kind === 'DANGLING_LINK_FEATURES_TARGET',
    );
  });
  test('force persists a dangling target through the chokepoint', async () => {
    const root = newFixture();
    writeFeature(root, base('COMP-A'));
    await linkFeatures(root, { from_code: 'COMP-A', to_code: 'COMP-GONE', kind: 'depends_on', force: true });
    const f = readFeature(root, 'COMP-A');
    assert.equal(f.links[0].to_code, 'COMP-GONE');
  });
  test('idempotent retry of a forced dangling link no-ops (does not re-throw)', async () => {
    const root = newFixture();
    writeFeature(root, base('COMP-A'));
    await linkFeatures(root, { from_code: 'COMP-A', to_code: 'COMP-GONE', kind: 'depends_on', force: true });
    // Re-issuing the same (still-dangling) link WITHOUT force must no-op, not throw.
    const r = await linkFeatures(root, { from_code: 'COMP-A', to_code: 'COMP-GONE', kind: 'depends_on' });
    assert.equal(r.noop, true);
    assert.equal(readFeature(root, 'COMP-A').links.length, 1);
  });
});

describe('corpus regression', () => {
  test('every committed feature.json has valid link shape (no link-invalid files)', () => {
    const featuresDir = join(REPO_ROOT, 'docs', 'features');
    const bad = [];
    for (const d of readdirSync(featuresDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(featuresDir, d.name, 'feature.json');
      if (!existsSync(p)) continue;
      let obj;
      try { obj = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { bad.push(`${d.name}: parse ${e.message}`); continue; }
      try { assertValidLinkShape(obj); } catch (e) { bad.push(`${d.name}: ${e.message}`); }
    }
    assert.deepEqual(bad, [], `link-invalid feature.json files:\n${bad.join('\n')}`);
  });
});
