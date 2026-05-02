/**
 * changelog-writer.test.js — coverage for lib/changelog-writer.js
 * (COMP-MCP-CHANGELOG-WRITER T1–T3).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  addChangelogEntry,
  getChangelogEntries,
  parseChangelog,
  renderEntry,
} from '../lib/changelog-writer.js';
import { readEvents } from '../lib/feature-events.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'changelog-writer-'));
  return cwd;
}

function seedChangelog(cwd, content) {
  writeFileSync(join(cwd, 'CHANGELOG.md'), content);
}

function readChangelog(cwd) {
  return readFileSync(join(cwd, 'CHANGELOG.md'), 'utf-8');
}

// ---------------------------------------------------------------------------
// parseChangelog
// ---------------------------------------------------------------------------

describe('parseChangelog', () => {
  test('#1 empty file returns null h1, no surfaces', () => {
    const r = parseChangelog('');
    assert.equal(r.h1, null);
    assert.deepEqual(r.surfaces, []);
  });

  test('#2 H1 only', () => {
    const r = parseChangelog('# Changelog\n');
    assert.equal(r.h1, 'Changelog');
    assert.deepEqual(r.surfaces, []);
  });

  test('#3 single date surface, single entry, all four canonical sections', () => {
    const text = [
      '# Changelog',
      '',
      '## 2026-05-02',
      '',
      '### FOO-1 — adds the foo',
      '',
      'Body paragraph.',
      '',
      '**Added:**',
      '- a',
      '- b',
      '',
      '**Changed:**',
      '- c',
      '',
      '**Fixed:**',
      '- d',
      '',
      '**Snapshot:**',
      '- e',
      '',
    ].join('\n');
    const r = parseChangelog(text);
    assert.equal(r.h1, 'Changelog');
    assert.equal(r.surfaces.length, 1);
    const s = r.surfaces[0];
    assert.equal(s.kind, 'date');
    assert.equal(s.label, '2026-05-02');
    assert.equal(s.entries.length, 1);
    const e = s.entries[0];
    assert.equal(e.code, 'FOO-1');
    assert.equal(e.summary, 'adds the foo');
    assert.match(e.body, /Body paragraph\./);
    assert.deepEqual(e.sections.added, ['a', 'b']);
    assert.deepEqual(e.sections.changed, ['c']);
    assert.deepEqual(e.sections.fixed, ['d']);
    assert.deepEqual(e.sections.snapshot, ['e']);
  });

  test('#4 version surface', () => {
    const text = '# Changelog\n\n## v0.1.4\n\n### FOO-1 — release\n\nBody.\n';
    const r = parseChangelog(text);
    assert.equal(r.surfaces.length, 1);
    assert.equal(r.surfaces[0].kind, 'version');
    assert.equal(r.surfaces[0].label, 'v0.1.4');
  });

  test('#5 unknown labels preserved in unknownLabels', () => {
    const text = [
      '# Changelog',
      '',
      '## 2026-05-02',
      '',
      '### FOO-1 — x',
      '',
      '**Hardened:**',
      '- h1',
      '- h2',
      '',
      '**Knobs:**',
      '- k1',
      '',
    ].join('\n');
    const r = parseChangelog(text);
    const e = r.surfaces[0].entries[0];
    assert.deepEqual(e.unknownLabels.Hardened, ['h1', 'h2']);
    assert.deepEqual(e.unknownLabels.Knobs, ['k1']);
    assert.deepEqual(e.sections.added, []);
  });

  test('#6 body without subsections', () => {
    const text = '# Changelog\n\n## 2026-05-02\n\n### FOO-1 — x\n\nJust prose.\n\nMore prose.\n';
    const r = parseChangelog(text);
    const e = r.surfaces[0].entries[0];
    assert.match(e.body, /Just prose/);
    assert.match(e.body, /More prose/);
    assert.deepEqual(e.sections.added, []);
  });

  test('#7 round-trip on real compose/CHANGELOG.md', () => {
    const real = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
    const r = parseChangelog(real);
    assert.equal(r.h1, 'Changelog');
    assert.ok(r.surfaces.length >= 5, `expected >=5 surfaces, got ${r.surfaces.length}`);
    // Real file has duplicate ## 2026-05-02 surfaces — both must be present.
    const dups = r.surfaces.filter(s => s.label === '2026-05-02');
    assert.ok(dups.length >= 2, `expected duplicate 2026-05-02 surfaces, got ${dups.length}`);
  });

  test('#28 parser preserves duplicate same-label surfaces as separate entries', () => {
    const text = [
      '# Changelog', '',
      '## 2026-05-02', '',
      '### FOO-1 — first', '',
      '## 2026-05-02', '',
      '### FOO-2 — second', '',
    ].join('\n');
    const r = parseChangelog(text);
    assert.equal(r.surfaces.length, 2);
    assert.equal(r.surfaces[0].entries[0].code, 'FOO-1');
    assert.equal(r.surfaces[1].entries[0].code, 'FOO-2');
  });
});

// ---------------------------------------------------------------------------
// renderEntry
// ---------------------------------------------------------------------------

describe('renderEntry', () => {
  test('#8 minimal — header + summary, no body, no sections', () => {
    const out = renderEntry({ code: 'FOO-1', summary: 'adds foo' });
    assert.match(out, /^### FOO-1 — adds foo$/m);
    assert.doesNotMatch(out, /\*\*Added/);
  });

  test('#9 full — all four sections in fixed order', () => {
    const out = renderEntry({
      code: 'FOO-1',
      summary: 's',
      body: 'B',
      sections: { added: ['a'], changed: ['c'], fixed: ['f'], snapshot: ['s1'] },
    });
    const idxAdded = out.indexOf('**Added:**');
    const idxChanged = out.indexOf('**Changed:**');
    const idxFixed = out.indexOf('**Fixed:**');
    const idxSnap = out.indexOf('**Snapshot:**');
    assert.ok(idxAdded < idxChanged && idxChanged < idxFixed && idxFixed < idxSnap,
      `subsection order broken: ${idxAdded},${idxChanged},${idxFixed},${idxSnap}`);
  });

  test('#10 empty section dropped', () => {
    const out = renderEntry({
      code: 'FOO-1', summary: 's',
      sections: { added: ['a'], fixed: [] },
    });
    assert.match(out, /\*\*Added:\*\*/);
    assert.doesNotMatch(out, /\*\*Fixed:\*\*/);
  });
});

