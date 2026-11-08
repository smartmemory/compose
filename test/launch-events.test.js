/**
 * launch-events.test.js — launches, gate refusals, the retry queue and hop-governor lines as Compose events
 * (COMP-DOGFOOD-LAUNCH-GATE-1, row C of COMP-DOGFOOD-1).
 *
 * The fixture is the 2026-11-03 22:48 seat-equalize launch, copied verbatim (test/fixtures/launch-gate): gate.log said
 * `admit`, the claude shim then refused it (exit `77 1793717293`, the log's first line is the gate line), and the Day view
 * drew it as running. Each event below is the shape smart-memory-ops `launch_events.py` sends for that launch.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLaunchFeed, blockedUnits, ingestGovernorLog, parseGovernorLog, readLaunchEvents, recordLaunchEvent, retryQueue, shortGate, validateLaunchEvent,
} from '../lib/launch-events.js';
import { main as cli } from '../lib/launch-events-cli.js';
import { parseGateLog } from '../lib/ribbon-feed.js';
import { attachRibbonRoutes, LAUNCH_QUEUE_ROUTE, RIBBON_ROUTE } from '../server/ribbon-routes.js';
import { tipText } from '../src/components/ribbon/ribbonLayout.js';

const FIX = new URL('./fixtures/launch-gate/', import.meta.url);
const fx = (n) => readFileSync(new URL(n, FIX), 'utf8');
const GATE_LINE = fx('seat-equalize.log').split('\n')[0];
const [EXIT_CODE, EXIT_EPOCH] = fx('seat-equalize.exit').trim().split(/\s+/).map(Number);
const LAUNCHED = Date.parse('2026-11-03T22:48:09+08:00'); // gate.log's admit line, local time on the fleet Mac (Asia/Shanghai, the gate line's CST)
const REFUSED = EXIT_EPOCH * 1000;
const NOW = REFUSED + 10 * 60_000;
const iso = (t) => new Date(t).toISOString();
const UNIT = 'OPS-SEAT-EQUALIZE-HOP-1';
const MARK = 'seat-equalize:k3f9';
const OPS = '/Users/ruze/reg/my/SmartMemory/smart-memory-ops';

const base = (tool, key, t) => ({ tool, ts: iso(t), source: 'detach_job', idempotency_key: key, label: 'seat-equalize', mark: MARK, session: 'ops-main', unit: UNIT, lane: null });
const REQUESTED = { ...base('launch.requested', `launch.requested:${MARK}`, LAUNCHED), engine: 'claude', model: 'opus', seat: 'seat4', priority: 'P1', work_kind: 'author',
  for_id: null, brief: `${OPS}/units/${UNIT}/brief.md`, report: `${OPS}/units/${UNIT}/report.md`, pid: 51234, launched_at: iso(LAUNCHED) };
const REFUSAL = { ...base('launch.refused', `launch.refused:${MARK}:0`, REFUSED), attempt: 0, at: iso(REFUSED), exit_code: EXIT_CODE, gate_line: GATE_LINE };
const QUEUED = { ...base('launch.queued', `launch.queued:${MARK}:0`, REFUSED), attempt: 0, at: iso(REFUSED), gate_line: GATE_LINE, meter: 'overall', seat: 'seat4',
  frees_at: '2026-11-04T05:00:00.000Z', frees_at_source: 'usage_watch.py status --json: accounts[seat4].windows.5h.resets_at = 1793761200', retry: 'reroute', retry_max: 3 };
const RUNNING = (over = {}) => ({ ...base('launch.running', `launch.running:${MARK}:0`, LAUNCHED + 130_000), attempt: 0, at: iso(LAUNCHED + 130_000), pid: 51234,
  receipt: { kind: 'process', pid: 51234, launched_at: iso(LAUNCHED), label: 'seat-equalize', log: `${OPS}/units/${UNIT}/seat-equalize.log`, at: iso(LAUNCHED + 130_000), by: 'detach_job' }, ...over });
const TONIGHT = [REQUESTED, REFUSAL, QUEUED];

const events = (o = {}) => ({ owner_waits: [], reviews: [], fix_runs: [], gates: [], deploys: [], fixes: [], ready_at: null, dispatched_at: null, author_done_at: null, landed_at: null, account: null, ...o });
const UNITS = [{ id: UNIT, lane: 'ops', title: 'Seat equalize hop', titleSource: 'stamp', state: 'authoring', landedAt: null, deployedAt: null,
  events: events({ ready_at: iso(LAUNCHED - 60_000), dispatched_at: iso(LAUNCHED), account: 'seat4' }) }];

const dirs = [];
const tmpRoot = () => { const d = mkdtempSync(join(tmpdir(), 'launch-events-test-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

/** Both route handlers in-process (no listen). Every mount passes `loadLaunchEvents`: never the real fleet store or governor log. */
function mount(launchEvents) {
  const handlers = {};
  attachRibbonRoutes({ get: (p, h) => { handlers[p] = h; }, locals: {} }, { deps: {
    now: () => NOW, warn: () => {}, info: () => {}, dataDir: () => '/nonexistent/launch-events-test',
    loadUnits: async () => ({ units: UNITS, coverage: {}, asOf: iso(NOW) }),
    loadSnapshots: async () => [], loadGateLog: async () => parseGateLog(fx('gate.log')), loadOwnerQueue: async () => [], loadSeats: async () => ({ seats: [] }),
    ledger: { get: async () => ({ value: [] }), rows: () => [] }, loadOutage: async () => ({ state: 'ok', since: null }),
    eta: async () => ({ p50: '2h', p80: '3h', asOf: 'a', raw: 'r' }), loadLaunchEvents: launchEvents,
  } });
  const get = (path, query = {}) => new Promise((resolve, reject) => {
    let status = 200;
    const res = { set() {}, status(c) { status = c; return this; }, json: (body) => resolve({ status, body }) };
    handlers[path]({ query, socket: { localPort: 1 } }, res).catch(reject);
  });
  return { get, paths: Object.keys(handlers) };
}
const DAY = { from: iso(NOW - 12 * 3_600_000), to: iso(NOW + 12 * 3_600_000) };
const ops = (body) => body.lanes.find((l) => l.lane === 'ops');

