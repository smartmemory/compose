/**
 * experiment-stage.test.js — stage-run mode of the experiment engine (COMP-STAGE-GRADING-2).
 *
 * Every test injects the engine's seams: opts._stratumFactory / opts.stratum (a fake
 * client whose agentRun edits the workspace and writes one dispatch-ledger row the way
 * StratumMcpClient#recordAgentDispatch does) and opts._loadArchetype (a fake archetype).
 * No model call, no Stratum MCP process. The model catalog is the installed Stratum's
 * `models --json`, read the same way production reads it.
 *
 * Records are validated with Ajv 2020 against
 * docs/features/COMP-MODEL-AB-DECISION/stage-run-contract.json.
 *
 * Run: node --test test/experiment-stage.test.js
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { runExperiment, validateSpec } from '../lib/experiment.js';
import { canonicalJson, sha256Hex, STAGE_SITE } from '../lib/experiment-stage.js';
import { appendEvent, resolveDispatchLedgerCwd, DISPATCH_SITES } from '../lib/dispatch-ledger.js';
import { getModelCatalog } from '../lib/model-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(
  resolve(__dirname, '..', 'docs', 'features', 'COMP-MODEL-AB-DECISION', 'stage-run-contract.json'), 'utf-8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);
const validateRecord = ajv.getSchema(`${CONTRACT.$id}#/$defs/stageRunRecord`);
const validateStageSpecSchema = ajv.getSchema(`${CONTRACT.$id}#/$defs/specStage`);

const ROOT = mkdtempSync(join(tmpdir(), 'exp-stage-test-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// Ledger row values the receipts join must reproduce; the fake's RETURN value carries
// different numbers so taking cost from the return turns every cost assertion red.
const RECEIPT = { tokens_in: 1200, tokens_out: 300, tokens_total: 1500, usd: 0.05 };
const RETURNED_USAGE = { tokens: 999_999, usd: 99, model: 'not-from-the-ledger' };

const BUDGET = { maxRuns: 10, perRunTimeoutMs: 60_000, maxUsdTotal: null, maxTokensTotal: 9_000_000, perRunTokenAssume: 400_000 };

function fakeArchetype(over = {}) {
  const hiddenPath = mkdtempSync(join(ROOT, 'hidden-'));
  writeFileSync(join(hiddenPath, 'expected.txt'), 'fixed\n');
  return {
    id: 'debug', stage: 'debug', runner: 'stage', judged: false, version: '1',
    oracleName: 'repro-passes',
    scenario: { task: 'make bug.js print fixed' },
    hiddenPath,
    fixture: { context: 'tiny', task: 'make bug.js print fixed', gold: { fix: 'fixed' }, task_type: 'debug' },
    buildInput(workspace, scenario) {
      writeFileSync(join(workspace, 'bug.js'), `// ${scenario.task}\nconsole.log('broken');\n`);
    },
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

/** Fake StratumMcpClient: connect/close counters, ledger row written to telemetry.project_cwd. */
function fakeStratum({ throwOnCall = 0, receipt = RECEIPT } = {}) {
  const fake = {
    connects: 0, closes: 0, calls: [],
    async connect() { fake.connects++; },
    async close() { fake.closes++; },
    async agentRun(provider, prompt, opts) {
      fake.calls.push({ provider, prompt, opts });
      const n = fake.calls.length;
      const throws = n === throwOnCall;
      if (!throws) writeFileSync(join(opts.cwd, 'bug.js'), "console.log('fixed');\n");
      appendEvent(resolveDispatchLedgerCwd(opts.telemetry?.project_cwd), {
        kind: 'dispatch', dispatch_id: randomUUID(), site: opts.telemetry?.site ?? 'unattributed', agent: provider,
        outcome: throws ? 'error' : 'ok', model: receipt.tokens_in === null ? null : 'm-from-ledger',
        effort_intended: opts.effort ?? null, effort_executed: null,
        ...receipt, usd_source: receipt.usd === null ? null : 'reported', duration_ms: 10, transport_derived: null,
      });
      if (throws) throw new Error(`fake agentRun failure on call ${n}`);
      return { text: `output of call ${n}`, usage: RETURNED_USAGE };
    },
  };
  return fake;
}

