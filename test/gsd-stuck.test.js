/**
 * COMP-GSD-5 Task 2: GsdStuckDetector unit tests.
 *
 * The detector consumes BuildStreamEvents (tool_use_summary + tool_result),
 * keyed by event.task_id, and fires four signals at configured thresholds:
 *   - same_file:        one file_path edited >= sameFileEdits times (FixChainDetector)
 *   - error_recurrence: a normalized error hash recurs >= errorRepeats
 *   - no_progress:      >= noProgressCalls consecutive non-file-changing tool calls
 *   - wall_clock:       nowMs - startedAt >= wallClockMs
 *
 * Telemetry contract (schema 0.2.7):
 *   tool_use_summary.metadata = { tool, summary, ok, duration_ms, input, tool_use_id }
 *     - input.file_path present for Edit/Write/MultiEdit/Read
 *   tool_result.metadata     = { tool_use_id, ok, output }
 *   envelope.task_id carries the per-task attribution.
 *
 * No mocking of the detector; pure logic exercised through real events.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { GsdStuckDetector } = await import(`${REPO_ROOT}/lib/gsd-stuck.js`);

// --- Event factories ---------------------------------------------------------

let seq = 0;
function envelope(kind, taskId, metadata) {
  return {
    schema_version: '0.2.7',
    flow_id: 'F1',
    step_id: 'execute',
    seq: seq++,
    ts: new Date().toISOString(),
    kind,
    task_id: taskId,
    metadata,
  };
}

function toolCall(taskId, tool, { filePath, ok = true, toolUseId } = {}) {
  const input = {};
  if (filePath !== undefined) input.file_path = filePath;
  return envelope('tool_use_summary', taskId, {
    tool,
    summary: `${tool} call`,
    ok,
    duration_ms: 10,
    input,
    tool_use_id: toolUseId ?? `tu-${seq}`,
  });
}

function toolResult(taskId, { ok, output, toolUseId }) {
  return envelope('tool_result', taskId, {
    tool_use_id: toolUseId ?? `tu-${seq}`,
    ok,
    output,
  });
}

// =============================================================================
// same_file
// =============================================================================

describe('same_file signal', () => {
  test('fires at sameFileEdits hits of one file_path, not below', () => {
    const d = new GsdStuckDetector({ sameFileEdits: 3 });
    d.startTask('T1', 1000);

    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' }));
    // 2 hits — below threshold
    assert.equal(d.check('T1', 2000).stuck, false, 'should not fire at 2 edits');

    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' }));
    const v = d.check('T1', 3000);
    assert.equal(v.stuck, true, 'should fire at 3 edits');
    assert.equal(v.signal, 'same_file');
    assert.match(v.detail, /lib\/foo\.js/);
  });

  test('Write and MultiEdit also count toward same_file', () => {
    const d = new GsdStuckDetector({ sameFileEdits: 3 });
    d.startTask('T1', 1000);
    d.record(toolCall('T1', 'Write', { filePath: 'lib/foo.js' }));
    d.record(toolCall('T1', 'MultiEdit', { filePath: 'lib/foo.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' }));
    assert.equal(d.check('T1', 2000).stuck, true);
  });

  test('Read does NOT count toward same_file', () => {
    const d = new GsdStuckDetector({ sameFileEdits: 3 });
    d.startTask('T1', 1000);
    d.record(toolCall('T1', 'Read', { filePath: 'lib/foo.js' }));
    d.record(toolCall('T1', 'Read', { filePath: 'lib/foo.js' }));
    d.record(toolCall('T1', 'Read', { filePath: 'lib/foo.js' }));
    assert.equal(d.check('T1', 2000).stuck, false, 'reads should not trip same_file');
  });

  test('edits spread across distinct files do not fire', () => {
    const d = new GsdStuckDetector({ sameFileEdits: 3 });
    d.startTask('T1', 1000);
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'b.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'c.js' }));
    assert.equal(d.check('T1', 2000).stuck, false);
  });
});

// =============================================================================
// error_recurrence
// =============================================================================

describe('error_recurrence signal', () => {
  test('fires at errorRepeats of a normalized error hash, not below', () => {
    const d = new GsdStuckDetector({ errorRepeats: 3 });
    d.startTask('T1', 1000);
    const err = 'TypeError: cannot read property x of undefined';
    d.record(toolResult('T1', { ok: false, output: err }));
    d.record(toolResult('T1', { ok: false, output: err }));
    assert.equal(d.check('T1', 2000).stuck, false, 'should not fire at 2 repeats');
    d.record(toolResult('T1', { ok: false, output: err }));
    const v = d.check('T1', 3000);
    assert.equal(v.stuck, true);
    assert.equal(v.signal, 'error_recurrence');
  });

  test('cosmetic differences (paths/line-numbers/whitespace) collapse to one hash', () => {
    const d = new GsdStuckDetector({ errorRepeats: 3 });
    d.startTask('T1', 1000);
    // Same logical error, different volatile bits each time.
    d.record(toolResult('T1', { ok: false, output: 'Error at /Users/alice/proj/lib/foo.js:12:5 — boom' }));
    d.record(toolResult('T1', { ok: false, output: 'Error at /tmp/build-xyz/lib/foo.js:48:19 — boom' }));
    d.record(toolResult('T1', { ok: false, output: 'Error   at\t/var/q/lib/foo.js:9:1  —   boom' }));
    const v = d.check('T1', 2000);
    assert.equal(v.stuck, true, 'cosmetic-only diffs must collapse to the same hash');
    assert.equal(v.signal, 'error_recurrence');
  });

  test('genuinely different errors do NOT collapse', () => {
    const d = new GsdStuckDetector({ errorRepeats: 3 });
    d.startTask('T1', 1000);
    d.record(toolResult('T1', { ok: false, output: 'TypeError: x is not a function' }));
    d.record(toolResult('T1', { ok: false, output: 'ReferenceError: y is not defined' }));
    d.record(toolResult('T1', { ok: false, output: 'SyntaxError: unexpected token' }));
    assert.equal(d.check('T1', 2000).stuck, false, 'distinct errors must not collapse');
  });

  test('successful tool_results (ok:true) are ignored', () => {
    const d = new GsdStuckDetector({ errorRepeats: 3 });
    d.startTask('T1', 1000);
    d.record(toolResult('T1', { ok: true, output: 'fine' }));
    d.record(toolResult('T1', { ok: true, output: 'fine' }));
    d.record(toolResult('T1', { ok: true, output: 'fine' }));
    assert.equal(d.check('T1', 2000).stuck, false);
  });
});

// =============================================================================
// no_progress
// =============================================================================

describe('no_progress signal', () => {
  test('fires at noProgressCalls consecutive non-file-changing calls (after first edit)', () => {
    const d = new GsdStuckDetector({ noProgressCalls: 8 });
    d.startTask('T1', 1000);
    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' })); // arm: task has started editing
    for (let i = 0; i < 7; i++) d.record(toolCall('T1', 'Bash'));
    assert.equal(d.check('T1', 2000).stuck, false, '7 calls — below threshold');
    d.record(toolCall('T1', 'Bash'));
    const v = d.check('T1', 3000);
    assert.equal(v.stuck, true);
    assert.equal(v.signal, 'no_progress');
  });

  test('a file-changing tool resets the no-progress counter', () => {
    const d = new GsdStuckDetector({ noProgressCalls: 8 });
    d.startTask('T1', 1000);
    for (let i = 0; i < 7; i++) d.record(toolCall('T1', 'Grep'));
    // One Edit resets the run.
    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' }));
    for (let i = 0; i < 7; i++) d.record(toolCall('T1', 'Grep'));
    assert.equal(d.check('T1', 2000).stuck, false, 'counter must reset after a file-changing tool');
    d.record(toolCall('T1', 'Grep'));
    assert.equal(d.check('T1', 3000).stuck, true, 'fires once 8 consecutive non-file calls accrue post-reset');
  });

  test('Read is non-file-changing and counts toward no_progress (after first edit)', () => {
    const d = new GsdStuckDetector({ noProgressCalls: 3 });
    d.startTask('T1', 1000);
    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' })); // arm
    d.record(toolCall('T1', 'Read', { filePath: 'lib/foo.js' }));
    d.record(toolCall('T1', 'Read', { filePath: 'lib/bar.js' }));
    d.record(toolCall('T1', 'Bash'));
    assert.equal(d.check('T1', 2000).stuck, true, 'reads do not count as progress once editing has started');
  });

  test('upfront exploration before the first edit does NOT trip no_progress', () => {
    const d = new GsdStuckDetector({ noProgressCalls: 3 });
    d.startTask('T1', 1000);
    // A normal task reads/greps/tests before its first write — legitimate work,
    // not a stall. Without an arming edit the counter must stay dormant.
    for (let i = 0; i < 10; i++) d.record(toolCall('T1', 'Read', { filePath: `lib/f${i}.js` }));
    d.record(toolCall('T1', 'Grep'));
    d.record(toolCall('T1', 'Bash'));
    assert.equal(d.check('T1', 2000).stuck, false, 'exploration before the first edit is not a stall');
  });
});

// =============================================================================
// wall_clock
// =============================================================================

describe('wall_clock signal', () => {
  test('fires when nowMs - startedAt >= wallClockMs', () => {
    const d = new GsdStuckDetector({ wallClockMs: 600000 });
    d.startTask('T1', 1000);
    assert.equal(d.check('T1', 1000 + 599999).stuck, false, 'just under threshold');
    const v = d.check('T1', 1000 + 600000);
    assert.equal(v.stuck, true);
    assert.equal(v.signal, 'wall_clock');
  });

  test('does not fire for a task that never started', () => {
    const d = new GsdStuckDetector({ wallClockMs: 1 });
    // No startTask — wall-clock has no baseline.
    assert.equal(d.check('T1', 10_000_000).stuck, false);
  });
});

// =============================================================================
// Verdict shape, isolation, thresholds, serialization
// =============================================================================

describe('verdict shape + per-task isolation', () => {
  test('check returns {stuck:false} when nothing is wrong', () => {
    const d = new GsdStuckDetector();
    d.startTask('T1', 1000);
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    const v = d.check('T1', 2000);
    assert.equal(v.stuck, false);
  });

  test('check returns {stuck, signal, detail} on a verdict', () => {
    const d = new GsdStuckDetector({ sameFileEdits: 2 });
    d.startTask('T1', 1000);
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    const v = d.check('T1', 2000);
    assert.deepEqual(Object.keys(v).sort(), ['detail', 'signal', 'stuck']);
    assert.equal(typeof v.detail, 'string');
  });

  test("one task's events do not trip another task", () => {
    const d = new GsdStuckDetector({ sameFileEdits: 3, noProgressCalls: 3, errorRepeats: 3 });
    d.startTask('T1', 1000);
    d.startTask('T2', 1000);
    // Pile everything onto T1.
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    d.record(toolResult('T1', { ok: false, output: 'boom' }));
    // T2 stays clean.
    assert.equal(d.check('T1', 2000).stuck, true, 'T1 is stuck');
    assert.equal(d.check('T2', 2000).stuck, false, 'T2 must be unaffected by T1 events');
  });

  test('events with no task_id are ignored (gsd is max_concurrent:1 but be defensive)', () => {
    const d = new GsdStuckDetector({ sameFileEdits: 2 });
    d.startTask('T1', 1000);
    const e = toolCall('T1', 'Edit', { filePath: 'a.js' });
    delete e.task_id;
    d.record(e); // no task_id — dropped
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    assert.equal(d.check('T1', 2000).stuck, false, 'untagged event should not have counted');
  });

  test('thresholds come from constructor opts; documented defaults are 3/3/8/600000', () => {
    const dDefault = new GsdStuckDetector();
    assert.deepEqual(
      { sameFileEdits: dDefault.sameFileEdits, errorRepeats: dDefault.errorRepeats, noProgressCalls: dDefault.noProgressCalls, wallClockMs: dDefault.wallClockMs },
      { sameFileEdits: 3, errorRepeats: 3, noProgressCalls: 8, wallClockMs: 600000 },
    );
    const d = new GsdStuckDetector({ sameFileEdits: 5, errorRepeats: 7, noProgressCalls: 11, wallClockMs: 42 });
    assert.equal(d.sameFileEdits, 5);
    assert.equal(d.errorRepeats, 7);
    assert.equal(d.noProgressCalls, 11);
    assert.equal(d.wallClockMs, 42);
  });

  test('reset clears one task without touching others', () => {
    const d = new GsdStuckDetector({ sameFileEdits: 2 });
    d.startTask('T1', 1000);
    d.startTask('T2', 1000);
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'a.js' }));
    d.record(toolCall('T2', 'Edit', { filePath: 'b.js' }));
    d.reset('T1');
    assert.equal(d.check('T1', 2000).stuck, false, 'reset cleared T1');
    // T2 still has its one edit; add another to confirm its state survived reset of T1.
    d.record(toolCall('T2', 'Edit', { filePath: 'b.js' }));
    assert.equal(d.check('T2', 2000).stuck, true, 'T2 survived T1 reset');
  });
});

describe('serialization', () => {
  test('toJSON -> fromJSON round-trips detector state', () => {
    const d = new GsdStuckDetector({ sameFileEdits: 3, errorRepeats: 3, noProgressCalls: 8, wallClockMs: 600000 });
    d.startTask('T1', 1000);
    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' }));
    d.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' }));
    d.record(toolResult('T1', { ok: false, output: 'boom' }));
    d.record(toolCall('T1', 'Bash'));

    const json = JSON.parse(JSON.stringify(d.toJSON()));
    const restored = GsdStuckDetector.fromJSON(json);

    // Thresholds survive.
    assert.equal(restored.sameFileEdits, 3);
    assert.equal(restored.wallClockMs, 600000);

    // State survives: one more same-file edit should now trip the threshold.
    restored.record(toolCall('T1', 'Edit', { filePath: 'lib/foo.js' }));
    const v = restored.check('T1', 2000);
    assert.equal(v.stuck, true, 'restored state should reach same_file threshold on the 3rd edit');
    assert.equal(v.signal, 'same_file');
  });

  test('fromJSON tolerates null/garbage and yields a default detector', () => {
    const d = GsdStuckDetector.fromJSON(null);
    assert.equal(d.sameFileEdits, 3);
    assert.equal(d.check('T1', 1).stuck, false);
  });

  test('wall-clock baseline (startedAt) survives round-trip', () => {
    const d = new GsdStuckDetector({ wallClockMs: 600000 });
    d.startTask('T1', 1000);
    const restored = GsdStuckDetector.fromJSON(JSON.parse(JSON.stringify(d.toJSON())));
    assert.equal(restored.check('T1', 1000 + 600000).stuck, true, 'startedAt baseline must persist');
  });
});
