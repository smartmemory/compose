/**
 * Tests for roadmap-parser.js and build-dag.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRoadmap, filterBuildable } from '../lib/roadmap-parser.js';
import { buildDag, topoSort } from '../lib/build-dag.js';

// ---------------------------------------------------------------------------
// Fixture: minimal roadmap
// ---------------------------------------------------------------------------

const MINIMAL_ROADMAP = `\
# Roadmap

## Phase 1: Setup — COMPLETE

| # | Feature | Item | Status |
|---|---------|------|--------|
| 1 | SETUP-1 | Initialize project | COMPLETE |
| 2 | SETUP-2 | Add config | COMPLETE |

## Phase 2: Core — IN_PROGRESS

| # | Feature | Item | Status |
|---|---------|------|--------|
| 3 | CORE-1 | Build the widget | PLANNED |
| 4 | CORE-2 | Add validation | PLANNED |
| 5 | CORE-3 | Polish UI | PLANNED |

## Phase 3: Ship — PLANNED

| # | Feature | Item | Status |
|---|---------|------|--------|
| 6 | SHIP-1 | Write docs | PLANNED |
| 7 | SHIP-2 | Release | PLANNED |
`;

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe('parseRoadmap', () => {
  test('extracts feature codes and statuses', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const codes = entries.filter(e => !e.code.startsWith('_anon_')).map(e => e.code);
    assert.deepEqual(codes, ['SETUP-1', 'SETUP-2', 'CORE-1', 'CORE-2', 'CORE-3', 'SHIP-1', 'SHIP-2']);
  });

  test('marks COMPLETE phase items as COMPLETE', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const setup1 = entries.find(e => e.code === 'SETUP-1');
    assert.equal(setup1.status, 'COMPLETE');
  });

  test('preserves PLANNED status in IN_PROGRESS phase', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const core1 = entries.find(e => e.code === 'CORE-1');
    assert.equal(core1.status, 'PLANNED');
  });

  test('assigns phase IDs', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const core1 = entries.find(e => e.code === 'CORE-1');
    assert.ok(core1.phaseId.includes('Phase 2'));
  });

  test('positions are sequential', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const positions = entries.map(e => e.position);
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] > positions[i - 1], `position ${positions[i]} should be > ${positions[i - 1]}`);
    }
  });

  test('handles 3-column tables (no Feature column)', () => {
    const roadmap = `\
## Phase 0: Bootstrap — COMPLETE

| # | Item | Status |
|---|------|--------|
| — | Setup stuff | COMPLETE |
| — | More setup | COMPLETE |
`;
    const entries = parseRoadmap(roadmap);
    assert.ok(entries.length === 2);
    assert.ok(entries.every(e => e.code.startsWith('_anon_')));
  });

  test('handles milestone sub-headings', () => {
    const roadmap = `\
## STRAT-1: Engine — IN_PROGRESS

### Milestone 1: Core

| # | Feature | Item | Status |
|---|---------|------|--------|
| 1 | ENG-1 | Build core | COMPLETE |

### Milestone 2: Extensions

| # | Feature | Item | Status |
|---|---------|------|--------|
| 2 | ENG-2 | Add extensions | PLANNED |
`;
    const entries = parseRoadmap(roadmap);
    const eng1 = entries.find(e => e.code === 'ENG-1');
    const eng2 = entries.find(e => e.code === 'ENG-2');
    assert.ok(eng1.phaseId.includes('Milestone 1'));
    assert.ok(eng2.phaseId.includes('Milestone 2'));
  });

  test('consecutive milestones reset to parent phase (no nesting) (GENFIX T2)', () => {
    const roadmap = `\
## Phase A — PLANNED

### Milestone 1

| # | Feature | Item | Status |
|---|---------|------|--------|
| 1 | MA-1 | first | PLANNED |

### Milestone 2

| # | Feature | Item | Status |
|---|---------|------|--------|
| 2 | MA-2 | second | PLANNED |
`;
    const entries = parseRoadmap(roadmap);
    const ma1 = entries.find(e => e.code === 'MA-1');
    const ma2 = entries.find(e => e.code === 'MA-2');
    assert.equal(ma1.phaseId, 'Phase A > Milestone 1',
      `expected reset-to-parent, got ${ma1.phaseId}`);
    assert.equal(ma2.phaseId, 'Phase A > Milestone 2',
      `expected reset-to-parent (not accumulated), got ${ma2.phaseId}`);
  });

  test('explicit row status wins over SKIP_STATUS phase override', () => {
    const roadmap = `\
## Phase X: Rollup — COMPLETE

| # | Feature | Item | Status |
|---|---------|------|--------|
| 1 | ROLL-1 | Done item | COMPLETE |
| 2 | ROLL-2 | Carried over | PLANNED |
| 3 | ROLL-3 | Blank cell |  |
`;
    const entries = parseRoadmap(roadmap);
    const roll1 = entries.find(e => e.code === 'ROLL-1');
    const roll2 = entries.find(e => e.code === 'ROLL-2');
    const roll3 = entries.find(e => e.code === 'ROLL-3');
    // Explicit PLANNED under a COMPLETE phase must NOT be rewritten to COMPLETE.
    assert.equal(roll2.status, 'PLANNED', 'explicit PLANNED row should be preserved');
    // Explicit COMPLETE stays COMPLETE.
    assert.equal(roll1.status, 'COMPLETE');
    // Blank status cell under a COMPLETE phase still falls back to COMPLETE.
    assert.equal(roll3.status, 'COMPLETE', 'blank cell should inherit phase COMPLETE');
  });
});

// ---------------------------------------------------------------------------
// filterBuildable tests
// ---------------------------------------------------------------------------

describe('filterBuildable', () => {
  test('excludes COMPLETE, SUPERSEDED, PARKED, anonymous', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const buildable = filterBuildable(entries);
    const codes = buildable.map(e => e.code);
    assert.ok(!codes.includes('SETUP-1'), 'COMPLETE should be excluded');
    assert.ok(!codes.includes('SETUP-2'), 'COMPLETE should be excluded');
    assert.ok(codes.includes('CORE-1'), 'PLANNED should be included');
    assert.ok(codes.includes('SHIP-1'), 'PLANNED should be included');
  });

  test('returns only buildable features', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const buildable = filterBuildable(entries);
    assert.equal(buildable.length, 5); // CORE-1,2,3 + SHIP-1,2
  });
});

// ---------------------------------------------------------------------------
// DAG tests
// ---------------------------------------------------------------------------

describe('buildDag', () => {
  test('creates sequential deps within a phase', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const dag = buildDag(entries);
    const nodeMap = new Map(dag.map(n => [n.code, n]));

    const core2 = nodeMap.get('CORE-2');
    assert.ok(core2.deps.includes('CORE-1'), 'CORE-2 should depend on CORE-1');

    const core3 = nodeMap.get('CORE-3');
    assert.ok(core3.deps.includes('CORE-2'), 'CORE-3 should depend on CORE-2');
  });

  test('creates cross-phase deps', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const dag = buildDag(entries);
    const nodeMap = new Map(dag.map(n => [n.code, n]));

    const core1 = nodeMap.get('CORE-1');
    assert.ok(core1.deps.includes('SETUP-2'), 'CORE-1 should depend on last Phase 1 item');

    const ship1 = nodeMap.get('SHIP-1');
    assert.ok(ship1.deps.includes('CORE-3'), 'SHIP-1 should depend on last Phase 2 item');
  });
});

// ---------------------------------------------------------------------------
// topoSort tests
// ---------------------------------------------------------------------------

describe('topoSort', () => {
  test('returns features in dependency order', () => {
    const entries = parseRoadmap(MINIMAL_ROADMAP);
    const dag = buildDag(entries);
    const order = topoSort(dag);

    const idx = (code) => order.indexOf(code);
    assert.ok(idx('SETUP-1') < idx('SETUP-2'));
    assert.ok(idx('SETUP-2') < idx('CORE-1'));
    assert.ok(idx('CORE-1') < idx('CORE-2'));
    assert.ok(idx('CORE-3') < idx('SHIP-1'));
  });

  test('throws on cycle', () => {
    const nodes = [
      { code: 'A', deps: ['B'] },
      { code: 'B', deps: ['A'] },
    ];
    assert.throws(() => topoSort(nodes), /Cycle detected/);
  });

  test('handles empty input', () => {
    assert.deepEqual(topoSort([]), []);
  });
});

// ---------------------------------------------------------------------------
// Integration: parse actual ROADMAP.md
// ---------------------------------------------------------------------------

describe('actual ROADMAP.md', () => {
  const roadmapPath = join(import.meta.dirname, '..', 'ROADMAP.md');
  let text;
  try { text = readFileSync(roadmapPath, 'utf-8'); } catch { /* skip */ }

  test('parses without error', { skip: !text && 'ROADMAP.md not found' }, () => {
    const entries = parseRoadmap(text);
    assert.ok(entries.length > 0, 'should find entries');
  });

  test('finds known feature codes', { skip: !text && 'ROADMAP.md not found' }, () => {
    const entries = parseRoadmap(text);
    const codes = entries.map(e => e.code);
    assert.ok(codes.includes('STRAT-COMP-4'), 'should find STRAT-COMP-4');
  });

  test('DAG sorts without cycle', { skip: !text && 'ROADMAP.md not found' }, () => {
    const entries = parseRoadmap(text);
    const dag = buildDag(entries);
    const order = topoSort(dag);
    assert.ok(order.length > 0);
  });

  test('filterBuildable returns PLANNED features', { skip: !text && 'ROADMAP.md not found' }, () => {
    const entries = parseRoadmap(text);
    const buildable = filterBuildable(entries);
    assert.ok(buildable.length > 0, 'should have buildable features');
    assert.ok(buildable.every(e => !['COMPLETE', 'SUPERSEDED', 'PARKED'].includes(e.status)));
  });
});

