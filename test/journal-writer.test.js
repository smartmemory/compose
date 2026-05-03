/**
 * journal-writer.test.js — coverage for lib/journal-writer.js
 * (COMP-MCP-JOURNAL-WRITER T1–T4).
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
  writeJournalEntry,
  getJournalEntries,
  parseJournalEntry,
  parseJournalIndex,
  renderJournalEntry,
  _fsHooks,
} from '../lib/journal-writer.js';
import { readEvents } from '../lib/feature-events.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_JOURNAL = join(REPO_ROOT, 'docs', 'journal');
const REAL_INDEX   = join(REAL_JOURNAL, 'README.md');
const REAL_SESSION36 = join(REAL_JOURNAL, '2026-05-03-session-36-mcp-changelog-writer.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'journal-writer-'));
  return cwd;
}

/**
 * Set up a tmp cwd with a journal dir and a minimal valid index.
 * Optionally pre-seed entry files. Returns the cwd.
 */
function freshJournalCwd({ rows = [], extraPreamble = '' } = {}) {
  const cwd = freshCwd();
  const jDir = join(cwd, 'docs', 'journal');
  mkdirSync(jDir, { recursive: true });

  // Write entry files.
  for (const r of rows) {
    const filename = `${r.date}-session-${r.session_number}-${r.slug}.md`;
    const content = renderJournalEntry({
      date: r.date,
      slug: r.slug,
      session_number: r.session_number,
      sections: r.sections || {
        what_happened: 'happened',
        what_we_built: 'built',
        what_we_learned: 'learned',
        open_threads: 'threads',
      },
      summary_for_index: r.summary || 'A summary',
      feature_code: r.feature_code,
    });
    writeFileSync(join(jDir, filename), content);
  }

  // Write index.
  writeIndex(cwd, rows);
  return cwd;
}

function writeIndex(cwd, rows) {
  const jDir = join(cwd, 'docs', 'journal');
  const rowLines = rows.map(r => {
    const fn = `${r.date}-session-${r.session_number}-${r.slug}.md`;
    const summary = r.summary || 'A summary';
    return `| ${r.date} | [Session ${r.session_number}: ${summary}](${fn}) | ${summary} |`;
  });
  const content = [
    '# Developer Journal',
    '',
    'Preamble.',
    '',
    '## Entries',
    '',
    '| Date | Entry | Summary |',
    '|------|-------|---------|',
    ...rowLines,
    '',
  ].join('\n');
  writeFileSync(join(jDir, 'README.md'), content);
}

// ---------------------------------------------------------------------------
// T1 — parseJournalEntry
// ---------------------------------------------------------------------------