// ---------------------------------------------------------------------------
// addChangelogEntry
// ---------------------------------------------------------------------------

describe('addChangelogEntry', () => {
  test('#11 new file — creates H1, surface, entry', async () => {
    const cwd = freshCwd();
    const r = await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02',
      code: 'FOO-1',
      summary: 'adds foo',
    });
    assert.equal(r.idempotent, false);
    assert.equal(r.surface, '2026-05-02');
    assert.equal(typeof r.inserted_at, 'number');
    const text = readChangelog(cwd);
    assert.match(text, /^# Changelog/m);
    assert.match(text, /## 2026-05-02/);
    assert.match(text, /### FOO-1 — adds foo/);
  });

  test('#12 append to existing surface — prior entries untouched', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, '# Changelog\n\n## 2026-05-02\n\n### FOO-1 — first\n\nBody.\n');
    await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02',
      code: 'FOO-2',
      summary: 'second',
    });
    const text = readChangelog(cwd);
    assert.match(text, /### FOO-1 — first/);
    assert.match(text, /### FOO-2 — second/);
    // Order: FOO-1 before FOO-2
    assert.ok(text.indexOf('FOO-1') < text.indexOf('FOO-2'));
  });

  test('#13 new surface inserted at top after H1', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, '# Changelog\n\n## 2026-04-01\n\n### OLD-1 — old\n');
    await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02',
      code: 'NEW-1',
      summary: 'new',
    });
    const text = readChangelog(cwd);
    const newIdx = text.indexOf('## 2026-05-02');
    const oldIdx = text.indexOf('## 2026-04-01');
    assert.ok(newIdx > 0 && newIdx < oldIdx, 'new surface should land above old');
  });

  test('#14 duplicate code, no force — idempotent no-op', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, '# Changelog\n\n## 2026-05-02\n\n### FOO-1 — first\n\nBody one.\n');
    const before = readChangelog(cwd);
    const r = await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02',
      code: 'FOO-1',
      summary: 'different summary',
    });
    assert.equal(r.idempotent, true);
    assert.equal(readChangelog(cwd), before);
  });

  test('#15 duplicate code with force — replaces in place', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, '# Changelog\n\n## 2026-05-02\n\n### FOO-1 — first\n\nOld body.\n');
    const r = await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02',
      code: 'FOO-1',
      summary: 'updated',
      body: 'New body.',
      force: true,
    });
    assert.equal(r.idempotent, false);
    const text = readChangelog(cwd);
    assert.match(text, /### FOO-1 — updated/);
    assert.match(text, /New body\./);
    assert.doesNotMatch(text, /Old body/);
    assert.doesNotMatch(text, /### FOO-1 — first/);
  });

  test('#16 invalid code — throws', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addChangelogEntry(cwd, { date_or_version: '2026-05-02', code: 'lowercase', summary: 's' }),
      /invalid feature code/i,
    );
  });

  test('#17 invalid date_or_version — throws', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addChangelogEntry(cwd, { date_or_version: '5/2/26', code: 'FOO-1', summary: 's' }),
      /date_or_version/i,
    );
  });

  test('#18 invalid section key — throws', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addChangelogEntry(cwd, {
        date_or_version: '2026-05-02', code: 'FOO-1', summary: 's',
        sections: { bogus: ['x'] },
      }),
      /sections/i,
    );
  });

  test('#19 H1 missing on non-empty file — throws CHANGELOG_FORMAT', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, 'Some text\nNo H1 here\n');
    await assert.rejects(
      () => addChangelogEntry(cwd, { date_or_version: '2026-05-02', code: 'FOO-1', summary: 's' }),
      err => err.code === 'CHANGELOG_FORMAT',
    );
  });

  test('#20 atomic write — tmp file does not linger after success', async () => {
    const cwd = freshCwd();
    await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 's',
    });
    const files = readdirSync(cwd);
    assert.ok(!files.some(f => f.endsWith('.tmp')), `unexpected tmp file: ${files.join(',')}`);
  });

  test('#21 emits audit event with tool: add_changelog_entry', async () => {
    const cwd = freshCwd();
    await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 's',
    });
    const events = readEvents(cwd, { tool: 'add_changelog_entry' });
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'FOO-1');
    assert.equal(events[0].surface_label, '2026-05-02');
    assert.equal(typeof events[0].surface_start_line, 'number');
  });

  test('#22 audit failure does not throw — returns success', async () => {
    const cwd = freshCwd();
    // Make .compose/data path be a regular file so mkdir fails.
    const dataParent = join(cwd, '.compose');
    mkdirSync(dataParent, { recursive: true });
    writeFileSync(join(dataParent, 'data'), 'block');
    // Should still succeed.
    const r = await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 's',
    });
    assert.equal(r.idempotent, false);
    assert.match(readChangelog(cwd), /### FOO-1 — s/);
  });

  test('#23 caller-supplied idempotency_key replays cached result', async () => {
    const cwd = freshCwd();
    const r1 = await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 's',
      idempotency_key: 'k-1',
    });
    const r2 = await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 's',
      idempotency_key: 'k-1',
    });
    assert.deepEqual(r1, r2);
    // File only has one entry.
    const text = readChangelog(cwd);
    const matches = text.match(/### FOO-1 — /g) || [];
    assert.equal(matches.length, 1);
  });

  test('#29 dedup hits second of duplicate same-label surfaces', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, [
      '# Changelog', '',
      '## 2026-05-02', '',
      '### OTHER-1 — x', '',
      '## 2026-05-02', '',
      '### FOO-1 — already here', '',
    ].join('\n'));
    const r = await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 'different',
    });
    assert.equal(r.idempotent, true);
    const text = readChangelog(cwd);
    assert.match(text, /### FOO-1 — already here/);
    assert.doesNotMatch(text, /### FOO-1 — different/);
    // Only one FOO-1 entry total.
    const matches = text.match(/### FOO-1 —/g) || [];
    assert.equal(matches.length, 1);
  });

  test('#30 force replace targets first surface; second untouched', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, [
      '# Changelog', '',
      '## 2026-05-02', '',
      '### FOO-1 — first surface entry', '',
      '## 2026-05-02', '',
      '### OTHER-1 — keepme', '',
    ].join('\n'));
    await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 'replaced',
      force: true,
    });
    const text = readChangelog(cwd);
    assert.match(text, /### FOO-1 — replaced/);
    assert.doesNotMatch(text, /first surface entry/);
    assert.match(text, /### OTHER-1 — keepme/);
  });

  test('#31 new entry lands in first (topmost) matching surface', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, [
      '# Changelog', '',
      '## 2026-05-02', '',
      '### A — top', '',
      '## 2026-05-02', '',
      '### B — bottom', '',
    ].join('\n'));
    await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'NEW-1', summary: 'new',
    });
    const text = readChangelog(cwd);
    // NEW-1 should appear after A but before the second ## 2026-05-02 surface.
    const idxA = text.indexOf('### A — top');
    const idxNew = text.indexOf('### NEW-1 — new');
    const idxSecondSurface = text.indexOf('## 2026-05-02', idxA + 1);
    const idxB = text.indexOf('### B — bottom');
    assert.ok(idxA < idxNew && idxNew < idxSecondSurface, 'NEW-1 must land in first surface');
    assert.ok(idxSecondSurface < idxB);
  });

  test('#34 same code on different surfaces — replace returns correct line for chosen surface', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, [
      '# Changelog', '',
      '## 2026-05-02', '',
      '### FOO-1 — newer date', '',
      '## 2026-04-01', '',
      '### FOO-1 — older date', '',
    ].join('\n'));
    const r = await addChangelogEntry(cwd, {
      date_or_version: '2026-04-01',
      code: 'FOO-1',
      summary: 'replaced older',
      force: true,
    });
    // inserted_at must point at the replaced entry under 2026-04-01, NOT under 2026-05-02.
    const text = readChangelog(cwd);
    const lines = text.split('\n');
    const insertedLine = lines[r.inserted_at - 1];
    assert.match(insertedLine, /### FOO-1 — replaced older/);
    assert.equal(r.surface, '2026-04-01');
    // Older-surface header just above must be ## 2026-04-01.
    let surfaceLine = -1;
    for (let i = r.inserted_at - 2; i >= 0; i--) {
      if (lines[i].startsWith('## ')) { surfaceLine = i; break; }
    }
    assert.equal(lines[surfaceLine], '## 2026-04-01');
  });

  test('#35 idempotent no-op does not write audit event', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, '# Changelog\n\n## 2026-05-02\n\n### FOO-1 — first\n');
    const before = existsSync(join(cwd, '.compose', 'data', 'feature-events.jsonl'));
    const r = await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 'second attempt',
    });
    assert.equal(r.idempotent, true);
    const events = readEvents(cwd);
    assert.equal(events.length, 0, 'no-op should not append audit row');
    // File flag preserved
    assert.equal(existsSync(join(cwd, '.compose', 'data', 'feature-events.jsonl')), before);
  });

  test('#36 validation throws err.code = INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addChangelogEntry(cwd, { date_or_version: '2026-05-02', code: 'lc', summary: 's' }),
      err => err.code === 'INVALID_INPUT',
    );
  });

  test('#37 H1-missing throws err.code = CHANGELOG_FORMAT', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, 'no heading here\n');
    await assert.rejects(
      () => addChangelogEntry(cwd, { date_or_version: '2026-05-02', code: 'FOO-1', summary: 's' }),
      err => err.code === 'CHANGELOG_FORMAT',
    );
  });

  test('#33 audit row fields', async () => {
    const cwd = freshCwd();
    await addChangelogEntry(cwd, {
      date_or_version: '2026-05-02', code: 'FOO-1', summary: 's',
      idempotency_key: 'k-aud',
    });
    const events = readEvents(cwd, { tool: 'add_changelog_entry' });
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.tool, 'add_changelog_entry');
    assert.equal(e.code, 'FOO-1');
    assert.equal(e.surface_label, '2026-05-02');
    assert.equal(typeof e.surface_start_line, 'number');
    assert.equal(e.idempotency_key, 'k-aud');
  });
});

