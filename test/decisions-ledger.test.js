/**
 * decisions-ledger.test.js — COMP-COCKPIT-DECISIONS-1: the ledger line grammar, the classifier, the marked (D-id) grammar,
 * status from explicit pointers only, relay folding, the owner queue and the blame cache. One row table.
 *
 * `fixtures/decisions-ledger/sample-lines.json` holds 80 real ledger lines verbatim with their hand labels: the design's 40
 * (`units/COMP-COCKPIT-DECISIONS-1/report.md`) and 40 held-out lines drawn and labelled before the parser ran
 * (`report-build.md`). Label D = a decision (a row, or folded into one), X = not a decision (never a row).
 */
// COMPOSE-GOLDEN-LEAK-1: scrub inherited GIT_* redirection before any git call, even under a bare `node --test`.
import './helpers/git-env-scrub.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDecisions, classifyEntry, createLedgerBlame, parseLedger, parsePorcelain, queueDecisions, refsIn, unitsIn,
} from '../lib/decisions-ledger.js';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/decisions-ledger/sample-lines.json', import.meta.url), 'utf8'));
const rowsOf = (lines) => buildDecisions(parseLedger(lines.join('\n')));
/** One fixture line alone (its carried day as a heading): 'row', 'echo' (a D-id echo) or 'out'. */
function outcome(f) {
  const entries = parseLedger(`## ${f.day}\n${f.text}`);
  assert.equal(entries.length, 1, `L${f.line} parses as one entry`);
  if (buildDecisions(entries).length) return 'row';
  return classifyEntry(entries[0]).echoOf ? 'echo' : 'out';
}
const falseDecisions = (set) => FIXTURES.filter((f) => f.set === set && f.label === 'X' && outcome(f) === 'row').map((f) => `L${f.line}`);
const misses = (set) => FIXTURES.filter((f) => f.set === set && f.label === 'D' && outcome(f) === 'out').map((f) => `L${f.line}`);
const fixture = (n) => FIXTURES.find((f) => f.line === n).text;

function fakeGit(repoState) {
  const calls = [];
  const git = async (args) => {
    calls.push(args.slice(2).join(' '));
    const [cmd] = args.slice(2);
    if (cmd === 'rev-parse') return `${repoState.head}\n`;
    if (cmd === 'show') return repoState.lines.map((_, i) => `l${i + 1}`).join('\n') + '\n';
    if (cmd === 'diff') return repoState.numstat;
    if (cmd === 'blame') {
      const L = args.indexOf('-L');
      const [a, b] = L > 0 ? args[L + 1].split(',').map(Number) : [1, repoState.lines.length];
      let out = '';
      for (let l = a; l <= b; l += 1) out += `${repoState.lines[l - 1].padEnd(40, '0')} ${l} ${l} 1\n\tline ${l}\n`;
      return out;
    }
    throw new Error(`unexpected git ${cmd}`);
  };
  return { git, calls };
}