test('parses a feature code that does not end in -<digits> as a real code', () => {
  const md = [
    '## Phase 6: MCP Writers — PLANNED',
    '',
    '| # | Feature | Description | Status |',
    '|---|---------|-------------|--------|',
    '| 1 | COMP-ROADMAP-RT | harden roundtrip | PLANNED |',
    '',
  ].join('\n');
  const codes = parseRoadmap(md).map(e => e.code);
  assert.ok(codes.includes('COMP-ROADMAP-RT'),
    `expected COMP-ROADMAP-RT as a real code, got ${JSON.stringify(codes)}`);
  assert.ok(!codes.some(c => c.startsWith('_anon_')),
    'COMP-ROADMAP-RT must not be classified anonymous');
});

test('unescapes escaped pipes in a description cell and reads status correctly (GENFIX T3)', () => {
  const md = [
    '## Phase 7: Escaping — PLANNED',
    '',
    '| # | Feature | Description | Status |',
    '|---|---------|-------------|--------|',
    '| 1 | ESC-1 | a \\| b | IN_PROGRESS |',
    '',
  ].join('\n');
  const entries = parseRoadmap(md);
  const esc = entries.find(e => e.code === 'ESC-1');
  assert.ok(esc, `expected ESC-1 in ${JSON.stringify(entries.map(e => e.code))}`);
  assert.equal(esc.description, 'a | b', 'escaped pipe must be unescaped to a literal pipe');
  assert.equal(esc.status, 'IN_PROGRESS', 'status column must not be a description fragment');
});