function writeSpec(spec) {
  const dir = mkdtempSync(join(ROOT, 'spec-'));
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

function stageSpec(over = {}) {
  return {
    id: 'stage-t', fixture: { archetype: 'debug' },
    configs: [{ label: 'sonnet-fast', candidate: 'claude::fast' }, { label: 'sol-std', candidate: 'codex::standard' }],
    reps: 1, parallelism: 1, budget: BUDGET, ...over,
  };
}

const quiet = fn => async (...a) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(...a); } finally { process.stderr.write = write; }
};

describe('stage run: records, receipts join, client lifecycle', () => {
  test('one contract-valid record per config; cost from the ledger; one connect, one close', quiet(async () => {
    const stratum = fakeStratum();
    const archetype = fakeArchetype();
    const specPath = writeSpec(stageSpec());
    assert.ok(validateStageSpecSchema(JSON.parse(readFileSync(specPath, 'utf-8'))), 'test spec is a valid specStage');
    let factoryCalls = 0;
    const { runs } = await runExperiment(specPath, {
      _stratumFactory: () => { factoryCalls++; return stratum; },
      _loadArchetype: id => (id === 'debug' ? archetype : null),
    });

    assert.equal(runs.length, 2);
    assert.equal(factoryCalls, 1);
    assert.deepEqual([stratum.connects, stratum.closes], [1, 1]);
    const catalog = getModelCatalog();
    for (const [i, run] of runs.entries()) {
      assert.ok(validateRecord(run), `record ${run.runId}: ${JSON.stringify(validateRecord.errors)}`);
      const onDisk = JSON.parse(readFileSync(join(dirname(run.artifacts.logPath), `${run.runId}.json`), 'utf-8'));
      assert.deepEqual(onDisk, run, 'the kept record equals the returned one');
      // Receipts join (negative control): the ledger numbers, never the agentRun return.
      assert.deepEqual(run.metrics.cost, { tokensIn: 1200, tokensOut: 300, calls: 1, wallMs: run.metrics.cost.wallMs, usd: 0.05 });
      assert.deepEqual(run.budget, { stoppedBy: null, spentUsd: 0.05, spentTokens: 1500 });
      assert.equal(run.metrics.stage.accuracy, 1);
      assert.equal(run.metrics.stage.canaryOk, true);
      assert.equal(run.metrics.stage.oracle, 'repro-passes');
      assert.equal(run.metrics.outcome.completed, true);
      assert.deepEqual([run.metrics.outcome.filesChanged, run.metrics.outcome.linesChanged], [1, 3]);
      assert.equal(readFileSync(run.artifacts.outputPath, 'utf-8'), `output of call ${i + 1}`);
      assert.match(readFileSync(run.artifacts.diffPath, 'utf-8'), /\+console\.log\('fixed'\);/);
      assert.equal(run.artifacts.transcriptPath, null);
      assert.equal(run.runKey, sha256Hex(canonicalJson(run.runKeyInputs)));
      assert.equal(run.runKeyInputs.catalogDigest, catalog.catalogDigest);
      // The dispatch: one agentRun per run, attributed to the experiment-stage site in this sandbox.
      const call = stratum.calls[i];
      const workspace = call.opts.cwd;
      assert.deepEqual(call.opts.telemetry, { site: STAGE_SITE, project_cwd: workspace });
      assert.equal(relative(dirname(run.artifacts.logPath), workspace).startsWith('workspace-tmp'), true);
      assert.equal(existsSync(join(workspace, 'expected.txt')), false, 'hidden material never enters the workspace');
      assert.match(call.prompt, /^Fix it: /);
    }
    // candidateResolved comes from the catalog through resolveAgentConfig, never a literal.
    const [claudeRun, codexRun] = runs;
    const tier = (provider, key) => catalog.catalog.tiers[provider][key];
    assert.deepEqual(codexRun.candidateResolved, {
      provider: 'codex', modelID: tier('codex', 'standard').model, effort: tier('codex', 'standard').effort,
      catalogDigest: catalog.catalogDigest,
    });
    assert.deepEqual(claudeRun.candidateResolved, {
      provider: 'claude', modelID: tier('claude', 'fast').model, effort: tier('claude', 'fast').effort,
      catalogDigest: catalog.catalogDigest,
    });
    assert.equal(stratum.calls[1].provider, 'codex');
    assert.equal(stratum.calls[1].opts.modelID, tier('codex', 'standard').model);
    assert.equal(stratum.calls[1].opts.sandboxMode, 'workspace-write', 'codex dispatches with workspace-write');
    assert.equal(stratum.calls[0].opts.sandboxMode, undefined, 'claude gets no sandboxMode');
  }));

  test('agentRun throwing on config 2: one connect, one close, kept _error record with accuracy null', quiet(async () => {
    const stratum = fakeStratum({ throwOnCall: 2 });
    const { runs } = await runExperiment(writeSpec(stageSpec()), {
      _stratumFactory: () => stratum, _loadArchetype: () => fakeArchetype(),
    });
    assert.deepEqual([stratum.connects, stratum.closes], [1, 1]);
    const failed = runs[1];
    assert.ok(validateRecord(failed), JSON.stringify(validateRecord.errors));
    assert.match(failed._error, /fake agentRun failure on call 2/);
    assert.equal(failed.metrics.outcome.completed, false);
    assert.equal(failed.metrics.stage.accuracy, null);
    assert.match(failed.metrics.stage.oracleError, /^not run: agentRun failed/);
    assert.deepEqual(failed.metrics.cost, { tokensIn: 1200, tokensOut: 300, calls: 1, wallMs: failed.metrics.cost.wallMs, usd: 0.05 },
      'the failed attempt still costs what its ledger row says');
    assert.equal(runs[0]._error, undefined);
  }));

  test('a passed opts.stratum is used and never connected or closed by the engine', quiet(async () => {
    const stratum = fakeStratum({ throwOnCall: 2 });
    let factoryCalls = 0;
    await runExperiment(writeSpec(stageSpec()), {
      stratum, _stratumFactory: () => { factoryCalls++; return fakeStratum(); }, _loadArchetype: () => fakeArchetype(),
    });
    assert.deepEqual([stratum.connects, stratum.closes, factoryCalls, stratum.calls.length], [0, 0, 0, 2]);
  }));

  test('connect failure still closes the owned client exactly once and propagates', quiet(async () => {
    const stratum = fakeStratum();
    stratum.connect = async () => { stratum.connects++; throw new Error('spawn failed'); };
    await assert.rejects(runExperiment(writeSpec(stageSpec()), {
      _stratumFactory: () => stratum, _loadArchetype: () => fakeArchetype(),
    }), /spawn failed/);
    assert.deepEqual([stratum.connects, stratum.closes, stratum.calls.length], [1, 1, 0]);
  }));

  test('a receipt with unknown usage keeps cost null (never 0); the budget counts perRunTokenAssume', quiet(async () => {
    const stratum = fakeStratum({ receipt: { tokens_in: null, tokens_out: null, tokens_total: null, usd: null } });
    const { runs } = await runExperiment(writeSpec(stageSpec({ configs: [{ label: 'sol-std', candidate: 'codex::standard' }] })), {
      _stratumFactory: () => stratum, _loadArchetype: () => fakeArchetype(),
    });
    const [run] = runs;
    assert.ok(validateRecord(run), JSON.stringify(validateRecord.errors));
    assert.deepEqual(
      { ...run.metrics.cost, wallMs: 0 },
      { tokensIn: null, tokensOut: null, calls: 1, wallMs: 0, usd: null },
    );
    assert.deepEqual(run.budget, { stoppedBy: null, spentUsd: null, spentTokens: BUDGET.perRunTokenAssume });
  }));

  test('an oracle that throws gives a kept record with oracleError and accuracy null', quiet(async () => {
    const stratum = fakeStratum();
    const archetype = fakeArchetype({ oracle() { throw new Error('hidden suite failed to start: exit 2'); } });
    const { runs } = await runExperiment(writeSpec(stageSpec({ configs: [{ label: 'sonnet-fast', candidate: 'claude::fast' }] })), {
      _stratumFactory: () => stratum, _loadArchetype: () => archetype,
    });
    const [run] = runs;
    assert.ok(validateRecord(run), JSON.stringify(validateRecord.errors));
    assert.equal(run.metrics.stage.accuracy, null);
    assert.equal(run.metrics.stage.oracleError, 'oracle threw: hidden suite failed to start: exit 2');
    assert.equal(run._error, undefined, 'the run itself succeeded');
    assert.ok(existsSync(join(dirname(run.artifacts.logPath), `${run.runId}.json`)));
  }));

  test('an oracle reporting oracleError with accuracy 0 is recorded as accuracy null', quiet(async () => {
    const archetype = fakeArchetype({ oracle: () => ({ accuracy: 0, detail: {}, oracleError: 'suite did not start' }) });
    const { runs } = await runExperiment(writeSpec(stageSpec({ configs: [{ label: 'sonnet-fast', candidate: 'claude::fast' }] })), {
      _stratumFactory: () => fakeStratum(), _loadArchetype: () => archetype,
    });
    assert.deepEqual([runs[0].metrics.stage.accuracy, runs[0].metrics.stage.oracleError], [null, 'suite did not start']);
    assert.ok(validateRecord(runs[0]), JSON.stringify(validateRecord.errors));
  }));
});