// ---------------------------------------------------------------------------
// getChangelogEntries
// ---------------------------------------------------------------------------

describe('getChangelogEntries', () => {
  test('#24 no filters — returns all in file order (newest-first)', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, [
      '# Changelog', '',
      '## 2026-05-02', '', '### BB-2 — newer', '',
      '## 2026-04-01', '', '### AA-1 — older', '',
    ].join('\n'));
    const r = getChangelogEntries(cwd);
    assert.equal(r.count, 2);
    assert.equal(r.entries[0].code, 'BB-2');
    assert.equal(r.entries[1].code, 'AA-1');
  });

  test('#25 code filter', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, [
      '# Changelog', '',
      '## 2026-05-02', '', '### AA-1 — x', '', '### BB-2 — y', '',
    ].join('\n'));
    const r = getChangelogEntries(cwd, { code: 'BB-2' });
    assert.equal(r.count, 1);
    assert.equal(r.entries[0].code, 'BB-2');
  });

  test('#26 since shorthand 7d filters out older date surfaces', async () => {
    const cwd = freshCwd();
    const today = new Date().toISOString().slice(0, 10);
    const longAgo = '2020-01-01';
    seedChangelog(cwd, [
      '# Changelog', '',
      `## ${today}`, '', '### NEW-1 — n', '',
      `## ${longAgo}`, '', '### OLD-1 — o', '',
    ].join('\n'));
    const r = getChangelogEntries(cwd, { since: '7d' });
    assert.equal(r.count, 1);
    assert.equal(r.entries[0].code, 'NEW-1');
  });

  test('#27 limit respects max', async () => {
    const cwd = freshCwd();
    const lines = ['# Changelog', '', '## 2026-05-02', ''];
    for (let i = 1; i <= 10; i++) lines.push(`### F-${i} — s`, '');
    seedChangelog(cwd, lines.join('\n'));
    const r = getChangelogEntries(cwd, { limit: 3 });
    assert.equal(r.count, 3);
  });

  test('#38 reader surfaces unknownLabels and tolerates digit-bearing label like Phase 7 review-loop fixes', async () => {
    const cwd = freshCwd();
    seedChangelog(cwd, [
      '# Changelog', '',
      '## 2026-05-02', '',
      '### FOO-1 — x', '',
      '**New tools:**', '- t1', '',
      '**Phase 7 review-loop fixes:**', '- f1', '- f2', '',
    ].join('\n'));
    const r = getChangelogEntries(cwd, { code: 'FOO-1' });
    assert.equal(r.count, 1);
    const e = r.entries[0];
    assert.deepEqual(e.unknownLabels['New tools'], ['t1']);
    assert.deepEqual(e.unknownLabels['Phase 7 review-loop fixes'], ['f1', 'f2']);
  });

  test('#32 since: date surfaces filtered, version surfaces always pass through', async () => {
    const cwd = freshCwd();
    const today = new Date().toISOString().slice(0, 10);
    seedChangelog(cwd, [
      '# Changelog', '',
      '## v0.1.4', '', '### REL-1 — release', '',
      `## ${today}`, '', '### NEW-1 — n', '',
      '## 2020-01-01', '', '### OLD-1 — o', '',
    ].join('\n'));
    const r = getChangelogEntries(cwd, { since: '7d' });
    const codes = r.entries.map(e => e.code);
    assert.ok(codes.includes('REL-1'), 'version surface should pass through');
    assert.ok(codes.includes('NEW-1'), 'recent date surface should pass');
    assert.ok(!codes.includes('OLD-1'), 'old date surface should drop');
  });
});
