import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { FixChainDetector, AttemptCounter, TraceValidator, DebugLedger } from '../lib/debug-discipline.js';

describe('FixChainDetector', () => {
  it('starts with no chains', () => {
    const d = new FixChainDetector();
    assert.deepEqual(d.detect(), []);
  });

  it('returns no chains after one iteration', () => {
    const d = new FixChainDetector();
    d.recordIteration(['src/a.js', 'src/b.js']);
    assert.deepEqual(d.detect(), []);
  });

  it('returns warning when same file hit in 2 iterations', () => {
    const d = new FixChainDetector();
    d.recordIteration(['src/a.js']);
    d.recordIteration(['src/a.js', 'src/c.js']);
    const chains = d.detect();
    assert.equal(chains.length, 1);
    assert.equal(chains[0].file, 'src/a.js');
    assert.equal(chains[0].iterations, 2);
    assert.equal(chains[0].level, 'warning');
  });

  it('returns critical when same file hit in 3+ iterations', () => {
    const d = new FixChainDetector();
    d.recordIteration(['src/a.js']);
    d.recordIteration(['src/a.js']);
    d.recordIteration(['src/a.js']);
    const chains = d.detect();
    assert.equal(chains.length, 1);
    assert.equal(chains[0].level, 'critical');
    assert.equal(chains[0].iterations, 3);
  });

  it('tracks multiple files independently', () => {
    const d = new FixChainDetector();
    d.recordIteration(['src/a.js', 'src/b.js']);
    d.recordIteration(['src/a.js']);
    d.recordIteration(['src/b.js']);
    const chains = d.detect();
    assert.equal(chains.length, 2);
  });

  it('tracks iteration count', () => {
    const d = new FixChainDetector();
    assert.equal(d.iteration, 0);
    d.recordIteration(['x.js']);
    assert.equal(d.iteration, 1);
    d.recordIteration(['y.js']);
    assert.equal(d.iteration, 2);
  });

  it('serializes to JSON for persistence', () => {
    const d = new FixChainDetector();
    d.recordIteration(['src/a.js']);
    d.recordIteration(['src/a.js']);
    const json = d.toJSON();
    assert.equal(typeof json, 'object');
    assert.equal(json.iteration, 2);
    assert.ok(json.fileHits['src/a.js']);
  });

  it('restores from JSON', () => {
    const d1 = new FixChainDetector();
    d1.recordIteration(['src/a.js']);
    d1.recordIteration(['src/a.js']);
    const d2 = FixChainDetector.fromJSON(d1.toJSON());
    assert.equal(d2.iteration, 2);
    const chains = d2.detect();
    assert.equal(chains.length, 1);
    assert.equal(chains[0].file, 'src/a.js');
  });
});

describe('AttemptCounter', () => {
  it('starts at attempt 0', () => {
    const c = new AttemptCounter();
    assert.equal(c.count, 0);
  });

  it('increments on record', () => {
    const c = new AttemptCounter();
    c.record({ filesChanged: ['a.css'] });
    assert.equal(c.count, 1);
  });

  it('returns no intervention at attempt 1', () => {
    const c = new AttemptCounter();
    c.record({ filesChanged: ['a.js'] });
    assert.equal(c.getIntervention(), null);
  });

  it('returns trace_reminder at attempt 2 for non-visual', () => {
    const c = new AttemptCounter();
    c.record({ filesChanged: ['a.js'] });
    c.record({ filesChanged: ['a.js'] });
    assert.equal(c.getIntervention(), 'trace_reminder');
  });

  it('returns escalate at attempt 2 for visual bugs', () => {
    const c = new AttemptCounter();
    c.record({ filesChanged: ['layout.css'], isVisual: true });
    c.record({ filesChanged: ['layout.css'], isVisual: true });
    assert.equal(c.getIntervention(), 'escalate');
  });

  it('returns trace_refresh at attempt 3 for non-visual', () => {
    const c = new AttemptCounter();
    for (let i = 0; i < 3; i++) c.record({ filesChanged: ['a.js'] });
    assert.equal(c.getIntervention(), 'trace_refresh');
  });

  it('returns escalate at attempt 5 for all bugs', () => {
    const c = new AttemptCounter();
    for (let i = 0; i < 5; i++) c.record({ filesChanged: ['a.js'] });
    assert.equal(c.getIntervention(), 'escalate');
  });

  it('detects visual bugs from CSS file extensions', () => {
    assert.equal(AttemptCounter.isVisualFile('style.css'), true);
    assert.equal(AttemptCounter.isVisualFile('style.scss'), true);
    assert.equal(AttemptCounter.isVisualFile('App.jsx'), true);
    assert.equal(AttemptCounter.isVisualFile('App.tsx'), true);
    assert.equal(AttemptCounter.isVisualFile('server.js'), false);
  });

  it('serializes to JSON', () => {
    const c = new AttemptCounter();
    c.record({ filesChanged: ['a.css'], isVisual: true });
    const json = c.toJSON();
    assert.equal(json.count, 1);
    assert.equal(json.isVisual, true);
  });

  it('restores from JSON', () => {
    const c1 = new AttemptCounter();
    c1.record({ filesChanged: ['a.css'], isVisual: true });
    c1.record({ filesChanged: ['a.css'], isVisual: true });
    const c2 = AttemptCounter.fromJSON(c1.toJSON());
    assert.equal(c2.count, 2);
    assert.equal(c2.getIntervention(), 'escalate');
  });
});

