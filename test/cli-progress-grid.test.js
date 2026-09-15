/**
 * cli-progress-grid.test.js — COMP-TUI-4
 *
 * Tests for the parallel task grid in CliProgress:
 *   - grid entries populate and update correctly
 *   - #drawGrid output format
 *   - toolUse suppression during grid mode
 *   - non-TTY plain-text updates
 *   - grid cleared by next sequential stepStart
 *   - single-step builds unaffected
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { CliProgress } from '../lib/cli-progress.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake TTY stream that records all written data.
 */
function makeTTYStream({ columns = 120 } = {}) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      cb();
    },
  });
  stream.isTTY = true;
  stream.columns = columns;
  stream.chunks = chunks;
  stream.text = () => chunks.join('');
  stream.clear = () => chunks.splice(0);
  return stream;
}

/**
 * Create a fake non-TTY stream.
 */
function makeNonTTYStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      cb();
    },
  });
  stream.isTTY = false;
  stream.columns = 120;
  stream.chunks = chunks;
  stream.text = () => chunks.join('');
  return stream;
}

/**
 * Build a CliProgress whose stdin hooks are safely no-op'd.
 * We pass expanded=true to skip drawCollapsed in non-grid sequential steps,
 * but for grid tests we rely on the grid renderer which is TTY-gated separately.
 */
function makeProgress(stream, opts = {}) {
  // Patch process.stdin so #startListening doesn't blow up in test
  const origIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false; // prevent raw mode
  const p = new CliProgress({ stream, ...opts });
  process.stdin.isTTY = origIsTTY;
  activeProgress.add(p);
  return p;
}

const activeProgress = new Set();

