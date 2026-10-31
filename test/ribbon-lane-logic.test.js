/**
 * COMP-COCKPIT-RIBBON-LANE-1: the pure half of the lane drawer and page, over the RIBBON-ROWS-1 fixture (`test/fixtures/ribbon/day.json`).
 * One row table: each row names a lane, a function and the value it must return.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chainForLane, asOfWord, etaWord, expectedLanding, lastLanded, liveState, nextLines, nowLine, sessionsForLane, timeLost, unitSegments } from '../src/components/ribbon/lane/laneLogic.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/ribbon/day.json', import.meta.url), 'utf8'));
const lane = (name) => FIX.lanes.find((l) => l.lane === name);
const NOW = FIX.now;
const rowsOf = (name) => unitSegments(lane(name)).map((r) => [r.unit, r.live, r.segments.map((s) => s.key)]);

describe('lane logic (COMP-COCKPIT-RIBBON-LANE-1)', () => {
  it('one row table over unitSegments, timeLost, lastLanded, liveState and the drawer wording', () => {
    const noDeployLane = { lane: 'docs', spans: [{ kind: 'work', start: '2026-10-31T01:00:00-07:00', end: '2026-10-31T02:00:00-07:00', unit: 'D-1', title: 'Doc', job: 'authoring', cause: null, why: null }], marks: [{ kind: 'land', at: '2026-10-31T02:00:00-07:00', unit: 'D-1', title: 'Doc' }] };
    const rows = [
      { name: 'unitSegments 2.0: newest first, live state per unit', got: rowsOf('2.0'), want: [
        ['COMP-SEARCH-1', 'not landed yet', ['authoring']], ['S-3', 'deployed', ['fix_rounds']],
        ['S-2', 'not landed yet', ['authoring', 'waitReview']], ['S-1', 'landed, not deployed yet', ['authoring']]] },
      { name: 'unitSegments web: a failed deploy after a deploy reads "deploy failed", the gap keeps its own row', got: rowsOf('web'), want: [
        ['W-2', 'not landed yet', ['authoring']], ['W-1', 'deploy failed', ['authoring']], [null, 'no unit recorded', ['notRecorded']]] },
      { name: 'timeLost 2.0: 3 h 30 m of review wait, nothing unrecorded', got: (({ byCause, notRecorded }) => ({ byCause, notRecorded }))(timeLost(lane('2.0'))), want: { byCause: { review: 210 }, notRecorded: 0 } },
      { name: 'timeLost web: 6 h 15 m not recorded, listed apart from waits', got: (({ byCause, notRecorded, total }) => ({ byCause, notRecorded, total }))(timeLost(lane('web'))), want: { byCause: {}, notRecorded: 375, total: 375 } },
      { name: 'lastLanded 2.0: newest first with live words', got: lastLanded(lane('2.0'), 3).map((l) => [l.unit, l.live]), want: [['S-3', 'deployed'], ['S-1', 'landed, not deployed yet']] },
      { name: 'lastLanded n=1 keeps only the newest', got: lastLanded(lane('2.0'), 1).map((l) => l.unit), want: ['S-3'] },
      { name: 'liveState: a lane that stamps no deploy says "no deploy stamp"', got: unitSegments(noDeployLane)[0].live, want: 'no deploy stamp' },
      { name: 'liveState: never an empty cell', got: [liveState({}), liveState({ landedAt: 'x' }), liveState({ landedAt: '2026-10-31T01:00:00Z', deployedAt: '2026-10-31T02:00:00Z' })], want: ['not landed yet', 'landed, not deployed yet', 'deployed'] },
      { name: 'expectedLanding 2.0: the estimate with its as-of', got: expectedLanding(lane('2.0'), NOW), want: { text: 'p50 Mon · p80 Mon', sub: 'as of today 16:40' } },
      { name: 'expectedLanding with the live estimator shape: durations and an as-of with no zone', got: expectedLanding({ eta: { p50: '9h', p80: '32h', asOf: '2026-10-31T20:14', raw: 'ESTIMATE 2.0 P50 9h P80 32h' }, spans: [] }, NOW), want: { text: 'p50 in 9h · p80 in 32h', sub: 'as of 20:14' } },
      { name: 'etaWord / asOfWord: unknown words are shown as given, missing is "unknown", no as-of is null', got: [etaWord('soon', NOW), etaWord(null, NOW), asOfWord(null, NOW)], want: ['soon', 'unknown', null] },
      { name: 'expectedLanding ops: waiting on the owner reads "on answer"', got: expectedLanding(lane('ops'), NOW).text, want: 'on answer' },
      { name: 'expectedLanding: noData reads the no-data words', got: expectedLanding({ eta: { noData: true, raw: 'n=4' }, spans: [] }, NOW).text, want: 'no estimate (n<10)' },
      { name: 'expectedLanding: no eta at all', got: expectedLanding({ eta: null, spans: [] }, NOW).text, want: 'no estimate' },
      { name: 'nowLine / nextLines: live, then past window', got: [nowLine(lane('maya'), true, NOW), nowLine(lane('2.0'), false, NOW), nextLines(lane('2.0'), false), nextLines(lane('maya'), true)], want: ['nothing running', 'past window', ['past window'], ['nothing queued']] },
      { name: 'nextLines 2.0 live: the two queued titles', got: nextLines(lane('2.0'), true), want: ['Workspace switcher polish', 'Facet counts'] },
      { name: 'sessionsForLane: <lane>-main and <lane>-x match, others do not, no list is empty', got: [sessionsForLane([{ name: 'ops-main' }, { name: 'ops-wk-a' }, { name: 'opsx' }, { name: 'web-main' }], 'ops').map((s) => s.name), sessionsForLane(null, 'ops')], want: [['ops-main', 'ops-wk-a'], []] },
      { name: 'sessionsForLane aliases: 2.0 finds sm20-main, ops finds ops-main, no session is empty, main keeps main-overdue-main', got: (() => {
        const live = [{ name: 's1-chat' }, { name: 'sm20-main' }, { name: 'ops-main' }, { name: 'main-overdue-main' }, { name: 'forge-main' }];
        return ['2.0', 'ops', 'bench', 'main'].map((l) => sessionsForLane(live, l).map((x) => x.name));
      })(), want: [['sm20-main'], ['ops-main'], [], ['main-overdue-main']] },
      { name: 'chainForLane: links by step name, prefers an open chain, null when none', got: [
        chainForLane(lane('ops'), [{ unit: 'a', steps: [{ name: 'X-1', stateKind: 'done' }] }, { unit: 'b', steps: [{ name: 'O-3', stateKind: 'ready' }] }])?.unit,
        chainForLane(lane('ops'), [{ unit: 'a', steps: [{ name: 'X-1', stateKind: 'done' }] }])], want: ['b', null] },
    ];
    for (const r of rows) assert.deepEqual(r.got, r.want, r.name);
  });
});