describe('TraceValidator', () => {
  it('rejects null trace_evidence', () => {
    const r = TraceValidator.validate({ trace_evidence: null });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes('missing'));
  });

  it('rejects empty trace_evidence', () => {
    const r = TraceValidator.validate({ trace_evidence: [] });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes('minimum 2'));
  });

  it('rejects single evidence item', () => {
    const r = TraceValidator.validate({
      trace_evidence: [{ command: 'echo test', actual_output: 'test output here' }],
      root_cause: 'something',
    });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes('minimum 2'));
  });

  it('rejects evidence without command', () => {
    const r = TraceValidator.validate({
      trace_evidence: [
        { command: 'cmd1', actual_output: 'output longer than five' },
        { actual_output: 'output longer than five' },
      ],
      root_cause: 'something',
    });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes('command'));
  });

  it('rejects evidence with too-short output', () => {
    const r = TraceValidator.validate({
      trace_evidence: [
        { command: 'cmd1', actual_output: 'ok' },
        { command: 'cmd2', actual_output: 'no' },
      ],
      root_cause: 'something',
    });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes('output'));
  });

  it('rejects missing root_cause', () => {
    const r = TraceValidator.validate({
      trace_evidence: [
        { command: 'cmd1', actual_output: 'output longer than five' },
        { command: 'cmd2', actual_output: 'another output here' },
      ],
    });
    assert.equal(r.valid, false);
    assert.ok(r.reason.includes('root_cause'));
  });

  it('accepts valid trace with 2+ items and root_cause', () => {
    const r = TraceValidator.validate({
      trace_evidence: [
        { command: 'type(x)', actual_output: 'MemoryItem' },
        { command: 'curl localhost:9001/api', actual_output: '{"status": "ok", "items": []}' },
      ],
      root_cause: 'callers expect dict but get MemoryItem',
    });
    assert.equal(r.valid, true);
  });

  it('accepts short but valid output (> 5 chars)', () => {
    const r = TraceValidator.validate({
      trace_evidence: [
        { command: 'type(x)', actual_output: 'MemoryItem' },
        { command: 'len(x)', actual_output: '42 items' },
      ],
      root_cause: 'type mismatch',
    });
    assert.equal(r.valid, true);
  });
});

describe('DebugLedger', () => {
  const TMP = join(import.meta.dirname, '.tmp-ledger-test');

  beforeEach(() => { mkdirSync(TMP, { recursive: true }); });
  afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

  it('creates ledger file on first write', () => {
    const ledger = new DebugLedger(TMP);
    ledger.record({ type: 'fix_chain_detected', file: 'a.js', iterations: 2 });
    const content = readFileSync(join(TMP, 'debug-ledger.jsonl'), 'utf-8');
    assert.ok(content.includes('fix_chain_detected'));
  });

  it('appends entries as JSONL', () => {
    const ledger = new DebugLedger(TMP);
    ledger.record({ type: 'a' });
    ledger.record({ type: 'b' });
    const lines = readFileSync(join(TMP, 'debug-ledger.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, 'a');
    assert.equal(JSON.parse(lines[1]).type, 'b');
  });

  it('adds timestamp to each entry', () => {
    const ledger = new DebugLedger(TMP);
    ledger.record({ type: 'test' });
    const line = readFileSync(join(TMP, 'debug-ledger.jsonl'), 'utf-8').trim();
    const entry = JSON.parse(line);
    assert.ok(entry.ts, 'should have timestamp');
    assert.ok(entry.ts.startsWith('20'), 'timestamp should be ISO date');
  });
});
