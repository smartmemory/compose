/**
 * test/backfill-evidence.test.js — COMP-LIFECYCLE-BACKFILL blueprint §4.3.
 *
 * Against a REAL tmp git repo (the makeWorkspace fixture pattern at
 * test/completion-gate.test.js:38-60) plus a REAL symlink. Nothing here is
 * mocked: the whole point of the resolver is that it reads the substrate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONFIDENCE_BY_KIND, deriveConfidence, resolveEvidenceRef,
} from '../lib/backfill-evidence.js';

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'bfev-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(path.join(root, 'README.md'), '# t\n');
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'design.md'), '# d\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const sha = git('rev-parse', 'HEAD').trim();
  return { root, sha, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('CONFIDENCE_BY_KIND is frozen and deriveConfidence throws on an unknown kind', () => {
  assert.deepEqual({ ...CONFIDENCE_BY_KIND }, { commit: 0.9, path: 0.6 });
  assert.ok(Object.isFrozen(CONFIDENCE_BY_KIND));
  assert.equal(deriveConfidence('commit'), 0.9);
  assert.equal(deriveConfidence('path'), 0.6);
  assert.throws(() => deriveConfidence('vibes'), /unknown evidence kind/);
});

test('a commit SHA is verified in the REAL repo and resolves to its AUTHOR date', () => {
  const { root, sha, cleanup } = makeRepo();
  try {
    const r = resolveEvidenceRef(root, { kind: 'commit', ref: sha });
    assert.equal(r.kind, 'commit');
    assert.equal(r.ref, sha);
    assert.ok(Number.isFinite(r.observedEpochMs));
    assert.equal(r.observedEpochMs, Date.parse(r.observedTime));
    // The author date, not the committer date — Decision 3.
    const authored = execFileSync('git', ['show', '-s', '--format=%aI', sha], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(r.observedTime, authored);
    assert.ok(Number.isFinite(Date.parse(r.verifiedAt)));
  } finally { cleanup(); }
});

test('BP-8: an author date with a UTC OFFSET still yields a correct epoch', () => {
  const { root, git, cleanup } = makeRepo();
  try {
    writeFileSync(path.join(root, 'b.txt'), 'b\n');
    git('add', '-A');
    execFileSync('git', ['commit', '-qm', 'offset'], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-06-01T02:00:00+02:00', GIT_COMMITTER_DATE: '2026-06-01T02:00:00+02:00' },
    });
    const sha = git('rev-parse', 'HEAD').trim();
    const r = resolveEvidenceRef(root, { kind: 'commit', ref: sha });
    assert.match(r.observedTime, /\+02:00$/);
    assert.equal(r.observedEpochMs, Date.parse('2026-06-01T00:00:00.000Z'));
    // The string form sorts AFTER the equivalent Z form; the epoch form does not.
    assert.ok(r.observedTime > '2026-06-01T00:00:00.000Z');
    assert.equal(r.observedEpochMs, Date.parse('2026-06-01T00:00:00Z'));
  } finally { cleanup(); }
});

test('a SHA that is not a commit in this repo is refused', () => {
  const { root, cleanup } = makeRepo();
  try {
    assert.throws(
      () => resolveEvidenceRef(root, { kind: 'commit', ref: 'a'.repeat(40) }),
      /not found in repository/,
    );
  } finally { cleanup(); }
});

test('a repo-relative path resolves to its mtime', () => {
  const { root, cleanup } = makeRepo();
  try {
    const when = new Date('2026-07-04T12:00:00.000Z');
    utimesSync(path.join(root, 'docs', 'design.md'), when, when);
    const r = resolveEvidenceRef(root, { kind: 'path', ref: 'docs/design.md' });
    assert.equal(r.kind, 'path');
    assert.equal(r.observedTime, when.toISOString());
    assert.equal(r.observedEpochMs, when.getTime());
  } finally { cleanup(); }
});

test('an absolute path, a ~ path and a ../ escape are all refused', () => {
  const { root, cleanup } = makeRepo();
  try {
    assert.throws(() => resolveEvidenceRef(root, { kind: 'path', ref: '/etc/passwd' }), /repo-relative/);
    assert.throws(() => resolveEvidenceRef(root, { kind: 'path', ref: '~/x' }), /repo-relative/);
    assert.throws(() => resolveEvidenceRef(root, { kind: 'path', ref: '../../etc/passwd' }), /must not contain/);
  } finally { cleanup(); }
});

test('a REAL repo-internal symlink pointing outside the repo is refused', () => {
  const { root, cleanup } = makeRepo();
  const outside = mkdtempSync(path.join(tmpdir(), 'bfev-out-'));
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'docs', 'leak.md'));
    assert.ok(existsSync(path.join(root, 'docs', 'leak.md')));
    assert.throws(
      () => resolveEvidenceRef(root, { kind: 'path', ref: 'docs/leak.md' }),
      /symlinks outside cwd/,
    );
  } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('a repo-INTERNAL symlink is accepted, and a directory is not a file', () => {
  const { root, cleanup } = makeRepo();
  try {
    symlinkSync(path.join(root, 'docs', 'design.md'), path.join(root, 'docs', 'alias.md'));
    const r = resolveEvidenceRef(root, { kind: 'path', ref: 'docs/alias.md' });
    assert.equal(r.kind, 'path');
    assert.throws(() => resolveEvidenceRef(root, { kind: 'path', ref: 'docs' }), /must point at a file/);
    assert.throws(() => resolveEvidenceRef(root, { kind: 'path', ref: 'docs/nope.md' }), /does not exist/);
  } finally { cleanup(); }
});

test('macOS firmlink: a cwd reached through /System/Volumes/Data still contains its own files', {
  skip: !existsSync('/System/Volumes/Data') ? 'not macOS' : false,
}, () => {
  const { root, cleanup } = makeRepo();
  try {
    // tmpdir() on macOS is itself a symlink (/var -> /private/var), so the
    // firmlink mirror is built from the REAL path.
    const firmlinked = `/System/Volumes/Data${realpathSync(root)}`;
    assert.ok(existsSync(firmlinked), 'the firmlink mirror must exist for this test to mean anything');
    // realpath does NOT collapse the firmlink — this is the landmine.
    assert.ok(realpathSync(firmlinked).startsWith('/System/Volumes/Data'));
    // …and yet an ordinary repo-relative path resolves cleanly through it.
    const r = resolveEvidenceRef(firmlinked, { kind: 'path', ref: 'docs/design.md' });
    assert.equal(r.kind, 'path');
    assert.ok(Number.isFinite(r.observedEpochMs));
  } finally { cleanup(); }
});

test('an unknown evidence kind throws BEFORE any I/O', () => {
  assert.throws(
    () => resolveEvidenceRef('/nonexistent-root', { kind: 'guess', ref: 'x' }),
    /unknown evidence kind/,
  );
  assert.throws(() => resolveEvidenceRef('/x', { kind: 'commit', ref: '' }), /non-empty string/);
});
