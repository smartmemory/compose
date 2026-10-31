/**
 * COMP-COCKPIT-WIRING-1: GET /api/build/state serves liveBuildState(active-build.json).
 * BUG-27 was aborted 2026-09-19 and still read as the live build on 2026-10-31. One row table: an ended build is shown
 * for a grace window after it ends, then it is history; failed and running records stay (they are the resume handle).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { liveBuildState, ENDED_BUILD_GRACE_MS } from '../server/workspace-activity.js';

const NOW = Date.parse('2026-10-31T03:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const BUG27 = { featureCode: 'BUG-27', mode: 'bug', pid: 22724, startedAt: '2026-09-19T08:48:06.033Z' };

describe('liveBuildState', () => {
  it('serves running and resumable records, and ended ones only inside the grace window', () => {
    const ROWS = [
      // [label, record, served]
      ['no file', null, false],
      ['BUG-27 as found: aborted six weeks ago', { ...BUG27, status: 'aborted', completedAt: '2026-09-19T09:13:43.869Z' }, false],
      ['aborted just now', { ...BUG27, status: 'aborted', completedAt: ago(60_000) }, true],
      ['aborted at the grace edge', { ...BUG27, status: 'aborted', completedAt: ago(ENDED_BUILD_GRACE_MS) }, false],
      ['complete just now', { ...BUG27, status: 'complete', completedAt: ago(60_000) }, true],
      ['complete long ago', { ...BUG27, status: 'complete', completedAt: ago(86_400_000) }, false],
      ['killed long ago', { ...BUG27, status: 'killed', completedAt: ago(86_400_000) }, false],
      ['ended with no completedAt falls back to startedAt', { ...BUG27, status: 'aborted' }, false],
      ['ended with no timestamps at all', { featureCode: 'BUG-27', status: 'aborted' }, false],
      ['failed long ago stays (resume may succeed)', { ...BUG27, status: 'failed', completedAt: ago(86_400_000) }, true],
      ['running stays, even with a dead pid (crash resume)', { ...BUG27, status: 'running' }, true],
      ['legacy record with no status stays', { ...BUG27 }, true],
    ];
    for (const [label, record, served] of ROWS) {
      assert.equal(liveBuildState(record, NOW), served ? record : null, label);
    }
  });
});