describe('(a) tonight: admit, then the shim refused it', () => {
  it('the ops lane has no running unit, one refused mark with the gate line, and one queued launch', async () => {
    const { get } = mount(async () => TONIGHT);
    const { status, body } = await get(RIBBON_ROUTE, DAY);
    assert.equal(status, 200);
    assert.equal(ops(body).current, null, 'an admit followed by a refusal is never the running unit');
    const refused = ops(body).marks.filter((m) => m.kind === 'refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].text, 'refused: SEAT CEILING GATE: seat4 5h used 97% >= its ceiling 70%, resets 2026-11-03 23:00:00 CST');
    assert.equal(refused[0].full, GATE_LINE, 'the whole line is the hover');
    assert.equal(refused[0].at, iso(REFUSED));
    assert.equal(refused[0].laneGuess, false);
    assert.equal(body.launches.queue.count, 1);
    assert.deepEqual(body.launches.queue.labels, ['seat-equalize']);
    assert.equal(body.sourceErrors.launches, undefined);
  });
  it('GET /api/launch-queue answers the same queue, with the meter and when it frees', async () => {
    const { get, paths } = mount(async () => TONIGHT);
    assert.deepEqual(paths, [LAUNCH_QUEUE_ROUTE, RIBBON_ROUTE], 'the queue route is mounted before the ribbon route');
    const { status, body } = await get(LAUNCH_QUEUE_ROUTE);
    assert.equal(status, 200);
    assert.equal(body.count, 1);
    assert.deepEqual([body.entries[0].label, body.entries[0].meter, body.entries[0].seat, body.entries[0].frees_at, body.entries[0].retry],
      ['seat-equalize', 'overall', 'seat4', '2026-11-04T05:00:00.000Z', 'reroute']);
    assert.match(body.entries[0].frees_at_source, /^usage_watch\.py status --json: accounts\[seat4\]\.windows\.5h\.resets_at = /);
  });
  it('an unreadable event store is unknown (queue null, sourceErrors.launches), never an empty queue', async () => {
    const { get } = mount(async () => { throw new Error('store unreadable'); });
    const { status, body } = await get(RIBBON_ROUTE, DAY);
    assert.equal(status, 200);
    assert.equal(body.launches.queue, null);
    assert.match(body.sourceErrors.launches, /store unreadable/);
  });
});

describe('(b) old-code control: gate.log alone, no launch events', () => {
  it('the feed draws the refused job as the running unit and shows no refused mark', async () => {
    const entries = parseGateLog(fx('gate.log'));
    assert.deepEqual(entries.map((e) => [e.verb, e.label]), [['admit', 'seat-equalize'], ['author-bypass', 'seat-equalize']], 'gate.log has no refusal in it');
    const { body } = await mount(async () => []).get(RIBBON_ROUTE, DAY);
    assert.equal(ops(body).current?.id, UNIT, 'the old result: still running');
    assert.equal(ops(body).marks.filter((m) => m.kind === 'refused').length, 0);
    assert.equal(body.launches.queue.count, 0);
  });
});

describe('(c) hop-governor log: orders and outcomes', () => {
  it('parses each order and outcome line, and skips STAY, WAIT and the repeated DRY RUN-HOP', () => {
    const evs = parseGovernorLog(fx('hop-governor.log'));
    assert.deepEqual(evs.map((e) => [e.tool, e.outcome ?? null, e.mode, e.session, e.target]), [
      ['hop.order', null, 'dry', 'sm20-main', 'seat2'],
      ['hop.order', null, 'live', 'sm20-main', 'seat2'],
      ['hop.outcome', 'hopped', 'live', 'sm20-main', 'seat2'],
      ['hop.outcome', 'unconfirmed', 'live', 'forge-main', 'seat2'],
      ['hop.outcome', 'failed', 'live', 'ops-main', 'seat4'],
      ['hop.outcome', 'cancel', 'live', 's1-chat', 'seat3'],
    ]);
    const hopped = evs[2];
    assert.deepEqual([hopped.from, hopped.new_pid, hopped.old_pids], ['seat3', 4242, [4100, 4101]]);
    for (const e of evs) assert.deepEqual(validateLaunchEvent(e), { ok: true, errors: [] }, e.line);
  });
  it('ingest keeps a cursor: a re-read writes nothing, a new line writes one, a half line waits, a rotated log writes no duplicate', () => {
    const root = tmpRoot();
    const log = join(root, 'hop-governor.log');
    writeFileSync(log, fx('hop-governor.log'));
    assert.deepEqual(ingestGovernorLog(root, log, { warn: () => {} }), { written: 6, duplicate: 0, invalid: [] });
    assert.deepEqual(ingestGovernorLog(root, log, { warn: () => {} }), { written: 0, duplicate: 0, invalid: [] }, 'cursor at the end');
    const next = '2026-11-04 01:35:00,000 INFO hop_governor: LIVE HOP ops-main -> seat1 (overall 101% vs 40%)';
    appendFileSync(log, `${next}\n2026-11-04 01:40:00,000 INFO hop_gov`);
    assert.deepEqual(ingestGovernorLog(root, log, { warn: () => {} }), { written: 1, duplicate: 0, invalid: [] }, 'the half line is not consumed');
    appendFileSync(log, 'ernor: LIVE HOP-FAILED ops-main -> seat1: session_hop exit 2\n');
    assert.deepEqual(ingestGovernorLog(root, log, { warn: () => {} }), { written: 1, duplicate: 0, invalid: [] }, 'completed on the next read');
    renameSync(log, `${log}.1`);
    writeFileSync(log, fx('hop-governor.log'));
    assert.deepEqual(ingestGovernorLog(root, log, { warn: () => {} }), { written: 0, duplicate: 6, invalid: [] }, 'a new inode restarts at 0, the keys stop a rewrite');
    assert.equal(readLaunchEvents(root).length, 8);
    const cursor = JSON.parse(readFileSync(join(root, '.compose', 'data', 'hop-governor.cursor.json'), 'utf8'));
    assert.equal(cursor.offset, Buffer.byteLength(fx('hop-governor.log')));
  });
  it('the ribbon carries them as data on the session\'s lane (`hops`), not as marks', () => {
    const evs = parseGovernorLog(fx('hop-governor.log'));
    const body = { lanes: ['ops', 'forge'].map((lane) => ({ lane, marks: [], idle: true })) };
    const t = (e) => Date.parse(e.at);
    applyLaunchFeed(body, evs, { units: [], from: Math.min(...evs.map(t)), to: Math.max(...evs.map(t)), now: Math.max(...evs.map(t)) });
    const forge = body.lanes.find((l) => l.lane === 'forge');
    assert.deepEqual(forge.hops.map((h) => [h.kind, h.session, h.laneGuess]), [['unconfirmed', 'forge-main', false]]);
    assert.equal(body.lanes.find((l) => l.lane === 'ops').hops.length, 5, 'ops-main, plus sm20-main and s1-chat on the fallback lane');
    assert.equal(body.lanes.every((l) => l.marks.length === 0), true);
  });
});

describe('(e) launch.running is stored only behind a passed process re-check', () => {
  const refuse = () => { throw Object.assign(new Error('refused'), { reasons: ['pid 51234 not alive'] }); };
  it('a refused re-check is not stored; a passed one carries ev:<id> and closes the queue entry', () => {
    const root = tmpRoot();
    for (const ev of TONIGHT) assert.equal(recordLaunchEvent(root, ev).status, 'written');
    assert.deepEqual(recordLaunchEvent(root, RUNNING(), { check: refuse }), { status: 'refused', errors: ['pid 51234 not alive'] });
    assert.equal(readLaunchEvents(root).filter((e) => e.tool === 'launch.running').length, 0);
    const ok = recordLaunchEvent(root, RUNNING({ idempotency_key: `launch.running:${MARK}:1`, attempt: 1, at: iso(REFUSED + 200_000) }), { check: () => ({ evidence_id: 'ev:abc123' }) });
    assert.equal(ok.row.evidence_id, 'ev:abc123');
    assert.equal(retryQueue(readLaunchEvents(root), NOW).count, 0);
    assert.equal(recordLaunchEvent(root, REFUSAL).status, 'duplicate');
  });
  it('a replayed row whose re-check fails is kept with evidence_id null and never counts as running', () => {
    const root = tmpRoot();
    for (const ev of TONIGHT) recordLaunchEvent(root, ev);
    const r = recordLaunchEvent(root, RUNNING({ replayed: true, at: iso(REFUSED + 60_000) }), { check: refuse });
    assert.equal(r.status, 'written');
    assert.deepEqual([r.row.evidence_id, r.row.evidence_refused], [null, ['pid 51234 not alive']]);
    const evs = readLaunchEvents(root);
    assert.equal(retryQueue(evs, NOW).count, 1, 'the queue entry stays open');
    assert.equal(blockedUnits(evs).has(UNIT), true, 'the unit stays refused');
  });
});

describe('(f) the contract', () => {
  it('a refusal without its gate line is invalid; tonight\'s three events are valid', () => {
    const { gate_line: _, ...bare } = REFUSAL;
    const v = validateLaunchEvent(bare);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /gate_line/.test(e)), v.errors.join('; '));
    assert.equal(recordLaunchEvent(tmpRoot(), bare).status, 'invalid');
    for (const ev of TONIGHT) assert.deepEqual(validateLaunchEvent(ev), { ok: true, errors: [] }, ev.tool);
    assert.equal(validateLaunchEvent({ ...QUEUED, meter: 'fable' }).ok, true);
    assert.equal(validateLaunchEvent({ ...QUEUED, meter: 'seat' }).ok, false);
  });
});

