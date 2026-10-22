/**
 * experiment-budget.test.js — run budget and checkpoint/retry (COMP-STAGE-GRADING-12, B1).
 *
 * Zero model calls: every test injects a fake Stratum client (agentRun writes the ledger row the real client
 * writes) and a fake archetype, or a fake build runner for the legacy path. Dispatch counts come from the fake.
 * The checkpoint rows are also run against the worked cases in stage-run-contract.json.
 *
 * Run: node --test test/experiment-budget.test.js
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { runExperiment, validateSpec } from '../lib/experiment.js';
import { decideCheckpoint, createMeter, isTerminal } from '../lib/experiment-budget.js';
import { appendEvent, resolveDispatchLedgerCwd } from '../lib/dispatch-ledger.js';
import { readRegistry, cellKeyOf } from '../lib/experiment-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(
  resolve(__dirname, '..', 'docs', 'features', 'COMP-MODEL-AB-DECISION', 'stage-run-contract.json'), 'utf-8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);
const validateRecord = ajv.getSchema(`${CONTRACT.$id}#/$defs/stageRunRecord`);

const ROOT = mkdtempSync(join(tmpdir(), 'exp-budget-test-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const RECEIPT = { tokens_in: 1200, tokens_out: 300, tokens_total: 1500, usd: 0.05 };
const NULL_RECEIPT = { tokens_in: null, tokens_out: null, tokens_total: null, usd: null };
const BUDGET = { maxRuns: 10, perRunTimeoutMs: 60_000, maxUsdTotal: null, maxTokensTotal: 9_000_000, perRunTokenAssume: 400_000 };

function fakeArchetype(over = {}) {
  const hiddenPath = mkdtempSync(join(ROOT, 'hidden-'));
  writeFileSync(join(hiddenPath, 'expected.txt'), 'fixed\n');
  return {
    id: 'debug', stage: 'debug', runner: 'stage', judged: false, version: '1',
    oracleName: 'repro-passes', scenario: { task: 'make bug.js print fixed' }, hiddenPath,
    fixture: { context: 'tiny', task: 'make bug.js print fixed', gold: { fix: 'fixed' }, task_type: 'debug' },
    buildInput(workspace, scenario) { writeFileSync(join(workspace, 'bug.js'), `// ${scenario.task}\nconsole.log('broken');\n`); },
    prompt: scenario => `Fix it: ${scenario.task}`,
    oracle(workspace, hidden) {
      const fixed = readFileSync(join(workspace, 'bug.js'), 'utf-8').includes(readFileSync(join(hidden, 'expected.txt'), 'utf-8').trim());
      return { accuracy: fixed ? 1 : 0, detail: { fixed }, oracleError: null };
    },
    canary: workspace => !readFileSync(join(workspace, 'bug.js'), 'utf-8').includes('broken'),
    mechanismEngaged: () => true,
    ...over,
  };
}

/**
 * Fake StratumMcpClient. `failCalls`: 1-based call numbers that throw. `receipts(n)`: ledger row values for call n.
 * `hang`: agentRun waits for the abort signal (a model that never answers) and records what it saw.
 */
