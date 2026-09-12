/**
 * build-stream-usage-provenance.test.js — COMP-COST-OWNER S2.
 *
 * Unknown cost must stay unknown all the way to the screen.
 *
 * Traced 2026-09-12: a step whose cost nobody could state was converted to the
 * number 0 twice on its way out — once by the stream writer (`cost_usd:
 * usage.cost_usd ?? 0`) and again by the cockpit bridge (`event.cost_usd ?? 0`) —
 * and `usd_source` was dropped entirely by the bridge's projection. The cockpit
 * then rendered `<$0.001` for a call that may have cost dollars, in a formatter
 * that ALREADY had a correct `usd == null` branch it could never reach.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { formatCost } = await import('../src/lib/format-cost.js');
const { BuildStreamWriter } = await import('../lib/build-stream-writer.js');
const { BuildStreamBridge } = await import('../server/build-stream-bridge.js');

/** Capture what a writer would emit, without touching a filesystem. */
function captureWriter() {
  const events = [];
  const writer = Object.create(BuildStreamWriter.prototype);
  writer.write = (event) => { events.push(event); return event; };
  return { writer, events };
}

const project = (event) => BuildStreamBridge.prototype._mapEvent.call({}, event);

describe('COMP-COST-OWNER S2: the stream writer does not invent a zero', () => {
  test('a step with STATED cost carries both the amount and its provenance', () => {
    const { writer, events } = captureWriter();
    writer.writeUsage('work', { input_tokens: 10, output_tokens: 20, cost_usd: 0.25, model: 'm' },
      { usdSource: 'reported' });
    assert.equal(events.length, 1);
    assert.equal(events[0].cost_usd, 0.25);
    assert.equal(events[0].usd_source, 'reported');
  });

  test('an ESTIMATED cost is never promoted to reported', () => {
    const { writer, events } = captureWriter();
    writer.writeUsage('work', { input_tokens: 10, output_tokens: 20, cost_usd: 0.25 },
      { usdSource: 'estimated' });
    assert.equal(events[0].usd_source, 'estimated');
  });

  test('an UNKNOWN cost omits the key rather than writing 0', () => {
    const { writer, events } = captureWriter();
    writer.writeUsage('work', { input_tokens: 10, output_tokens: 20 }, { usdSource: null });
    const event = events[0];
    // The tokens are real and must survive.
    assert.equal(event.input_tokens, 10);
    assert.equal(event.output_tokens, 20);
    // The cost is not. `?? 0` here is what made "we could not price this" read
    // downstream as "the provider reported zero".
    assert.ok(!Object.hasOwn(event, 'cost_usd'), `cost_usd should be absent, got ${event.cost_usd}`);
    assert.ok(!Object.hasOwn(event, 'usd_source'));
  });

  test('an unrecognised provenance is treated as unknown, never passed through', () => {
    const { writer, events } = captureWriter();
    writer.writeUsage('work', { input_tokens: 1, output_tokens: 1, cost_usd: 5 }, { usdSource: 'vibes' });
    assert.ok(!Object.hasOwn(events[0], 'usd_source'));
    assert.ok(!Object.hasOwn(events[0], 'cost_usd'), 'an unlabelled dollar must not survive');
  });
});

describe('COMP-COST-OWNER S2: the bridge carries provenance instead of flattening it', () => {
  test('a stated cost reaches the cockpit with its provenance', () => {
    const out = project({ type: 'step_usage', stepId: 'work', input_tokens: 1, output_tokens: 2, cost_usd: 0.5, usd_source: 'estimated' });
    assert.equal(out.cost_usd, 0.5);
    assert.equal(out.usd_source, 'estimated');
  });

  test('an unknown cost arrives at the cockpit as UNKNOWN, not as 0', () => {
    const out = project({ type: 'step_usage', stepId: 'work', input_tokens: 1, output_tokens: 2 });
    // Tokens still default to 0 — a missing token count genuinely is zero tokens.
    assert.equal(out.input_tokens, 1);
    // Cost does not. This is the assertion the old `event.cost_usd ?? 0` failed.
    assert.equal(out.cost_usd, null);
    assert.equal(out.usd_source, null);
  });
});

describe('COMP-COST-OWNER S2: one formatter, and it can say "unknown"', () => {
  test('unknown is not a number', () => {
    for (const value of [null, undefined, NaN, 'x', -1]) {
      assert.equal(formatCost(value), '—', `formatted ${String(value)} as a cost`);
    }
  });

  test('a genuine zero is still rendered as zero', () => {
    // The distinction that matters: this build really did cost nothing, and that is
    // a different statement from "we do not know what it cost".
    assert.equal(formatCost(0), '$0.00');
  });

  test('a real amount formats, and a tiny one is not rounded away to zero', () => {
    assert.equal(formatCost(1.5), '$1.50');
    assert.equal(formatCost(0.1234), '$0.1234');
    assert.equal(formatCost(0.0000004), '<$0.001');
  });

  test('callers may choose their own unknown marker and precision', () => {
    assert.equal(formatCost(null, { unknown: '' }), '');
    assert.equal(formatCost(2, { digits: 4 }), '$2.0000');
  });
});
