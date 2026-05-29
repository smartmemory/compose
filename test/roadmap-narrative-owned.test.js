/**
 * Tests for the narrative-owned workspace guard (issue #39).
 *
 * A workspace whose .compose/compose.json declares `roadmap.narrative: true`
 * has a hand-authored ROADMAP.md that must never be machine-regenerated from
 * feature.json. The typed writer (generateRoadmap / writeRoadmap) must no-op
 * with a warning, and add_roadmap_entry must refuse.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isNarrativeOwned } from '../lib/roadmap-config.js';
import { generateRoadmap, writeRoadmap } from '../lib/roadmap-gen.js';
import { addRoadmapEntry } from '../lib/feature-writer.js';
import { validateProject } from '../lib/feature-validator.js';

const HAND_AUTHORED = `# Hand-authored Roadmap

This file is curated by a human. It has no phase tables — regenerating it from
feature.json would flatten this prose into rendered tables.

## Wave 6 — Situational Awareness — COMPLETE

Curated narrative the writer would otherwise destroy.
`;

// A workspace that HAS a feature.json (so regen would produce something very
// different from HAND_AUTHORED) and a compose.json that may or may not flag it
// narrative-owned.
function makeWorkspace({ narrative }) {
  const cwd = mkdtempSync(join(tmpdir(), 'narrative-owned-'));
  mkdirSync(join(cwd, 'docs', 'features', 'FOO-1'), { recursive: true });
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(
    join(cwd, '.compose', 'compose.json'),
    JSON.stringify(narrative ? { roadmap: { narrative: true } } : {}, null, 2),
  );
  writeFileSync(
    join(cwd, 'docs', 'features', 'FOO-1', 'feature.json'),
    JSON.stringify(
      { code: 'FOO-1', description: 'a feature', status: 'PLANNED', phase: 'Phase 0', position: 1, created: '2026-05-02', updated: '2026-05-02' },
      null, 2,
    ),
  );
  writeFileSync(join(cwd, 'ROADMAP.md'), HAND_AUTHORED);
  return cwd;
}

describe('isNarrativeOwned', () => {
  test('true when roadmap.narrative === true', () => {
    assert.equal(isNarrativeOwned(makeWorkspace({ narrative: true })), true);
  });
  test('false when the flag is absent', () => {
    assert.equal(isNarrativeOwned(makeWorkspace({ narrative: false })), false);
  });
  test('false when there is no compose.json at all', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'no-config-'));
    assert.equal(isNarrativeOwned(cwd), false);
  });
});

describe('writeRoadmap / generateRoadmap guard (#39)', () => {
  test('writeRoadmap is a no-op on a narrative-owned workspace (byte-equal)', () => {
    const cwd = makeWorkspace({ narrative: true });
    const before = readFileSync(join(cwd, 'ROADMAP.md'), 'utf8');
    const path = writeRoadmap(cwd);
    const after = readFileSync(join(cwd, 'ROADMAP.md'), 'utf8');
    assert.equal(after, before, 'narrative-owned ROADMAP.md must survive regen byte-for-byte');
    assert.equal(path, join(cwd, 'ROADMAP.md'));
  });

  test('generateRoadmap returns the existing content verbatim on a narrative-owned workspace', () => {
    const cwd = makeWorkspace({ narrative: true });
    assert.equal(generateRoadmap(cwd), HAND_AUTHORED);
  });

  test('control: a NON-narrative workspace IS regenerated (guard is load-bearing)', () => {
    const cwd = makeWorkspace({ narrative: false });
    const before = readFileSync(join(cwd, 'ROADMAP.md'), 'utf8');
    writeRoadmap(cwd);
    const after = readFileSync(join(cwd, 'ROADMAP.md'), 'utf8');
    assert.notEqual(after, before, 'a normal workspace must still be regenerated');
  });
});

describe('add_roadmap_entry guard (#39)', () => {
  test('refuses with an actionable error and writes no feature.json', async () => {
    const cwd = makeWorkspace({ narrative: true });
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'BAR-1', description: 'x', phase: 'Phase 0' }),
      /narrative-owned/,
    );
    assert.equal(existsSync(join(cwd, 'docs', 'features', 'BAR-1', 'feature.json')), false,
      'no feature.json should be created when the workspace is narrative-owned');
  });
});

describe('validateProject roadmap-correspondence guard (#39 gap fix)', () => {
  // Every finding that treats a roadmap row as canonical is suppressed when
  // narrative-owned — roundtrip, folder↔row linkage, AND roadmap-vs-* drift.
  const SUPPRESSED = new Set([
    'ROUNDTRIP_NOT_FIXED_POINT', 'ROADMAP_LOSSY', 'HIERARCHY_DEPTH_INVALID', 'ORPHAN_PHASE',
    'ROADMAP_ROW_WITHOUT_FOLDER', 'FOLDER_WITHOUT_ROADMAP_ROW', 'ORPHAN_FOLDER',
    'STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON', 'STATUS_MISMATCH_ROADMAP_VS_VISION_STATE',
    'COMPLEXITY_OR_DESCRIPTION_DRIFT',
  ]);
  const correspondence = (findings) => findings.filter(f => SUPPRESSED.has(f.kind));

  // FOO-1 has a folder but no ROADMAP row; GHOST-1 has a row but no folder — this
  // drives ROADMAP_LOSSY, FOLDER_WITHOUT_ROADMAP_ROW, ROADMAP_ROW_WITHOUT_FOLDER,
  // and ORPHAN_FOLDER on a normal workspace.
  const driftingRoadmap = `# Roadmap

## Phase 9 — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | GHOST-1 | not backed by feature.json | PLANNED |
`;

  test('narrative-owned: ALL correspondence findings suppressed, one ROADMAP_NARRATIVE_OWNED info', async () => {
    const cwd = makeWorkspace({ narrative: true });
    writeFileSync(join(cwd, 'ROADMAP.md'), driftingRoadmap);
    const { findings } = await validateProject(cwd);
    assert.deepEqual(correspondence(findings), [],
      `narrative-owned must suppress the whole correspondence class, got ${JSON.stringify(correspondence(findings))}`);
    assert.equal(findings.filter(f => f.kind === 'ROADMAP_NARRATIVE_OWNED').length, 1,
      'exactly one info finding records the skip, not silent');
    assert.ok(findings.some(f => f.kind === 'ROADMAP_NARRATIVE_OWNED' && f.severity === 'info'));
  });

  test('control: a NON-narrative workspace with the same drift DOES report correspondence findings', async () => {
    const cwd = makeWorkspace({ narrative: false });
    writeFileSync(join(cwd, 'ROADMAP.md'), driftingRoadmap);
    const { findings } = await validateProject(cwd);
    assert.ok(correspondence(findings).length > 0,
      'guard is load-bearing: a normal workspace still reports correspondence drift');
    assert.ok(!findings.some(f => f.kind === 'ROADMAP_NARRATIVE_OWNED'),
      'no narrative-owned info on a normal workspace');
  });

  test('does NOT over-suppress: feature.json↔vision drift survives (no roadmap involved)', async () => {
    const cwd = makeWorkspace({ narrative: true });
    writeFileSync(join(cwd, 'ROADMAP.md'), driftingRoadmap); // FOO-1 absent from roadmap → rStatus null
    // vision-state binds FOO-1 as COMPLETE while feature.json says PLANNED →
    // STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE (no roadmap on either side).
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'data', 'vision-state.json'), JSON.stringify({
      items: [{ id: 'v1', type: 'feature', status: 'COMPLETE', lifecycle: { featureCode: 'FOO-1' } }],
      connections: [], gates: [],
    }));
    const { findings } = await validateProject(cwd);
    assert.ok(findings.some(f => f.kind === 'STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE'),
      'feature.json↔vision drift must survive — narrative only suppresses roadmap-derived findings');
    assert.deepEqual(correspondence(findings), [], 'roadmap-derived findings still suppressed');
  });
});

describe('validateProject killed-mode roadmap-source guard (#39)', () => {
  // A killed feature whose ROADMAP row is non-terminal must NOT raise
  // KILLED_STATUS_NOT_TERMINAL from the roadmap source on a narrative-owned
  // workspace — the roadmap is hand-authored, not canonical. feature.json /
  // vision sources are still checked (no over-suppression).
  const killedRoadmap = `# Hand-authored

## Phase 0 — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | FOO-1 | killed but row still says planned | PLANNED |
`;

  function seedKilled(cwd, featureStatus) {
    writeFileSync(join(cwd, 'docs', 'features', 'FOO-1', 'feature.json'),
      JSON.stringify({ code: 'FOO-1', description: 'a feature', status: featureStatus, phase: 'Phase 0', position: 1, created: '2026-05-02', updated: '2026-05-02' }, null, 2));
    writeFileSync(join(cwd, 'docs', 'features', 'FOO-1', 'killed.md'), '# Killed\n\nNo longer pursuing.\n');
    writeFileSync(join(cwd, 'ROADMAP.md'), killedRoadmap);
  }
  const killedTerminal = (findings) => findings.filter(f => f.kind === 'KILLED_STATUS_NOT_TERMINAL');

  test('narrative-owned: a non-terminal ROADMAP row does NOT raise KILLED_STATUS_NOT_TERMINAL', async () => {
    const cwd = makeWorkspace({ narrative: true });
    seedKilled(cwd, 'KILLED'); // feature.json terminal; only the roadmap row is non-terminal
    const { findings } = await validateProject(cwd);
    assert.deepEqual(killedTerminal(findings), [],
      `roadmap-sourced KILLED_STATUS_NOT_TERMINAL must be suppressed, got ${JSON.stringify(killedTerminal(findings))}`);
  });

  test('control: a NON-narrative workspace DOES raise it from the roadmap row', async () => {
    const cwd = makeWorkspace({ narrative: false });
    seedKilled(cwd, 'KILLED');
    const { findings } = await validateProject(cwd);
    assert.ok(killedTerminal(findings).some(f => /roadmap/i.test(f.detail)),
      'guard is load-bearing: a normal workspace flags the non-terminal roadmap row');
  });

  test('does NOT over-suppress: a non-terminal feature.json with killed.md still flags', async () => {
    const cwd = makeWorkspace({ narrative: true });
    seedKilled(cwd, 'IN_PROGRESS'); // feature.json itself is non-terminal — real drift
    const { findings } = await validateProject(cwd);
    assert.ok(killedTerminal(findings).some(f => /feature\.json/i.test(f.detail)),
      'feature.json non-terminal status with killed.md must still flag — only the roadmap source is suppressed');
  });
});

describe('validateProject narrative-owned: row-schema + status-fallback (#39 codex round)', () => {
  const rowSchemaBad = `# Hand-authored

## Phase 0 — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | FOO-1 | x | WIP |
`;

  test('narrative-owned: an invalid hand-authored ROADMAP row is NOT schema-validated', async () => {
    const cwd = makeWorkspace({ narrative: true });
    writeFileSync(join(cwd, 'ROADMAP.md'), rowSchemaBad);
    const { findings } = await validateProject(cwd);
    assert.equal(findings.filter(f => f.kind === 'ROADMAP_ROW_SCHEMA_VIOLATION').length, 0,
      'a hand-authored row must not be typed-schema-validated');
  });

  test('control: non-narrative DOES raise ROADMAP_ROW_SCHEMA_VIOLATION', async () => {
    const cwd = makeWorkspace({ narrative: false });
    writeFileSync(join(cwd, 'ROADMAP.md'), rowSchemaBad);
    const { findings } = await validateProject(cwd);
    assert.ok(findings.some(f => f.kind === 'ROADMAP_ROW_SCHEMA_VIOLATION'),
      'guard is load-bearing: a normal workspace still schema-validates rows');
  });

  // A folder-only feature (no feature.json) must NOT inherit its status from a
  // hand-authored roadmap row in narrative mode — the row is not canonical.
  const folderOnlyRoadmap = `# Hand-authored

## Phase 0 — IN_PROGRESS

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | BAR-1 | active per hand-authored row | IN_PROGRESS |
`;

  test('narrative-owned: folder-only feature does not inherit roadmap IN_PROGRESS (no MISSING_DESIGN_ARTIFACT)', async () => {
    const cwd = makeWorkspace({ narrative: true });
    mkdirSync(join(cwd, 'docs', 'features', 'BAR-1'), { recursive: true }); // folder, no feature.json, no design.md
    writeFileSync(join(cwd, 'ROADMAP.md'), folderOnlyRoadmap);
    const { findings } = await validateProject(cwd);
    assert.equal(findings.filter(f => f.kind === 'MISSING_DESIGN_ARTIFACT' && f.feature_code === 'BAR-1').length, 0,
      'narrative-owned must not enforce design.md off a hand-authored roadmap status');
  });

  test('control: non-narrative folder-only feature DOES inherit roadmap status → MISSING_DESIGN_ARTIFACT', async () => {
    const cwd = makeWorkspace({ narrative: false });
    mkdirSync(join(cwd, 'docs', 'features', 'BAR-1'), { recursive: true });
    writeFileSync(join(cwd, 'ROADMAP.md'), folderOnlyRoadmap);
    const { findings } = await validateProject(cwd);
    assert.ok(findings.some(f => f.kind === 'MISSING_DESIGN_ARTIFACT' && f.feature_code === 'BAR-1'),
      'guard is load-bearing: normal workspace still uses the roadmap status fallback');
  });
});
