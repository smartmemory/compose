/**
 * COMP-MCP-MIGRATION-2-1-1-1 — `compose migrate-anon`.
 *
 * Promotes historical anonymous ROADMAP rows (preserved verbatim by
 * COMP-MCP-MIGRATION-2-1-1) to typed features. The load-bearing correctness
 * point: scaffolding a feature.json ALONE does not replace the anonymous row
 * (rows anchor by predecessorCode, not position) — so promotion must strip the
 * source `rawLine` before regen, or you get a duplicate. These tests guard that.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

import {
  collectAnonRowsFromText,
  stripAnonLine,
  promoteAnonRow,
  runMigrateAnon,
} from '../lib/migrate-anon.js';
import { readFeature, writeFeature } from '../lib/feature-json.js';

const ROADMAP_3COL = `# Test Roadmap

## Phase A

| # | Item | Status |
|---|------|--------|
| — | First historical thing | COMPLETE |
| — | Second historical thing | PARTIAL |

## Phase B

| # | Item | Status |
|---|------|--------|
| — | Bold status thing | **IN_PROGRESS** |
| — | Commentary status thing | PARKED — superseded by X |
| — | Blank status thing |  |
`;

const ROADMAP_4COL = `# Test Roadmap

## Phase A

| # | Feature | Item | Status |
|---|---------|------|--------|
| — | — | Four column historical | COMPLETE |
`;

const ROADMAP_DUP = `# Test Roadmap

## Phase A

| # | Item | Status |
|---|------|--------|
| — | Repeated thing | COMPLETE |
| — | Repeated thing | COMPLETE |
`;

function freshCwd(roadmap) {
  const cwd = mkdtempSync(join(tmpdir(), 'migrate-anon-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  writeFileSync(join(cwd, 'ROADMAP.md'), roadmap);
  return cwd;
}

describe('collectAnonRowsFromText — header-aware', () => {
  test('3-column table: num/title/status parsed per row', () => {
    const rows = collectAnonRowsFromText(ROADMAP_3COL);
    const a = rows.filter(r => r.phaseId === 'Phase A');
    assert.equal(a.length, 2);
    assert.equal(a[0].title, 'First historical thing');
    assert.equal(a[0].status, 'COMPLETE');
    assert.equal(a[0].occurrenceIndex, 0);
    assert.equal(a[1].occurrenceIndex, 1);
  });

  test('4-column (# | Feature | Item | Status) table reads the right title/status column', () => {
    const rows = collectAnonRowsFromText(ROADMAP_4COL);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Four column historical');
    assert.equal(rows[0].status, 'COMPLETE');
  });

  test('status seed is normalized to the canonical enum', () => {
    const rows = collectAnonRowsFromText(ROADMAP_3COL).filter(r => r.phaseId === 'Phase B');
    assert.equal(rows[0].status, 'IN_PROGRESS');      // **IN_PROGRESS**
    assert.equal(rows[1].status, 'PARKED');           // PARKED — superseded by X
    assert.equal(rows[2].status, 'PLANNED');          // blank → default
  });

  test('two tables in one phase: each row uses its OWN table header (nearest preceding)', () => {
    // 4-col table then a 3-col table, both under Phase A. The second row must not
    // inherit the first table's layout.
    const mixed = `# R

## Phase A

| # | Feature | Item | Status |
|---|---------|------|--------|
| — | — | Four col row | COMPLETE |

Some prose breaks the table.

| # | Item | Status |
|---|------|--------|
| — | Three col row | PARTIAL |
`;
    const rows = collectAnonRowsFromText(mixed);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].title, 'Four col row');
    assert.equal(rows[0].status, 'COMPLETE');
    assert.equal(rows[1].title, 'Three col row');   // would be 'PARTIAL' if it reused the 4-col layout
    assert.equal(rows[1].status, 'PARTIAL');
  });
});

describe('stripAnonLine — phase-scoped, occurrence-specific', () => {
  test('removes only the chosen occurrence when row text repeats', () => {
    const out = stripAnonLine(ROADMAP_DUP, 'Phase A', 1);
    const count = out.split('\n').filter(l => l.trim() === '| — | Repeated thing | COMPLETE |').length;
    assert.equal(count, 1, 'one of the two identical rows remains');
  });

  test('removing occurrence 0 leaves occurrence 1', () => {
    const out = stripAnonLine(ROADMAP_DUP, 'Phase A', 0);
    assert.equal(out.split('\n').filter(l => l.trim() === '| — | Repeated thing | COMPLETE |').length, 1);
  });
});

describe('promoteAnonRow — the spec-correction guard', () => {
  test('scaffolds feature.json and replaces the anon row with NO duplicate', async () => {
    const cwd = freshCwd(ROADMAP_3COL);
    const rows = collectAnonRowsFromText(ROADMAP_3COL);
    const target = rows.find(r => r.title === 'First historical thing');

    await promoteAnonRow(cwd, target, { code: 'HIST-1', status: 'COMPLETE' });

    const feat = readFeature(cwd, 'HIST-1');
    assert.ok(feat, 'feature.json created');
    assert.equal(feat.phase, 'Phase A');
    assert.equal(feat.status, 'COMPLETE');
    assert.equal(feat.description, 'First historical thing');

    const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /HIST-1/, 'typed row rendered');
    // The promoted row must NOT also survive as an anonymous `—` row.
    assert.equal(
      roadmap.split('\n').filter(l => l.includes('First historical thing')).length,
      1,
      'no anonymous duplicate of the promoted row',
    );
    assert.match(roadmap, /Second historical thing/, 'sibling anon row preserved');
  });
});

describe('promoteAnonRow — transaction safety (error-code branching)', () => {
  test('pre-commit failure restores the stripped anon row', async () => {
    const cwd = freshCwd(ROADMAP_3COL);
    const rows = collectAnonRowsFromText(ROADMAP_3COL);
    const target = rows.find(r => r.title === 'First historical thing');
    // Inject a scaffold that fails BEFORE committing feature.json.
    const failScaffold = async () => { const e = new Error('boom'); e.code = 'ROUNDTRIP_NOT_FIXED_POINT'; throw e; };
    await assert.rejects(
      () => promoteAnonRow(cwd, target, { code: 'HIST-1', status: 'COMPLETE', scaffold: failScaffold }),
      /boom/,
    );
    const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /First historical thing/, 'anon row restored after pre-commit failure');
  });

  test('ROADMAP_PARTIAL_WRITE does NOT restore (feature committed; avoids duplicate)', async () => {
    const cwd = freshCwd(ROADMAP_3COL);
    const rows = collectAnonRowsFromText(ROADMAP_3COL);
    const target = rows.find(r => r.title === 'First historical thing');
    // Faithful stub: addRoadmapEntry commits feature.json BEFORE regen, so a
    // partial-write means the typed replacement DOES exist on disk.
    const partialScaffold = async (c, a) => {
      writeFeature(c, { code: a.code, description: a.description, status: a.status, phase: a.phase }, 'docs/features', { validate: false });
      const e = new Error('regen failed'); e.code = 'ROADMAP_PARTIAL_WRITE'; throw e;
    };
    await assert.rejects(
      () => promoteAnonRow(cwd, target, { code: 'HIST-1', status: 'COMPLETE', scaffold: partialScaffold }),
      /regen failed/,
    );
    const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    assert.doesNotMatch(roadmap, /First historical thing/, 'stripped row NOT restored on partial-write');
    assert.ok(readFeature(cwd, 'HIST-1'), 'typed replacement is committed (not left without a replacement)');
  });
});

describe('runMigrateAnon — interactive + guards', () => {
  function driveIO(lines) {
    const input = new PassThrough();
    const output = new PassThrough();
    let buf = '';
    output.on('data', (c) => { buf += c.toString(); });
    let i = 0;
    const pump = () => {
      if (i < lines.length) { input.write(lines[i++] + '\n'); setTimeout(pump, 15); }
    };
    setTimeout(pump, 15);
    return { input, output, getOutput: () => buf };
  }

  test('non-interactive lists rows and writes nothing', async () => {
    const cwd = freshCwd(ROADMAP_3COL);
    const before = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    const res = await runMigrateAnon(cwd, { nonInteractive: true });
    assert.ok(res.listed >= 5, 'all anon rows listed');
    assert.equal(res.promoted.length, 0);
    assert.equal(readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8'), before, 'no writes');
  });

  test('no anonymous rows → clean message, no error', async () => {
    const cwd = freshCwd('# Empty\n\n## Phase A\n\nNothing here.\n');
    const res = await runMigrateAnon(cwd, { nonInteractive: true });
    assert.equal(res.listed, 0);
  });

  test('interactive: promote one, skip one', async () => {
    const cwd = freshCwd(ROADMAP_3COL);
    // Walk: row 1 → assign HIST-1, confirm status; row 2 → skip; (Phase B rows) skip x3.
    const { input, output } = driveIO(['HIST-1', '', '', '', '', '']);
    const res = await runMigrateAnon(cwd, { input, output });
    assert.equal(res.promoted.length, 1);
    assert.equal(res.promoted[0], 'HIST-1');
    const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /HIST-1/);
    assert.equal(roadmap.split('\n').filter(l => l.includes('First historical thing')).length, 1);
    assert.match(roadmap, /Second historical thing/, 'skipped row round-trips verbatim');
  });

  test('interactive: two promotions in the SAME phase (occurrenceIndex drift handled)', async () => {
    const cwd = freshCwd(ROADMAP_3COL);
    // Promote BOTH Phase A rows: HIST-1 (occ 0), HIST-2 (occ 1). After the first
    // strip, the second row's live index shifts 1→0; liveIndex must compensate.
    const { input, output } = driveIO(['HIST-1', '', 'HIST-2', '', '', '', '']);
    const res = await runMigrateAnon(cwd, { input, output });
    assert.deepEqual(res.promoted, ['HIST-1', 'HIST-2']);
    assert.ok(readFeature(cwd, 'HIST-1') && readFeature(cwd, 'HIST-2'), 'both committed');
    const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    assert.equal(roadmap.split('\n').filter(l => l.includes('First historical thing')).length, 1);
    assert.equal(roadmap.split('\n').filter(l => l.includes('Second historical thing')).length, 1);
    // Neither survives as an anonymous `—` row.
    assert.doesNotMatch(roadmap, /\|\s*—\s*\| First historical thing/);
    assert.doesNotMatch(roadmap, /\|\s*—\s*\| Second historical thing/);
  });

  test('interactive: abort (q) writes nothing', async () => {
    const cwd = freshCwd(ROADMAP_3COL);
    const before = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    const { input, output } = driveIO(['q']);
    const res = await runMigrateAnon(cwd, { input, output });
    assert.equal(res.promoted.length, 0);
    assert.equal(res.aborted, true);
    assert.equal(readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8'), before);
  });

  test('interactive: invalid code is rejected then re-prompted', async () => {
    const cwd = freshCwd(ROADMAP_3COL);
    // row 1: bad code '123' (leading digit) → re-prompt → valid HIST-9 → status enter; rest skip.
    const { input, output } = driveIO(['123', 'HIST-9', '', '', '', '', '']);
    const res = await runMigrateAnon(cwd, { input, output });
    assert.deepEqual(res.promoted, ['HIST-9']);
  });
});