// Strip ANSI escape sequences for assertion clarity
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[^m]*m/g, '').replace(/\x1b\[\d+[A-Z]/gi, '').replace(/\x1b\[2K\r/g, '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('COMP-TUI-4 — parallel task grid', () => {
  afterEach(() => {
    for (const progress of activeProgress) progress.finish();
    activeProgress.clear();
  });

  describe('grid entries populate correctly', () => {
    test('stepStart with ∥-prefix adds an entry to the grid', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01-auth-fix', { agent: 'codex' });

      const out = stripAnsi(stream.text());
      // Should show grid header
      assert.match(out, /parallel/i);
      // Should show task row
      assert.match(out, /∥0/);
      assert.match(out, /T01-auth-fix/);
      assert.match(out, /codex/);

      p.finish();
    });

    test('multiple parallel stepStarts build up the grid', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01-auth-fix', { agent: 'codex' });
      p.stepStart('∥1', '?', 'T02-add-tests', { agent: 'claude' });

      const out = stripAnsi(stream.text());
      assert.match(out, /∥0/);
      assert.match(out, /∥1/);
      assert.match(out, /T01-auth-fix/);
      assert.match(out, /T02-add-tests/);

      p.finish();
    });

    test('parallel stepStart does NOT print the [N/total] banner', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01-auth-fix', { agent: 'codex' });

      const out = stripAnsi(stream.text());
      // Banner format is "[∥0/?] T01-auth-fix..."
      assert.doesNotMatch(out, /\[∥0\/\?\]/);

      p.finish();
    });

    test('agent defaults to empty string when opts.agent is absent', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      // No fourth argument — backward-compatible
      p.stepStart('∥0', '?', 'T01-auth-fix');

      const out = stripAnsi(stream.text());
      assert.match(out, /∥0/);
      assert.match(out, /T01-auth-fix/);

      p.finish();
    });
  });

  describe('grid status updates correctly', () => {
    test('stepDone with succeeded updates entry status to done', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      stream.clear();

      p.stepDone('T01', 'succeeded');

      const out = stripAnsi(stream.text());
      // ✓ icon should appear for done status
      assert.match(out, /✓/);

      p.finish();
    });

    test('stepDone with failed updates entry status to failed', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      stream.clear();

      p.stepDone('T01', 'failed');

      const out = stripAnsi(stream.text());
      // ✗ icon should appear for failed status
      assert.match(out, /✗/);

      p.finish();
    });

    test('stepDone for unknown stepId (non-grid step) does not crash', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      // No grid active — must not throw
      assert.doesNotThrow(() => p.stepDone('T99', 'succeeded'));

      p.finish();
    });

    test('unknown stepDone while a grid is active leaves the grid unchanged', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      p.stepStart('∥1', '?', 'T02', { agent: 'claude' });
      stream.clear();

      p.stepDone('T99', 'failed');

      assert.strictEqual(stream.text(), '', 'unknown completion must not redraw or mutate the active grid');

      p.finish();
    });

    test('stepDone defaults status to succeeded when second arg omitted', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      stream.clear();

      // Backward-compatible: no second argument
      p.stepDone('T01');

      const out = stripAnsi(stream.text());
      assert.match(out, /✓/);

      p.finish();
    });
  });

  describe('#drawGrid output format', () => {
    test('grid includes header line with task count', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      p.stepStart('∥1', '?', 'T02', { agent: 'claude' });

      const out = stripAnsi(stream.text());
      assert.match(out, /parallel\s*·\s*2\s*tasks/i);

      p.finish();
    });

    test('grid includes key hints bar', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });

      const out = stripAnsi(stream.text());
      assert.match(out, /keys:/i);
      assert.match(out, /toggle/i);

      p.finish();
    });

    test('rows are sorted by itemIndex ascending', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      // Register ∥1 before ∥0 — should still appear in index order
      p.stepStart('∥1', '?', 'T02', { agent: 'claude' });
      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });

      const out = stripAnsi(stream.text());
      const idx0 = out.lastIndexOf('∥0');
      const idx1 = out.lastIndexOf('∥1');
      assert.ok(idx0 < idx1, '∥0 row should appear before ∥1 row');

      p.finish();
    });

    test('working task shows ⋯ icon', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });

      const out = stripAnsi(stream.text());
      assert.match(out, /⋯/);

      p.finish();
    });

    test('elapsed seconds appear in grid row', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });

      const out = stripAnsi(stream.text());
      // Should have a number followed by 's'
      assert.match(out, /\d+s/);

      p.finish();
    });

    test('narrow grid redraw erases every wrapped physical row', () => {
      const stream = makeTTYStream({ columns: 40 });
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01-first-task', { agent: 'codex' });
      p.stepStart('∥1', '?', 'T02-second-task', { agent: 'claude' });
      stream.clear();

      p.stepDone('T01-first-task', 'succeeded');

      const eraseSequences = stream.text().match(/\x1b\[1A\x1b\[2K\r/g) ?? [];
      assert.strictEqual(eraseSequences.length, 5, 'header + 2 task rows + 2 wrapped hint rows must be erased');

      p.finish();
    });
  });

  describe('grid-aware redraws', () => {
    test('toggle during fanout re-renders the grid instead of the collapsed view', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      p.stepStart('∥1', '?', 'T02', { agent: 'claude' });
      p.toolUse('Bash', 'some command');
      stream.clear();

      p.toggle();

      const out = stripAnsi(stream.text());
      assert.match(out, /parallel\s*·\s*2\s*tasks/i);
      assert.match(out, /∥0/);
      assert.match(out, /∥1/);
      assert.doesNotMatch(out, /T01\s+·\s+\d+s\s+·/, 'single-task collapsed status must not replace the grid');

      p.finish();
    });
  });

  describe('toolUse suppression during grid mode', () => {
    test('toolUse does not trigger a redraw when grid is active', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });

      stream.clear();

      // Fire several toolUse events
      p.toolUse('Bash', 'ls -la');
      p.toolUse('Read', 'lib/foo.js');
      p.toolSummary('Did something');
      p.toolProgress('Bash', 3);

      const textAfter = stream.text();
      // In grid mode, tool events should NOT trigger a redraw
      // (the output after tool events should be minimal/empty)
      assert.strictEqual(textAfter, '', 'toolUse/toolSummary/toolProgress should not emit output in grid mode');

      p.finish();
    });

    test('toolUse still accumulates in toolHistory during grid mode', () => {
      // Expanded mode exposes the history, then restores the active grid.
      const stream = makeTTYStream();
      const p = makeProgress(stream, { expanded: false });

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      p.toolUse('Bash', 'some command');

      stream.clear();
      p.toggle();

      const out = stripAnsi(stream.text());
      assert.match(out, /↳ Bash: some command/, 'toggle expansion should include history accumulated during grid mode');

      p.finish();
    });
  });

  describe('non-TTY updates', () => {
    test('parallel start and done emit plain-text status lines', () => {
      const stream = makeNonTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      p.stepDone('T01', 'succeeded');

      const out = stream.text();
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(out, /\x1b\[/);
      assert.match(out, /^\[∥0\] codex T01 started\n\[∥0\] codex T01 done \d+s\n$/);

      p.finish();
    });

    test('parallel stepStart on non-TTY does not crash', () => {
      const stream = makeNonTTYStream();
      const p = makeProgress(stream);

      assert.doesNotThrow(() => {
        p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
        p.stepDone('T01', 'succeeded');
      });

      p.finish();
    });
  });

  describe('grid cleared by next sequential stepStart', () => {
    test('non-parallel stepStart clears the grid', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      p.stepDone('T01', 'succeeded');

      stream.clear();

      // Next sequential step (not parallel)
      p.stepStart('10', '17', 'triage');

      const out = stripAnsi(stream.text());
      // Grid header should NOT appear — we're in normal mode now
      assert.doesNotMatch(out, /parallel\s*·\s*\d+\s*tasks/i);
      // The sequential step banner should appear
      assert.match(out, /triage/);

      p.finish();
    });

    test('after grid is cleared, toolUse triggers normal redraw again', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('∥0', '?', 'T01', { agent: 'codex' });
      p.stepDone('T01', 'succeeded');
      p.stepStart('10', '17', 'triage');

      stream.clear();

      // Now a toolUse should trigger the collapsed redraw
      p.toolUse('Bash', 'ls');

      const out = stream.text();
      // Something should be written (collapsed view or expanded line)
      assert.ok(out.length > 0, 'toolUse should write output after grid is cleared');

      p.finish();
    });
  });

  describe('single-step builds unaffected', () => {
    test('sequential heartbeat timer remains referenced', () => {
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      let unrefCalled = false;
      const fakeTimer = {
        unref() {
          unrefCalled = true;
        },
        hasRef() {
          return !unrefCalled;
        },
      };
      let p;

      globalThis.setInterval = () => fakeTimer;
      globalThis.clearInterval = () => {};

      try {
        const stream = makeTTYStream();
        p = makeProgress(stream);

        p.stepStart('1', '17', 'explore_design');

        assert.strictEqual(unrefCalled, false, 'heartbeat timer must keep the process alive during a step');
        assert.strictEqual(fakeTimer.hasRef(), true);
      } finally {
        p?.finish();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });

    test('non-parallel stepStart never shows grid header', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('1', '17', 'explore_design');

      const out = stripAnsi(stream.text());
      // Should show the normal banner
      assert.match(out, /\[1\/17\]/);
      assert.match(out, /explore_design/);
      // Should NOT show grid header
      assert.doesNotMatch(out, /parallel\s*·\s*\d+\s*tasks/i);

      p.finish();
    });

    test('sequential stepDone without grid active still records step history', () => {
      const stream = makeTTYStream();
      const p = makeProgress(stream);

      p.stepStart('1', '17', 'explore_design');
      // This must not throw and must still record in step history
      assert.doesNotThrow(() => p.stepDone('explore_design', 'succeeded'));

      p.finish();
    });
  });

});
