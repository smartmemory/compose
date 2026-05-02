/**
 * Unit tests for COMP-PLAN-SECTIONS-REPORT:
 *   - analyzeRollup (read-only analyzer)
 *   - renderRollupBlock (pure markdown renderer)
 *   - writeRollup (atomic same-directory writer)
 *
 * See docs/features/COMP-PLAN-SECTIONS-REPORT/{design,blueprint,plan}.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeRollup,
  renderRollupBlock,
  writeRollup,
} from '../lib/sections.js';

function tmpDir(prefix = 'sections-rollup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSection(sectionsDir, filename, { title, files = [] } = {}) {
  fs.mkdirSync(sectionsDir, { recursive: true });
  const filesLine = files.length ? files.join(', ') : '—';
  const body = [
    `# Section ${title}`,
    ``,
    `**Task ID:** T1`,
    `**Depends on:** —`,
    `**Files:** ${filesLine}`,
    ``,
    `## Plan`,
    ``,
    `Body.`,
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(sectionsDir, filename), body);
}

// ---------- T1: analyzeRollup ----------

test('analyzeRollup: missing dir → null', () => {
  const dir = tmpDir();
  const res = analyzeRollup({ sectionsDir: path.join(dir, 'nope'), filesChanged: [] });
  assert.equal(res, null);
});

test('analyzeRollup: empty dir → null', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sections'));
  const res = analyzeRollup({ sectionsDir: path.join(dir, 'sections'), filesChanged: [] });
  assert.equal(res, null);
});

test('analyzeRollup: 3-section all-changed fixture → sectionsWithChanges === 3', () => {
  const dir = tmpDir();
  const sectionsDir = path.join(dir, 'sections');
  writeSection(sectionsDir, 'section-01-alpha.md', { title: '01 — Alpha', files: ['a.js'] });
  writeSection(sectionsDir, 'section-02-beta.md', { title: '02 — Beta', files: ['b.js'] });
  writeSection(sectionsDir, 'section-03-gamma.md', { title: '03 — Gamma', files: ['c.js'] });
  const res = analyzeRollup({ sectionsDir, filesChanged: ['a.js', 'b.js', 'c.js'] });
  assert.equal(res.sectionCount, 3);
  assert.equal(res.sectionsWithChanges, 3);
  assert.equal(res.sectionsAllUnchanged, 0);
  assert.deepEqual(res.unattributed, []);
  assert.equal(res.sections[0].title, 'Alpha');
  assert.deepEqual(res.sections[0].changed, ['a.js']);
  assert.deepEqual(res.sections[0].missing, []);
});

test('analyzeRollup: 1-section declared-but-unchanged → sectionsAllUnchanged === 1', () => {
  const dir = tmpDir();
  const sectionsDir = path.join(dir, 'sections');
  writeSection(sectionsDir, 'section-01-alpha.md', { title: '01 — Alpha', files: ['a.js'] });
  const res = analyzeRollup({ sectionsDir, filesChanged: [] });
  assert.equal(res.sectionCount, 1);
  assert.equal(res.sectionsWithChanges, 0);
  assert.equal(res.sectionsAllUnchanged, 1);
  assert.deepEqual(res.sections[0].missing, ['a.js']);
});

test('analyzeRollup: unattributed file in filesChanged → appears in unattributed', () => {
  const dir = tmpDir();
  const sectionsDir = path.join(dir, 'sections');
  writeSection(sectionsDir, 'section-01-alpha.md', { title: '01 — Alpha', files: ['a.js'] });
  writeSection(sectionsDir, 'section-02-beta.md', { title: '02 — Beta', files: ['b.js'] });
  const res = analyzeRollup({ sectionsDir, filesChanged: ['a.js', 'b.js', 'extra.js'] });
  assert.deepEqual(res.unattributed, ['extra.js']);
});

test('analyzeRollup: H1 fallback to slug when malformed', () => {
  const dir = tmpDir();
  const sectionsDir = path.join(dir, 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sectionsDir, 'section-01-fallback-here.md'),
    `**Files:** a.js\n`,
  );
  const res = analyzeRollup({ sectionsDir, filesChanged: ['a.js'] });
  assert.equal(res.sections[0].title, 'fallback-here');
});

// ---------- T2: renderRollupBlock ----------

test('renderRollupBlock: empty analysis → header line shows zeros, no index entries', () => {
  const analysis = {
    sections: [],
    unattributed: [],
    sectionCount: 0,
    sectionsWithChanges: 0,
    sectionsAllUnchanged: 0,
  };
  const out = renderRollupBlock({ analysis, commit: 'abc1234deadbeef', date: '2026-05-02' });
  assert.match(out, /^## Section Roll-up\b/m);
  assert.match(out, /Sections:\*\* 0 total — 0 with changes \/ 0 with no declared changes/);
  assert.ok(out.endsWith('\n'));
});

test('renderRollupBlock: short SHA derivation = commit.slice(0,7)', () => {
  const analysis = {
    sections: [], unattributed: [], sectionCount: 0,
    sectionsWithChanges: 0, sectionsAllUnchanged: 0,
  };
  const out = renderRollupBlock({ analysis, commit: 'abcdef1234567890', date: '2026-05-02' });
  assert.match(out, /\*\*Commit:\*\* `abcdef1`/);
});

test('renderRollupBlock: null/empty commit → (commit unavailable)', () => {
  const analysis = {
    sections: [], unattributed: [], sectionCount: 0,
    sectionsWithChanges: 0, sectionsAllUnchanged: 0,
  };
  const out1 = renderRollupBlock({ analysis, commit: null, date: '2026-05-02' });
  const out2 = renderRollupBlock({ analysis, commit: '', date: '2026-05-02' });
  assert.match(out1, /\(commit unavailable\)/);
  assert.match(out2, /\(commit unavailable\)/);
});

test('renderRollupBlock: stable date when arg passed', () => {
  const analysis = {
    sections: [], unattributed: [], sectionCount: 0,
    sectionsWithChanges: 0, sectionsAllUnchanged: 0,
  };
  const out = renderRollupBlock({ analysis, commit: 'abc1234', date: '2026-05-02' });
  assert.match(out, /\*\*Date:\*\* 2026-05-02/);
});

test('renderRollupBlock: missing date defaults to today', () => {
  const analysis = {
    sections: [], unattributed: [], sectionCount: 0,
    sectionsWithChanges: 0, sectionsAllUnchanged: 0,
  };
  const out = renderRollupBlock({ analysis, commit: 'abc1234' });
  assert.match(out, /\*\*Date:\*\* \d{4}-\d{2}-\d{2}/);
});

test('renderRollupBlock: None vs list rendering for unattributed', () => {
  const baseAnalysis = {
    sections: [], unattributed: [], sectionCount: 0,
    sectionsWithChanges: 0, sectionsAllUnchanged: 0,
  };
  const noneOut = renderRollupBlock({ analysis: baseAnalysis, commit: 'abc1234', date: '2026-05-02' });
  assert.match(noneOut, /### Unattributed files this commit\n\nNone\b/);
  const listOut = renderRollupBlock({
    analysis: { ...baseAnalysis, unattributed: ['x.js', 'y.js'] },
    commit: 'abc1234', date: '2026-05-02',
  });
  assert.match(listOut, /- `x\.js`/);
  assert.match(listOut, /- `y\.js`/);
});

test('renderRollupBlock: index entry format with sections', () => {
  const analysis = {
    sections: [
      { filename: 'section-01-alpha.md', title: 'Alpha', declared: ['a.js', 'b.js'], changed: ['a.js'], missing: ['b.js'] },
    ],
    unattributed: [],
    sectionCount: 1,
    sectionsWithChanges: 0,
    sectionsAllUnchanged: 0,
  };
  const out = renderRollupBlock({ analysis, commit: 'abc1234', date: '2026-05-02' });
  assert.match(out, /- \[Section 01 — Alpha\]\(sections\/section-01-alpha\.md\) — `1\/2` files changed/);
});

test('renderRollupBlock: deviations summary three lines', () => {
  const analysis = {
    sections: [],
    unattributed: ['x.js'],
    sectionCount: 2,
    sectionsWithChanges: 1,
    sectionsAllUnchanged: 0,
  };
  const out = renderRollupBlock({ analysis, commit: 'abc1234', date: '2026-05-02' });
  assert.match(out, /Sections with all declared files changed:\*\* 1/);
  assert.match(out, /Sections with declared files that did NOT change:\*\* 0/);
  assert.match(out, /Files changed but undeclared:\*\* 1/);
});

// ---------- T3: writeRollup ----------

test('writeRollup: null analysis → returns null, no file written', () => {
  const dir = tmpDir();
  const res = writeRollup({ featureDir: dir, analysis: null, commit: 'abc', date: '2026-05-02' });
  assert.equal(res, null);
  assert.equal(fs.existsSync(path.join(dir, 'report.md')), false);
});

test('writeRollup: sectionCount 0 → returns null, no file written', () => {
  const dir = tmpDir();
  const analysis = { sections: [], unattributed: [], sectionCount: 0, sectionsWithChanges: 0, sectionsAllUnchanged: 0 };
  const res = writeRollup({ featureDir: dir, analysis, commit: 'abc', date: '2026-05-02' });
  assert.equal(res, null);
  assert.equal(fs.existsSync(path.join(dir, 'report.md')), false);
});

function fixtureAnalysis() {
  return {
    sections: [
      { filename: 'section-01-alpha.md', title: 'Alpha', declared: ['a.js'], changed: ['a.js'], missing: [] },
    ],
    unattributed: [],
    sectionCount: 1,
    sectionsWithChanges: 1,
    sectionsAllUnchanged: 0,
  };
}

test('writeRollup: missing report.md → creates with only the block', () => {
  const dir = tmpDir();
  const res = writeRollup({ featureDir: dir, analysis: fixtureAnalysis(), commit: 'abc1234', date: '2026-05-02' });
  assert.deepEqual(res, { written: true, path: path.join(dir, 'report.md') });
  const content = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(content, /^## Section Roll-up\b/m);
  assert.equal(fs.existsSync(path.join(dir, 'report.md.tmp')), false);
});

test('writeRollup: existing narrative (no roll-up) → appends block after narrative', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'report.md'), '# Report\n\nNarrative here.\n');
  writeRollup({ featureDir: dir, analysis: fixtureAnalysis(), commit: 'abc1234', date: '2026-05-02' });
  const content = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(content, /^# Report\n\nNarrative here\.\n/);
  assert.match(content, /## Section Roll-up\b/);
});

test('writeRollup: existing roll-up at EOF → replaces block', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'report.md'),
    '# Report\n\n## Section Roll-up\n\n**Commit:** `oldsha1`\n**Date:** 2026-04-01\n**Sections:** 0 total — 0 with changes / 0 with no declared changes\n\n### Index\n\n### Unattributed files this commit\n\nNone\n\n### Deviations summary\n\n- old\n',
  );
  writeRollup({ featureDir: dir, analysis: fixtureAnalysis(), commit: 'newsha1234567', date: '2026-05-02' });
  const content = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.equal((content.match(/^## Section Roll-up\b/gm) || []).length, 1);
  assert.match(content, /newsha1/);
  assert.doesNotMatch(content, /oldsha1/);
  assert.match(content, /^# Report\n/);
});

test('writeRollup: roll-up followed by another ## heading → only block replaced', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'report.md'),
    '# Report\n\n## Section Roll-up\n\nold content\n\n## Notes\n\nKeep me.\n',
  );
  writeRollup({ featureDir: dir, analysis: fixtureAnalysis(), commit: 'newsha1234567', date: '2026-05-02' });
  const content = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(content, /## Notes\n\nKeep me\./);
  assert.doesNotMatch(content, /old content/);
  assert.equal((content.match(/^## Section Roll-up\b/gm) || []).length, 1);
});

test('writeRollup: after success, report.md.tmp does not exist (atomic cleanup)', () => {
  const dir = tmpDir();
  writeRollup({ featureDir: dir, analysis: fixtureAnalysis(), commit: 'abc1234', date: '2026-05-02' });
  assert.equal(fs.existsSync(path.join(dir, 'report.md.tmp')), false);
});