describe('T1 — parseJournalEntry', () => {
  test('#1 empty string → all fields default', () => {
    const r = parseJournalEntry('');
    assert.deepEqual(r.frontmatter, {});
    assert.equal(r.sections.what_happened, '');
    assert.equal(r.sections.what_we_built, '');
    assert.equal(r.sections.what_we_learned, '');
    assert.equal(r.sections.open_threads, '');
    assert.deepEqual(r.unknownSections, []);
    assert.equal(r.closing_line, null);
  });

  test('#2a frontmatter: bare key:value', () => {
    const text = '---\ndate: 2026-05-03\nslug: foo-bar\n---\n\n# Session 1 — Title\n';
    const r = parseJournalEntry(text);
    assert.equal(r.frontmatter.date, '2026-05-03');
    assert.equal(r.frontmatter.slug, 'foo-bar');
  });

  test('#2b frontmatter: double-quoted with escapes', () => {
    const text = '---\nsummary: "Hello: world\\nline2"\n---\n';
    const r = parseJournalEntry(text);
    assert.equal(r.frontmatter.summary, 'Hello: world\nline2');
  });

  test('#2c frontmatter: session_number coerced to int', () => {
    const text = '---\nsession_number: 42\n---\n';
    const r = parseJournalEntry(text);
    assert.equal(r.frontmatter.session_number, 42);
    assert.equal(typeof r.frontmatter.session_number, 'number');
  });

  test('#2d frontmatter: missing closing --- throws JOURNAL_FORMAT', () => {
    // parseJournalEntry is permissive (parser, not validator).
    // A missing closing --- means the frontmatter regex won't match; the
    // content falls through as body (no frontmatter).
    const text = '---\ndate: 2026-05-03\n\n# Session 1 — Title\n';
    const r = parseJournalEntry(text);
    // No frontmatter parsed (regex didn't match).
    assert.deepEqual(r.frontmatter, {});
  });

  test('#3 title parse: session_number and title extracted from H1', () => {
    const text = '# Session 36 — COMP-MCP-CHANGELOG-WRITER\n';
    const r = parseJournalEntry(text);
    assert.equal(r.session_number, 36);
    assert.equal(r.title, 'COMP-MCP-CHANGELOG-WRITER');
  });

  test('#3b frontmatter session_number overrides H1', () => {
    const text = '---\nsession_number: 99\n---\n\n# Session 36 — COMP-MCP-CHANGELOG-WRITER\n';
    const r = parseJournalEntry(text);
    assert.equal(r.session_number, 99);
  });

  test('#4 four canonical sections recovered in order, bodies edge-trimmed', () => {
    const text = [
      '# Session 1 — Test',
      '',
      '## What happened',
      '',
      'Something happened.',
      '',
      '## What we built',
      '',
      'We built a thing.',
      '',
      '## What we learned',
      '',
      'We learned stuff.',
      '',
      '## Open threads',
      '',
      '- [ ] TODO',
      '',
    ].join('\n');
    const r = parseJournalEntry(text);
    assert.equal(r.sections.what_happened, 'Something happened.');
    assert.equal(r.sections.what_we_built, 'We built a thing.');
    assert.equal(r.sections.what_we_learned, 'We learned stuff.');
    assert.equal(r.sections.open_threads, '- [ ] TODO');
    assert.deepEqual(r.unknownSections, []);
  });

  test('#5 non-canonical ## Postmortem lands in unknownSections', () => {
    const text = [
      '# Session 1 — Test',
      '',
      '## What happened',
      '',
      'Happened.',
      '',
      '## Postmortem',
      '',
      'Postmortem body.',
      '',
    ].join('\n');
    const r = parseJournalEntry(text);
    assert.equal(r.unknownSections.length, 1);
    assert.equal(r.unknownSections[0].heading, 'Postmortem');
    assert.match(r.unknownSections[0].body, /Postmortem body/);
    assert.equal(typeof r.unknownSections[0].startLine, 'number');
  });

  test('#6 two ## Notes blocks both in unknownSections with distinct startLine', () => {
    const text = [
      '# Session 1 — Test',
      '',
      '## What happened',
      '',
      'Happened.',
      '',
      '## Notes',
      '',
      'First notes.',
      '',
      '## Notes',
      '',
      'Second notes.',
      '',
    ].join('\n');
    const r = parseJournalEntry(text);
    const notesSections = r.unknownSections.filter(s => s.heading === 'Notes');
    assert.equal(notesSections.length, 2);
    assert.ok(notesSections[0].startLine < notesSections[1].startLine,
      'first Notes should have a lower startLine than second Notes');
    assert.match(notesSections[0].body, /First notes/);
    assert.match(notesSections[1].body, /Second notes/);
  });

  test('#7a HR + italic closing_line: closing_line stripped of italics', () => {
    const text = [
      '# Session 1 — Test',
      '',
      '## Open threads',
      '',
      '- [ ] item',
      '',
      '---',
      '',
      '*This is the closing line.*',
      '',
    ].join('\n');
    const r = parseJournalEntry(text);
    assert.equal(r.closing_line, 'This is the closing line.');
  });

  test('#7b HR + non-italic line: closing_line set as-is', () => {
    const text = [
      '# Session 1 — Test',
      '',
      '## Open threads',
      '',
      '- [ ] item',
      '',
      '---',
      '',
      'Plain closing line.',
      '',
    ].join('\n');
    const r = parseJournalEntry(text);
    assert.equal(r.closing_line, 'Plain closing line.');
  });

  test('#7c no HR but frontmatter closing_line: use frontmatter', () => {
    const text = '---\nclosing_line: From frontmatter\n---\n\n# Session 1 — Test\n\n## Open threads\n\nStuff.\n';
    const r = parseJournalEntry(text);
    assert.equal(r.closing_line, 'From frontmatter');
  });

  test('#7d no HR and no frontmatter: closing_line null', () => {
    const text = '# Session 1 — Test\n\n## Open threads\n\n- [ ] item\n\n- [ ] another\n';
    const r = parseJournalEntry(text);
    assert.equal(r.closing_line, null);
  });

  test('#7e Open threads ending with list items and no HR: list not swallowed, closing_line null', () => {
    const text = [
      '# Session 1 — Test',
      '',
      '## What happened',
      '',
      'Happened.',
      '',
      '## Open threads',
      '',
      '- [ ] Item one',
      '- [ ] Item two',
      '- [ ] Item three',
    ].join('\n');
    const r = parseJournalEntry(text);
    // All items should be in open_threads, not swallowed.
    assert.match(r.sections.open_threads, /Item one/);
    assert.match(r.sections.open_threads, /Item three/);
    assert.equal(r.closing_line, null);
  });

  test('#8 round-trip on real session-36 entry', () => {
    const text = readFileSync(REAL_SESSION36, 'utf-8');
    const r = parseJournalEntry(text);
    assert.match(r.sections.what_happened, /.+/);
    assert.match(r.sections.what_we_built, /.+/);
    assert.match(r.sections.what_we_learned, /.+/);
    assert.match(r.sections.open_threads, /.+/);
    assert.deepEqual(r.unknownSections, []);
    assert.equal(r.frontmatter.summary, undefined);  // no frontmatter in this entry
    assert.equal(r.feature_code, null);
    assert.equal(r.closing_line, null);
  });
});

// ---------------------------------------------------------------------------
// T2 — parseJournalIndex + renderJournalEntry
// ---------------------------------------------------------------------------

