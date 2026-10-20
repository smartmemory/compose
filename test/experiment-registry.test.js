/**
 * experiment-registry.test.js — COMP-STAGE-GRADING-4 (G4): registry writer, admission, signed uplift, promotion.
 *
 * Spec: docs/features/COMP-MODEL-AB-DECISION/registry-contract.json (+ stage-run-contract.json for the records read).
 * No model call anywhere: every run record is built in memory and the registry lands in a temp dir.
 *
 * Run: node --test test/experiment-registry.test.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  writeRegistry, promoteRows, demoteRows, selectRows, saveRegistry, readRegistry, validateRegistrySemantics,
  isAdmitted, RegistryError,
} from '../lib/experiment-registry.js';
import { aggregate } from '../lib/experiment-report.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = JSON.parse(readFileSync(join(ROOT, 'docs/features/COMP-MODEL-AB-DECISION/registry-contract.json'), 'utf8'));

const CAT = 'c'.repeat(64);
const FIX = 'f'.repeat(64);
const OPUS = { provider: 'claude', modelID: 'claude-opus-5-5', effort: 'medium', workflow: 'default' };
const SONNET = { provider: 'claude', modelID: 'claude-sonnet-5-5', effort: 'medium', workflow: 'default' };
const CODEX = { provider: 'codex', modelID: 'gpt-6.1-sol', effort: 'high', workflow: 'default' };
const cellOf = (stage, i) => `${stage}|${i.provider}|${i.modelID}|${i.effort}|${i.workflow}`;

/** One executed stage run record (stage-run-contract $defs.stageRunExecuted), reduced to what the writer reads. */
function run(stage, ing, n, accuracy, over = {}) {
  const tag = `${stage}-${ing.modelID}-r${n}`;
  const stageM = { accuracy, oracle: 'o', oracleVersion: '1', canaryOk: true, mechanismEngaged: true, oracleError: null, detail: {}, ...(over.stage ?? {}) };
  const rec = {
    runId: tag, configLabel: ing.modelID, rep: n, runner: 'stage', archetype: { id: stage, version: '1' },
    metrics: {
      cost: { tokensIn: 1000 + n, tokensOut: 100 + n, calls: 3, wallMs: 5000 + n, usd: 0.5 },
      outcome: { completed: true, health: null, testsPass: null, testsTotal: null, filesChanged: 0, linesChanged: 0 },
      process: { reviewIters: 0, gateFailures: 0, retries: 0, escalations: 0 },
      stage: stageM,
    },
    manifest: { composeSha: 'x', fixtureGoal: 'g', seedRef: null, startedAt: '2026-10-20T11:00:00.000Z', endedAt: `2026-10-20T11:${String(n).padStart(2, '0')}:00.000Z` },
    budget: { stoppedBy: null, spentUsd: 0.5, spentTokens: 1000 },
    runKeyInputs: { configLabel: ing.modelID, candidate: 'x', ingredients: ing, pipelineDigest: null, profilesDigest: null, archetype: { id: stage, version: '1' }, fixtureDigest: over.fixtureDigest ?? FIX, oracleVersion: '1', catalogDigest: CAT, rep: n },
  };
  if (over.outcome) Object.assign(rec.metrics.outcome, over.outcome);
  if (over._error) rec._error = over._error;
  return rec;
}
const cell = (stage, ing, accs, over) => accs.map((a, i) => run(stage, ing, i + 1, a, over));
const good = n => Array.from({ length: n }, () => 1);

