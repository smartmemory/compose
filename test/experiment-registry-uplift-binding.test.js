/**
 * experiment-registry-uplift-binding.test.js — COMP-STAGE-GRADING-4-FU-1.
 *
 * The bug class: an uplift row was not bound to the exact samples and champion revision it was computed from.
 * One row per class member (a plain table, no stacked parametrize):
 *   R1 cross-call arrival, R1 reverse arrival, R1 champion refresh (named and unnamed), R2 catalog key (own champion
 *   and fallback), R3 demotion (re-point, and null when none remains), promotion of a newer champion, review item 8
 *   (complete-snapshot refusal and acceptance), persisted samples, deterministic pick tie, replay bytes.
 * Numbers are the reviewer's static reproductions from COMP-STAGE-GRADING-4/review.md (probes 1-4), verbatim.
 *
 * Spec: docs/features/COMP-MODEL-AB-DECISION/registry-contract.json (`rules.uplift`, `rules.snapshot`, S9, S10).
 * Run: node --test test/experiment-registry-uplift-binding.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writeRegistry, promoteRows, demoteRows, readRegistry, saveRegistry, validateRegistrySemantics,
  pickChampion, sampleRevisionOf,
} from '../lib/experiment-registry.js';

const CAT_A = 'a'.repeat(64);
const CAT_B = 'b'.repeat(64);
const FIX = 'f'.repeat(64);
const CHAMP = { provider: 'claude', modelID: 'claude-opus-5-5', effort: 'medium', workflow: 'default' };
const SRC = { provider: 'claude', modelID: 'claude-sonnet-5-5', effort: 'medium', workflow: 'default' };
const THIRD = { provider: 'codex', modelID: 'gpt-6.1-sol', effort: 'high', workflow: 'default' };
const cellOf = (stage, i) => `${stage}|${i.provider}|${i.modelID}|${i.effort}|${i.workflow}`;
const EVID = { calibrationReport: 'docs/calib.md', panelModels: ['claude-opus-5-5'], judgeCatalogDigest: 'a'.repeat(64), gatePassed: true, agreement: 0.9 };

/** One executed stage run (stage-run-contract), reduced to what the writer reads. o: catalog, day, bad (canary false). */
function run(stage, ing, n, accuracy, o = {}) {
  const catalog = o.catalog ?? CAT_A;
  const runId = `${stage}-${ing.modelID}-${catalog[0]}-${o.tag ?? 'x'}-r${n}`;
  return {
    runId, rep: n, runner: 'stage', archetype: { id: stage, version: '1' },
    metrics: {
      cost: { tokensIn: 1000, tokensOut: 100, calls: 3, wallMs: 5000, usd: 0.5 },
      outcome: { completed: true },
      process: { retries: 0, escalations: 0, gateFailures: 0 },
      stage: { accuracy, oracleError: null, canaryOk: !o.bad, mechanismEngaged: true },
    },
    manifest: { endedAt: `2026-10-${o.day ?? '20'}T11:${String(n).padStart(2, '0')}:00.000Z` },
    runKeyInputs: { ingredients: ing, fixtureDigest: FIX, oracleVersion: '1', catalogDigest: catalog },
  };
}
const cell = (stage, ing, accs, o) => accs.map((a, i) => run(stage, ing, i + 1, a, o));
const dbg = (ing, accs, o) => cell('debug', ing, accs, o);

