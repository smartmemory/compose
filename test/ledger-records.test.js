/**
 * ledger-records.test.js — ledger lines as Compose records (COMP-DOGFOOD-CUTOVER-1, row I of COMP-DOGFOOD-1) and the check-in view.
 *
 * Every test uses its own temp workspace; none reads or writes the fleet's .compose/data.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  LEDGER_RECORD_SCHEMA_PATH, readLedgerRecords, recordLedgerLines, recordsDir, sgtDay, validateLedgerRecord,
} from '../lib/ledger-records.js';
import { main as cli } from '../lib/ledger-records-cli.js';
import { buildCheckin, formatCheckin, main as checkinCli } from '../lib/checkin-cli.js';

const dirs = [];
const ws = () => { const d = mkdtempSync(join(tmpdir(), 'ledger-records-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const rec = (over = {}) => ({
  v: 1, id: 'a'.repeat(24), day: '2026-11-06', at: '2026-11-06T01:05:00+08:00', written_at: '2026-11-06T01:05:12+08:00', by: 's2-coord',
  text: 'COMP-X LANDED ev:0123456789abcdef', line: '- 01:05 s2-coord: COMP-X LANDED ev:0123456789abcdef', source: 'ledger.py', ...over,
});
const io = (stdin = '') => {
  const o = { out: '', err: '' };
  return { o, io: { out: { write: (s) => { o.out += s; } }, err: { write: (s) => { o.err += s; } }, stdin: () => stdin } };
};
const lines = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('ledger-records store', () => {
  it('writes a record once per (day, id): a replay is a duplicate, the same id on another day is a new record', () => {
    const root = ws();
    const r1 = recordLedgerLines(root, [rec(), rec(), rec({ day: '2026-11-07', at: '2026-11-07T01:05:00+08:00' })]);
    assert.deepEqual(r1.map((r) => r.status), ['written', 'duplicate', 'written']);
    assert.deepEqual(recordLedgerLines(root, [rec()]).map((r) => r.status), ['duplicate']);
    const day6 = readFileSync(join(recordsDir(root), '2026-11-06.jsonl'), 'utf8').trim().split('\n');
    assert.equal(day6.length, 1);
    assert.ok(JSON.parse(day6[0]).stored_at, 'the store stamps stored_at');
  });

  it('keeps the order it was given and answers one result per record, invalid ones in place', () => {
    const root = ws();
    const ids = ['1', '2', '3'].map((c) => c.repeat(24));
    const res = recordLedgerLines(root, [rec({ id: ids[0] }), rec({ id: 'XYZ' }), rec({ id: ids[1] }), null, rec({ id: ids[2] })]);
    assert.deepEqual(res.map((r) => r.status), ['written', 'invalid', 'written', 'invalid', 'written']);
    assert.deepEqual(readLedgerRecords(root).map((r) => r.id), ids);
  });

  it('refuses a record whose at is not on its day, an unknown field, a missing field, a bad source', () => {
    assert.match(validateLedgerRecord(rec({ day: '2026-11-05' })).errors[0], /not on day/);
    assert.match(validateLedgerRecord(rec({ extra: 1 })).errors.join(), /additional property 'extra'/);
    const { text, ...noText } = rec();
    assert.match(validateLedgerRecord(noText).errors.join(), /required property 'text'/);
    assert.equal(validateLedgerRecord(rec({ source: 'model' })).ok, false);
    assert.equal(validateLedgerRecord(rec({ at: '2026-11-06T01:05:00Z', day: '2026-11-06' })).ok, false, 'at is Asia/Singapore');
  });

  it('the hand validator agrees with Ajv on the contract for every fixture', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const check = ajv.compile(JSON.parse(readFileSync(LEDGER_RECORD_SCHEMA_PATH, 'utf8')));
    const { text, ...noText } = rec();
    const fixtures = [rec(), rec({ replayed: true }), rec({ source: 'swept' }), rec({ source: 'timer' }), rec({ id: 'A'.repeat(24) }),
      rec({ by: 'has space' }), rec({ text: '' }), rec({ text: 'x'.repeat(20001) }), rec({ v: 2 }), rec({ replayed: 'yes' }), noText,
      rec({ written_at: 'yesterday' }), rec({ at: '2026-11-06T01:05+08:00' }), rec({ text: '😀'.repeat(20000), line: 'l' })];
    for (const f of fixtures) assert.equal(validateLedgerRecord(f).ok, check(f), JSON.stringify(f).slice(0, 120));
  });

  it('reads a window across day files, at in [since, until)', () => {
    const root = ws();
    recordLedgerLines(root, [
      rec({ id: '1'.repeat(24), day: '2026-11-05', at: '2026-11-05T23:59:00+08:00' }),
      rec({ id: '2'.repeat(24), day: '2026-11-06', at: '2026-11-06T01:05:00+08:00' }),
      rec({ id: '3'.repeat(24), day: '2026-11-13', at: '2026-11-13T01:05:00+08:00' }),
    ]);
    const got = readLedgerRecords(root, { since: '2026-11-06T01:05:00+08:00', until: '2026-11-13T01:05:00+08:00' });
    assert.deepEqual(got.map((r) => r.id), ['2'.repeat(24)]);
    assert.equal(sgtDay(Date.parse('2026-11-05T17:00:00Z')), '2026-11-06');
  });
});

describe('ledger-records-cli', () => {
  it('append prints one result per line and exits 0, then 2 when a line is invalid or not JSON', () => {
    const root = ws();
    const a = io(`${JSON.stringify(rec())}\n${JSON.stringify(rec())}\n`);
    assert.equal(cli(['append', '--root', root, '-'], a.io), 0);
    assert.deepEqual(lines(a.o.out).map((r) => r.status), ['written', 'duplicate']);
    const b = io(`not json\n${JSON.stringify(rec({ id: 'b'.repeat(24) }))}\n`);
    assert.equal(cli(['append', '--root', root, '-'], b.io), 2);
    const out = lines(b.o.out);
    assert.deepEqual(out.map((r) => r.status), ['invalid', 'written']);
    assert.match(out[0].errors[0], /not JSON/);
  });

  it('a held store lock exits 1 with no result line, so the caller keeps every row', () => {
    const root = ws();
    mkdirSync(join(recordsDir(root), '.lock'), { recursive: true });
    const a = io(`${JSON.stringify(rec())}\n`);
    assert.equal(cli(['append', '--root', root, '-'], a.io), 1);
    assert.equal(a.o.out, '');
    assert.match(a.o.err, /locked/);
  });

  it('list prints the window as JSON lines; bad usage exits 1', () => {
    const root = ws();
    recordLedgerLines(root, [rec()]);
    const a = io();
    assert.equal(cli(['list', '--root', root, '--since', '2026-11-06T00:00:00+08:00'], a.io), 0);
    assert.equal(lines(a.o.out)[0].id, 'a'.repeat(24));
    assert.equal(cli(['list'], io().io), 1);
    assert.equal(cli(['list', '--root', root, '--since', 'nope'], io().io), 1);
  });
});

describe('checkin-cli', () => {
  const NOW = Date.parse('2026-11-06T12:00:00+08:00');
  const ASK = {
    id: 'STUDIO-PIN-FALLBACK', by: 's2-coord',
    text: 'The Studio crash fix (an Enterprise writer could crash shared Studio) is merged at studio main 134f968152e6 but NOT live. If that row has not landed by the time you read this, you can move the pin by hand on <HOST>.',
    ts: NOW / 1000 - 600, status: 'open', answer: null, unit: 'STUDIO-EVOLVER-DOTTED-PATH-1', post_id: 'ops.ask:STUDIO-PIN-FALLBACK',
    options: [{ value: 'a', label: 'wait for the row (recommended)' }, { value: 'b', label: "I'll move the pin by hand" }], severity: 'warn',
  };
  const world = () => {
    const root = ws();
    const data = join(root, '.compose', 'data');
    mkdirSync(data, { recursive: true });
    const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
    const ev = [
      { tool: 'launch.requested', ts: at(2), at: at(2), mark: 'U1:1', label: 'U1', session: 'forge-main', pid: 11 },
      { tool: 'launch.running', ts: at(1.9), at: at(1.9), mark: 'U1:1', label: 'U1', session: 'forge-main', pid: 11, evidence_id: 'ev:1111111111111111' },
      { tool: 'launch.requested', ts: at(1), at: at(1), mark: 'U2:1', label: 'U2', session: 's2-coord', pid: 22 },
      { tool: 'launch.running', ts: at(3), at: at(3), mark: 'U3:1', label: 'U3', session: 'ops-main', pid: 33, evidence_id: 'ev:3333333333333333' },
      { tool: 'launch.requested', ts: at(4), at: at(4), mark: 'U4:1', label: 'U4', session: 'ops-main', pid: 44 },
      { tool: 'launch.refused', ts: at(0.5), at: at(0.5), mark: 'U4:1', label: 'U4', session: 'ops-main', gate_line: 'GATE' },
      { tool: 'launch.running', ts: at(30), at: at(30), mark: 'OLD:1', label: 'OLD', session: 'ops-main', pid: 55, evidence_id: 'ev:5555555555555555' },
      { tool: 'record_completion', ts: at(1), code: 'COMP-X', completion_id: 'c1', commit_sha: 'abcdef1234567890' },
      { tool: 'record_completion', ts: at(40), code: 'COMP-OLD', completion_id: 'c0' },
    ];
    writeFileSync(join(data, 'feature-events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(join(data, 'live-state.json'), JSON.stringify({ version: 1, rules_dir: null, next_seq: 3, live_orders: [
      { id: 'LO-1', text: 'OWNER: keep deploying', at: at(5), by: 's1-chat', source: 'ledger.md#x' },
      { id: 'LO-2', text: 'retired', at: at(6), by: 's1-chat', source: 'ledger.md#y', superseded_by: 'LO-1' },
    ] }));
    const q = join(root, 'owner-queue.jsonl');
    writeFileSync(q, `${JSON.stringify(ASK)}\n`);
    recordLedgerLines(root, [rec({ id: '1'.repeat(24), day: '2026-11-06', at: '2026-11-06T11:00:00+08:00', by: 's2-coord' }),
      rec({ id: '2'.repeat(24), day: '2026-11-06', at: '2026-11-06T11:30:00+08:00', by: 'forge-main' }),
      rec({ id: '3'.repeat(24), day: '2026-11-04', at: '2026-11-04T11:30:00+08:00', by: 'old' })]);
    return { root, q };
  };

  it('builds the view from Compose: in-flight launches by live pid, recent completions, pending gates, live orders, ledger by writer', () => {
    const { root, q } = world();
    const v = buildCheckin({ root, hours: 24, now: NOW, ownerQueueFile: q, alive: (pid) => pid === 11 || pid === 22 });
    assert.deepEqual(v.launches_in_flight.map((l) => [l.label, l.state, l.evidence_id]), [['U2', 'requested', null], ['U1', 'running', 'ev:1111111111111111']]);
    assert.deepEqual(v.launches_ended, { running_seen: 1, requested_only: 0 }, 'U3 pid gone; U4 refused; OLD outside the window');
    assert.deepEqual(v.completions.map((c) => c.code), ['COMP-X']);
    assert.deepEqual(v.owner_gates.map((g) => g.id), ['owner:STUDIO-PIN-FALLBACK']);
    assert.deepEqual(v.live_orders.map((o) => o.id), ['LO-1']);
    assert.deepEqual(v.ledger.by_writer, { 's2-coord': 1, 'forge-main': 1 });
    assert.deepEqual(v.unknown, []);
    const text = formatCheckin(v);
    for (const h of ['launches in flight: 2', 'completions: 1', 'owner gates pending: 1', 'live orders: 1', 'ledger records: 2']) assert.ok(text.includes(h), h);
  });

  it('an unreadable section is printed as UNKNOWN and the CLI exits 2; bad usage exits 1', () => {
    const { root, q } = world();
    writeFileSync(join(root, '.compose', 'data', 'live-state.json'), '{ torn');
    const a = io();
    assert.equal(checkinCli(['--root', root], a.io, { ownerQueueFile: q, now: NOW, alive: () => false }), 2);
    assert.match(a.o.out, /UNKNOWN live orders: live-state store unreadable/);
    assert.match(a.o.out, /owner gates pending: 1/);
    const b = io();
    assert.equal(checkinCli(['--root', root, '--json'], b.io, { ownerQueueFile: join(root, 'none.jsonl'), now: NOW, alive: () => false }), 2);
    assert.ok(JSON.parse(b.o.out).unknown.some((u) => u.startsWith('owner gates')), 'a missing owner queue is unknown, not 0');
    assert.equal(checkinCli(['--hours', '3'], io().io), 1);
  });
});