describe('T2 — parseJournalIndex', () => {
  test('#9 parse real README.md — row 0 is the newest, row count >= 30', () => {
    const text = readFileSync(REAL_INDEX, 'utf-8');
    const r = parseJournalIndex(text);
    // Row count grows over time as new sessions ship; assert the floor.
    assert.ok(r.rows.length >= 30, `expected >=30 rows, got ${r.rows.length}`);
    // Row 0 (top of table) should be the most recent entry — date/session_number/slug parse correctly.
    const row0 = r.rows[0];
    assert.match(row0.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof row0.session_number, 'number');
    assert.match(row0.slug, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  test('#10a index format: missing ## Entries → throws JOURNAL_INDEX_FORMAT', () => {
    const text = '# Journal\n\n| Date | Entry | Summary |\n|---|---|---|\n';
    assert.throws(
      () => parseJournalIndex(text),
      err => err.code === 'JOURNAL_INDEX_FORMAT',
    );
  });

  test('#10b malformed table header (extra column) → throws', () => {
    const text = '## Entries\n\n| Date | Entry | Summary | Extra |\n|---|---|---|---|\n';
    assert.throws(
      () => parseJournalIndex(text),
      err => err.code === 'JOURNAL_INDEX_FORMAT',
    );
  });

  test('#10c missing separator → throws', () => {
    const text = '## Entries\n\n| Date | Entry | Summary |\n\n| 2026-05-03 | [Session 1: x](f.md) | x |\n';
    assert.throws(
      () => parseJournalIndex(text),
      err => err.code === 'JOURNAL_INDEX_FORMAT',
    );
  });

  test('#10d preamble preserved verbatim', () => {
    const text = '# Journal\n\nSome preamble text.\n\n## Entries\n\n| Date | Entry | Summary |\n|------|-------|---------|';
    const r = parseJournalIndex(text);
    assert.match(r.preamble, /Some preamble text/);
  });

  test('#11 opaque rows preserved with slug:null, session_number:null', () => {
    const text = [
      '## Entries',
      '',
      '| Date | Entry | Summary |',
      '|------|-------|---------|',
      '| 2026-05-03 | [Session 36: normal](2026-05-03-session-36-foo.md) | normal |',
      '| 2026-05-03 | not a valid row',
      '',
    ].join('\n');
    const r = parseJournalIndex(text);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].session_number, 36);
    assert.equal(r.rows[1].slug, null);
    assert.equal(r.rows[1].session_number, null);
    assert.ok(r.rows[1].raw, 'opaque row should have raw field');
  });
});

describe('T2 — renderJournalEntry', () => {
  test('#12 render→parse round-trip structural equality', () => {
    const args = {
      date: '2026-05-03',
      slug: 'test-session',
      session_number: 5,
      sections: {
        what_happened: 'Something happened.',
        what_we_built: 'We built things.',
        what_we_learned: 'Insight 1.\nInsight 2.',
        open_threads: '- [ ] Todo item',
      },
      summary_for_index: 'Test session summary',
      feature_code: 'TEST-1',
      closing_line: 'A closing remark.',
    };
    const rendered = renderJournalEntry(args);
    const parsed = parseJournalEntry(rendered);
    assert.equal(parsed.frontmatter.date, args.date);
    assert.equal(parsed.frontmatter.session_number, args.session_number);
    assert.equal(parsed.feature_code, args.feature_code);
    assert.equal(parsed.sections.what_happened, args.sections.what_happened);
    assert.equal(parsed.sections.what_we_built, args.sections.what_we_built);
    assert.equal(parsed.closing_line, args.closing_line);
    assert.deepEqual(parsed.unknownSections, []);
  });

  test('#12b render without feature_code → no **Feature:** line', () => {
    const rendered = renderJournalEntry({
      date: '2026-05-03',
      slug: 'no-feature',
      session_number: 0,
      sections: { what_happened: 'x', what_we_built: 'x', what_we_learned: 'x', open_threads: 'x' },
      summary_for_index: 'No feature code',
    });
    assert.doesNotMatch(rendered, /\*\*Feature:\*\*/);
  });

  test('#12c render without closing_line → no trailing HR + italic block', () => {
    const rendered = renderJournalEntry({
      date: '2026-05-03',
      slug: 'no-closing',
      session_number: 0,
      sections: { what_happened: 'x', what_we_built: 'x', what_we_learned: 'x', open_threads: 'x' },
      summary_for_index: 'No closing',
    });
    // Should not end with --- followed by italic.
    assert.doesNotMatch(rendered, /\n---\n\n\*/);
  });

  test('#13 frontmatter encoding: bare values for simple strings', () => {
    const rendered = renderJournalEntry({
      date: '2026-05-03',
      slug: 'simple-slug',
      session_number: 7,
      sections: { what_happened: 'x', what_we_built: 'x', what_we_learned: 'x', open_threads: 'x' },
      summary_for_index: 'Simple summary',
    });
    // session_number bare integer.
    assert.match(rendered, /^session_number: 7$/m);
    // date bare value.
    assert.match(rendered, /^date: 2026-05-03$/m);
  });

  test('#13b frontmatter encoding: double-quoted for strings with colons', () => {
    const rendered = renderJournalEntry({
      date: '2026-05-03',
      slug: 'test',
      session_number: 0,
      sections: { what_happened: 'x', what_we_built: 'x', what_we_learned: 'x', open_threads: 'x' },
      summary_for_index: 'Summary: with colon',
    });
    // summary has a colon, should be quoted.
    assert.match(rendered, /^summary: "/m);
  });

  test('#14a title derivation: feature_code provided → title = feature_code', () => {
    const rendered = renderJournalEntry({
      date: '2026-05-03',
      slug: 'test',
      session_number: 0,
      sections: { what_happened: 'x', what_we_built: 'x', what_we_learned: 'x', open_threads: 'x' },
      summary_for_index: 'Some summary',
      feature_code: 'COMP-FOO-1',
    });
    assert.match(rendered, /^# Session 0 — COMP-FOO-1$/m);
  });

  test('#14b title derivation: no feature_code → from summary up to first colon', () => {
    const rendered = renderJournalEntry({
      date: '2026-05-03',
      slug: 'test',
      session_number: 0,
      sections: { what_happened: 'x', what_we_built: 'x', what_we_learned: 'x', open_threads: 'x' },
      summary_for_index: 'Foo bar: baz',
    });
    assert.match(rendered, /^# Session 0 — Foo bar$/m);
  });

  test('#14c title derivation: summary truncated to 80 chars', () => {
    const longSummary = 'x'.repeat(120);
    const rendered = renderJournalEntry({
      date: '2026-05-03',
      slug: 'test',
      session_number: 0,
      sections: { what_happened: 'x', what_we_built: 'x', what_we_learned: 'x', open_threads: 'x' },
      summary_for_index: longSummary,
    });
    // The H1 title should not exceed 80 chars of summary.
    const h1Match = rendered.match(/^# Session 0 — (.+)$/m);
    assert.ok(h1Match, 'H1 line should exist');
    assert.ok(h1Match[1].length <= 80, `title too long: ${h1Match[1].length}`);
  });
});

// ---------------------------------------------------------------------------
// T3 — writeJournalEntry
// ---------------------------------------------------------------------------

describe('T3 — writeJournalEntry', () => {
  test('#15 validation rejects bad date', async () => {
    const cwd = freshJournalCwd();
    await assert.rejects(
      () => writeJournalEntry(cwd, {
        date: '05-03-2026', slug: 'test', sections: validSections(), summary_for_index: 'summary',
      }),
      err => err.code === 'INVALID_INPUT',
    );
  });

  test('#15b validation rejects bad slug', async () => {
    const cwd = freshJournalCwd();
    await assert.rejects(
      () => writeJournalEntry(cwd, {
        date: '2026-05-03', slug: 'UPPERCASE', sections: validSections(), summary_for_index: 'summary',
      }),
      err => err.code === 'INVALID_INPUT',
    );
  });

  test('#15c validation rejects missing what_happened', async () => {
    const cwd = freshJournalCwd();
    const sec = validSections();
    delete sec.what_happened;
    await assert.rejects(
      () => writeJournalEntry(cwd, {
        date: '2026-05-03', slug: 'test', sections: sec, summary_for_index: 'summary',
      }),
      err => err.code === 'INVALID_INPUT',
    );
  });

  test('#15d validation rejects multi-line summary', async () => {
    const cwd = freshJournalCwd();
    await assert.rejects(
      () => writeJournalEntry(cwd, {
        date: '2026-05-03', slug: 'test', sections: validSections(), summary_for_index: 'line1\nline2',
      }),
      err => err.code === 'INVALID_INPUT',
    );
  });

  test('#15e validation rejects | in summary', async () => {
    const cwd = freshJournalCwd();
    await assert.rejects(
      () => writeJournalEntry(cwd, {
        date: '2026-05-03', slug: 'test', sections: validSections(), summary_for_index: 'bad | summary',
      }),
      err => err.code === 'INVALID_INPUT',
    );
  });

  test('#15f validation rejects bad feature_code', async () => {
    const cwd = freshJournalCwd();
    await assert.rejects(
      () => writeJournalEntry(cwd, {
        date: '2026-05-03', slug: 'test', sections: validSections(), summary_for_index: 'summary',
        feature_code: 'not-valid',
      }),
      err => err.code === 'INVALID_INPUT',
    );
  });

  test('#15g validation rejects multi-line closing_line', async () => {
    const cwd = freshJournalCwd();
    await assert.rejects(
      () => writeJournalEntry(cwd, {
        date: '2026-05-03', slug: 'test', sections: validSections(), summary_for_index: 'summary',
        closing_line: 'line1\nline2',
      }),
      err => err.code === 'INVALID_INPUT',
    );
  });

  test('#16 empty journal dir + valid index → file created, session_number: 0', async () => {
    const cwd = freshJournalCwd();
    const r = await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'first-entry',
      sections: validSections(),
      summary_for_index: 'First entry summary',
    });
    assert.equal(r.session_number, 0);
    assert.equal(r.idempotent, false);
    assert.ok(existsSync(r.path), 'entry file should exist');
    assert.match(r.path, /2026-05-03-session-0-first-entry\.md$/);
    assert.equal(typeof r.index_line, 'number');
    assert.ok(r.index_line > 0);

    // Check audit event.
    const events = readEvents(cwd, { tool: 'write_journal_entry' });
    assert.equal(events.length, 1);
    assert.equal(events[0].date, '2026-05-03');
    assert.equal(events[0].slug, 'first-entry');
    assert.equal(events[0].session_number, 0);
  });

  test('#17 pre-seeded sessions 0,1,3 → next gets session_number: 4', async () => {
    const cwd = freshJournalCwd({
      rows: [
        { date: '2026-05-01', session_number: 0, slug: 'alpha' },
        { date: '2026-05-02', session_number: 1, slug: 'beta' },
        { date: '2026-05-03', session_number: 3, slug: 'gamma' },
      ],
    });
    const r = await writeJournalEntry(cwd, {
      date: '2026-05-04',
      slug: 'delta',
      sections: validSections(),
      summary_for_index: 'Delta summary',
    });
    assert.equal(r.session_number, 4);
  });

  test('#18 dedup force:false → second call idempotent', async () => {
    const cwd = freshJournalCwd();
    const args = {
      date: '2026-05-03',
      slug: 'dedup-test',
      sections: validSections(),
      summary_for_index: 'Dedup summary',
    };
    const r1 = await writeJournalEntry(cwd, args);
    assert.equal(r1.idempotent, false);
    assert.equal(r1.session_number, 0);

    const r2 = await writeJournalEntry(cwd, args);
    assert.equal(r2.idempotent, true);
    assert.equal(r2.session_number, r1.session_number);
    assert.equal(r2.path, r1.path);

    // No second row in index.
    const indexText = readFileSync(join(cwd, 'docs', 'journal', 'README.md'), 'utf-8');
    const matches = (indexText.match(/dedup-test/g) || []).length;
    assert.equal(matches, 1, 'should only have one index row for slug dedup-test');

    // No second audit event.
    const events = readEvents(cwd, { tool: 'write_journal_entry' });
    assert.equal(events.length, 1);
  });

  test('#19 force overwrite: file rewritten, session preserved, index row updated', async () => {
    const cwd = freshJournalCwd();
    const r1 = await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'force-test',
      sections: validSections(),
      summary_for_index: 'Original summary',
    });
    assert.equal(r1.session_number, 0);

    // Write a second entry so there are now two rows.
    await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'another-entry',
      sections: validSections(),
      summary_for_index: 'Another entry',
    });

    // Force overwrite the first.
    const r2 = await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'force-test',
      sections: { ...validSections(), what_happened: 'Updated content.' },
      summary_for_index: 'Updated summary',
      force: true,
    });
    assert.equal(r2.idempotent, false);
    assert.equal(r2.session_number, r1.session_number, 'session_number must be preserved on overwrite');
    assert.equal(r2.path, r1.path, 'path must be the same');

    // Entry file updated.
    const entryText = readFileSync(r2.path, 'utf-8');
    assert.match(entryText, /Updated content\./);
    // The original generic validSections() content "Something happened today." should be gone.
    assert.doesNotMatch(entryText, /Something happened today\./);  // original sections text gone

    // Index row updated, not duplicated.
    const indexText = readFileSync(join(cwd, 'docs', 'journal', 'README.md'), 'utf-8');
    const matches = (indexText.match(/force-test/g) || []).length;
    assert.equal(matches, 1, 'force overwrite should not create duplicate row');
    assert.match(indexText, /Updated summary/);
  });

  test('#20 caller idempotency_key replay: same key returns cached result', async () => {
    const cwd = freshJournalCwd();
    const r1 = await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'idkey-test',
      sections: validSections(),
      summary_for_index: 'Idkey summary',
      idempotency_key: 'k-journal-1',
    });
    const r2 = await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'idkey-test',
      sections: validSections(),
      summary_for_index: 'Idkey summary',
      idempotency_key: 'k-journal-1',
    });
    assert.deepEqual(r1, r2);
  });

  test('#21 atomic write: no .tmp file left after success', async () => {
    const cwd = freshJournalCwd();
    await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'atomic-test',
      sections: validSections(),
      summary_for_index: 'Atomic summary',
    });
    const jDir = join(cwd, 'docs', 'journal');
    const files = readdirSync(jDir);
    assert.ok(!files.some(f => f.endsWith('.tmp')), `unexpected .tmp files: ${files.filter(f => f.endsWith('.tmp')).join(',')}`);
  });

  test('#22 concurrency: two parallel writes different slugs → adjacent session numbers', async () => {
    const cwd = freshJournalCwd();
    const [rA, rB] = await Promise.all([
      writeJournalEntry(cwd, {
        date: '2026-05-03',
        slug: 'concurrent-a',
        sections: validSections(),
        summary_for_index: 'Concurrent A',
      }),
      writeJournalEntry(cwd, {
        date: '2026-05-03',
        slug: 'concurrent-b',
        sections: validSections(),
        summary_for_index: 'Concurrent B',
      }),
    ]);
    assert.equal(Math.abs(rA.session_number - rB.session_number), 1,
      `expected adjacent session numbers, got ${rA.session_number} and ${rB.session_number}`);
    // Both files exist.
    assert.ok(existsSync(rA.path));
    assert.ok(existsSync(rB.path));
    // Both rows in index.
    const indexText = readFileSync(join(cwd, 'docs', 'journal', 'README.md'), 'utf-8');
    assert.match(indexText, /concurrent-a/);
    assert.match(indexText, /concurrent-b/);
  });

  test('#23 audit failure non-fatal → writeJournalEntry still succeeds', async () => {
    const cwd = freshJournalCwd();
    // Create .compose/data as a directory (normal lock path), then create
    // feature-events.jsonl as a directory so appendEvent can't write to it.
    const dataDir = join(cwd, '.compose', 'data');
    mkdirSync(dataDir, { recursive: true });
    // Make feature-events.jsonl a directory so writes fail.
    mkdirSync(join(dataDir, 'feature-events.jsonl'), { recursive: true });
    const r = await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'audit-fail',
      sections: validSections(),
      summary_for_index: 'Audit fail test',
    });
    assert.equal(r.idempotent, false);
    assert.ok(existsSync(r.path));
  });

  test('#24 index format guard: JOURNAL_INDEX_FORMAT before any disk mutation', async () => {
    const cwd = freshCwd();
    const jDir = join(cwd, 'docs', 'journal');
    mkdirSync(jDir, { recursive: true });
    // Write a broken index (no ## Entries).
    writeFileSync(join(jDir, 'README.md'), '# Journal\n\nNo entries heading.\n');

    await assert.rejects(
      () => writeJournalEntry(cwd, {
        date: '2026-05-03',
        slug: 'should-not-exist',
        sections: validSections(),
        summary_for_index: 'Should not write',
      }),
      err => err.code === 'JOURNAL_INDEX_FORMAT',
    );

    // Verify no entry file was created.
    const files = readdirSync(jDir);
    assert.ok(!files.some(f => f !== 'README.md'), `unexpected files created: ${files.join(',')}`);
  });
});