let dir; let seq = 0;
before(() => { dir = mkdtempSync(join(tmpdir(), 'compose-g4fu1-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });
const regPath = () => join(dir, `registry-${++seq}.json`);
const write = (p, id, runs, champion = cellOf('debug', CHAMP)) => writeRegistry({ experimentId: id }, runs, { registryPath: p, champion }).registry;
const rowOf = (reg, stage, ing, cat = CAT_A, exp) => reg.rows.find(r => r.cellKey === cellOf(stage, ing) && r.catalogDigest === cat && (!exp || r.experimentId === exp));
const valid = reg => assert.deepEqual(validateRegistrySemantics(reg, {}), []);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`); // 0.8 - 0.5 is 0.30000000000000004
const flat = (u, delta, ci) => { near(u.delta, delta); near(u.ci95[0], ci); near(u.ci95[1], ci); };

const table = [
  ['persisted samples: every row keeps accuracies parallel to sourceRunIds (measured and triaged)', () => {
    const reg = write(regPath(), 'e', [...dbg(CHAMP, [0.3, 0.1, 0.2]), ...cell('debug', SRC, [0.9, 0.8, 0.7], { bad: false }).slice(0, 2)]);
    const champ = rowOf(reg, 'debug', CHAMP); const low = rowOf(reg, 'debug', SRC);
    assert.deepEqual([champ.state, champ.sourceRunIds.length, champ.accuracies], ['measured', 3, [0.3, 0.1, 0.2]]);
    assert.deepEqual([low.state, low.sourceRunIds.length, low.accuracies], ['triaged', 2, [0.9, 0.8]]);
    valid(reg);
  }],

  ['R1 cross-call: champion first, source plus a third arm later (probe 1: delta 0.5, CI [0.5, 0.5], same as one call)', () => {
    const p = regPath();
    write(p, 'e', dbg(CHAMP, [0.25, 0.25, 0.25]));
    const reg = write(p, 'e', [...dbg(SRC, [0.75, 0.75, 0.75]), ...dbg(THIRD, [0.5, 0.5, 0.5])]);
    const one = write(regPath(), 'e', [...dbg(CHAMP, [0.25, 0.25, 0.25]), ...dbg(SRC, [0.75, 0.75, 0.75]), ...dbg(THIRD, [0.5, 0.5, 0.5])]);
    const u = rowOf(reg, 'debug', SRC).uplift;
    flat(u, 0.5, 0.5);
    assert.deepEqual(u, rowOf(one, 'debug', SRC).uplift);
    assert.equal(u.championRowId, rowOf(reg, 'debug', CHAMP).rowId);
    flat(rowOf(reg, 'debug', THIRD).uplift, 0.25, 0.25);
    valid(reg);
  }],

  ['R1 reverse arrival: source first, champion later; the earlier null becomes an uplift', () => {
    const p = regPath();
    const first = write(p, 'e', dbg(SRC, [0.75, 0.75, 0.75]));
    assert.equal(rowOf(first, 'debug', SRC).upliftNullReason, 'NO_COMPATIBLE_CHAMPION');
    const reg = write(p, 'e', dbg(CHAMP, [0.25, 0.25, 0.25]));
    flat(rowOf(reg, 'debug', SRC).uplift, 0.5, 0.5);
    valid(reg);
  }],

  ['R1 stale: champion runs replaced with [1,1,1] (probe 2: delta -0.25, CI [-0.25, -0.25])', () => {
    const p = regPath();
    const before = write(p, 'e', [...dbg(CHAMP, [0.25, 0.25, 0.25]), ...dbg(SRC, [0.75, 0.75, 0.75])]);
    flat(rowOf(before, 'debug', SRC).uplift, 0.5, 0.5);
    const reg = write(p, 'e', dbg(CHAMP, [1, 1, 1]));
    const u = rowOf(reg, 'debug', SRC).uplift;
    flat(u, -0.25, -0.25);
    assert.equal(u.championSampleRevision, sampleRevisionOf(rowOf(reg, 'debug', CHAMP)));
    assert.notEqual(u.championSampleRevision, rowOf(before, 'debug', SRC).uplift.championSampleRevision);
    valid(reg);
  }],

  ['R1 stale, champion not named again: the refresh still re-points the dependant (hint kept from its uplift)', () => {
    const p = regPath();
    write(p, 'e', [...dbg(CHAMP, [0.25, 0.25, 0.25]), ...dbg(SRC, [0.75, 0.75, 0.75])]);
    const reg = write(p, 'e', dbg(CHAMP, [1, 1, 1]), null);
    flat(rowOf(reg, 'debug', SRC).uplift, -0.25, -0.25);
    valid(reg);
  }],

  ['R2 catalog key, champion under both catalogs (probe 3: A row -0.3, B row +0.3)', () => {
    const reg = write(regPath(), 'e', [
      ...dbg(SRC, [0.2, 0.2, 0.2], { catalog: CAT_A, day: '20' }), ...dbg(SRC, [0.8, 0.8, 0.8], { catalog: CAT_B, day: '21' }),
      ...dbg(CHAMP, [0.5, 0.5, 0.5], { catalog: CAT_A, day: '20' }), ...dbg(CHAMP, [0.5, 0.5, 0.5], { catalog: CAT_B, day: '21' }),
    ]);
    const a = rowOf(reg, 'debug', SRC, CAT_A).uplift; const b = rowOf(reg, 'debug', SRC, CAT_B).uplift;
    flat(a, -0.3, -0.3); flat(b, 0.3, 0.3);
    assert.equal(a.championRowId, rowOf(reg, 'debug', CHAMP, CAT_A).rowId);
    assert.equal(b.championRowId, rowOf(reg, 'debug', CHAMP, CAT_B).rowId);
    valid(reg);
  }],

  ['R2 catalog key, one champion under catalog A only (probe 3 as stated): each row scores its OWN samples; B falls back to the A champion, recorded', () => {
    const reg = write(regPath(), 'e', [
      ...dbg(SRC, [0.2, 0.2, 0.2], { catalog: CAT_A, day: '20' }), ...dbg(SRC, [0.8, 0.8, 0.8], { catalog: CAT_B, day: '21' }),
      ...dbg(CHAMP, [0.5, 0.5, 0.5], { catalog: CAT_A, day: '20' }),
    ]);
    const a = rowOf(reg, 'debug', SRC, CAT_A).uplift; const b = rowOf(reg, 'debug', SRC, CAT_B).uplift;
    flat(a, -0.3, -0.3); flat(b, 0.3, 0.3);
    assert.equal(b.championRowId, rowOf(reg, 'debug', CHAMP, CAT_A).rowId);
    valid(reg);
  }],

  ['R3 demotion (probe 4): newest champion demoted, the dependant re-points to the remaining champion (+0.5, [0.5, 0.5]); latest rebuilt', () => {
    const p = regPath(); const cc = cellOf('design', CHAMP); const named = { design: cc };
    const w = (id, runs) => writeRegistry({ experimentId: id }, runs, { registryPath: p, champion: named }).registry;
    w('old', cell('design', CHAMP, [0, 0, 0], { day: '19', tag: 'old' }));
    const first = w('new', [...cell('design', CHAMP, [1, 1, 1], { day: '21', tag: 'new' }), ...cell('design', SRC, [0.5, 0.5, 0.5], { day: '21', tag: 'new' })]);
    saveRegistry(p, promoteRows(first, { rowIds: first.rows.filter(r => r.experimentId === 'new').map(r => r.rowId), evidence: EVID }));
    const reg = w('new', [...cell('design', CHAMP, [1, 1, 1], { day: '21', tag: 'new' }), ...cell('design', SRC, [0.5, 0.5, 0.5], { day: '21', tag: 'new' })]);
    const newChamp = rowOf(reg, 'design', CHAMP, CAT_A, 'new'); const oldChamp = rowOf(reg, 'design', CHAMP, CAT_A, 'old');
    assert.equal(oldChamp.state, 'triaged', 'the old champion is unpromoted until promoted');
    const both = promoteRows(reg, { rowIds: [oldChamp.rowId], evidence: EVID });
    const src = rowOf(both, 'design', SRC);
    flat(src.uplift, -0.5, -0.5);
    assert.equal(src.uplift.championRowId, newChamp.rowId);
    const demoted = demoteRows(both, { rowIds: [newChamp.rowId], reason: 'JUDGE_DRIFT' });
    const after = rowOf(demoted, 'design', SRC);
    flat(after.uplift, 0.5, 0.5);
    assert.equal(after.uplift.championRowId, oldChamp.rowId);
    assert.equal(demoted.latest.design[after.compatKey][cc], oldChamp.rowId);
    valid(demoted);
  }],

  ['R3 demotion of the only champion: the dependant is null NO_COMPATIBLE_CHAMPION, never a stale uplift', () => {
    const p = regPath(); const named = { design: cellOf('design', CHAMP) };
    const first = writeRegistry({ experimentId: 'e' }, [...cell('design', CHAMP, [1, 1, 1]), ...cell('design', SRC, [0.5, 0.5, 0.5])], { registryPath: p, champion: named }).registry;
    saveRegistry(p, promoteRows(first, { rowIds: first.rows.map(r => r.rowId), evidence: EVID }));
    const reg = writeRegistry({ experimentId: 'e' }, [...cell('design', CHAMP, [1, 1, 1]), ...cell('design', SRC, [0.5, 0.5, 0.5])], { registryPath: p, champion: named }).registry;
    assert.ok(rowOf(reg, 'design', SRC).uplift);
    const demoted = demoteRows(reg, { rowIds: [rowOf(reg, 'design', CHAMP).rowId], reason: 'JUDGE_DRIFT' });
    const d = rowOf(demoted, 'design', SRC);
    assert.deepEqual([d.uplift, d.upliftNullReason], [null, 'NO_COMPATIBLE_CHAMPION']);
    valid(demoted);
  }],

  ['promotion of a newer champion re-binds the dependants (hint kept): delta follows the new champion row', () => {
    const p = regPath(); const named = { design: cellOf('design', CHAMP) };
    const w = (id, runs) => writeRegistry({ experimentId: id }, runs, { registryPath: p, champion: named }).registry;
    const o = w('old', [...cell('design', CHAMP, [0, 0, 0], { day: '19', tag: 'old' }), ...cell('design', SRC, [0.5, 0.5, 0.5], { day: '19', tag: 'old' })]);
    saveRegistry(p, promoteRows(o, { rowIds: o.rows.map(r => r.rowId), evidence: EVID }));
    const settled = w('old', [...cell('design', CHAMP, [0, 0, 0], { day: '19', tag: 'old' }), ...cell('design', SRC, [0.5, 0.5, 0.5], { day: '19', tag: 'old' })]);
    flat(rowOf(settled, 'design', SRC).uplift, 0.5, 0.5);
    const withNew = w('new', cell('design', CHAMP, [1, 1, 1], { day: '21', tag: 'new' }));
    flat(rowOf(withNew, 'design', SRC).uplift, 0.5, 0.5); // the new champion is still unpromoted, so not a champion yet
    const newChamp = rowOf(withNew, 'design', CHAMP, CAT_A, 'new');
    const promoted = promoteRows(withNew, { rowIds: [newChamp.rowId], evidence: EVID });
    const src = rowOf(promoted, 'design', SRC);
    flat(src.uplift, -0.5, -0.5);
    assert.equal(src.uplift.championRowId, newChamp.rowId);
    valid(promoted);
  }],

  ['review item 8: a replacement that omits recorded attempts is refused INCOMPLETE_SNAPSHOT and the file is untouched', () => {
    const p = regPath();
    const five = [...dbg(CHAMP, [1, 1, 1]), ...dbg(CHAMP, [1, 1], { bad: true, tag: 'bad' })];
    const first = write(p, 'e', five);
    assert.deepEqual([rowOf(first, 'debug', CHAMP).state, rowOf(first, 'debug', CHAMP).nAttempted], ['triaged', 5]);
    const bytes = readFileSync(p, 'utf8');
    assert.throws(() => write(p, 'e', dbg(CHAMP, [1, 1, 1])), e => e.code === 'INCOMPLETE_SNAPSHOT' && e.violations.length === 2);
    assert.equal(readFileSync(p, 'utf8'), bytes);
    assert.deepEqual(readdirSync(dir).filter(f => f.includes('.tmp-')), []);
  }],

  ['review item 8: a complete snapshot (every recorded attempt plus a new one) replaces the row', () => {
    const p = regPath();
    write(p, 'e', dbg(CHAMP, [1, 1, 1]));
    const reg = write(p, 'e', [...dbg(CHAMP, [1, 1, 1]), ...dbg(CHAMP, [0.5], { tag: 'more' })]);
    const r = rowOf(reg, 'debug', CHAMP);
    assert.deepEqual([r.nAttempted, r.nAdmitted, r.accuracies.length], [4, 4, 4]);
    assert.equal(reg.rows.length, 1);
  }],

  ['deterministic champion pick: equal catalog and instant fall to the greater rowId; a newer instant beats it; same catalog beats newer', () => {
    const mk = (rowId, generatedAt, catalogDigest) => ({ rowId, state: 'measured', stage: 'debug', compatKey: 'k', cellKey: 'c', generatedAt, catalogDigest });
    const src = { rowId: 's', stage: 'debug', compatKey: 'k', cellKey: 'x', catalogDigest: CAT_A };
    const t = '2026-10-20T11:00:00.000Z';
    assert.equal(pickChampion([mk('r1', t, CAT_A), mk('r2', t, CAT_A)], src, 'c').rowId, 'r2');
    assert.equal(pickChampion([mk('r2', t, CAT_A), mk('r1', '2026-10-21T00:00:00Z', CAT_A)], src, 'c').rowId, 'r1');
    assert.equal(pickChampion([mk('r1', t, CAT_A), mk('r9', '2026-10-21T00:00:00Z', CAT_B)], src, 'c').rowId, 'r1');
    assert.equal(pickChampion([mk('r1', t, CAT_B)], src, 'c').rowId, 'r1');
    assert.equal(pickChampion([], src, 'c'), null);
  }],

  ['replay: the same runs again give identical bytes (recompute is a pure function of persisted state)', () => {
    const p = regPath(); const runs = [...dbg(CHAMP, [0.25, 0.5, 0.75]), ...dbg(SRC, [0.5, 0.6, 0.9])];
    write(p, 'e', runs); const b1 = readFileSync(p, 'utf8');
    write(p, 'e', runs); assert.equal(readFileSync(p, 'utf8'), b1);
    assert.equal(readRegistry(p).rows.length, 2);
  }],
];

for (const [name, body] of table) test(name, body);
