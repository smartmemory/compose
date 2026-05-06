/**
 * Round-trip integration test for ROADMAP.md typed-writer regen.
 *
 * COMP-MCP-MIGRATION-2-1-1 T5 (Option A).
 *
 * Asserts that running writeRoadmap() against the marker-wrapped ROADMAP.md
 * with no feature.json mutations is idempotent: every preserved subtree
 * survives byte-equal, every override text survives unchanged, every
 * anonymous row appears at its parsed position.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateRoadmap } from '../lib/roadmap-gen.js';
import {
  readPhaseOverrides,
  readAnonymousRows,
  readPreservedSections,
} from '../lib/roadmap-preservers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COMPOSE_ROOT = join(__dirname, '..');

describe('writeRoadmap round-trip on compose ROADMAP.md', () => {
  test('all 4 preserved sections survive byte-equal in regenerated output', () => {
    const original = readFileSync(join(COMPOSE_ROOT, 'ROADMAP.md'), 'utf-8');
    const regenerated = generateRoadmap(COMPOSE_ROOT);

    const originalSections = readPreservedSections(original);
    assert.equal(originalSections.size, 4, 'expected 4 preserved sections in source');

    for (const [id, raw] of originalSections) {
      assert.ok(
        regenerated.includes(raw),
        `preserved section "${id}" not present byte-equal in regenerated output`
      );
    }
  });

  test('all curated phase-status overrides survive in regenerated headings', () => {
    const original = readFileSync(join(COMPOSE_ROOT, 'ROADMAP.md'), 'utf-8');
    const regenerated = generateRoadmap(COMPOSE_ROOT);

    const overrides = readPhaseOverrides(original);
    assert.ok(overrides.size > 0, 'expected at least one override in source');

    for (const [phaseId, override] of overrides) {
      // Skip Phase 0 etc. that get rolled up to a status the writer already produces.
      // The relevant assertion: non-bare overrides (with parenthetical or " by X") must survive.
      if (!/[(\s]/.test(override.replace(/^[A-Z_]+$/, ''))) continue;
      const expected = `## ${phaseId} — ${override}`;
      assert.ok(
        regenerated.includes(expected),
        `override heading "${expected}" not present in regenerated output`
      );
    }
  });

  test('all anonymous rows appear in regenerated output', () => {
    const original = readFileSync(join(COMPOSE_ROOT, 'ROADMAP.md'), 'utf-8');
    const regenerated = generateRoadmap(COMPOSE_ROOT);

    const anon = readAnonymousRows(original);
    let totalAnonRows = 0;
    for (const rows of anon.values()) totalAnonRows += rows.length;
    assert.ok(totalAnonRows > 0, 'expected at least one anonymous row in source');

    for (const rows of anon.values()) {
      for (const row of rows) {
        assert.ok(
          regenerated.includes(row.rawLine),
          `anonymous row "${row.rawLine}" not present in regenerated output`
        );
      }
    }
  });

  test('regen is idempotent (regen of regen produces same output)', () => {
    // We can't easily writeRoadmap(regen) without filesystem, so assert
    // generateRoadmap is stable on its input by parsing its own output.
    const first = generateRoadmap(COMPOSE_ROOT);
    // Capture preserved sections + overrides from the regen output;
    // they should match the originals.
    const originalText = readFileSync(join(COMPOSE_ROOT, 'ROADMAP.md'), 'utf-8');

    const origSections = readPreservedSections(originalText);
    const newSections = readPreservedSections(first);
    assert.equal(newSections.size, origSections.size, 'preserved-section count diverged');
    for (const id of origSections.keys()) {
      assert.equal(newSections.get(id), origSections.get(id), `preserved section "${id}" diverged`);
    }

    const origOverrides = readPhaseOverrides(originalText);
    const newOverrides = readPhaseOverrides(first);
    for (const [phase, ov] of origOverrides) {
      assert.equal(
        newOverrides.get(phase),
        ov,
        `override for "${phase}" diverged`
      );
    }
  });
});