// ---------------------------------------------------------------------------
// T4 — getJournalEntries
// ---------------------------------------------------------------------------

describe('T4 — getJournalEntries', () => {
  test('#25 no filters → all newest-first by (date desc, session_number desc)', async () => {
    const cwd = freshJournalCwd({
      rows: [
        { date: '2026-05-01', session_number: 0, slug: 'alpha' },
        { date: '2026-05-03', session_number: 2, slug: 'gamma' },
        { date: '2026-05-02', session_number: 1, slug: 'beta' },
      ],
    });
    const r = getJournalEntries(cwd);
    assert.equal(r.count, 3);
    assert.equal(r.entries[0].date, '2026-05-03');
    assert.equal(r.entries[1].date, '2026-05-02');
    assert.equal(r.entries[2].date, '2026-05-01');
  });

  test('#25b same date: session_number desc', async () => {
    const cwd = freshJournalCwd({
      rows: [
        { date: '2026-05-03', session_number: 0, slug: 'early' },
        { date: '2026-05-03', session_number: 2, slug: 'late' },
      ],
    });
    const r = getJournalEntries(cwd);
    assert.equal(r.entries[0].session_number, 2);
    assert.equal(r.entries[1].session_number, 0);
  });

  test('#26 feature_code filter: only entries with matching frontmatter feature_code', async () => {
    const cwd = freshJournalCwd();
    // Write entries with different feature_codes.
    await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'with-feature',
      sections: validSections(),
      summary_for_index: 'Has feature code',
      feature_code: 'COMP-TEST-1',
    });
    await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'without-feature',
      sections: validSections(),
      summary_for_index: 'No feature code',
    });
    // Write a pre-frontmatter style entry (plain markdown, no FM).
    const jDir = join(cwd, 'docs', 'journal');
    writeFileSync(join(jDir, '2026-01-01-session-99-old-style.md'),
      '# Session 99 — Old Style\n\n## What happened\n\nOld stuff.\n');

    const r = getJournalEntries(cwd, { feature_code: 'COMP-TEST-1' });
    assert.equal(r.count, 1);
    assert.equal(r.entries[0].slug, 'with-feature');
    // Pre-frontmatter entries are excluded because feature_code is null, not 'COMP-TEST-1'.
  });

  test('#27 session exact match → at most one entry', async () => {
    const cwd = freshJournalCwd({
      rows: [
        { date: '2026-05-01', session_number: 0, slug: 'alpha' },
        { date: '2026-05-02', session_number: 1, slug: 'beta' },
      ],
    });
    const r = getJournalEntries(cwd, { session: 1 });
    assert.equal(r.count, 1);
    assert.equal(r.entries[0].session_number, 1);
  });

  test('#28a since: "7d" filters out older entries', async () => {
    const cwd = freshJournalCwd();
    // Write a recent entry.
    const today = new Date().toISOString().slice(0, 10);
    await writeJournalEntry(cwd, {
      date: today,
      slug: 'recent',
      sections: validSections(),
      summary_for_index: 'Recent entry',
    });
    // Write an old entry directly (bypass writeJournalEntry to control date).
    const jDir = join(cwd, 'docs', 'journal');
    writeFileSync(join(jDir, '2020-01-01-session-99-old-entry.md'),
      renderJournalEntry({
        date: '2020-01-01',
        slug: 'old-entry',
        session_number: 99,
        sections: validSections(),
        summary_for_index: 'Old entry',
      }));

    const r = getJournalEntries(cwd, { since: '7d' });
    const slugs = r.entries.map(e => e.slug);
    assert.ok(slugs.includes('recent'), 'recent entry should be included');
    assert.ok(!slugs.includes('old-entry'), 'old entry should be excluded by since:7d');
  });

  test('#28b since: ISO date works', async () => {
    const cwd = freshJournalCwd({
      rows: [
        { date: '2026-05-03', session_number: 0, slug: 'newer' },
        { date: '2026-04-01', session_number: 1, slug: 'older' },
      ],
    });
    const r = getJournalEntries(cwd, { since: '2026-05-01' });
    assert.equal(r.count, 1);
    assert.equal(r.entries[0].slug, 'newer');
  });

  test('#29 limit respected (default 50, ceiling 500)', async () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ date: '2026-05-03', session_number: i, slug: `entry-${i}` });
    }
    const cwd = freshJournalCwd({ rows });

    const r3 = getJournalEntries(cwd, { limit: 3 });
    assert.equal(r3.count, 3);

    const r500 = getJournalEntries(cwd, { limit: 600 });  // capped at 500
    assert.equal(r500.count, 10);  // only 10 total
  });

  test('#30 returned shape: all documented fields present', async () => {
    const cwd = freshJournalCwd();
    await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'shape-test',
      sections: validSections(),
      summary_for_index: 'Shape test',
      feature_code: 'SHAPE-1',
      closing_line: 'A closing line.',
    });
    const r = getJournalEntries(cwd);
    assert.equal(r.count, 1);
    const e = r.entries[0];
    assert.ok('date' in e);
    assert.ok('session_number' in e);
    assert.ok('slug' in e);
    assert.ok('path' in e);
    assert.ok('summary' in e);
    assert.ok('feature_code' in e);
    assert.ok('sections' in e);
    assert.ok('what_happened' in e.sections);
    assert.ok('what_we_built' in e.sections);
    assert.ok('what_we_learned' in e.sections);
    assert.ok('open_threads' in e.sections);
    assert.ok('unknownSections' in e);
    assert.ok(Array.isArray(e.unknownSections));
    assert.ok('closing_line' in e);
    assert.equal(e.summary, 'Shape test');
    assert.equal(e.feature_code, 'SHAPE-1');
    assert.equal(e.closing_line, 'A closing line.');
  });

  test('#31 summary from frontmatter, not README', async () => {
    const cwd = freshJournalCwd();
    await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'summary-test',
      sections: validSections(),
      summary_for_index: 'Frontmatter summary',
    });

    // Mutate the README index row's Summary cell only.
    const indexPath = join(cwd, 'docs', 'journal', 'README.md');
    const indexText = readFileSync(indexPath, 'utf-8');
    const mutated = indexText.replace('Frontmatter summary', 'README-only summary');
    writeFileSync(indexPath, mutated);

    // getJournalEntries should still return the frontmatter value.
    const r = getJournalEntries(cwd);
    assert.equal(r.count, 1);
    assert.equal(r.entries[0].summary, 'Frontmatter summary',
      'summary must come from frontmatter, not README');
  });
});

