import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AttemptCounter, FixChainDetector } from '../lib/debug-discipline.js';

describe('AttemptCounter — per-bug keying (COMP-FIX-HARD T9)', () => {
  it('recordForBug increments only the targeted bug', () => {
    const c = new AttemptCounter();
    c.recordForBug('BUG-1', { filesChanged: ['a.js'] });
    c.recordForBug('BUG-1', { filesChanged: ['a.js'] });
    assert.equal(c.getCountForBug('BUG-1'), 2);
    assert.equal(c.getCountForBug('BUG-2'), 0);
  });

  it('getInterventionForBug applies thresholds independently per bug', () => {
    const c = new AttemptCounter();
    // BUG-1: 2 visual attempts → escalate
    c.recordForBug('BUG-1', { filesChanged: ['layout.css'], isVisual: true });
    c.recordForBug('BUG-1', { filesChanged: ['layout.css'], isVisual: true });
    assert.equal(c.getInterventionForBug('BUG-1'), 'escalate');
    // BUG-2: untouched
    assert.equal(c.getInterventionForBug('BUG-2'), null);

    // BUG-3: 2 non-visual → trace_reminder
    c.recordForBug('BUG-3', { filesChanged: ['x.js'] });
    c.recordForBug('BUG-3', { filesChanged: ['x.js'] });
    assert.equal(c.getInterventionForBug('BUG-3'), 'trace_reminder');

    // BUG-4: 5 non-visual → escalate
    for (let i = 0; i < 5; i++) c.recordForBug('BUG-4', { filesChanged: ['y.js'] });
    assert.equal(c.getInterventionForBug('BUG-4'), 'escalate');
  });

  it('resetForBug clears one bug without affecting others', () => {
    const c = new AttemptCounter();
    c.recordForBug('BUG-1', { filesChanged: ['a.js'] });
    c.recordForBug('BUG-2', { filesChanged: ['b.js'] });
    c.resetForBug('BUG-1');
    assert.equal(c.getCountForBug('BUG-1'), 0);
    assert.equal(c.getCountForBug('BUG-2'), 1);
  });

  it('round-trip toJSON → fromJSON preserves all per-bug state', () => {
    const c = new AttemptCounter();
    c.recordForBug('BUG-1', { filesChanged: ['a.css'], isVisual: true });
    c.recordForBug('BUG-1', { filesChanged: ['a.css'], isVisual: true });
    c.recordForBug('BUG-2', { filesChanged: ['b.js'] });
    const json = c.toJSON();
    assert.deepEqual(Object.keys(json).sort(), ['BUG-1', 'BUG-2']);
    assert.equal(json['BUG-1'].count, 2);
    assert.equal(json['BUG-1'].isVisual, true);
    assert.equal(json['BUG-2'].count, 1);

    const c2 = AttemptCounter.fromJSON(json);
    assert.equal(c2.getCountForBug('BUG-1'), 2);
    assert.equal(c2.getInterventionForBug('BUG-1'), 'escalate');
    assert.equal(c2.getCountForBug('BUG-2'), 1);
  });

  it('legacy migration: flat-shape JSON wraps under __legacy__ key', () => {
    const legacy = { count: 3, isVisual: true };
    const c = AttemptCounter.fromJSON(legacy);
    assert.equal(c.getCountForBug('__legacy__'), 3);
    // After a save it should serialize under per-bug shape
    const json = c.toJSON();
    assert.ok(json['__legacy__']);
    assert.equal(json['__legacy__'].count, 3);
    assert.equal(json['__legacy__'].isVisual, true);
  });

  it('global record() / getIntervention() delegate to __feature_mode__ key', () => {
    const c = new AttemptCounter();
    c.record({ filesChanged: ['a.js'] });
    c.record({ filesChanged: ['a.js'] });
    assert.equal(c.count, 2);
    assert.equal(c.getIntervention(), 'trace_reminder');
    const json = c.toJSON();
    assert.ok(json['__feature_mode__']);
    assert.equal(json['__feature_mode__'].count, 2);
  });

  it('global escalate at attempt 5 still works', () => {
    const c = new AttemptCounter();
    for (let i = 0; i < 5; i++) c.record({ filesChanged: ['a.js'] });
    assert.equal(c.getIntervention(), 'escalate');
  });

  it('global record() and recordForBug() are independent', () => {
    const c = new AttemptCounter();
    c.record({ filesChanged: ['a.js'] });
    c.recordForBug('BUG-1', { filesChanged: ['b.js'] });
    assert.equal(c.count, 1);
    assert.equal(c.getCountForBug('BUG-1'), 1);
    assert.equal(c.getCountForBug('__feature_mode__'), 1);
  });
});

