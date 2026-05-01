/**
 * bug-ledger.test.js — Unit tests for COMP-FIX-HARD bug-ledger helpers.
 *
 * Run: node --test test/bug-ledger.test.js
 *
 * Coverage:
 *   - getHypothesesPath returns expected path
 *   - appendHypothesisEntry creates parent dir if missing
 *   - appendHypothesisEntry → readHypotheses round-trip
 *   - idempotency on (attempt, ts)
 *   - readHypotheses on missing file returns []
 *   - readHypotheses tolerates malformed JSON lines (warn + skip)
 *   - formatRejectedHypotheses with all rejected → markdown header + blocks
 *   - formatRejectedHypotheses with mixed verdicts → only rejected appear
 *   - formatRejectedHypotheses with empty array → returns ""
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  getHypothesesPath,
  appendHypothesisEntry,
  readHypotheses,
  formatRejectedHypotheses,
} = await import(`${REPO_ROOT}/lib/bug-ledger.js`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpCwd() {
  return mkdtempSync(join(tmpdir(), 'bug-ledger-test-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Capture stderr writes during a callback
function captureStderr(fn) {
  const orig = console.warn;
  const captured = [];
  console.warn = (...args) => { captured.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return captured;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getHypothesesPath', () => {
  test('returns docs/bugs/<bug-code>/hypotheses.jsonl under cwd', () => {
    const cwd = '/tmp/foo';
    const p = getHypothesesPath(cwd, 'BUG-123');
    assert.equal(p, join(cwd, 'docs', 'bugs', 'BUG-123', 'hypotheses.jsonl'));
  });
});

describe('appendHypothesisEntry + readHypotheses', () => {
  test('append → read round-trip', () => {
    const cwd = makeTmpCwd();
    try {
      const entry = {
        attempt: 1,
        ts: '2026-05-01T12:00:00Z',
        hypothesis: 'Race condition in writer',
        verdict: 'rejected',
        evidence_against: ['No race observed in logs'],
        next_to_try: 'Inspect lock ordering',
      };
      appendHypothesisEntry(cwd, 'BUG-1', entry);
      const got = readHypotheses(cwd, 'BUG-1');
      assert.equal(got.length, 1);
      assert.deepEqual(got[0], entry);
    } finally {
      cleanup(cwd);
    }
  });

  test('creates parent directory if missing', () => {
    const cwd = makeTmpCwd();
    try {
      const path = getHypothesesPath(cwd, 'BUG-NEW');
      assert.equal(existsSync(dirname(path)), false);
      appendHypothesisEntry(cwd, 'BUG-NEW', {
        attempt: 1, ts: '2026-05-01T00:00:00Z', hypothesis: 'h', verdict: 'confirmed',
      });
      assert.equal(existsSync(path), true);
    } finally {
      cleanup(cwd);
    }
  });

  test('idempotent on (attempt, ts) — same key written twice yields one entry', () => {
    const cwd = makeTmpCwd();
    try {
      const entry = {
        attempt: 2,
        ts: '2026-05-01T12:34:56Z',
        hypothesis: 'first',
        verdict: 'rejected',
      };
      appendHypothesisEntry(cwd, 'BUG-2', entry);
      // Second call with same (attempt, ts) but different content — should be skipped.
      appendHypothesisEntry(cwd, 'BUG-2', { ...entry, hypothesis: 'second-attempt-write' });
      const got = readHypotheses(cwd, 'BUG-2');
      assert.equal(got.length, 1);
      assert.equal(got[0].hypothesis, 'first');
    } finally {
      cleanup(cwd);
    }
  });

  test('different (attempt, ts) entries both persisted', () => {
    const cwd = makeTmpCwd();
    try {
      appendHypothesisEntry(cwd, 'BUG-3', {
        attempt: 1, ts: '2026-05-01T00:00:00Z', hypothesis: 'a', verdict: 'rejected',
      });
      appendHypothesisEntry(cwd, 'BUG-3', {
        attempt: 2, ts: '2026-05-01T00:00:01Z', hypothesis: 'b', verdict: 'confirmed',
      });
      const got = readHypotheses(cwd, 'BUG-3');
      assert.equal(got.length, 2);
    } finally {
      cleanup(cwd);
    }
  });
});

describe('readHypotheses', () => {
  test('returns [] when file missing', () => {
    const cwd = makeTmpCwd();
    try {
      assert.deepEqual(readHypotheses(cwd, 'NEVER-WAS'), []);
    } finally {
      cleanup(cwd);
    }
  });

  test('skips malformed JSON lines, returns valid ones, warns to stderr', () => {
    const cwd = makeTmpCwd();
    try {
      const valid1 = { attempt: 1, ts: '2026-05-01T00:00:00Z', hypothesis: 'a', verdict: 'rejected' };
      const valid2 = { attempt: 2, ts: '2026-05-01T00:00:01Z', hypothesis: 'b', verdict: 'confirmed' };
      const path = getHypothesesPath(cwd, 'BUG-MAL');
      mkdirSync(dirname(path), { recursive: true });
      const contents =
        JSON.stringify(valid1) + '\n' +
        '{not valid json at all\n' +
        JSON.stringify(valid2) + '\n';
      writeFileSync(path, contents, 'utf8');

      let warnings;
      const got = (() => {
        let result;
        warnings = captureStderr(() => { result = readHypotheses(cwd, 'BUG-MAL'); });
        return result;
      })();

      assert.equal(got.length, 2);
      assert.deepEqual(got[0], valid1);
      assert.deepEqual(got[1], valid2);
      assert.ok(warnings.length >= 1, 'expected at least one stderr warning');
    } finally {
      cleanup(cwd);
    }
  });
});

describe('formatRejectedHypotheses', () => {
  test('returns "" for empty array', () => {
    assert.equal(formatRejectedHypotheses([]), '');
  });

  test('returns "" when no rejected entries', () => {
    const out = formatRejectedHypotheses([
      { attempt: 1, ts: 't1', hypothesis: 'h1', verdict: 'confirmed' },
      { attempt: 2, ts: 't2', hypothesis: 'h2', verdict: 'inconclusive' },
    ]);
    assert.equal(out, '');
  });

  test('renders header + one block per rejected entry', () => {
    const entries = [
      {
        attempt: 1, ts: 't1', hypothesis: 'Race condition', verdict: 'rejected',
        evidence_against: ['No race observed'], next_to_try: 'Check locks',
      },
      {
        attempt: 2, ts: 't2', hypothesis: 'Stale cache', verdict: 'rejected',
        evidence_against: ['Cache was empty'],
      },
    ];
    const md = formatRejectedHypotheses(entries);
    assert.match(md, /## Previously Rejected Hypotheses/);
    assert.match(md, /Race condition/);
    assert.match(md, /Stale cache/);
  });

  test('only rejected entries appear in mixed list', () => {
    const entries = [
      { attempt: 1, ts: 't1', hypothesis: 'Confirmed thing', verdict: 'confirmed' },
      { attempt: 2, ts: 't2', hypothesis: 'Rejected thing', verdict: 'rejected' },
      { attempt: 3, ts: 't3', hypothesis: 'Inconclusive thing', verdict: 'inconclusive' },
    ];
    const md = formatRejectedHypotheses(entries);
    assert.match(md, /## Previously Rejected Hypotheses/);
    assert.match(md, /Rejected thing/);
    assert.doesNotMatch(md, /Confirmed thing/);
    assert.doesNotMatch(md, /Inconclusive thing/);
  });
});
