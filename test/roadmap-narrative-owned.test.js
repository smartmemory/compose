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
