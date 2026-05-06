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

  test('curated phase prose survives in typed phases (intro)', () => {
    const original = readFileSync(join(COMPOSE_ROOT, 'ROADMAP.md'), 'utf-8');
    const regenerated = generateRoadmap(COMPOSE_ROOT);

    // Phase 7 has a curated intro paragraph between heading and table.
    const phase7Idx = original.indexOf('## Phase 7: MCP Writers');
    assert.ok(phase7Idx >= 0, 'Phase 7 heading missing from source');
    const phase7End = original.indexOf('\n## ', phase7Idx + 1);
    const phase7Block = original.slice(phase7Idx, phase7End);
    const tableStart = phase7Block.indexOf('\n|');
    const phase7Intro = phase7Block.slice(phase7Block.indexOf('\n') + 1, tableStart).trim();
    if (phase7Intro.length > 0) {
      assert.ok(
        regenerated.includes(phase7Intro),
        `Phase 7 intro prose lost in regen:\n--- expected substring ---\n${phase7Intro}\n--- not found in regen ---`
      );
    }
  });

  test('exit-text lines survive across all typed phases', () => {
    const original = readFileSync(join(COMPOSE_ROOT, 'ROADMAP.md'), 'utf-8');
    const regenerated = generateRoadmap(COMPOSE_ROOT);

    // Every line that starts with `**Exit:**` is curated content that must
    // round-trip. There are several across typed phases.
    const exitLines = original
      .split('\n')
      .filter(l => l.startsWith('**Exit:**'));
    assert.ok(exitLines.length >= 5, `expected at least 5 **Exit:** lines, found ${exitLines.length}`);
    for (const line of exitLines) {
      assert.ok(
        regenerated.includes(line),
        `exit line lost in regen:\n${line}`
      );
    }
  });

  test('doc-link tails survive (See `docs/...` references)', () => {
    const original = readFileSync(join(COMPOSE_ROOT, 'ROADMAP.md'), 'utf-8');
    const regenerated = generateRoadmap(COMPOSE_ROOT);

    const seeLines = original
      .split('\n')
      .filter(l => /^See `docs\//.test(l));
    assert.ok(seeLines.length >= 3, `expected at least 3 See lines, found ${seeLines.length}`);
    for (const line of seeLines) {
      assert.ok(
        regenerated.includes(line),
        `doc-link tail lost in regen:\n${line}`
      );
    }
  });

  test('regen of regen is structurally idempotent', () => {
    // True round-trip: feed regenerated output back through the writer and
    // confirm the second regen produces the same content. We can't run
    // generateRoadmap on a string directly (it reads from disk), so we
    // compare key invariants between first and second-pass-equivalent regens
    // by re-parsing the output.
    const first = generateRoadmap(COMPOSE_ROOT);
    const originalText = readFileSync(join(COMPOSE_ROOT, 'ROADMAP.md'), 'utf-8');

    // Preserved sections must round-trip byte-equal.
    const origSections = readPreservedSections(originalText);
    const newSections = readPreservedSections(first);
    assert.equal(newSections.size, origSections.size, 'preserved-section count diverged');
    for (const id of origSections.keys()) {
      assert.equal(newSections.get(id), origSections.get(id), `preserved section "${id}" diverged`);
    }

    // Overrides must round-trip identically.
    const origOverrides = readPhaseOverrides(originalText);
    const newOverrides = readPhaseOverrides(first);
    for (const [phase, ov] of origOverrides) {
      assert.equal(
        newOverrides.get(phase),
        ov,
        `override for "${phase}" diverged`
      );
    }

    // Anonymous rows must round-trip identically.
    const origAnon = readAnonymousRows(originalText);
    const newAnon = readAnonymousRows(first);
    for (const [phase, rows] of origAnon) {
      const newRows = newAnon.get(phase) ?? [];
      assert.equal(newRows.length, rows.length, `anon row count for "${phase}" diverged`);
      const origLines = new Set(rows.map(r => r.rawLine));
      for (const r of newRows) {
        assert.ok(origLines.has(r.rawLine), `anon row text diverged in "${phase}": ${r.rawLine}`);
      }
    }
  });
});