describe('decisions-ledger', () => {
  // [name, fn]
  const ROWS = [
    // ---- line grammar
    ['a dated line: day, local time, writer and body', () => {
      const [e] = parseLedger('- 2026-11-01 11:45 forge-main: push14 started');
      assert.deepEqual([e.day, new Date(e.ts).getHours(), e.who, e.body, e.masked], ['2026-11-01', 11, 'forge-main', 'push14 started', false]);
    }],
    ['a minute-masked time HH:Mx reads as HH:M0 and is flagged', () => {
      const [e] = parseLedger('- 2026-11-01 12:1x s1-chat: x');
      assert.deepEqual([new Date(e.ts).getMinutes(), e.masked], [10, true]);
    }],
    ['a bare time more than 12 h earlier than the previous entry is the next day (ledger.md:22290 shape)', () => {
      const es = parseLedger(['- 2026-10-31 23:5x s2-coord: a', '- 03:17 sm20-main: b', '00:10 sm20-main: c'].join('\n'));
      assert.deepEqual(es.map((e) => e.day), ['2026-10-31', '2026-11-01', '2026-11-01']);
    }],
    ['a time a little earlier than the previous one stays on the same day', () => {
      const es = parseLedger(['- 2026-10-31 10:05 a: x', '- 09:58 b: y'].join('\n'));
      assert.deepEqual(es.map((e) => e.day), ['2026-10-31', '2026-10-31']);
    }],
    ['a Z time is UTC', () => assert.equal(new Date(parseLedger('- 2026-10-30T09:26Z session_hop: hop')[0].ts).toISOString(), '2026-10-30T09:26:00.000Z')],
    ['`HH:MM UTC` (the zone as a word) is UTC, dated or not', () => {
      const es = parseLedger(['- 2026-10-24 19:26 UTC web-main: launched', '- 19:28 UTC web-main: x'].join('\n'));
      assert.deepEqual([es.map((e) => new Date(e.ts).toISOString()), es.map((e) => e.who)], [['2026-10-24T19:26:00.000Z', '2026-10-24T19:28:00.000Z'], ['web-main', 'web-main']]);
    }],
    ['unmarked UTC writers between local ones never run the day ahead of the next dated line (ledger.md:15129-15324 shape)', () => {
      const es = parseLedger([
        '- 2026-10-26 00:00 s1-chat: OWNER (night): x', '23:56 inefficiency-flags: missing-stamp', '- 00:12 codegen-main: V1-2 verified',
        '- 16:25 cadence-main: ADMIT-1 dispatched', '- 00:32 auto-compact ops-main', '- 16:32 s2-coord: FU-1 LANDED', '00:28 inefficiency-flags: m',
        '- 16:52 ops-main: LANDED', '- 00:55 codegen-main: V1-4 verified', '- 00:38 s2-coord: OWNER (via s1-chat 08:2x): y',
        '- 2026-10-26 08:43 s1-chat: OWNER: "time to up the"',
      ].join('\n'));
      assert.deepEqual(es.filter((e) => /^00:/.test(e.raw.replace(/^- /, ''))).map((e) => e.day), Array(5).fill('2026-10-26'));
      assert.ok(es.every((e) => e.day <= '2026-10-26'), es.map((e) => e.day).join(' '));
    }],
    ['with no dated line after it, `now` bounds an undated time', () => {
      const now = new Date(2026, 9, 25, 20, 0).getTime() + 6 * 3600e3; // local, so the row holds in any zone
      const es = parseLedger(['- 2026-10-25 20:00 s1-chat: a', '- 16:25 cadence-main: b', '- 00:32 auto-compact c', '- 16:32 s2-coord: d', '- 00:28 x-main: e'].join('\n'), { now });
      assert.ok(es.every((e) => e.ts <= now + 3600e3), es.map((e) => new Date(e.ts).toISOString()).join(' '));
    }],
    ['a line before any date is skipped; a heading with a date sets the day', () => {
      assert.equal(parseLedger('- 10:00 a: x').length, 0);
      assert.equal(parseLedger('## STATE AT STOP (2026-10-06 ~15:10 CST)\n- 15:20 a: x')[0].day, '2026-10-06');
    }],
    ['the writer: "s1-chat OWNER DECISION ..." has no colon after the session; an OWNER-written line keeps OWNER in the body', () => {
      const [a, b] = parseLedger(['- 2026-11-01 12:2x s1-chat OWNER DECISION D-0006: x', '- 2026-10-06 14:29 OWNER (via sm-chat): y'].join('\n'));
      assert.deepEqual([a.who, a.body, b.who, b.body], ['s1-chat', 'OWNER DECISION D-0006: x', 'sm-chat', 'OWNER (via sm-chat): y']);
    }],
    ['unit IDs and refs', () => {
      assert.deepEqual(unitsIn('RR-TRUST-1 (c), REL-2.0-CUT-1 row, D-0004, 12:1x, COMP-AUDIT-17/18.'), ['RR-TRUST-1', 'REL-2.0-CUT-1', 'COMP-AUDIT-17']);
      assert.deepEqual(refsIn('ledger 53ed0fd98493; ledger :22555; ops c7532a3bc'), [{ kind: 'line', value: 22555 }, { kind: 'sha', value: '53ed0fd98493' }, { kind: 'sha', value: 'c7532a3bc' }]);
    }],

    // ---- marked grammar (Q2 ruling, ledger.md:22704 on)
    ['a D-line parses exactly: id, owner decider, never inferred (ledger.md:22747 verbatim)', () => {
      const [r] = rowsOf([fixture(22747)]);
      assert.deepEqual([r.id, r.dId, r.decider, r.exact, r.inferred, r.summary], ['D-0004', 'D-0004', 'owner', true, false, 'fuck the reviews just run it and see']);
    }],
    ['a D-line with no colon after the session parses exactly (ledger.md:22764 verbatim)', () => {
      const [r] = rowsOf([fixture(22764)]);
      assert.deepEqual([r.dId, r.decider, r.exact], ['D-0006', 'owner', true]);
    }],
    ['a D-line whose decider is OWNER via s1-chat is exact, owner, via s1-chat, and not a relay', () => {
      const [r] = rowsOf(['- 2026-11-01 13:00 s2-coord: DECISION D-0009: OWNER (via s1-chat 12:5x): "ship the pane" -> forge-main.']);
      assert.deepEqual([r.dId, r.decider, r.via, r.exact, r.inferred, r.tags.includes('relay-only'), r.summary], ['D-0009', 'owner', 's1-chat', true, false, false, 'ship the pane']);
    }],
    ['supersedes D-<id> sets the earlier row superseded (exactly) and the correction is an exact row', () => {
      const rows = rowsOf([
        '- 2026-11-01 12:1x s1-chat: DECISION D-0005: OWNER "if it breaks then we might consider reviews after 2 things break". General bar.',
        '- 2026-11-01 12:2x s1-chat: CORRECTION supersedes D-0005 scope: OWNER "no not fleet wide for runners only". D-0005 applies to runners ONLY.',
      ]);
      const [d5, corr] = rows;
      assert.deepEqual([d5.status, d5.statusBy.exact, d5.statusBy.line], ['superseded', true, 2]);
      assert.deepEqual([corr.exact, corr.inferred, corr.decider, corr.supersedes], [true, false, 'owner', [{ id: 'D-0005', kind: 'superseded' }]]);
    }],
    ['no marked row carries inferred, over every fixture line plus the marked lines', () => {
      const rows = rowsOf([...FIXTURES.map((f) => `## ${f.day}\n${f.text}`), '- 2026-11-01 12:2x s1-chat: CORRECTION supersedes D-0005 scope: OWNER "x".']);
      const marked = rows.filter((r) => r.dId || r.supersedes.length);
      assert.ok(marked.length >= 3);
      assert.deepEqual(marked.filter((r) => r.inferred || !r.exact), []);
    }],
    ['another session naming a D-id is an echo of that row, not a row (ledger.md:22748 verbatim)', () => {
      const rows = rowsOf(['## 2026-11-01', fixture(22747), fixture(22748)]);
      assert.deepEqual([rows.length, rows[0].echoes.map((e) => e.line)], [1, [3]]);
    }],

    // ---- classifier
    ['OWNER-ABSENT decision is a row with the colon, without it, and plural', () => {
      const rows = rowsOf(['- 2026-10-20 10:00 s2-coord: OWNER-ABSENT decision: a.', '- 10:01 s2-coord: OWNER-ABSENT decision BYOC F3: REFUSE.', '- 10:02 s1-chat: OWNER-ABSENT decisions (owner confirms in digest): (1) x']);
      assert.deepEqual(rows.map((r) => [r.decider, r.summary]), [['absent', 'a.'], ['absent', 'BYOC F3: REFUSE.'], ['absent', '(1) x']]);
    }],
    ['owner asks are not decisions: a quote ending in ?, OWNER QUESTION, OWNER ASK (ledger.md:21350, :22111 verbatim)', () => {
      assert.equal(rowsOf(['## 2026-10-31', fixture(21350), fixture(22111), '- 11:00 s2-coord: OWNER QUESTION sent: x?', '- 11:01 cadence-main: OWNER ASK sent to s2-coord']).length, 0);
    }],
    ['an owner quote with a ? inside followed by a RULING is a decision (ledger.md:22574 verbatim)', () => assert.equal(rowsOf([fixture(22574)])[0].decider, 'owner')],
    ['an owner question is not a decision: no `?` at the end, a `?` mid-quote, a trailing interrogative clause (ledger.md:22509, :22517 verbatim, 2026-11-01)', () => {
      const lines = ['## 2026-11-01', "- 2026-11-01 09:0x s1-chat: OWNER \"ah right but mostly no edges, what's wrong\" (Flow editor). Cause: PipelineEditorCanvas.jsx:153/213/279 read `depends_on`; every pipelines/*.stratum.yaml declares deps as `after:` (v1 rename, bug-fix.stratum.yaml:37; after= bug-fix 8, build-quick 12, build 18, content 3, gsd 2, new 5, plan 4, refactor 6, research 2, review-fix 2; depends_on 0 real). Filed COMP-PIPE-EDIT-EDGES-1 (P1) to forge-main.", "- 2026-11-01 09:1x s1-chat: OWNER \"a more visual view for cadence than Board? something that shows activity in realtime across active units\" -> filed CADENCE-UI-LIVE-1 (P1, Opus design note first) to cadence-main, cc forge-main (Compose hosts the Cadence tab; compose/src/components/vision/AgentStream.jsx + agent-stream-lanes.js is the existing live-lanes surface to reuse)."];
      assert.equal(rowsOf(lines).length, 0);
      assert.deepEqual(parseLedger(lines.join('\n')).map((e) => classifyEntry(e).why), ['question', 'question']);
    }],
    ['an owner quote that asks and then gives an instruction or a pick stays a decision (fix them / use cleaned / dispatch)', () => {
      for (const q of ['are there any gaps in metrics collection? fix them.', 'use cleaned, why handicap ourselves', 'why are there no logs? dispatch to a new session', 'can we run impeccable on the web UI', 'should we cut it? yes']) {
        assert.equal(rowsOf(['## 2026-11-01', `- 10:00 s1-chat: OWNER "${q}" -> sent to ops-main`]).length, 1, q);
      }
    }],
    ['a relayed owner instruction with no question stays a row (ledger.md:22500 shape: file issues to fix the gaps)', () => {
      const [r] = rowsOf(['## 2026-11-01', "- 08:58 s2-coord: OWNER (via s1-chat 09:4x) 'file issues to fix the missing readers gaps' -> ops-main to file 4 units"]);
      assert.equal(r.decider, 'owner');
    }],
    ['a `DECISION D-<id>:` line is exact whatever its punctuation, even ending in `?`', () => {
      const [r] = rowsOf(['## 2026-11-01', '- 10:00 s1-chat: DECISION D-0007: OWNER "why not ship it now?"']);
      assert.deepEqual([r.exact, r.dId, r.decider], [true, 'D-0007', 'owner']);
    }],
    ['echoes of earlier rulings are not decisions: per X ruling, rulings applied, filed per', () => {
      assert.equal(rowsOf(['## 2026-10-31', fixture(20993), fixture(21246), fixture(22150), fixture(22161), fixture(21151)]).length, 0);
    }],
    ['a lane ruling counts when the writer made it; another session\'s ruling is an echo', () => {
      const rows = rowsOf(['- 2026-10-31 04:06 s2-coord: CLERK r1. s2-coord ruling: blocks; one narrow r2.', '- 04:07 ops-main: s2-coord ruling: blocks noted.', '- 04:08 sm20-main: Lead ruling: census re-pin ACCEPTED.']);
      assert.deepEqual(rows.map((r) => [r.by, r.decider, r.summary]), [['s2-coord', 'lane', 'blocks; one narrow r2.'], ['sm20-main', 'lane', 'census re-pin ACCEPTED.']]);
    }],
    ['OWNER only inside unit IDs, machine writers and mid-line mentions are not decisions', () => {
      assert.equal(rowsOf(['## 2026-10-31', fixture(21406), fixture(21435), fixture(21568), fixture(20348), fixture(22055), fixture(22709)]).length, 0);
    }],
    ['the summary is the quote after the mark, and a single quote never closes inside a word (ledger.md:22569 verbatim)', () => {
      assert.equal(rowsOf([fixture(22569)])[0].summary, "leave them for now, let's see");
    }],

    // ---- status: explicit pointers only
    ['a KILLED line naming CUT-1 leaves the 42 CUT-1 rows standing (candidates only)', () => {
      const lines = ['- 2026-10-31 00:00 s1-chat: OWNER: start'];
      for (let i = 0; i < 42; i += 1) lines.push(`- 00:${String(i + 1).padStart(2, '0')} s1-chat: OWNER: row ${i} goes on REL-2.0-CUT-1.`);
      lines.push('- 01:00 s2-coord: RR-SERVICE-TRUST-1 KILLED; REL-2.0-CUT-1 row closed.');
      const cut = rowsOf(lines).filter((r) => r.units.includes('REL-2.0-CUT-1'));
      assert.equal(cut.length, 42);
      assert.deepEqual([...new Set(cut.map((r) => r.status))], ['standing']);
      assert.ok(cut.every((r) => r.maybe.includes(44)));
    }],
    ['a later line with `ledger :<n>` and SUPERSEDED in the same clause supersedes row n (inferred)', () => {
      const rows = rowsOf(['- 2026-10-31 09:00 s1-chat: OWNER: shadow mode x3 for RR-PAIR-1.', '- 10:00 s1-chat: OWNER: no shadow; ledger :1 SUPERSEDED.']);
      assert.deepEqual([rows[0].status, rows[0].statusBy], ['superseded', { line: 2, id: 'L2', exact: false }]);
    }],
    ['a `ledger <sha>` ref resolves through the blame map; a status word in another clause does not count', () => {
      const blame = { shaAt: (l) => (l === 1 ? 'abcdef123456' : null), linesOf: (p) => ('abcdef123456'.startsWith(p) ? [1] : []) };
      const text = ['- 2026-10-31 09:00 s1-chat: OWNER: pick (a).', '- 10:00 s1-chat: OWNER: ledger abcdef1 reversed.'];
      const [r] = buildDecisions(parseLedger(text.join('\n')), { blame });
      assert.deepEqual([r.status, r.commit], ['reversed', 'abcdef123456']);
      const [s] = buildDecisions(parseLedger([text[0], '- 10:00 s1-chat: OWNER: see ledger abcdef1; X KILLED.'].join('\n')), { blame });
      assert.equal(s.status, 'standing');
    }],

    // ---- relays
    ['a relay sharing a unit within 90 min folds into the s1-chat row as an echo', () => {
      const rows = rowsOf(['- 2026-10-31 09:2x s1-chat: OWNER rulings: RR-TRUST-1 pick (c).', '- 09:18 s2-coord: OWNER (via s1-chat): RR-TRUST-1 = (c). Relayed to ops-main.']);
      assert.deepEqual([rows.length, rows[0].echoes.map((e) => e.by)], [1, ['s2-coord']]);
    }],
    ['a relay with no matching chat row stays as a relay-only row', () => {
      const [r] = rowsOf(['- 2026-11-01 10:13 forge-main: OWNER (via s1-chat) on X-1 Q2: "leave them for now".']);
      assert.deepEqual([r.tags, r.relay], [['relay-only'], true]);
    }],
    ['a relay naming the chat time folds by shared words, but time alone never links', () => {
      const rows = rowsOf([
        '- 2026-10-30 19:0x s1-chat: OWNER Compose nav (COMP-AUDIT-17/18) = 1a seven rooms + inner tab rows, 2a label status controls now.',
        '- 19:05 s1-chat: OWNER closed web-main tab (idle since 10:19).',
        '- 22:08 s2-coord: OWNER (via s1-chat 19:0x) Compose nav AUDIT-17/18 = 1a seven labelled rooms with an in-room tab row, 2a label the 3 status controls now.',
        '- 22:09 forge-main: OWNER (via s1-chat 19:0x): compose waits for COMPOSE-ORIGIN-RED-1, then pushes.',
      ]);
      assert.deepEqual(rows.map((r) => [r.line, r.echoes.map((e) => e.line), r.tags]), [[1, [3], []], [2, [], []], [4, [], ['relay-only']]]);
    }],

    // ---- owner queue
    ['the owner queue: last write wins; an owner answer is a queue row, APPLIED is absent; stale/resolved/session answers and TEST-* are not', () => {
      const rows = queueDecisions([
        { id: 'A', by: 's2-coord', text: 'Prune?', ts: 100, status: 'open', answer: null },
        { id: 'A', by: 's2-coord', text: 'Prune?', ts: 100, status: 'closed', answer: 'OWNER (via s1-chat) 2026-10-31: yes', closed_ts: 200 },
        { id: 'B', by: 's2-coord', text: 'APPLIED (night mode): ship. Reverse = revert.', ts: 300, status: 'closed', answer: 'stale: done' },
        { id: 'C', text: 'q', ts: 1, status: 'closed', answer: 'stale: shipped' },
        { id: 'D', text: 'q', ts: 1, status: 'closed', answer: 'resolved: n/a' },
        { id: 'E', text: 'q', ts: 1, status: 'closed', answer: 's1-chat: stash dropped' },
        { id: 'TEST-COCKPIT-ANSWER-1', text: 'q', ts: 1, status: 'closed', answer: 'OWNER (via cockpit): (b) no' },
      ]);
      assert.deepEqual(rows.map((r) => [r.id, r.decider, r.reverse ?? null]), [['Q:A', 'queue', null], ['Q:B:applied', 'absent', 'revert.']]);
    }],

    // ---- blame cache
    ['blame: cold until the first build, then every line has its commit; a sha prefix resolves to its lines', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'blame-'));
      const st = { head: 'h1', lines: ['aaaa', 'bbbb', 'aaaa'], numstat: '' };
      const { git } = fakeGit(st);
      const b = createLedgerBlame({ repo: '/r', relPath: 'l.md', cacheFile: join(dir, 'c.json'), git, info: () => {} });
      assert.equal(b.snapshot().state, 'cold');
      assert.equal(b.snapshot().shaAt(1), null);
      await b.refresh();
      const s = b.snapshot();
      assert.deepEqual([s.state, s.shaAt(1), s.shaAt(2), s.linesOf('aaaa000'), s.lastBuild.kind], ['warm', 'aaaa00000000', 'bbbb00000000', [1, 3], 'full']);
    }],
    ['blame: a new head with no deletions blames only the tail; deletions rebuild in full; the cache file survives a restart', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'blame-'));
      const st = { head: 'h1', lines: ['aaaa', 'bbbb'], numstat: '' };
      const { git, calls } = fakeGit(st);
      let t = 0;
      const mk = () => createLedgerBlame({ repo: '/r', relPath: 'l.md', cacheFile: join(dir, 'c.json'), git, info: () => {}, now: () => t, checkEveryMs: 0 });
      const b = mk();
      await b.refresh();
      Object.assign(st, { head: 'h2', lines: ['aaaa', 'bbbb', 'cccc'], numstat: '1\t0\tl.md\n' });
      t += 1; await b.refresh();
      assert.ok(calls.includes('blame --porcelain -L 3,3 h2 -- l.md'));
      assert.deepEqual([b.snapshot().lastBuild.kind, b.snapshot().shaAt(3)], ['tail', 'cccc00000000']);
      Object.assign(st, { head: 'h3', lines: ['dddd', 'cccc'], numstat: '0\t1\tl.md\n' });
      t += 1; await b.refresh();
      assert.deepEqual([b.snapshot().lastBuild.kind, b.snapshot().shaAt(1)], ['full', 'dddd00000000']);
      const again = mk();
      calls.length = 0;
      await again.refresh();
      assert.deepEqual([again.snapshot().shaAt(2), calls.filter((c) => c.startsWith('blame'))], ['cccc00000000', []]);
    }],
    ['blame on a real git repo: the tail increment after a commit takes under 5 s and names the new commit', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'blame-git-'));
      const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
      g('init', '-q');
      writeFileSync(join(dir, 'ledger.md'), Array.from({ length: 300 }, (_, i) => `- 10:00 a: line ${i}`).join('\n') + '\n');
      g('add', '.'); g('commit', '-qm', 'one');
      let t = 0;
      const b = createLedgerBlame({ repo: dir, relPath: 'ledger.md', cacheFile: join(dir, 'blame.json'), info: () => {}, now: () => t, checkEveryMs: 0 });
      await b.refresh();
      appendFileSync(join(dir, 'ledger.md'), '- 11:00 b: new\n');
      g('commit', '-qam', 'two');
      const head = g('rev-parse', 'HEAD').trim().slice(0, 12);
      t += 1;
      const t0 = Date.now();
      await b.refresh();
      assert.ok(Date.now() - t0 < 5000);
      assert.deepEqual([b.snapshot().lastBuild.kind, b.snapshot().shaAt(301), b.snapshot().nlines], ['tail', head, 301]);
    }],
    ['porcelain parsing keeps the final line number', () => assert.deepEqual([...parsePorcelain(`${'a'.repeat(40)} 7 2 1\n\tx\n${'b'.repeat(40)} 1 3\n\ty\n`)], [[2, 'aaaaaaaaaaaa'], [3, 'bbbbbbbbbbbb']])],

    // ---- the pre-registered false-decision bar on real lines
    ['the design\'s 40 lines: the one false decision left is the owner report L20789 (no pick verb, design 2 (b))', () => {
      assert.deepEqual(falseDecisions('design'), ['L20789']);
    }],
    ['the 40 held-out lines: at most 2 false decisions (0 today); the one miss is L20842, rulings in a parenthesis', () => {
      assert.deepEqual(falseDecisions('heldout'), []);
      assert.deepEqual(misses('heldout'), ['L20842']);
    }],
  ];
  for (const [name, fn] of ROWS) it(name, fn);
});