describe('FixChainDetector — per-bug keying (COMP-FIX-HARD T9)', () => {
  it('recordIterationForBug tracks file hits per bug', () => {
    const d = new FixChainDetector();
    d.recordIterationForBug('BUG-1', ['src/a.js']);
    d.recordIterationForBug('BUG-1', ['src/a.js']);
    d.recordIterationForBug('BUG-2', ['src/a.js']);
    const chains1 = d.detectForBug('BUG-1');
    assert.equal(chains1.length, 1);
    assert.equal(chains1[0].file, 'src/a.js');
    assert.equal(chains1[0].iterations, 2);
    const chains2 = d.detectForBug('BUG-2');
    assert.deepEqual(chains2, []);
  });

  it('resetForBug clears one bug without affecting others', () => {
    const d = new FixChainDetector();
    d.recordIterationForBug('BUG-1', ['a.js']);
    d.recordIterationForBug('BUG-1', ['a.js']);
    d.recordIterationForBug('BUG-2', ['b.js']);
    d.resetForBug('BUG-1');
    assert.deepEqual(d.detectForBug('BUG-1'), []);
    assert.equal(d.getIterationForBug('BUG-2'), 1);
  });

  it('round-trip toJSON → fromJSON preserves per-bug state', () => {
    const d = new FixChainDetector();
    d.recordIterationForBug('BUG-1', ['a.js']);
    d.recordIterationForBug('BUG-1', ['a.js']);
    d.recordIterationForBug('BUG-2', ['b.js']);
    const json = d.toJSON();
    assert.ok(json['BUG-1']);
    assert.ok(json['BUG-2']);
    const d2 = FixChainDetector.fromJSON(json);
    const chains = d2.detectForBug('BUG-1');
    assert.equal(chains.length, 1);
    assert.equal(chains[0].iterations, 2);
    assert.equal(d2.getIterationForBug('BUG-2'), 1);
  });

  it('legacy migration: flat shape wraps under __legacy__', () => {
    const legacy = { iteration: 2, fileHits: { 'src/a.js': 2 } };
    const d = FixChainDetector.fromJSON(legacy);
    const chains = d.detectForBug('__legacy__');
    assert.equal(chains.length, 1);
    assert.equal(chains[0].file, 'src/a.js');
    assert.equal(chains[0].iterations, 2);
  });

  it('global recordIteration() and detect() delegate to __feature_mode__', () => {
    const d = new FixChainDetector();
    d.recordIteration(['src/a.js']);
    d.recordIteration(['src/a.js']);
    const chains = d.detect();
    assert.equal(chains.length, 1);
    assert.equal(chains[0].file, 'src/a.js');
    assert.equal(d.iteration, 2);
    const json = d.toJSON();
    assert.ok(json['__feature_mode__']);
  });

  it('global and per-bug streams are independent', () => {
    const d = new FixChainDetector();
    d.recordIteration(['x.js']);
    d.recordIterationForBug('BUG-1', ['y.js']);
    assert.equal(d.iteration, 1);
    assert.equal(d.getIterationForBug('BUG-1'), 1);
    assert.deepEqual(d.detect(), []);
    assert.deepEqual(d.detectForBug('BUG-1'), []);
  });
});