describe('the retry queue', () => {
  it('a job_wall reroute (<label>-W1) closes it; past frees_at + 6 h it is expired, not counted', () => {
    const reroute = { ...REQUESTED, idempotency_key: 'launch.requested:seat-equalize-W1:z', label: 'seat-equalize-W1', mark: 'seat-equalize-W1:z', ts: iso(REFUSED + 60_000), launched_at: iso(REFUSED + 60_000) };
    assert.equal(retryQueue([...TONIGHT, reroute], NOW).count, 0);
    const late = retryQueue(TONIGHT, Date.parse(QUEUED.frees_at) + 7 * 3_600_000);
    assert.deepEqual([late.count, late.expired.map((e) => e.label)], [0, ['seat-equalize']]);
  });
  it('shortGate drops the shim prefix, the parentheses and the advice after the first sentence', () => {
    assert.equal(shortGate(GATE_LINE), 'SEAT CEILING GATE: seat4 5h used 97% >= its ceiling 70%, resets 2026-11-03 23:00:00 CST');
  });
});

describe('the CLI door launch_events.py writes through', () => {
  const io = (stdin = '') => { const out = []; const err = []; return { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, stdin: () => stdin, now: () => NOW, lines: () => out.join('').trim().split('\n').map((l) => JSON.parse(l)) }; };
  it('append (stdin lines) writes, then dedupes; queue reads it back; a bad event exits 2', () => {
    const root = tmpRoot();
    const a = io(TONIGHT.map((e) => JSON.stringify(e)).join('\n'));
    assert.equal(cli(['append', '--root', root, '-'], a), 0);
    assert.deepEqual(a.lines().map((r) => r.status), ['written', 'written', 'written']);
    const again = io(JSON.stringify(REFUSAL));
    assert.equal(cli(['append', '--root', root, '-'], again), 0);
    assert.equal(again.lines()[0].status, 'duplicate');
    const q = io();
    assert.equal(cli(['queue', '--root', root], q), 0);
    assert.deepEqual(q.lines()[0].labels, ['seat-equalize']);
    const bad = io();
    const { gate_line: _, ...bare } = REFUSAL;
    assert.equal(cli(['append', '--root', root, JSON.stringify(bare)], bad), 2);
    assert.equal(cli(['append'], io()), 1);
  });
});

describe('(g) the hover text of a refused mark', () => {
  it('says the short words, the job, then the whole gate line', () => {
    const tip = tipText({ kind: 'refused', text: 'refused: SEAT CEILING GATE: seat4 5h used 97%', label: 'seat-equalize', full: GATE_LINE, at: iso(REFUSED), now: iso(NOW) });
    const [first, second] = tip.split('\n');
    assert.equal(first, 'refused: SEAT CEILING GATE: seat4 5h used 97% · seat-equalize');
    assert.equal(second, GATE_LINE);
  });
});
