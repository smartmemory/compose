/**
 * COMPOSE-UX-SIMPLIFY-2 fix1 — class test for the recordFeatureEvent door.
 * One row per writer (journal, changelog, completion, checkpoint):
 *   - success: persists the record AND appends exactly one event.
 *   - event write fails: contract is BEST-EFFORT (feature-events.js recordFeatureEvent,
 *     matching the pre-cut safeAppendEvent). The caller still succeeds, warns once,
 *     the record is kept (never orphan-rolled-back, never duplicated).
 * Guards the cut-4 miss: completion-writer used recordFeatureEvent without importing it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { recordCompletion, getCompletions } from '../lib/completion-writer.js';
import { writeJournalEntry } from '../lib/journal-writer.js';
import { addChangelogEntry } from '../lib/changelog-writer.js';
import { writeCheckpoint } from '../lib/checkpoint/checkpoint-writer.js';
import { readEvents } from '../lib/feature-events.js';
import { writeFeature } from '../lib/feature-json.js';

const SHA = 'a'.repeat(40);

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-writers-'));
  mkdirSync(join(cwd, 'docs', 'features', 'EV-1'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'journal'), { recursive: true });
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, checkpoint: { enabled: true, backend: 'jsonl', confidenceThreshold: 0.6 } }));
  writeFileSync(join(cwd, 'docs', 'features', 'EV-1', 'design.md'), '# d\n');
  writeFeature(cwd, { code: 'EV-1', name: 'Ev', status: 'IN_PROGRESS', created: '2026-10-16', updated: '2026-10-16', phase: 'Phase 1', position: 1, description: 'd' });
  writeFileSync(join(cwd, 'docs', 'journal', 'README.md'),
    '# Developer Journal\n\nPreamble.\n\n## Entries\n\n| Date | Entry | Summary |\n|------|-------|---------|\n');
  execSync('git init -q -b main && git config user.email t@t.io && git config user.name t && git config commit.gpgsign false', { cwd });
  writeFileSync(join(cwd, '.gitignore'), '.compose/\n');
  execSync('git add -A && git commit -q -m init', { cwd });
  return cwd;
}

function breakEventLog(cwd) {
  // a directory where the JSONL file should be: appendFileSync throws EISDIR
  mkdirSync(join(cwd, '.compose', 'data', 'feature-events.jsonl'), { recursive: true });
}

const WRITERS = [
  {
    name: 'journal', tool: 'write_journal_entry',
    run: (cwd) => writeJournalEntry(cwd, {
      date: '2026-10-16', slug: 'ev', summary_for_index: 'ev',
      sections: { what_happened: 'a', what_we_built: 'b', what_we_learned: 'c', open_threads: '- [ ] d' },
    }),
    count: (cwd) => readdirSync(join(cwd, 'docs', 'journal')).filter((f) => f.endsWith('.md') && f !== 'README.md').length,
  },
  {
    name: 'changelog', tool: 'add_changelog_entry',
    run: (cwd) => addChangelogEntry(cwd, { date_or_version: '2026-10-16', code: 'EV-1', summary: 'ev' }),
    count: (cwd) => (existsSync(join(cwd, 'CHANGELOG.md')) ? (readFileSyncSafe(join(cwd, 'CHANGELOG.md')).match(/EV-1/g) || []).length : 0),
  },
  {
    name: 'completion', tool: 'record_completion',
    run: (cwd) => recordCompletion(cwd, { feature_code: 'EV-1', commit_sha: SHA, tests_pass: true, files_changed: [], set_status: false }),
    count: (cwd) => getCompletions(cwd, { feature_code: 'EV-1' }).completions.length,
  },
  {
    name: 'checkpoint', tool: 'write_checkpoint',
    run: async (cwd) => writeCheckpoint(cwd, { featureCode: 'EV-1', phase: 'implementation', trigger: 'manual' }),
    count: (cwd) => {
      const f = join(cwd, '.compose', 'data', 'checkpoints-EV-1.jsonl');
      return existsSync(f) ? readFileSyncSafe(f).split('\n').filter(Boolean).length : 0;
    },
  },
];

import { readFileSync } from 'node:fs';
function readFileSyncSafe(p) { return readFileSync(p, 'utf8'); }

describe('recordFeatureEvent door: every writer persists AND records its event', () => {
  for (const w of WRITERS) {
    test(`${w.name}: record persisted and exactly one ${w.tool} event`, async () => {
      const cwd = project();
      await w.run(cwd);
      assert.equal(w.count(cwd) >= 1, true, 'record persisted');
      const events = readEvents(cwd, { tool: w.tool });
      assert.equal(events.length, 1, `one ${w.tool} event`);
    });

    test(`${w.name}: event write failure is best-effort (caller succeeds, record kept once, warns)`, async () => {
      const cwd = project();
      breakEventLog(cwd);
      const warns = [];
      const orig = console.warn;
      console.warn = (...a) => warns.push(a.join(' '));
      try {
        await w.run(cwd);
      } finally {
        console.warn = orig;
      }
      assert.equal(w.count(cwd), 1, 'record present exactly once');
      assert.ok(warns.some((m) => m.includes('audit append failed')), 'warning names the lost event');
    });
  }

  test('completion: fresh, retry same SHA, and commit-less each leave one record and one event', async () => {
    const cwd = project();
    const a = await recordCompletion(cwd, { feature_code: 'EV-1', commit_sha: SHA, tests_pass: true, files_changed: [], set_status: false });
    assert.equal(a.idempotent, false);
    const b = await recordCompletion(cwd, { feature_code: 'EV-1', commit_sha: SHA, tests_pass: true, files_changed: [], set_status: false });
    assert.equal(b.idempotent, true);
    assert.equal(getCompletions(cwd, { feature_code: 'EV-1' }).completions.length, 1);
    assert.equal(readEvents(cwd, { tool: 'record_completion' }).length, 1);

    const c = await recordCompletion(cwd, { feature_code: 'EV-1', tests_pass: true, files_changed: [], set_status: false });
    assert.equal(c.idempotent, false);
    assert.equal(getCompletions(cwd, { feature_code: 'EV-1' }).completions.length, 2);
    assert.equal(readEvents(cwd, { tool: 'record_completion' }).length, 2);
  });
});