describe('refusals by name', () => {
  const legacy = {
    id: 'legacy', fixture: { goal: 'g' },
    configs: [{ label: 'a', implementer: 'claude', reviewer: 'codex' }], reps: 1,
  };
  const cases = [
    { name: 'unknown archetype id', code: 'ARCHETYPE_UNKNOWN', spec: stageSpec(), archetype: null },
    { name: 'stage config carrying implementer', code: 'CONFIG_SHAPE_MISMATCH',
      spec: stageSpec({ configs: [{ label: 'x', candidate: 'claude::fast', implementer: 'claude' }] }) },
    { name: 'stage config with no candidate', code: 'CONFIG_SHAPE_MISMATCH', spec: stageSpec({ configs: [{ label: 'x' }] }) },
    { name: 'build (legacy) config carrying candidate', code: 'CONFIG_SHAPE_MISMATCH',
      spec: { ...legacy, configs: [{ ...legacy.configs[0], candidate: 'claude::fast' }] } },
    { name: 'runner "build" archetype', code: 'ARCHETYPE_RUNNER_UNSUPPORTED', spec: stageSpec(),
      archetype: fakeArchetype({ runner: 'build' }) },
    { name: 'codex candidate on a judged archetype', code: 'JUDGED_STAGE_CLAUDE_ONLY', spec: stageSpec(),
      archetype: fakeArchetype({ id: 'debug', stage: 'design', judged: true }) },
    { name: 'archetype spec with no budget', code: 'BUDGET_REQUIRED', spec: stageSpec({ budget: undefined }) },
  ];
  for (const c of cases) {
    test(`${c.code}: ${c.name}`, () => {
      const archetype = 'archetype' in c ? c.archetype : fakeArchetype();
      assert.throws(() => validateSpec(JSON.parse(JSON.stringify(c.spec)), { archetype }),
        err => err.code === c.code && err.message.startsWith(`${c.code}: `));
    });
  }

  test('ARCHETYPE_UNKNOWN through runExperiment: loader refusal, before any client exists', async () => {
    let factoryCalls = 0;
    const loaders = [
      () => null,
      () => { throw Object.assign(new Error('ARCHETYPE_UNKNOWN: nope'), { code: 'ARCHETYPE_UNKNOWN' }); },
    ];
    for (const _loadArchetype of loaders) {
      await assert.rejects(
        runExperiment(writeSpec(stageSpec()), { _loadArchetype, _stratumFactory: () => { factoryCalls++; return fakeStratum(); } }),
        err => err.code === 'ARCHETYPE_UNKNOWN',
      );
    }
    assert.equal(factoryCalls, 0);
  });

  test('a legacy spec never reaches the archetype loader and keeps its shape', () => {
    const spec = validateSpec(legacy);
    assert.equal(spec.runner, undefined);
    assert.deepEqual(spec.fixture, { goal: 'g', seedRepo: null, seedRef: null });
  });

  test('experiment-stage is a dispatch-ledger site', () => {
    assert.ok(DISPATCH_SITES.includes(STAGE_SITE));
  });
});

describe('legacy judge path revived (F6)', () => {
  test('judge.enabled with no opts.stratum: the engine owns one client, judges, then closes it', quiet(async () => {
    const stratum = fakeStratum();
    stratum.agentRun = async (provider, prompt, opts) => {
      stratum.calls.push({ provider, prompt, opts });
      return { text: '{"correctness":4,"clarity":4,"idiomaticity":4,"rationale":"ok"}' };
    };
    const spec = {
      id: 'legacy-judge', fixture: { goal: 'add a file' },
      configs: [{ label: 'a', implementer: 'claude', reviewer: 'codex' }], reps: 2,
      judge: { enabled: true, model: 'claude::fast' },
    };
    const fakeBuild = async (_cfg, _env, { cwd }) => {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'a.js'), 'export const a = 1;\n');
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, wallMs: 1 };
    };
    await runExperiment(writeSpec(spec), { _runBuild: fakeBuild, _stratumFactory: () => stratum });
    assert.deepEqual([stratum.connects, stratum.closes, stratum.calls.length], [1, 1, 2]);
  }));
});
