/**
 * decisions-routes.test.js — COMP-COCKPIT-DECISIONS-1: `GET /api/decisions` over fake sources (no git, no ops files) and the
 * project attribution in `lib/decisions-feed.js`. One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { attachDecisionsRoutes } from '../server/decisions-routes.js';
import { buildDecisions, parseLedger } from '../lib/decisions-ledger.js';
import { buildPrefixMap, makeProjectResolver } from '../lib/decisions-feed.js';

const LEDGER = [
  '- 2026-10-31 09:00 s1-chat: OWNER: COMP-COCKPIT-RIBBON-1 ships first.',
  '- 09:10 s1-chat: OWNER: seats rotate every 5 h.',
  '- 09:20 sm20-main: OWNER-ABSENT decision: CORE-2.0-X-1 waits.',
  '- 09:30 s1-chat: OWNER: COMP-PANE-1 and CORE-2.0-Y-1 land together.',
  '- 2026-11-01 11:4x s1-chat: DECISION D-0001: owner decision lines carry a D-id from now.',
  '- 12:1x s1-chat: DECISION D-0002: OWNER "use all 3 boxes".',
  '- 12:2x s1-chat: CORRECTION supersedes D-0002: OWNER "us1 only for prod".',
].join('\n');
const SCOPE = {
  projects: [{ name: 'forge', label: 'Forge', root: '/f', modules: ['/f/compose'] }, { name: 'smartmemory', label: 'SmartMemory', root: '/s', modules: [] }],
  laneIndex: { forge: { project: 'forge' }, sm20: { project: 'smartmemory' } },
  prefixMap: buildPrefixMap([{ project: 'forge', codes: ['COMP-A-1', 'COMP-B-1', 'STRAT-1'] }, { project: 'smartmemory', codes: ['CORE-1', 'CORE-2', 'COMP-Z-1'] }]),
};
const fakeLedger = (text = LEDGER) => ({ get: async () => ({ value: parseLedger(text) }), rows: (e, blame) => buildDecisions(e, { blame }) });
const coldBlame = { refresh() {}, snapshot: () => ({ state: 'cold', head: null, nlines: 0, error: null, lastBuild: null, shaAt: () => null, linesOf: () => [] }) };
const warmBlame = { refresh() {}, snapshot: () => ({ state: 'warm', head: 'h', nlines: 99, error: null, lastBuild: { kind: 'full', ms: 1 }, shaAt: (l) => `sha${l}`, linesOf: () => [] }) };

async function get(query, { env = {}, ...over } = {}, remote = false) {
  const app = express();
  const mounted = attachDecisionsRoutes(app, {
    remote, env,
    deps: { now: () => Date.parse('2026-11-01T06:00:00Z'), warn: () => {}, info: () => {}, opsRoot: '/ops', hostRoot: '/host', dataDir: () => '/tmp',
      ledger: fakeLedger(), loadOwnerQueue: async () => [{ id: 'Q-1', by: 'forge-main', text: 'COMP-Q-1 now?', ts: 1793487600, status: 'closed', answer: 'OWNER (via s1-chat): yes', closed_ts: 1793487700 }],
      loadScope: async () => SCOPE, blame: coldBlame, ...over },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/decisions${query}`);
    return { mounted, status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
  } finally { server.close(); }
}
const ids = (b) => b.rows.map((r) => r.id);

describe('GET /api/decisions', () => {
  // [name, query, deps override, check({mounted, status, body})]
  const ROWS = [
    ['the contract keys; newest first; a cold blame says commit pending', '', {}, ({ status, body }) => {
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(body), ['asOf', 'filters', 'total', 'nextCursor', 'counts', 'rows', 'projects', 'ledgerDoc', 'queueDoc', 'blame', 'sourceErrors']);
      assert.deepEqual(ids(body), ['L7', 'D-0002', 'D-0001', 'Q:Q-1', 'L4', 'L3', 'L2', 'L1']);
      assert.deepEqual([body.blame.state, body.rows.find((r) => r.id === 'D-0001').commitPending, body.rows.find((r) => r.id === 'Q:Q-1').commitPending], ['cold', true, false]);
    }],
    ['D-0001 is an exact row, and the superseded D-0002 says so', '', {}, ({ body }) => {
      const d1 = body.rows.find((r) => r.id === 'D-0001');
      const d2 = body.rows.find((r) => r.id === 'D-0002');
      assert.deepEqual([d1.exact, d1.inferred, d2.status, d2.statusBy.line], [true, false, 'superseded', 7]);
    }],
    ['project=forge: rows by unit prefix (COMP is forge by share), the writer\'s lane, and the queue row', '?project=forge', {}, ({ body }) => {
      assert.deepEqual(ids(body), ['Q:Q-1', 'L4', 'L1']);
    }],
    ['project=smartmemory: CORE units and the sm20 writer; a row naming both projects shows in both', '?project=smartmemory', {}, ({ body }) => {
      assert.deepEqual(ids(body), ['L4', 'L3']);
    }],
    ['project=fleet: rows with no project; counts per project', '?project=fleet', {}, ({ body }) => {
      assert.deepEqual(ids(body), ['L7', 'D-0002', 'D-0001', 'L2']);
      assert.deepEqual(body.counts.projects, { all: 8, fleet: 4, forge: 3, smartmemory: 2 });
    }],
    ['decider and standing filters', '?decider=absent,queue&status=standing', {}, ({ body }) => assert.deepEqual(ids(body), ['Q:Q-1', 'L3'])],
    ['standing hides the superseded row', '?status=standing&project=fleet', {}, ({ body }) => assert.deepEqual(ids(body), ['L7', 'D-0001', 'L2'])],
    ['text search and paging', '?q=d-000&size=2', {}, ({ body }) => {
      assert.deepEqual([body.total, ids(body), body.nextCursor], [3, ['L7', 'D-0002'], '2']);
    }],
    ['a warm blame gives each ledger row its commit', '', { blame: warmBlame }, ({ body }) => {
      const r = body.rows.find((x) => x.id === 'D-0001');
      assert.deepEqual([r.commit, r.commitPending, body.blame.state], ['sha5', false, 'warm']);
    }],
    ['an unreadable ledger is a sourceError, never a 500; the queue rows still come back', '', { ledger: { get: async () => ({ value: null, error: 'ENOENT ledger.md' }), rows: () => [] } }, ({ status, body }) => {
      assert.deepEqual([status, body.sourceErrors.ledger, ids(body)], [200, 'ENOENT ledger.md', ['Q:Q-1']]);
    }],
    ['a failing project model is a sourceError and every row is Fleet-wide', '?project=fleet', { loadScope: async () => { throw new Error('compose.json broken'); } }, ({ status, body }) => {
      assert.deepEqual([status, body.sourceErrors.projects, body.total], [200, 'compose.json broken', 8]);
    }],
    // COMP-WIKI-DOC-PATH-LINKS-1: the ledger and owner queue as ops-repo paths, for the pane's wiki links; a file outside the ops repo has none.
    ['the ledger and the owner queue as paths inside the ops repo', '', {}, ({ body }) => {
      assert.deepEqual([body.ledgerDoc, body.queueDoc], ['coordination/ledger.md', 'coordination/owner-queue.jsonl']);
    }],
    ['a ledger or queue outside the ops repo has no doc path', '', { env: { COMPOSE_DECISIONS_LEDGER: '/elsewhere/ledger.md', COMPOSE_RIBBON_OWNER_QUEUE: '/ops/../x/q.jsonl' } }, ({ body }) => {
      assert.deepEqual([body.ledgerDoc, body.queueDoc], [null, null]);
    }],
    ['a bad decider is 400', '?decider=boss', {}, ({ status, body }) => assert.deepEqual([status, /decider/.test(body.error)], [400, true])],
    ['a bad status is 400', '?status=maybe', {}, ({ status }) => assert.equal(status, 400)],
  ];
  for (const [name, query, over, check] of ROWS) it(name, async () => check(await get(query, over)));
  it('remote mode: not mounted, the route 404s', async () => {
    const r = await get('', {}, true);
    assert.deepEqual([r.mounted, r.status], [false, 404]);
  });
  it('the project resolver: unit prefix first, then the writer lane, then the relay target; noise prefixes drop out', () => {
    const of = makeProjectResolver({ laneIndex: SCOPE.laneIndex, prefixMap: SCOPE.prefixMap });
    assert.deepEqual([
      of({ units: ['COMP-X-1'], by: 'sm20-main', text: '' }),
      of({ units: ['FU-1'], by: 'forge-main', text: '' }),
      of({ units: [], by: 's2-coord', text: 'OWNER: x -> forge-main.' }),
      of({ units: [], by: 's2-coord', text: 'OWNER: seats.' }),
    ], [['forge'], ['forge'], ['forge'], []]);
    assert.equal(SCOPE.prefixMap.has('STRAT'), false);
  });
});