let dir; let seq = 0;
const regPath = () => join(dir, `registry-${++seq}.json`);
before(() => { dir = mkdtempSync(join(tmpdir(), 'compose-g4-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv); ajv.addSchema(CONTRACT);
const validSchema = reg => { const ok = ajv.validate({ $ref: `${CONTRACT.$id}#/$defs/registry` }, reg); return ok ? [] : ajv.errors; };
const exp = id => ({ experimentId: id });
const rowOf = (reg, stage, ing) => reg.rows.find(r => r.cellKey === cellOf(stage, ing));

describe('admission and measured/triaged (negative-control table)', () => {
  // Each bad run joins 3 clean runs of the same cell: attempted 4, admitted 3, so the cell is measured
  // (3 >= 3 and 9 >= 8) and the ONLY thing under test is that the bad run is attempted but not admitted.
  const bad = [
    ['canary false', { stage: { canaryOk: false } }],
    ['mechanism false', { stage: { mechanismEngaged: false } }],
    ['accuracy null', { stage: { accuracy: null } }],
    ['oracleError set', { stage: { oracleError: 'boom', accuracy: null } }],
    ['_error set', { _error: 'crashed' }],
    ['not completed', { outcome: { completed: false } }],
  ];
  for (const [name, over] of bad) {
    test(`${name}: not admitted, still attempted`, () => {
      const runs = [...cell('debug', OPUS, [1, 1, 1]), run('debug', OPUS, 4, 1, over)];
      assert.equal(isAdmitted(runs[3]), false);
      const { registry } = writeRegistry(exp('e'), runs, { registryPath: regPath() });
      const r = rowOf(registry, 'debug', OPUS);
      assert.equal(r.nAttempted, 4); assert.equal(r.nAdmitted, 3);
      assert.equal(r.state, 'measured');
      assert.ok(!r.sourceRunIds.includes(runs[3].runId) && r.attemptedRunIds.includes(runs[3].runId));
    });
  }

  test('2 of 3 admitted -> triaged LOW_N', () => {
    const runs = [...cell('debug', OPUS, [1, 1]), run('debug', OPUS, 3, 1, { stage: { canaryOk: false } })];
    const r = rowOf(writeRegistry(exp('e'), runs, { registryPath: regPath() }).registry, 'debug', OPUS);
    assert.deepEqual([r.state, r.triageReason, r.nAdmitted, r.nAttempted], ['triaged', 'LOW_N', 2, 3]);
  });

  test('3 of 5 admitted -> triaged LOW_ADMISSION', () => {
    const runs = [...cell('debug', OPUS, [1, 1, 1]), run('debug', OPUS, 4, 1, { _error: 'x' }), run('debug', OPUS, 5, 1, { _error: 'y' })];
    const r = rowOf(writeRegistry(exp('e'), runs, { registryPath: regPath() }).registry, 'debug', OPUS);
    assert.deepEqual([r.state, r.triageReason, r.nAdmitted, r.nAttempted], ['triaged', 'LOW_ADMISSION', 3, 5]);
  });

  test('boundary: 4 of 6 admitted is measured (4*3 >= 6*2), skipped runs are not attempts', () => {
    const runs = [...cell('debug', OPUS, good(4)), run('debug', OPUS, 5, 1, { _error: 'x' }), run('debug', OPUS, 6, 1, { _error: 'y' }),
      { runId: 'debug-skipped', configLabel: 'opus', rep: 7, runner: 'stage', skipped: 'BUDGET_STOP', budget: { stoppedBy: 'maxUsdTotal', spentUsd: 1, spentTokens: 1 } }];
    const r = rowOf(writeRegistry(exp('e'), runs, { registryPath: regPath() }).registry, 'debug', OPUS);
    assert.deepEqual([r.state, r.nAdmitted, r.nAttempted], ['measured', 4, 6]);
  });

  test('a measured row with no admitted run is impossible: all-bad cell is triaged with null statistics', () => {
    const runs = cell('debug', OPUS, [1, 1, 1], { stage: { canaryOk: false } });
    const r = rowOf(writeRegistry(exp('e'), runs, { registryPath: regPath() }).registry, 'debug', OPUS);
    assert.deepEqual([r.state, r.triageReason, r.nAdmitted], ['triaged', 'LOW_N', 0]);
    assert.deepEqual(r.sourceRunIds, []); assert.equal(r.vector.accuracy, null); assert.equal(r.vector.usd, null);
  });
});

describe('signed uplift', () => {
  // Independent bootstrap, written from the documented procedure only (not from the writer's code).
  function handBootstrap(src, champ, seed, B) {
    let s = seed >>> 0;
    const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
    const med = a => { const x = [...a].sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
    const out = [];
    for (let b = 0; b < B; b++) {
      const a = []; for (let i = 0; i < src.length; i++) a.push(src[Math.floor(rand() * src.length)]);
      const c = []; for (let i = 0; i < champ.length; i++) c.push(champ[Math.floor(rand() * champ.length)]);
      out.push(med(a) - med(c));
    }
    out.sort((p, q) => p - q);
    return { delta: med(src) - med(champ), ci95: [out[Math.floor(B * 0.025)], out[Math.ceil(B * 0.975) - 1]] };
  }
  const CHAMP = cellOf('debug', OPUS);
  const sonnetAcc = [0.12, 0.37, 0.61, 0.83, 0.95, 0.2, 0.7]; const opusAcc = [0.3, 0.9, 0.5, 0.65, 0.4, 0.85]; // continuous values so the interval ends are not saturated
  const runs = () => [...cell('debug', OPUS, opusAcc), ...cell('debug', SONNET, sonnetAcc)];

  test('delta and the 95% interval equal an independent hand computation (seed 7, 1000 resamples)', () => {
    const { registry } = writeRegistry(exp('e'), runs(), { registryPath: regPath(), champion: CHAMP });
    const u = rowOf(registry, 'debug', SONNET).uplift;
    const h = handBootstrap([...sonnetAcc], [...opusAcc], 7, 1000);
    assert.equal(u.championCellKey, CHAMP);
    assert.equal(u.delta, h.delta); assert.deepEqual(u.ci95, h.ci95);
    assert.deepEqual([u.method, u.resamples, u.seed], ['bootstrap', 1000, 7]);
    assert.equal(rowOf(registry, 'debug', SONNET).upliftNullReason, null);
  });

  test('25 distinct accuracies per arm: the interval ends are the exact order statistics (pins both percentile indexes)', () => {
    const a = Array.from({ length: 25 }, (_, i) => ((i * 37) % 101) / 100); const c = Array.from({ length: 25 }, (_, i) => ((i * 53 + 11) % 103) / 103);
    const r = [...cell('debug', OPUS, c), ...cell('debug', SONNET, a)];
    const u = rowOf(writeRegistry(exp('e'), r, { registryPath: regPath(), champion: CHAMP }).registry, 'debug', SONNET).uplift;
    // runs are ordered by runId inside the writer; the cell() helper numbers them in input order and ids sort as strings (r1, r10, r11, ...)
    const order = arr => arr.map((v, i) => [`r${i + 1}`, v]).sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(x => x[1]);
    const h = handBootstrap(order(a), order(c), 7, 1000);
    assert.equal(u.delta, h.delta); assert.deepEqual(u.ci95, h.ci95);
    // 40 resamples: the end indexes are 1 and 38, and the order statistics there are distinct from their neighbours
    const u40 = rowOf(writeRegistry(exp('e'), r, { registryPath: regPath(), champion: CHAMP, resamples: 40 }).registry, 'debug', SONNET).uplift;
    const h40 = handBootstrap(order(a), order(c), 7, 40);
    assert.deepEqual(u40.ci95, h40.ci95); assert.equal(u40.resamples, 40);
  });

  test('separated arms: source 1.0 vs champion 0.5 -> delta 0.5, interval [0.5, 0.5]', () => {
    const r = [...cell('debug', OPUS, [0.5, 0.5, 0.5]), ...cell('debug', SONNET, [1, 1, 1])];
    const u = rowOf(writeRegistry(exp('e'), r, { registryPath: regPath(), champion: CHAMP }).registry, 'debug', SONNET).uplift;
    assert.deepEqual([u.delta, u.ci95], [0.5, [0.5, 0.5]]);
  });

  test('a different seed gives a different interval (richer sample)', () => {
    const r = [...cell('debug', OPUS, [0.3, 0.9, 0.5, 0.65, 0.4, 0.85]), ...cell('debug', SONNET, [0.1, 0.35, 0.6, 0.8, 0.95, 0.2, 0.7])];
    const a = writeRegistry(exp('e'), r, { registryPath: regPath(), champion: CHAMP, seed: 1 }).registry;
    const b = writeRegistry(exp('e'), r, { registryPath: regPath(), champion: CHAMP, seed: 2 }).registry;
    const [ua, ub] = [rowOf(a, 'debug', SONNET).uplift, rowOf(b, 'debug', SONNET).uplift];
    assert.notDeepEqual(ua.ci95, ub.ci95); assert.equal(ua.delta, ub.delta);
  });

  test('the champion row itself carries uplift null / NO_COMPATIBLE_CHAMPION', () => {
    const r = rowOf(writeRegistry(exp('e'), runs(), { registryPath: regPath(), champion: CHAMP }).registry, 'debug', OPUS);
    assert.deepEqual([r.uplift, r.upliftNullReason], [null, 'NO_COMPATIBLE_CHAMPION']);
  });

  test('champion absent from the compatKey -> uplift null NO_COMPATIBLE_CHAMPION', () => {
    const r = rowOf(writeRegistry(exp('e'), cell('debug', SONNET, sonnetAcc), { registryPath: regPath(), champion: CHAMP }).registry, 'debug', SONNET);
    assert.deepEqual([r.state, r.uplift, r.upliftNullReason], ['measured', null, 'NO_COMPATIBLE_CHAMPION']);
  });

  test('incompatible champion (another fixtureDigest -> another compatKey) -> NO_COMPATIBLE_CHAMPION', () => {
    const r = [...cell('debug', OPUS, opusAcc, { fixtureDigest: 'e'.repeat(64) }), ...cell('debug', SONNET, sonnetAcc)];
    const reg = writeRegistry(exp('e'), r, { registryPath: regPath(), champion: CHAMP }).registry;
    assert.notEqual(rowOf(reg, 'debug', OPUS).compatKey, rowOf(reg, 'debug', SONNET).compatKey);
    const row = rowOf(reg, 'debug', SONNET);
    assert.deepEqual([row.uplift, row.upliftNullReason], [null, 'NO_COMPATIBLE_CHAMPION']);
  });

  test('champion triaged (2 of 3 admitted) -> source uplift null NO_COMPATIBLE_CHAMPION', () => {
    const r = [...cell('debug', OPUS, [1, 1]), run('debug', OPUS, 3, 1, { _error: 'x' }), ...cell('debug', SONNET, sonnetAcc)];
    const reg = writeRegistry(exp('e'), r, { registryPath: regPath(), champion: CHAMP }).registry;
    assert.equal(rowOf(reg, 'debug', OPUS).state, 'triaged');
    assert.equal(rowOf(reg, 'debug', SONNET).upliftNullReason, 'NO_COMPATIBLE_CHAMPION');
  });

  test('source triaged -> uplift null SOURCE_NOT_MEASURED (takes precedence over a missing champion)', () => {
    const r = [...cell('debug', OPUS, opusAcc), ...cell('debug', SONNET, [1, 1]), run('debug', SONNET, 3, 1, { _error: 'x' })];
    const row = rowOf(writeRegistry(exp('e'), r, { registryPath: regPath(), champion: CHAMP }).registry, 'debug', SONNET);
    assert.deepEqual([row.state, row.uplift, row.upliftNullReason], ['triaged', null, 'SOURCE_NOT_MEASURED']);
    const none = rowOf(writeRegistry(exp('e'), [...cell('debug', SONNET, [1, 1]), run('debug', SONNET, 3, 1, { _error: 'x' })], { registryPath: regPath(), champion: CHAMP }).registry, 'debug', SONNET);
    assert.equal(none.upliftNullReason, 'SOURCE_NOT_MEASURED');
  });

  test('champion may be given per stage', () => {
    const reg = writeRegistry(exp('e'), runs(), { registryPath: regPath(), champion: { debug: CHAMP, review: 'unused' } }).registry;
    assert.equal(rowOf(reg, 'debug', SONNET).uplift.championCellKey, CHAMP);
  });
});

describe('idempotence, determinism, atomic write', () => {
  const runs = () => [...cell('debug', OPUS, [1, 0.75, 1]), ...cell('debug', SONNET, [0.5, 1, 0.75]), ...cell('review', CODEX, good(3)),
    ...cell('debug', CODEX, [1, 1]), run('debug', CODEX, 3, 1, { _error: 'x' })];
  const opts = p => ({ registryPath: p, champion: cellOf('debug', OPUS) });

  test('same run records twice -> byte-identical registry.json, no duplicate rows', () => {
    const p = regPath();
    const a = writeRegistry(exp('e'), runs(), opts(p)); const bytes1 = readFileSync(p);
    const b = writeRegistry(exp('e'), runs(), opts(p)); const bytes2 = readFileSync(p);
    assert.ok(a.written && !b.written);
    assert.ok(bytes1.equals(bytes2));
    assert.equal(readRegistry(p).rows.length, new Set(readRegistry(p).rows.map(r => r.rowId)).size);
  });

  test('two independent writers (and a shuffled input order) produce the same bytes (cmp)', () => {
    const p1 = regPath(); const p2 = regPath();
    writeRegistry(exp('e'), runs(), opts(p1));
    writeRegistry(exp('e'), runs().reverse(), opts(p2));
    assert.ok(readFileSync(p1).equals(readFileSync(p2)));
  });

  test('more runs of the same experiment replace the row in place; another experiment appends', () => {
    const p = regPath();
    writeRegistry(exp('e'), cell('debug', OPUS, [1, 1, 1]), opts(p));
    const first = readRegistry(p).rows[0].rowId;
    writeRegistry(exp('e'), cell('debug', OPUS, [1, 1, 1, 1]), opts(p));
    let rows = readRegistry(p).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].rowId, first); assert.equal(rows[0].nAdmitted, 4);
    writeRegistry(exp('other'), cell('debug', OPUS, [1, 1, 1]), opts(p));
    rows = readRegistry(p).rows;
    assert.equal(rows.length, 2);
  });

  test('output validates against the contract schema and the semantic layer', () => {
    const p = regPath(); const { registry } = writeRegistry(exp('e'), runs(), opts(p));
    assert.deepEqual(validSchema(registry), []);
    assert.deepEqual(validateRegistrySemantics(registry, {}), []);
    assert.deepEqual(validSchema(readRegistry(p)), []);
  });

  test('latest = newest measured row per stage/compatKey/cell; later experiment wins by instant, older stays a row', () => {
    const p = regPath();
    writeRegistry(exp('old'), cell('debug', OPUS, [1, 1, 1]), opts(p));
    const newer = cell('debug', OPUS, [1, 1, 1]).map(r => { r.manifest.endedAt = '2026-10-21T00:00:00.000Z'; return r; });
    const { registry } = writeRegistry(exp('new'), newer, opts(p));
    assert.equal(registry.rows.length, 2);
    const ck = registry.rows[0].compatKey;
    const winner = registry.rows.find(r => r.experimentId === 'new');
    assert.equal(registry.latest.debug[ck][cellOf('debug', OPUS)], winner.rowId);
  });

  test('atomic: a write that fails semantic validation leaves the file untouched and no temp file behind', () => {
    const p = regPath(); writeRegistry(exp('e'), runs(), opts(p));
    const before = readFileSync(p); const bad = readRegistry(p); bad.rows[0].nAdmitted = bad.rows[0].nAttempted + 1;
    assert.throws(() => saveRegistry(p, bad), e => e instanceof RegistryError && e.code === 'SEMANTIC_VIOLATION');
    assert.ok(readFileSync(p).equals(before));
    assert.deepEqual(readdirSync(dir).filter(f => f.includes('.tmp-')), []);
  });

  test('a successful write leaves no temp file; no stage runs writes no file', () => {
    const p = regPath(); writeRegistry(exp('e'), runs(), opts(p));
    assert.deepEqual(readdirSync(dir).filter(f => f.includes('.tmp-')), []);
    const q = regPath(); const r = writeRegistry(exp('e'), [{ runId: 'legacy', configLabel: 'x', metrics: { outcome: { completed: true } } }], opts(q));
    assert.equal(existsSync(q), false); assert.deepEqual(r.ignoredRunIds, ['legacy']);
  });

  test('experiment-report aggregate: results unchanged by the option, registry written only when asked', () => {
    const all = runs(); const p = regPath();
    const plain = aggregate(all, 'e'); const wired = aggregate(all, 'e', { registry: opts(p) });
    assert.deepEqual({ ...plain, generatedAt: 0 }, { ...wired, generatedAt: 0 });
    assert.ok(existsSync(p)); assert.equal(readRegistry(p).rows.length, 4);
  });
});

describe('judged stages: promotion, demotion, selection', () => {
  const EVID = { calibrationReport: 'docs/calib.md', panelModels: ['claude-opus-5-5'], judgeCatalogDigest: 'a'.repeat(64), gatePassed: true, agreement: 0.9 };
  const setup = () => {
    const p = regPath();
    const { registry } = writeRegistry(exp('e'), [...cell('design', OPUS, [1, 1, 1]), ...cell('design', SONNET, [0.5, 1, 0.75]), ...cell('debug', OPUS, good(3))], { registryPath: p, champion: { design: cellOf('design', OPUS) } });
    return registry;
  };
  const ids = (reg, st) => reg.rows.filter(r => r.stage === st).map(r => r.rowId);

  test('an unpromoted judged row is triaged JUDGED_UNPROMOTED and not selectable', () => {
    const reg = setup();
    assert.ok(reg.rows.filter(r => r.stage === 'design').every(r => r.state === 'triaged' && r.triageReason === 'JUDGED_UNPROMOTED' && r.promotion === null));
    assert.deepEqual(reg.latest.design ?? {}, {});
    assert.deepEqual(selectRows(reg, { stage: 'design', currentCatalogDigest: CAT }), { rows: [], refused: [] });
    assert.equal(selectRows(reg, { stage: 'debug', currentCatalogDigest: CAT }).rows.length, 1);
  });

  test('promotion with gatePassed false is refused, with nothing changed', () => {
    const reg = setup(); const snap = JSON.stringify(reg);
    assert.throws(() => promoteRows(reg, { rowIds: ids(reg, 'design'), evidence: { ...EVID, gatePassed: false } }), e => e.code === 'GATE_NOT_PASSED');
    assert.throws(() => promoteRows(reg, { rowIds: ids(reg, 'design'), evidence: { ...EVID, gatePassed: undefined } }), e => e.code === 'GATE_NOT_PASSED');
    assert.equal(JSON.stringify(reg), snap);
  });

  test('other promotion refusals: bad evidence, unknown row, non-judged stage', () => {
    const reg = setup();
    assert.throws(() => promoteRows(reg, { rowIds: ids(reg, 'design'), evidence: { ...EVID, agreement: 2 } }), e => e.code === 'BAD_EVIDENCE');
    assert.throws(() => promoteRows(reg, { rowIds: ['nope'], evidence: EVID }), e => e.code === 'UNKNOWN_ROW');
    assert.throws(() => promoteRows(reg, { rowIds: ids(reg, 'debug'), evidence: EVID }), e => e.code === 'NOT_JUDGED_STAGE');
  });

  test('promotion makes the judged rows measured, selectable, and in latest; the registry stays valid', () => {
    const reg = promoteRows(setup(), { rowIds: ids(setup(), 'design'), evidence: EVID });
    const design = reg.rows.filter(r => r.stage === 'design');
    assert.ok(design.every(r => r.state === 'measured' && r.triageReason === null && r.promotion.gatePassed === true));
    assert.equal(selectRows(reg, { stage: 'design', currentCatalogDigest: CAT }).rows.length, 2);
    assert.deepEqual(validSchema(reg), []); assert.deepEqual(validateRegistrySemantics(reg, {}), []);
  });

  test('promotion of a row with too few admitted runs keeps it triaged LOW_N', () => {
    const p = regPath();
    const { registry } = writeRegistry(exp('e'), [...cell('plan', OPUS, [1, 1]), run('plan', OPUS, 3, 1, { _error: 'x' })], { registryPath: p });
    const reg = promoteRows(registry, { rowIds: ids(registry, 'plan'), evidence: EVID });
    assert.deepEqual([reg.rows[0].state, reg.rows[0].triageReason], ['triaged', 'LOW_N']);
  });

  test('a re-run of the writer keeps a recorded promotion (same bytes as before the re-run)', () => {
    const p = regPath(); const r0 = [...cell('design', OPUS, [1, 1, 1])];
    const first = writeRegistry(exp('e'), r0, { registryPath: p }).registry;
    saveRegistry(p, promoteRows(first, { rowIds: ids(first, 'design'), evidence: EVID }));
    const before = readFileSync(p);
    writeRegistry(exp('e'), r0, { registryPath: p });
    assert.ok(readFileSync(p).equals(before)); assert.equal(readRegistry(p).rows[0].state, 'measured');
  });

  test('demotion: JUDGE_DRIFT, promotion kept, out of latest, uplift nulled on the row and on its dependants', () => {
    const base = setup(); const champId = rowOf(base, 'design', OPUS).rowId;
    const promoted = promoteRows(base, { rowIds: ids(base, 'design'), evidence: EVID });
    // writer-time uplift for the Sonnet row (champion Opus) lives on a registry produced with both arms promoted:
    const p = regPath(); saveRegistry(p, promoted);
    const again = writeRegistry(exp('e'), [...cell('design', OPUS, [1, 1, 1]), ...cell('design', SONNET, [0.5, 1, 0.75])], { registryPath: p, champion: { design: cellOf('design', OPUS) } }).registry;
    assert.ok(rowOf(again, 'design', SONNET).uplift, 'sonnet design row has an uplift once both arms are measured');
    const demoted = demoteRows(again, { rowIds: [champId], reason: 'JUDGE_DRIFT' });
    const d = demoted.rows.find(r => r.rowId === champId);
    assert.deepEqual([d.state, d.triageReason, d.uplift, d.upliftNullReason], ['triaged', 'JUDGE_DRIFT', null, 'SOURCE_NOT_MEASURED']);
    assert.ok(d.promotion && d.promotion.gatePassed === true);
    const dep = rowOf(demoted, 'design', SONNET);
    assert.deepEqual([dep.uplift, dep.upliftNullReason], [null, 'NO_COMPATIBLE_CHAMPION']);
    assert.ok(!Object.values(demoted.latest.design[d.compatKey]).includes(champId));
    assert.equal(selectRows(demoted, { stage: 'design', currentCatalogDigest: CAT }).rows.length, 1);
    assert.deepEqual(validSchema(demoted), []);
    // a replay of the writer keeps the demotion
    const q = regPath(); saveRegistry(q, demoted); const b = readFileSync(q);
    writeRegistry(exp('e'), [...cell('design', OPUS, [1, 1, 1]), ...cell('design', SONNET, [0.5, 1, 0.75])], { registryPath: q, champion: { design: cellOf('design', OPUS) } });
    assert.equal(readRegistry(q).rows.find(r => r.rowId === champId).triageReason, 'JUDGE_DRIFT');
    void b;
  });

  test('demotion refusals: wrong reason, unpromoted row, prior row', () => {
    const reg = setup();
    assert.throws(() => demoteRows(reg, { rowIds: ids(reg, 'design'), reason: 'LOW_N' }), e => e.code === 'BAD_ARGS');
    assert.throws(() => demoteRows(reg, { rowIds: ids(reg, 'design'), reason: 'JUDGE_DRIFT' }), e => e.code === 'NOT_PROMOTED');
    const withPrior = { ...reg, rows: [...reg.rows, CONTRACT.examples.find(e => e.name.startsWith('prior row')).value] };
    assert.throws(() => demoteRows(withPrior, { rowIds: [withPrior.rows.at(-1).rowId], reason: 'JUDGE_DRIFT' }), e => e.code === 'PRIOR_ROW');
  });

  test('selection: a row of another catalog digest is refused STALE_CATALOG unless that digest is named explicitly', () => {
    const reg = setup();
    assert.deepEqual(selectRows(reg, { stage: 'debug', currentCatalogDigest: 'd'.repeat(64) }), { rows: [], refused: [{ rowId: ids(reg, 'debug')[0], code: 'STALE_CATALOG' }] });
    assert.equal(selectRows(reg, { stage: 'debug', currentCatalogDigest: 'd'.repeat(64), explicitCatalogDigest: CAT }).rows.length, 1);
  });
});

describe('prior rows and the contract', () => {
  const priorRow = () => structuredClone(CONTRACT.examples.find(e => e.name.startsWith('prior row')).value);

  test('a prior row is preserved by the writer and never in latest or selectable', () => {
    const p = regPath(); const prior = priorRow();
    saveRegistry(p, { version: 1, rows: [prior], latest: {} });
    const { registry } = writeRegistry(exp('e'), cell(prior.stage, OPUS, good(3)), { registryPath: p });
    assert.deepEqual(registry.rows[0], prior);
    assert.ok(!JSON.stringify(registry.latest).includes(prior.rowId));
    assert.ok(!selectRows(registry, { stage: prior.stage, currentCatalogDigest: CAT }).rows.some(r => r.rowId === prior.rowId));
    const forged = { ...registry, latest: { ...registry.latest, [prior.stage]: { ...registry.latest[prior.stage], ['0'.repeat(64)]: { [prior.cellKey]: prior.rowId } } } };
    assert.ok(validateRegistrySemantics(forged, {}).some(v => v.code === 'PRIOR_EXCLUDED' && v.rowId === prior.rowId));
  });

  // JSON-patch subset (add / remove / replace / copy) to replay the contract's semanticCases.
  function patch(doc, ops) {
    const d = structuredClone(doc); const ptr = s => s.split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    const at = path => { const k = ptr(path); const last = k.pop(); let o = d; for (const x of k) o = o[x]; return [o, last]; };
    for (const op of ops) {
      const [o, last] = at(op.path);
      if (op.op === 'replace') o[Array.isArray(o) ? +last : last] = op.value;
      else if (op.op === 'add') { if (Array.isArray(o)) o.splice(last === '-' ? o.length : +last, 0, op.value); else o[last] = op.value; }
      else if (op.op === 'remove') { if (Array.isArray(o)) o.splice(+last, 1); else delete o[last]; }
      else if (op.op === 'copy') { const [so, sl] = at(op.from); const v = structuredClone(so[sl]); if (Array.isArray(o)) o.splice(last === '-' ? o.length : +last, 0, v); else o[last] = v; }
    }
    return d;
  }
  const bases = new Map(CONTRACT.examples.filter(e => e.validatesAgainst === '#/$defs/registry').map(e => [e.name, e]));

  test('baseline contract registries are clean under the writer-side validator', () => {
    for (const e of bases.values()) assert.deepEqual(validateRegistrySemantics(e.value, e.semanticContext ?? {}), [], e.name);
  });

  test('every semanticCases row: the validator returns the contract\'s expected codes', () => {
    const hit = new Set();
    for (const k of CONTRACT.semanticCases) {
      const b = bases.get(k.base); const reg = patch(b.value, k.patch);
      const got = [...new Set(validateRegistrySemantics(reg, k.semanticContext ?? b.semanticContext ?? {}).map(v => v.code))];
      if (k.expect.length === 0) assert.deepEqual(got, [], k.name);
      else { for (const c of k.expect) assert.ok(got.includes(c), `${k.name}: wanted ${c}, got ${got}`); k.expect.forEach(c => hit.add(c)); }
    }
    assert.deepEqual([...hit].sort(), CONTRACT.semantic.map(s => s.code).sort());
  });

  test('row-level examples of the contract (non-prior) pass S1-S3 and S8 under the validator', () => {
    for (const e of CONTRACT.examples.filter(x => x.validatesAgainst === '#/$defs/row' && x.value.state !== 'prior')) {
      const v = validateRegistrySemantics({ rows: [e.value], latest: {} }, {}).filter(x => ['COUNT_ORDER', 'MEASURED_RULE', 'RUN_ID_COUNTS', 'UPLIFT_ARM_STATE'].includes(x.code));
      assert.deepEqual(v, [], e.name);
    }
  });
});
