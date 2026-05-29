/**
 * feature-json-sort.test.js — listFeatures sort must be a deterministic
 * total order even when positions are ranged strings (COMP-ROADMAP-RT-GENFIX T4).
 *
 * Ranged positions like "141–144" come out of the historical-row migration.
 * The old comparator did `(a.position ?? 999) - (b.position ?? 999)`, which
 * yields NaN for string positions — a non-deterministic comparator that makes
 * regen order depend on directory-read order, breaking the roundtrip fixed point.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { listFeatures, writeFeature } from '../lib/feature-json.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'feat-sort-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

describe('listFeatures sort — deterministic with ranged-string positions', () => {
  test('ranged-string positions produce a stable total order', () => {
    const cwd = freshCwd();
    // Mixed numeric + ranged-string positions in one phase, plus a null.
    const seed = [
      { code: 'C-92', phase: 'P', status: 'PLANNED', description: 'd', position: '92–95' },
      { code: 'C-141', phase: 'P', status: 'PLANNED', description: 'd', position: '141–144' },
      { code: 'C-10', phase: 'P', status: 'PLANNED', description: 'd', position: 10 },
      { code: 'C-NULL', phase: 'P', status: 'PLANNED', description: 'd' },
      { code: 'C-2', phase: 'P', status: 'PLANNED', description: 'd', position: 2 },
    ];
    for (const f of seed) writeFeature(cwd, { created: '2026-05-02', updated: '2026-05-02', ...f });

    // Sorting the same set must give the same order every time (total order,
    // not subject to NaN-comparator instability).
    const order1 = listFeatures(cwd).map(f => f.code);
    const order2 = listFeatures(cwd).map(f => f.code);
    assert.deepEqual(order1, order2, 'sort must be deterministic across calls');

    // Numeric order on the leading integer of each position: 2, 10, 92, 141, then null last.
    assert.deepEqual(order1, ['C-2', 'C-10', 'C-92', 'C-141', 'C-NULL']);
  });
});
