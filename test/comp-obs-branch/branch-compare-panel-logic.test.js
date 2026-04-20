import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAge,
  fmtNum,
  fmtUsd,
  fmtWallClock,
  lastForkAge,
  summarizeLineage,
  pickInitialPair,
} from '../../src/components/vision/branchComparePanelLogic.js';

const NOW = Date.parse('2026-04-20T12:00:00Z');

describe('formatAge', () => {
  it('<1h yields "<1h ago"', () => {
    const t = new Date(NOW - 30 * 60_000).toISOString();
    assert.equal(formatAge(t, NOW), '<1h ago');
  });
  it('3h yields "3h ago"', () => {
    const t = new Date(NOW - 3 * 3_600_000).toISOString();
    assert.equal(formatAge(t, NOW), '3h ago');
  });
  it('3 days yields "3d ago"', () => {
    const t = new Date(NOW - 3 * 24 * 3_600_000).toISOString();
    assert.equal(formatAge(t, NOW), '3d ago');
  });
  it('null input yields null', () => {
    assert.equal(formatAge(null, NOW), null);
  });
});

describe('fmtNum', () => {
  it('< 1k uses integer', () => {
    assert.equal(fmtNum(42), '42');
  });
  it('< 1M uses k', () => {
    assert.equal(fmtNum(12_500), '12.5k');
  });
  it('>= 1M uses M', () => {
    assert.equal(fmtNum(3_500_000), '3.5M');
  });
  it('null yields em-dash', () => {
    assert.equal(fmtNum(null), '—');
  });
});

describe('fmtUsd', () => {
  it('< 1 uses 3 decimals', () => {
    assert.equal(fmtUsd(0.125), '$0.125');
  });
  it('>= 1 uses 2 decimals', () => {
    assert.equal(fmtUsd(12.345), '$12.35');
  });
  it('null yields em-dash', () => {
    assert.equal(fmtUsd(null), '—');
  });
});

describe('fmtWallClock', () => {
  it('< 60s uses seconds', () => {
    assert.equal(fmtWallClock(45_000), '45s');
  });
  it('< 60m uses minutes', () => {
    assert.equal(fmtWallClock(8 * 60_000), '8m');
  });
  it('>= 60m uses hours + remainder minutes', () => {
    assert.equal(fmtWallClock(2 * 3_600_000 + 15 * 60_000), '2h 15m');
  });
  it('exact hours omits minute suffix', () => {
    assert.equal(fmtWallClock(3 * 3_600_000), '3h');
  });
});

describe('lastForkAge', () => {
  it('returns the most-recent started_at formatted', () => {
    const branches = [
      { started_at: new Date(NOW - 10 * 3_600_000).toISOString() },
      { started_at: new Date(NOW - 3 * 3_600_000).toISOString() },
      { started_at: new Date(NOW - 20 * 3_600_000).toISOString() },
    ];
    assert.equal(lastForkAge(branches, NOW), '3h ago');
  });
  it('empty branches yields null', () => {
    assert.equal(lastForkAge([], NOW), null);
  });
  it('ignores branches without started_at', () => {
    const branches = [{ started_at: null }];
    assert.equal(lastForkAge(branches, NOW), null);
  });
});

describe('summarizeLineage', () => {
  const started = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

  it('empty/null lineage returns 0 branches, cannot compare', () => {
    const s = summarizeLineage(null, NOW);
    assert.equal(s.canCompare, false);
    assert.equal(s.totalCount, 0);
    assert.match(s.summary, /^0 branches/);
  });

  it('1 complete branch: cannot compare', () => {
    const s = summarizeLineage({
      branches: [{ branch_id: 'a', state: 'complete', started_at: started(1) }],
    }, NOW);
    assert.equal(s.canCompare, false);
    assert.equal(s.totalCount, 1);
    assert.match(s.summary, /^1 branch/);
  });

  it('2 complete branches: can compare', () => {
    const s = summarizeLineage({
      branches: [
        { branch_id: 'a', state: 'complete', started_at: started(1) },
        { branch_id: 'b', state: 'complete', started_at: started(2) },
      ],
    }, NOW);
    assert.equal(s.canCompare, true);
  });

  it('1 complete + 1 running: "1 of 2 branches ready"', () => {
    const s = summarizeLineage({
      branches: [
        { branch_id: 'a', state: 'complete', started_at: started(1) },
        { branch_id: 'b', state: 'running', started_at: started(2) },
      ],
    }, NOW);
    assert.equal(s.canCompare, false);
    assert.match(s.summary, /1 of 2 branches ready/);
  });

  it('3 complete: can compare, summary shows 3 branches + fork age', () => {
    const s = summarizeLineage({
      branches: [
        { branch_id: 'a', state: 'complete', started_at: started(5) },
        { branch_id: 'b', state: 'complete', started_at: started(2) },
        { branch_id: 'c', state: 'complete', started_at: started(10) },
      ],
    }, NOW);
    assert.equal(s.canCompare, true);
    assert.match(s.summary, /3 branches/);
    assert.match(s.summary, /last fork 2h ago/);
  });
});

describe('pickInitialPair', () => {
  const a = { branch_id: 'a', state: 'complete' };
  const b = { branch_id: 'b', state: 'complete' };
  const c = { branch_id: 'c', state: 'complete' };

  it('returns [first, second] when no stored selection', () => {
    assert.deepEqual(pickInitialPair([a, b, c], []), [a, b]);
  });

  it('returns stored pair when both ids exist', () => {
    assert.deepEqual(pickInitialPair([a, b, c], ['c', 'a']), [c, a]);
  });

  it('falls back to first/second when stored ids are stale', () => {
    assert.deepEqual(pickInitialPair([a, b, c], ['x', 'y']), [a, b]);
  });

  it('returns [null, null] for empty branches list', () => {
    assert.deepEqual(pickInitialPair([], []), [null, null]);
  });
});
