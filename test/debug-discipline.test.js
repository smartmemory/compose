import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FixChainDetector } from '../lib/debug-discipline.js';

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
