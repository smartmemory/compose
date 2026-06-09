/**
 * get-roadmap.test.js — COMP-MCP-ROADMAP-READ.
 *
 * Read-only get_roadmap primitive: renders the roadmap from canon (feature.json)
 * without writing, reports a staleness flag vs on-disk ROADMAP.md, and parses
 * rows via the shared parseRoadmap.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getRoadmap } from '../lib/get-roadmap.js';
import { addRoadmapEntry, setFeatureStatus } from '../lib/feature-writer.js';
import { readFeature, writeFeature } from '../lib/feature-json.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'get-roadmap-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

// Seed a feature.json-backed workspace with a few features and render ROADMAP.md.
async function seedRendered() {
  const cwd = freshCwd();
  await addRoadmapEntry(cwd, { code: 'AAA-1', description: 'alpha', phase: 'Phase 0' });
  await addRoadmapEntry(cwd, { code: 'BBB-2', description: 'beta', phase: 'Phase 0' });
  await addRoadmapEntry(cwd, { code: 'CCC-3', description: 'gamma', phase: 'Phase 1' });
  await setFeatureStatus(cwd, { code: 'BBB-2', status: 'IN_PROGRESS' });
  await setFeatureStatus(cwd, { code: 'CCC-3', status: 'IN_PROGRESS' });
  await setFeatureStatus(cwd, { code: 'CCC-3', status: 'BLOCKED' });
  return cwd;
}

function makeNarrative() {
  const cwd = mkdtempSync(join(tmpdir(), 'get-roadmap-narr-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ roadmap: { narrative: true } }));
  const hand = `# Hand-authored Roadmap\n\n## Phase 0: Bootstrap — COMPLETE\n\n| Feature | Description | Status |\n|---|---|---|\n| HAND-1 | curated | COMPLETE |\n`;
  writeFileSync(join(cwd, 'ROADMAP.md'), hand);
  return { cwd, hand };
}

describe('getRoadmap — rendered (feature.json-backed)', () => {
  test('source is rendered and summary counts match', async () => {
    const cwd = await seedRendered();
    const r = getRoadmap(cwd, {});
    assert.equal(r.source, 'rendered');
    assert.equal(r.summary.planned, 1);     // AAA-1
    assert.equal(r.summary.active, 1);       // BBB-2 IN_PROGRESS
    assert.equal(r.summary.blocked, 1);      // CCC-3 BLOCKED
  });

  test('does NOT write ROADMAP.md (mtime unchanged)', async () => {
    const cwd = await seedRendered();
    const before = statSync(join(cwd, 'ROADMAP.md')).mtimeMs;
    getRoadmap(cwd, { format: 'markdown' });
    const after = statSync(join(cwd, 'ROADMAP.md')).mtimeMs;
    assert.equal(after, before);
  });

  test('active list carries code/description/status/phaseId, not title/phase', async () => {
    const cwd = await seedRendered();
    const r = getRoadmap(cwd, {});
    const bbb = r.active.find(x => x.code === 'BBB-2');
    assert.ok(bbb, 'BBB-2 in active list');
    assert.equal(bbb.description, 'beta');
    assert.equal(bbb.status, 'IN_PROGRESS');
    assert.ok('phaseId' in bbb);
    assert.ok(!('title' in bbb) && !('phase' in bbb));
  });

  test('status filter narrows active rows', async () => {
    const cwd = await seedRendered();
    const r = getRoadmap(cwd, { status: 'IN_PROGRESS' });
    assert.equal(r.active.length, 1);
    assert.equal(r.active[0].code, 'BBB-2');
  });

  test('phase filter matches phaseId', async () => {
    const cwd = await seedRendered();
    const all = getRoadmap(cwd, {});
    const phaseId = all.blocked[0].phaseId; // CCC-3 is in Phase 1
    const r = getRoadmap(cwd, { phase: phaseId });
    assert.ok(r.blocked.every(x => x.phaseId === phaseId));
    assert.ok(r.blocked.some(x => x.code === 'CCC-3'));
  });

  test('format: summary omits markdown, markdown includes it', async () => {
    const cwd = await seedRendered();
    assert.ok(getRoadmap(cwd, { format: 'summary' }).markdown === undefined);
    assert.ok(typeof getRoadmap(cwd, { format: 'markdown' }).markdown === 'string');
  });

  test('summary-format payload stays small', async () => {
    const cwd = await seedRendered();
    const r = getRoadmap(cwd, { format: 'summary' });
    assert.ok(JSON.stringify(r).length < 4096);
  });
});

describe('getRoadmap — anonymous rows', () => {
  test('anonymous (codeless) rows are counted in summary but excluded from lists', () => {
    // A narrative file with an anonymous BLOCKED row (no feature code).
    const cwd = mkdtempSync(join(tmpdir(), 'get-roadmap-anon-'));
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ roadmap: { narrative: true } }));
    const md = `# Roadmap\n\n## Phase 0 — IN_PROGRESS\n\n| # | Feature | Description | Status |\n|---|---------|-------------|--------|\n| 1 | — | a codeless blocked item | BLOCKED |\n| 2 | REAL-1 | a real one | BLOCKED |\n`;
    writeFileSync(join(cwd, 'ROADMAP.md'), md);
    const r = getRoadmap(cwd, {});
    assert.equal(r.summary.blocked, 2, 'both blocked rows counted');
    assert.equal(r.blocked.length, 1, 'only the named row listed');
    assert.equal(r.blocked[0].code, 'REAL-1');
    assert.ok(!r.blocked.some((x) => x.code.startsWith('_anon_')), 'no _anon_ leak');
  });
});

describe('getRoadmap — narrative-owned', () => {
  test('source is narrative, markdown is file verbatim, never stale', () => {
    const { cwd, hand } = makeNarrative();
    const r = getRoadmap(cwd, { format: 'markdown' });
    assert.equal(r.source, 'narrative');
    assert.equal(r.markdown, hand);
    assert.equal(r.stale, false);
  });
});

describe('getRoadmap — drift', () => {
  test('flags drift when on-disk diverges from canon', async () => {
    const cwd = await seedRendered();
    // Mutate canon (feature.json) directly WITHOUT re-rendering, so the fresh
    // render reflects COMPLETE while on-disk ROADMAP.md still shows IN_PROGRESS.
    const f = readFeature(cwd, 'BBB-2');
    writeFeature(cwd, { ...f, status: 'COMPLETE' });
    const r = getRoadmap(cwd, { check_drift: true });
    assert.equal(r.stale, true);
    assert.ok(r.drift);
  });

  test('ignores a Last-updated-only difference', async () => {
    const cwd = await seedRendered();
    const path = join(cwd, 'ROADMAP.md');
    // Change ONLY the Last updated line on disk to an old date.
    const edited = readFileSync(path, 'utf-8').replace(/\*\*Last updated:\*\*.*$/m, '**Last updated:** 2000-01-01');
    writeFileSync(path, edited);
    const r = getRoadmap(cwd, { check_drift: true });
    assert.equal(r.stale, false);
  });
});
