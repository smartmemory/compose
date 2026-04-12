import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FixChainDetector, AttemptCounter } from '../lib/debug-discipline.js';

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
