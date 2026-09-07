/**
 * receipts-gate — a claim written as a fact must carry its receipt.
 *
 * The classifier fixtures below are the ACTUAL lines that did damage in this
 * repo (2026-09-07 sweep), verbatim, and the actual lines that replaced them.
 * A gate shipped without being run against the incidents that justify it is
 * the thing the gate exists to refuse.
 *
 * The range tests drive the real producer: a real git repo, real commits, the
 * real `git diff`/`git log`/`git show` path. No git double.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyDocLine, classifyCommitMessage, scanRange, formatViolations,
} from '../lib/receipts-gate.js';

// ---------------------------------------------------------------------------
// flake-label — the three "known flake" notes, verbatim, and their closures
// ---------------------------------------------------------------------------

describe('flake-label', () => {
  const OFFENDERS = [
    // journal session 115, open thread
    '- [ ] `test/build-stream-smoke.test.js` still flakes under full-suite load; green in isolation every time.',
    // journal session 99, open thread
    '- [ ] Known suite flakes, not regressions: build-stream-smoke retry, transient stratum-mcp PARSE_ERROR in lifecycle-guard-e2e.',
    // COMP-LIFECYCLE-BACKFILL plan
    '      `npm run test:tracker` (100) separately; only `test/build-stream-smoke.test.js` may flake',
    // COMP-PROV-LINEAGE feature.json notes — "fixed" + a binding sha in the same
    // line vouched for this in a first draft; lowercase closure words must not count
    '      "notes": "Two Codex review rounds adjudicated and fixed. Full suite green; build-stream-smoke flake unrelated. Bound to 9ec1a590."',
  ];
  for (const line of OFFENDERS) {
    test(`fires: ${line.trim().slice(0, 60)}…`, () => {
      assert.equal(classifyDocLine(line)?.shape, 'flake-label');
    });
  }

  const RECEIPTED = [
    // a measurement
    'The flake reproduced 14/450 under load and 0/450 with the fix.',
    'not reproduced since, in isolation (15 runs) or in a full node phase.',
    'One failure in 40 runs; 0 of 40 with a settle delay.',
    // closed the way this repo closes claims at the origin
    '      **RESOLVED 2026-09-07 @12a357a — it was never a test-timing problem.**',
    '- [x] still flakes under load. **RESOLVED 2026-09-07** — see 12a357a.',
    // the line disowns the flake
    '      **build-stream-smoke was NOT a flake — resolved 2026-09-07 @12a357a.**',
    '      (no longer expected — that flake was a real bridge defect, now fixed)',
    // mentioned, not asserted
    'The gate rejects a bare `flaky` label without a count.',
    // a heading titles the body, which is scanned on its own
    '### The "flaky" smoke test was real',
  ];
  for (const line of RECEIPTED) {
    test(`passes: ${line.trim().slice(0, 60)}…`, () => {
      assert.equal(classifyDocLine(line), null);
    });
  }

  test('a receipt within the window counts; one outside it does not', () => {
    const claim = 'This test is flaky under load.';
    assert.equal(classifyDocLine(claim, `${claim}\nMeasured: 3/40 failures.`), null);
    assert.equal(classifyDocLine(claim, `${claim}\nSee the numbers in the section below.`)?.shape, 'flake-label');
  });
});

// ---------------------------------------------------------------------------
// test-coverage — FOH-7's ticked boxes, verbatim, and their pinned forms
// ---------------------------------------------------------------------------

describe('test-coverage', () => {
  test('a CHECKED box claiming a test, with no path, fires', () => {
    assert.equal(
      classifyDocLine('- [x] All-members-failed returns an error, never an empty result set (pinned by test)')?.shape,
      'test-coverage',
    );
  });

  test('an UNCHECKED box saying "(pinned by test)" is design intent, not a fact', () => {
    assert.equal(
      classifyDocLine('- [ ] No writes on any portfolio path (pinned by test)'),
      null,
    );
  });

  test('the path may sit on a continuation line of the SAME item', () => {
    const item = [
      '- [x] No writes on any portfolio path (pinned by test)',
      '      **MET 2026-09-07.** `test/maya-routes.test.js:1132` (JSON) and `:1147` (SSE).',
    ].join('\n');
    assert.equal(classifyDocLine(item.split('\n')[0], item), null);
  });

  test('a path in backticks is still a receipt', () => {
    assert.equal(
      classifyDocLine('- [x] refused in v1 (pinned by test — `test/maya-routes.test.js:1031`)'),
      null,
    );
  });

  test('a checked box with no test claim on it is not this gate\'s business', () => {
    assert.equal(classifyDocLine('- [x] `portfolio.members` parsed and validated; duplicates fail loud'), null);
  });
});

// ---------------------------------------------------------------------------
// commit messages
// ---------------------------------------------------------------------------

describe('commit messages', () => {
  test('"suite green" with no counts fires', () => {
    const v = classifyCommitMessage('fix: the thing\n\nVerified independently. Full suite green.');
    assert.deepEqual(v.map((x) => x.shape), ['suite-green']);
  });

  test('counts anywhere in the message are the receipt', () => {
    const v = classifyCommitMessage(
      'fix: the thing\n\nSuite green.\n\nnode 6412/6412, UI 624/624, tracker 100/100.',
    );
    assert.deepEqual(v, []);
  });

  test('a test-coverage claim needs a path somewhere in the message', () => {
    assert.deepEqual(
      classifyCommitMessage('feat: x\n\nThe refusal is pinned by test.').map((x) => x.shape),
      ['test-coverage'],
    );
    assert.deepEqual(
      classifyCommitMessage('feat: x\n\nThe refusal is pinned by test (test/foo.test.js:12).'),
      [],
    );
  });

  test('a commit that DISOWNS a flake anywhere in its body passes', () => {
    // a8cbbb7's shape: the subject quotes the label, the body disowns it
    const msg = "docs: close the 'known flake' claims at their origins\n\nIt was a real product defect (12a357a).";
    assert.deepEqual(classifyCommitMessage(msg), []);
  });

  test('phrases inside a fenced block are not claims', () => {
    const msg = 'docs: gate\n\n```\nsuite green\npinned by test\nflaky\n```\n';
    assert.deepEqual(classifyCommitMessage(msg), []);
  });
});

// ---------------------------------------------------------------------------
// the range scan, against a real repository
// ---------------------------------------------------------------------------

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-gate-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'docs', 'features', 'X'), { recursive: true });
  const commit = (files, message) => {
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

describe('scanRange', () => {
  test('flags an added receipt-less line at file:line, and a receipt-less commit message', () => {
    const { dir, commit } = repo();
    const base = commit({ 'docs/notes.md': '# notes\n\nfine.\n' }, 'init');
    const head = commit(
      { 'docs/notes.md': '# notes\n\nfine.\n\nThe smoke test is flaky under load, ignore it.\n' },
      'docs: note\n\nSuite green after this.',
    );
    const found = scanRange(base, head, { cwd: dir });
    assert.deepEqual(
      found.map((f) => [f.where, f.shape]),
      [['docs/notes.md:5', 'flake-label'], [`commit ${head.slice(0, 7)}`, 'suite-green']],
    );
    assert.match(formatViolations(found), /docs\/notes\.md:5/);
  });

  test('a box flipped [ ]→[x] whose receipt is on an UNCHANGED continuation line passes', () => {
    // A zero-context diff cannot see the continuation line; the item must be
    // read from the file at head. This is exactly e7c47d0's shape.
    const { dir, commit } = repo();
    const doc = (box) => [
      '## Acceptance',
      '',
      `- [${box}] No writes on any portfolio path (pinned by test)`,
      '      `test/maya-routes.test.js:1132` (JSON) and `:1147` (SSE).',
      '- [ ] Something else (pinned by test)',
      '',
    ].join('\n');
    const base = commit({ 'docs/features/X/design.md': doc(' ') }, 'design');
    const head = commit({ 'docs/features/X/design.md': doc('x') }, 'docs: tick the box');
    assert.deepEqual(scanRange(base, head, { cwd: dir }), []);
  });

  test("a NEIGHBOURING item's test path does not vouch for a box that has none", () => {
    // cd6be85's shape: twelve boxes ticked off an audit, paths only on the
    // annotated gaps beside them.
    const { dir, commit } = repo();
    const doc = (box) => [
      `- [${box}] All-members-failed returns an error (pinned by test)`,
      '- [ ] A member unreachable yields a named omission (pinned by test)',
      '      **PARTIAL.** `unreachable` is pinned (`test/fluid-portfolio.test.js:169`).',
      '',
    ].join('\n');
    const base = commit({ 'docs/features/X/design.md': doc(' ') }, 'design');
    const head = commit({ 'docs/features/X/design.md': doc('x') }, 'docs: audit');
    assert.deepEqual(scanRange(base, head, { cwd: dir }).map((f) => f.shape), ['test-coverage']);
  });

  test('does not scan history — only the pushed range', () => {
    const { dir, commit } = repo();
    const a = commit({ 'docs/notes.md': 'This one is flaky, whatever.\n' }, 'old sin');
    const b = commit({ 'docs/notes.md': 'This one is flaky, whatever.\n\nA new, receipted line: 0/40 under load.\n' }, 'docs: fine');
    assert.deepEqual(scanRange(a, b, { cwd: dir }), []);
  });

  test('code fences in docs are not claims', () => {
    const { dir, commit } = repo();
    const a = commit({ 'docs/notes.md': 'x\n' }, 'init');
    const b = commit({ 'docs/notes.md': 'x\n\n```\nflaky\nsuite green\n```\n' }, 'docs: example');
    assert.deepEqual(scanRange(a, b, { cwd: dir }), []);
  });
});