function fakeStratum({ failCalls = [], receipts = () => RECEIPT, hang = false } = {}) {
  const fake = {
    calls: [], signals: [],
    async connect() {}, async close() {},
    async agentRun(provider, prompt, opts) {
      const n = fake.calls.push({ provider, opts });
      fake.signals.push(opts.signal);
      const row = receipts(n);
      const ledger = outcome => appendEvent(resolveDispatchLedgerCwd(opts.telemetry?.project_cwd), {
        kind: 'dispatch', dispatch_id: randomUUID(), site: opts.telemetry?.site ?? 'unattributed', agent: provider,
        outcome, model: 'm-from-ledger', effort_intended: opts.effort ?? null, effort_executed: null,
        ...row, usd_source: row.usd === null ? null : 'reported', duration_ms: 10, transport_derived: null,
      });
      if (hang) {
        await new Promise((_, reject) => {
          const onAbort = () => { ledger('error'); reject(new Error('aborted by perRunTimeoutMs')); };
          if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (failCalls.includes(n)) { ledger('error'); throw new Error(`fake agentRun failure on call ${n}`); }
      writeFileSync(join(opts.cwd, 'bug.js'), "console.log('fixed');\n");
      ledger('ok');
      return { text: `output of call ${n}` };
    },
  };
  return fake;
}

function writeSpec(spec, dir = mkdtempSync(join(ROOT, 'spec-'))) {
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

/** 1 config x `reps` reps unless configs are given. */
function stageSpec(over = {}) {
  return {
    id: 'bud', fixture: { archetype: 'debug' },
    configs: [{ label: 'sonnet-fast', candidate: 'claude::fast' }],
    reps: 3, parallelism: 1, budget: BUDGET, ...over,
  };
}

const quiet = fn => async (...a) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(...a); } finally { process.stderr.write = write; }
};

/** Run the spec once with a fresh fake; returns the result and the fake. */
async function go(specPath, { fake = fakeStratum(), archetype = fakeArchetype(), ...opts } = {}) {
  const result = await runExperiment(specPath, { stratum: fake, _loadArchetype: async () => archetype, ...opts });
  return { ...result, fake };
}

const prevFiles = expRoot => readdirSync(join(expRoot, 'runs')).flatMap(d =>
  readdirSync(join(expRoot, 'runs', d)).filter(f => f.includes('.json.prev-')));

describe('checkpoint: dispatch counts across restarts (probe)', () => {
  test('3 runs, run 2 fails once: restart 1, second restart 0, --rerun all 3, changed oracleVersion 3', quiet(async () => {
    const specPath = writeSpec(stageSpec());
    const first = await go(specPath, { fake: fakeStratum({ failCalls: [2] }) });
    assert.equal(first.fake.calls.length, 3);
    assert.deepEqual(first.runs.map(r => r._error !== undefined), [false, true, false]);

    const restart = await go(specPath);
    assert.equal(restart.fake.calls.length, 1, 'only the failed run is dispatched');
    assert.ok(restart.runs.every(r => r._error === undefined));
    for (const r of restart.runs) assert.ok(validateRecord(r), JSON.stringify(validateRecord.errors));

    const again = await go(specPath);
    assert.equal(again.fake.calls.length, 0, 'all terminal: nothing dispatched');
    assert.equal(again.runs.length, 3);

    const all = await go(specPath, { rerun: 'all' });
    assert.equal(all.fake.calls.length, 3);

    const bumped = await go(specPath, { archetype: fakeArchetype({ version: '2' }) });
    assert.equal(bumped.fake.calls.length, 3, 'a changed oracleVersion changes every runKey');
    assert.equal(prevFiles(bumped.expRoot).length, 3, 'each old record moved to <runId>.json.prev-<epoch>');
    assert.ok(bumped.runs.every(r => r.runKeyInputs.oracleVersion === '2'));
  }));

  test('--rerun <runId> reruns exactly that run; unknown runId is refused before any dispatch', quiet(async () => {
    const specPath = writeSpec(stageSpec());
    const first = await go(specPath);
    const one = await go(specPath, { rerun: first.runs[1].runId });
    assert.equal(one.fake.calls.length, 1);
    const fake = fakeStratum();
    await assert.rejects(go(specPath, { fake, rerun: 'nope' }), { code: 'RERUN_UNKNOWN_RUN' });
    assert.equal(fake.calls.length, 0);
  }));
});

describe('budget table (one row per rule)', () => {
  const rows = [
    {
      name: 'maxRuns reached: 2 dispatched, the rest skipped BUDGET_STOP',
      spec: { reps: 4, budget: { ...BUDGET, maxRuns: 2 } }, stratum: {},
      dispatched: 2, skipped: 2, stoppedBy: 'maxRuns',
    },
    {
      name: 'token meter: a null-usd receipt counts perRunTokenAssume (400k x 2 >= 800k)',
      spec: { reps: 4, budget: { ...BUDGET, maxTokensTotal: 800_000 } }, stratum: { receipts: () => NULL_RECEIPT },
      dispatched: 2, skipped: 2, stoppedBy: 'maxTokensTotal', spentTokensEach: 400_000,
    },
    {
      name: 'USD meter stops when every receipt has a usd (0.05 >= 0.05 after run 1)',
      spec: { reps: 4, budget: { ...BUDGET, maxUsdTotal: 0.05 } }, stratum: {},
      dispatched: 1, skipped: 3, stoppedBy: 'maxUsdTotal', restart: 1,
    },
    {
      name: 'USD meter ignored once any receipt lacks usd (cap 0.06, run 2 has null usd): all 4 run',
      spec: { reps: 4, budget: { ...BUDGET, maxUsdTotal: 0.06 } },
      stratum: { receipts: n => (n === 2 ? { ...RECEIPT, usd: null } : RECEIPT) },
      dispatched: 4, skipped: 0, stoppedBy: null,
    },
  ];
  for (const row of rows) {
    test(row.name, quiet(async () => {
      const specPath = writeSpec(stageSpec(row.spec));
      const { runs, fake } = await go(specPath, { fake: fakeStratum(row.stratum) });
      assert.equal(fake.calls.length, row.dispatched);
      const skipped = runs.filter(r => r.skipped === 'BUDGET_STOP');
      assert.equal(skipped.length, row.skipped);
      for (const r of runs) assert.ok(validateRecord(r), JSON.stringify(validateRecord.errors));
      for (const r of skipped) assert.equal(r.budget.stoppedBy, row.stoppedBy);
      if (row.spentTokensEach) {
        for (const r of runs.filter(x => !x.skipped)) assert.equal(r.budget.spentTokens, row.spentTokensEach);
      }
      if (row.skipped) {
        // unstarted runs are retried by the checkpoint rule: the restart dispatches exactly those
        const restart = await go(specPath, { fake: fakeStratum() });
        assert.equal(restart.fake.calls.length, row.restart ?? row.skipped, 'the restart gets a fresh meter and retries the skipped runs');
      }
    }));
  }

  test('per-run timeout aborts through the signal, record is terminal with stoppedBy "timeout", partial ledger row kept', quiet(async () => {
    const specPath = writeSpec(stageSpec({ reps: 1, budget: { ...BUDGET, perRunTimeoutMs: 40 } }));
    const hang = fakeStratum({ hang: true });
    const { runs, fake } = await go(specPath, { fake: hang });
    assert.ok(fake.signals[0] instanceof AbortSignal);
    assert.equal(fake.signals[0].aborted, true, 'the fake observed the abort');
    const [r] = runs;
    assert.equal(r.budget.stoppedBy, 'timeout');
    assert.equal(r._error, undefined, 'a timeout is terminal, not an error to retry');
    assert.equal(r.metrics.outcome.completed, false);
    assert.equal(r.metrics.cost.calls, 1, 'the aborted dispatch left its ledger row');
    assert.ok(validateRecord(r), JSON.stringify(validateRecord.errors));
    // terminal: a restart reuses it; --rerun failed reruns it
    assert.equal((await go(specPath)).fake.calls.length, 0);
    assert.equal((await go(specPath, { rerun: 'failed' })).fake.calls.length, 1);
  }));

  test('an archetype spec without budget is refused BUDGET_REQUIRED; a legacy spec without one is accepted', () => {
    const { budget, ...noBudget } = stageSpec();
    assert.ok(budget);
    assert.throws(() => validateSpec(noBudget, { archetype: fakeArchetype() }), { code: 'BUDGET_REQUIRED' });
    const legacy = { id: 'l', fixture: { goal: 'g' }, configs: [{ label: 'a', implementer: 'claude', reviewer: 'codex' }], reps: 1 };
    assert.equal(validateSpec(legacy).budget, undefined);
    assert.throws(() => validateSpec({ ...legacy, budget: { maxRuns: 0 } }), { code: 'BUDGET_REQUIRED' });
  });
});

describe('checkpoint decisions: contract worked cases', () => {
  const cases = CONTRACT.examples.filter(e => e.validatesAgainst === '#/$defs/checkpointCase').map(e => e.value);
  test('the contract carries checkpoint cases', () => assert.ok(cases.length >= 9));
  for (const c of cases) {
    test(`row ${c.row}: ${c.runId}`, () => {
      const got = decideCheckpoint({ runId: c.runId, ...c.input });
      assert.equal(got.row, c.row);
      assert.deepEqual({ dispatch: got.dispatch, archivePrev: got.archivePrev }, c.expect);
    });
  }

  test('isTerminal / meter edge rows', () => {
    assert.equal(isTerminal({ budget: { stoppedBy: 'timeout' } }), true);
    assert.equal(isTerminal({ budget: { stoppedBy: 'maxRuns' } }), false);
    assert.equal(isTerminal({ skipped: 'BUDGET_STOP', budget: {} }), false);
    const m = createMeter({ ...BUDGET, maxRuns: 1 });
    assert.equal(m.check(), null);
    m.start();
    assert.equal(m.check(), 'maxRuns');
    assert.equal(m.check(), 'maxRuns', 'a stop is sticky');
  });
});

describe('every dispatch path goes through the gate (legacy builds, registry writes)', () => {
  const legacySpec = (over = {}) => ({
    id: 'leg', fixture: { goal: 'make a thing' }, reps: 1,
    configs: [{ label: 'a', implementer: 'claude', reviewer: 'codex' }, { label: 'b', implementer: 'codex', reviewer: 'claude' }],
    ...over,
  });
  const fakeBuild = () => {
    const calls = [];
    const fn = async (config) => { calls.push(config.label); return { stdout: '', stderr: '', exitCode: 0, timedOut: false, wallMs: 1 }; };
    fn.calls = calls;
    return fn;
  };

  test('legacy spec WITHOUT budget behaves as today: every run dispatches on every start, records keep today\'s shape', quiet(async () => {
    const specPath = writeSpec(legacySpec());
    const b1 = fakeBuild(); const first = await runExperiment(specPath, { _runBuild: b1 });
    const b2 = fakeBuild(); await runExperiment(specPath, { _runBuild: b2 });
    assert.equal(b1.calls.length, 2);
    assert.equal(b2.calls.length, 2);
    for (const r of first.runs) for (const k of ['budget', 'runKey', 'runKeyInputs', 'skipped']) assert.equal(Object.hasOwn(r, k), false);
    await assert.rejects(runExperiment(specPath, { _runBuild: fakeBuild(), rerun: 'all' }), /budget/);
  }));

  test('legacy spec WITH budget: maxRuns skips the rest, restart dispatches only those, then reuses', quiet(async () => {
    const specPath = writeSpec(legacySpec({ budget: { ...BUDGET, maxRuns: 1 } }));
    const b1 = fakeBuild(); const first = await runExperiment(specPath, { _runBuild: b1 });
    assert.equal(b1.calls.length, 1);
    assert.deepEqual(first.runs.map(r => r.skipped ?? null), [null, 'BUDGET_STOP']);
    const b2 = fakeBuild(); await runExperiment(specPath, { _runBuild: b2 });
    assert.deepEqual(b2.calls, ['b']);
    const b3 = fakeBuild(); await runExperiment(specPath, { _runBuild: b3 });
    assert.equal(b3.calls.length, 0);
  }));

  test('registry write: champion is required; restart, rerun-all under a cap and budget skips never omit a recorded attempt', quiet(async () => {
    const dir = mkdtempSync(join(ROOT, 'reg-'));
    const registryPath = join(dir, 'registry.json');
    const specPath = writeSpec(stageSpec({ budget: { ...BUDGET, maxRuns: 2 } }), dir);
    await assert.rejects(go(specPath, { registry: { registryPath } }), { code: 'CHAMPION_REQUIRED' });

    const first = await go(specPath, { registry: { registryPath, champion: 'placeholder' } });
    assert.equal(first.runs.filter(r => r.skipped).length, 1);
    const cell = cellKeyOf('debug', first.runs[0].runKeyInputs.ingredients);
    const registry = { registryPath, champion: cell };
    assert.deepEqual(readRegistry(registryPath).rows[0].attemptedRunIds.length, 2);

    await go(specPath, { registry });                       // restart: 1 dispatched, 2 reused, registry sees all 3
    assert.equal(readRegistry(registryPath).rows[0].attemptedRunIds.length, 3);
    // --rerun all under maxRuns 2: 2 rerun, the third keeps its record; the snapshot still lists all 3
    const capped = await go(specPath, { registry, rerun: 'all' });
    assert.equal(capped.fake.calls.length, 2);
    assert.equal(readRegistry(registryPath).rows[0].attemptedRunIds.length, 3);
  }));
});