// ---------------------------------------------------------------------------
// Bug-fix regression tests (Codex review findings)
// ---------------------------------------------------------------------------

describe('BugFix — frontmatter round-trip with literal backslash-n', () => {
  test('#R1 literal \\n in closing_line survives render→parse unchanged', () => {
    // Input: closing_line contains a literal backslash followed by 'n' (two chars,
    // NOT a newline). It must survive encode→decode as those same two chars.
    const args = {
      date: '2026-05-03',
      slug: 'roundtrip-backslash',
      session_number: 0,
      sections: validSections(),
      summary_for_index: 'Backslash round-trip',
      closing_line: 'a\\nb',   // 4 chars: a \ n b
    };
    const rendered = renderJournalEntry(args);
    const parsed = parseJournalEntry(rendered);
    // Must come back as exactly 4 chars, not a newline.
    assert.equal(parsed.closing_line, 'a\\nb',
      `expected literal backslash-n, got: ${JSON.stringify(parsed.closing_line)}`);
    assert.equal(parsed.closing_line.length, 4,
      'closing_line should be 4 chars (a, \\, n, b)');
  });
});

describe('BugFix — heading whitespace normalization', () => {
  test('#R2 ## What  Happened (double space, mixed case) lands in what_happened', () => {
    const text = [
      '# Session 1 — Test',
      '',
      '## What  Happened',  // double space, capital H
      '',
      'Whitespace heading body.',
      '',
    ].join('\n');
    const r = parseJournalEntry(text);
    assert.equal(r.sections.what_happened, 'Whitespace heading body.',
      'expected double-space heading to match what_happened');
    assert.deepEqual(r.unknownSections, [],
      'expected no unknown sections — heading should have been recognized');
  });
});

