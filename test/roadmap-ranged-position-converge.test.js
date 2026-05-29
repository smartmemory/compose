/**
 * Convergence regression for COMP-ROADMAP-RT-GENFIX T4.
 *
 * The historical-row migration writes feature.json files whose `position` is a
 * RANGE string ("141–144", "92–95"). The old listFeatures comparator did
 * `(a.position ?? 999) - (b.position ?? 999)`, which is NaN for string
 * positions — a non-total order. listFeatures feeds generateRoadmap's emit
 * order, and anonymous/struck rows anchor to the typed row that precedes them.
 * An unstable typed-row order therefore moves the struck row's predecessor and
 * the regenerated ROADMAP.md never reaches a fixed point.
 *
 * Contract: with a numeric, range-tolerant sort key, typed rows emit in
 * leading-integer order, a `~~struck~~` anon row stays anchored to its
 * predecessor, and two generate passes are byte-identical.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeFeature } from '../lib/feature-json.js';
import { generateRoadmap } from '../lib/roadmap-gen.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'ranged-pos-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

describe('generateRoadmap converges with ranged positions + a struck anon row', () => {
  test('typed rows emit in leading-int order, struck row anchored, byte-idempotent', () => {
    const cwd = freshCwd();
    // Two ranged-position typed rows whose string sort (lexical) disagrees with
    // their numeric leading-int order: "141–144" < "92–95" lexically, but
    // 92 < 141 numerically. A null-position row must sort last.
    for (const f of [
      { code: 'WAVE-92', phase: 'Backlog', status: 'PLANNED', description: 'group 92-95', position: '92–95' },
      { code: 'WAVE-141', phase: 'Backlog', status: 'PLANNED', description: 'group 141-144', position: '141–144' },
      { code: 'WAVE-7', phase: 'Backlog', status: 'PLANNED', description: 'single 7', position: 7 },
    ]) {
      writeFeature(cwd, { created: '2026-05-02', updated: '2026-05-02', ...f });
    }

    // Seed a base ROADMAP whose Backlog table carries a struck historical row
    // immediately after WAVE-92 (a code the strict regex rejects → anon).
    const base = [
      '# Demo Roadmap', '',
      '**Last updated:** 2026-05-29', '',
      '---', '',
      '## Backlog — PLANNED', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 7 | WAVE-7 | single 7 | PLANNED |',
      '| 92–95 | WAVE-92 | group 92-95 | PLANNED |',
      '| — | ~~WAVE-OLD~~ | superseded experiment | SUPERSEDED |',
      '| 141–144 | WAVE-141 | group 141-144 | PLANNED |',
      '',
    ].join('\n');
    writeFileSync(join(cwd, 'ROADMAP.md'), base);

    const out1 = generateRoadmap(cwd, { now: '2026-05-29' });
    writeFileSync(join(cwd, 'ROADMAP.md'), out1);
    const out2 = generateRoadmap(cwd, { now: '2026-05-29' });

    // (a) Fixed point: regen of the generated file is byte-identical.
    assert.equal(out2, out1, 'generateRoadmap must reach a fixed point on ranged positions');

    // (b) Typed rows ordered by leading integer (7, 92, 141), NOT lexically.
    const order = [...out1.matchAll(/\| [^|]*\| (WAVE-\d+) \|/g)].map(m => m[1]);
    assert.deepEqual(order, ['WAVE-7', 'WAVE-92', 'WAVE-141'],
      `typed rows must sort by leading int, got ${JSON.stringify(order)}`);

    // (c) The struck anon row survives verbatim, anchored right after WAVE-92.
    assert.ok(out1.includes('| — | ~~WAVE-OLD~~ | superseded experiment | SUPERSEDED |'),
      'struck historical row must survive regen');
    const idx92 = out1.indexOf('WAVE-92');
    const idxOld = out1.indexOf('WAVE-OLD');
    const idx141 = out1.indexOf('WAVE-141');
    assert.ok(idx92 < idxOld && idxOld < idx141,
      'struck row must stay anchored between its predecessor (WAVE-92) and WAVE-141');
  });
});