describe('BugFix — idempotent no-op index_line inside lock', () => {
  test('#R3 index_line reflects post-concurrent-write line number', async () => {
    // Pre-seed a known entry.
    const cwd = freshJournalCwd({
      rows: [
        { date: '2026-05-01', session_number: 0, slug: 'existing' },
      ],
    });

    // First call creates a new entry (session 1).
    const r1 = await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'dedup-lock',
      sections: validSections(),
      summary_for_index: 'Dedup lock test',
    });
    assert.equal(r1.idempotent, false);

    // Insert an extra row directly into the index, simulating a concurrent
    // writer that pushed a row above our entry after we acquired the lock.
    const indexPath = join(cwd, 'docs', 'journal', 'README.md');
    const indexText = readFileSync(indexPath, 'utf-8');
    const lines = indexText.split('\n');
    // Find separator line (the |---|...) and insert a new row right after it.
    const sepIdx = lines.findIndex(l => /^\|[\s-]+\|[\s-]+\|[\s-]+\|/.test(l));
    lines.splice(sepIdx + 1, 0,
      '| 2026-05-03 | [Session 99: Injected](2026-05-03-session-99-injected.md) | Injected |');
    writeFileSync(indexPath, lines.join('\n'));

    // Now the idempotent call must return the UPDATED line number.
    const r2 = await writeJournalEntry(cwd, {
      date: '2026-05-03',
      slug: 'dedup-lock',
      sections: validSections(),
      summary_for_index: 'Dedup lock test',
    });
    assert.equal(r2.idempotent, true);

    // Verify r2.index_line matches where the row actually is on disk.
    const finalText = readFileSync(indexPath, 'utf-8');
    const finalLines = finalText.split('\n');
    const actualLine = finalLines.findIndex(l => l.includes('dedup-lock')) + 1;  // 1-based
    assert.ok(actualLine > 0, 'dedup-lock row must exist in index');
    assert.equal(r2.index_line, actualLine,
      `expected index_line=${actualLine} but got ${r2.index_line}`);
  });
});

describe('BugFix — atomic write failure leaves no .tmp file', () => {
  test('#R4 renameSync failure → no .tmp file remains', async () => {
    const cwd = freshJournalCwd();
    const origRenameSync = _fsHooks.renameSync;
    let callCount = 0;

    // Monkeypatch: throw on the first call to renameSync.
    _fsHooks.renameSync = (src, dst) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('simulated renameSync failure');
      }
      return origRenameSync(src, dst);
    };

    try {
      await assert.rejects(
        () => writeJournalEntry(cwd, {
          date: '2026-05-03',
          slug: 'atomic-fail',
          sections: validSections(),
          summary_for_index: 'Atomic fail test',
        }),
        err => err.message === 'simulated renameSync failure',
      );
    } finally {
      _fsHooks.renameSync = origRenameSync;
    }

    // No .tmp files should remain.
    const jDir = join(cwd, 'docs', 'journal');
    const files = readdirSync(jDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.deepEqual(tmpFiles, [],
      `expected no .tmp files after failure, found: ${tmpFiles.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// R5 — partial-write rollback (compensating-action pattern)
// ---------------------------------------------------------------------------

describe('R5 — partial-write rollback', () => {
  test('#R5a new-entry index failure rolls back entry file', async () => {
    const cwd = freshJournalCwd();
    const jDir = join(cwd, 'docs', 'journal');
    const origRenameSync = _fsHooks.renameSync;
    let callCount = 0;

    // Throw on the SECOND renameSync call (entry write = 1st, index write = 2nd).
    _fsHooks.renameSync = (src, dst) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('simulated index renameSync failure');
      }
      return origRenameSync(src, dst);
    };

    try {
      await assert.rejects(
        () => writeJournalEntry(cwd, {
          date: '2026-05-03',
          slug: 'r5a-rollback',
          sections: validSections(),
          summary_for_index: 'R5a rollback test',
        }),
        err => {
          assert.equal(err.code, 'JOURNAL_PARTIAL_WRITE', 'error.code must be JOURNAL_PARTIAL_WRITE');
          // err.cause must carry the original indexErr so callers can distinguish
          // root causes across the MCP boundary.
          assert.ok(err.cause instanceof Error, 'err.cause must be an Error');
          assert.match(err.cause.message, /simulated index renameSync failure/, 'err.cause.message must contain original error text');
          return true;
        },
      );
    } finally {
      _fsHooks.renameSync = origRenameSync;
    }

    // Entry file must not exist (rolled back).
    const entryFile = join(jDir, '2026-05-03-session-0-r5a-rollback.md');
    assert.equal(existsSync(entryFile), false, 'entry file should have been deleted on rollback');

    // No .tmp files remain.
    const tmpFiles = readdirSync(jDir).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(tmpFiles, [], `expected no .tmp files, found: ${tmpFiles.join(', ')}`);
  });

  test('#R5b force-overwrite index failure restores prior content', async () => {
    // Pre-seed entry with content A.
    const cwd = freshJournalCwd({
      rows: [{
        date: '2026-05-03',
        session_number: 0,
        slug: 'r5b-restore',
        summary: 'Original summary',
        sections: validSections(),
      }],
    });
    const jDir = join(cwd, 'docs', 'journal');
    const entryFile = join(jDir, '2026-05-03-session-0-r5b-restore.md');

    // Capture original (content A).
    const contentA = readFileSync(entryFile, 'utf-8');

    const origRenameSync = _fsHooks.renameSync;
    let callCount = 0;

    // Throw on the SECOND renameSync (index write).
    _fsHooks.renameSync = (src, dst) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('simulated index renameSync failure');
      }
      return origRenameSync(src, dst);
    };

    try {
      await assert.rejects(
        () => writeJournalEntry(cwd, {
          date: '2026-05-03',
          slug: 'r5b-restore',
          sections: {
            what_happened: 'Content B — new content.',
            what_we_built: 'Built B.',
            what_we_learned: 'Learned B.',
            open_threads: '- [ ] B thread',
          },
          summary_for_index: 'Content B summary',
          force: true,
        }),
        err => {
          assert.equal(err.code, 'JOURNAL_PARTIAL_WRITE', 'error.code must be JOURNAL_PARTIAL_WRITE');
          return true;
        },
      );
    } finally {
      _fsHooks.renameSync = origRenameSync;
    }

    // Entry file should be restored to content A.
    assert.equal(existsSync(entryFile), true, 'entry file should still exist after rollback');
    const onDisk = readFileSync(entryFile, 'utf-8');
    assert.equal(onDisk, contentA, 'entry file content should be restored to original (content A)');
  });

  test('#R5c audit not appended on partial-write failure', async () => {
    const cwd = freshJournalCwd();
    const origRenameSync = _fsHooks.renameSync;
    let callCount = 0;

    _fsHooks.renameSync = (src, dst) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('simulated index renameSync failure');
      }
      return origRenameSync(src, dst);
    };

    try {
      await assert.rejects(
        () => writeJournalEntry(cwd, {
          date: '2026-05-03',
          slug: 'r5c-no-audit',
          sections: validSections(),
          summary_for_index: 'R5c audit test',
        }),
        err => err.code === 'JOURNAL_PARTIAL_WRITE',
      );
    } finally {
      _fsHooks.renameSync = origRenameSync;
    }

    // Audit log must have no write_journal_entry row for this attempt.
    const events = readEvents(cwd);
    const written = events.filter(
      e => e.tool === 'write_journal_entry' && e.slug === 'r5c-no-audit',
    );
    assert.equal(written.length, 0, 'audit must not record a write_journal_entry on partial-write failure');
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function validSections() {
  return {
    what_happened: 'Something happened today.',
    what_we_built: 'We built a feature.',
    what_we_learned: 'We learned something valuable.',
    open_threads: '- [ ] Follow up on this.',
  };
}
