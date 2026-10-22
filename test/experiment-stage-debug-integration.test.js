/**
 * experiment-stage-debug-integration.test.js — G2 stage runner x G3 debug archetype (COMP-STAGE-GRADING-3-INTEG).
 *
 * The G2 and G3 suites each pass on their own because experiment-stage.test.js injects a fake archetype that
 * carries the runner's data names (`scenario`, `hiddenPath`) and archetype-debug.test.js never calls the runner.
 * This file closes the gap: the REAL loader (`loadArchetype('debug')`, no `_loadArchetype` seam) goes through
 * `runExperiment` with a fake stratum client, and the record is checked against stage-run-contract.json.
 *
 * Needs node:sqlite (the debug oracle runs the notes-server suite), so the grading rows skip on older nodes.
 * No model call. Run: node --test test/experiment-stage-debug-integration.test.js
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { runExperiment } from '../lib/experiment.js';
import { loadArchetype } from '../lib/archetypes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(
  resolve(__dirname, '..', 'docs', 'features', 'COMP-MODEL-AB-DECISION', 'stage-run-contract.json'), 'utf-8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);
const validateRecord = ajv.getSchema(`${CONTRACT.$id}#/$defs/stageRunRecord`);

const ROOT = mkdtempSync(join(tmpdir(), 'exp-stage-debug-integ-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const BUDGET = { maxRuns: 10, perRunTimeoutMs: 120_000, maxUsdTotal: null, maxTokensTotal: 9_000_000, perRunTokenAssume: 400_000 };
const SQLITE = isBuiltin('node:sqlite') ? false : 'node:sqlite unavailable';

// The gold fix is the inverse of hidden/debug/bug.patch: put the body match back into search().
const BUGGED = `    sql += ')';\n`;
const FIXED = `    sql += " OR n.body LIKE $p ESCAPE '\\\\')";\n`;
function applyGoldFix(cwd) {
  const file = join(cwd, 'src', 'store.js');
  const src = readFileSync(file, 'utf-8');
  assert.ok(src.includes(BUGGED), 'workspace holds the planted bug');
  writeFileSync(file, src.replace(BUGGED, FIXED));
}

/**
 * Fake StratumMcpClient: connect/close plus an agentRun that applies `edit` to the workspace.
 * `shape.events` are BuildStreamEvent envelopes pushed to onEvent subscribers during the call (as the real client does);
 * `shape.transcript` rides on the result (a provider that returns its own).
 */
function fakeStratum(edit, shape = {}) {
  const subs = new Map();
  const fake = {
    calls: [],
    async connect() {},
    async close() {},
    onEvent(flowId, stepId, handler) {
      subs.set(`${flowId}::${stepId}`, handler);
      return () => subs.delete(`${flowId}::${stepId}`);
    },
    async agentRun(provider, prompt, opts) {
      fake.calls.push({ provider, prompt, opts });
      edit(opts.cwd);
      (shape.events ?? []).forEach((e, seq) => subs.get(`${opts.correlationId}::_agent_run`)?.({
        schema_version: '0.2.8', flow_id: opts.correlationId, step_id: '_agent_run', seq, ts: '2026-10-23T00:00:00Z', ...e,
      }));
      return { text: 'done', usage: null, ...(shape.transcript !== undefined ? { transcript: shape.transcript } : {}) };
    },
  };
  return fake;
}

function writeSpec() {
  const dir = mkdtempSync(join(ROOT, 'spec-'));
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify({
    id: 'integ', fixture: { archetype: 'debug' },
    configs: [{ label: 'sonnet-fast', candidate: 'claude::fast' }],
    reps: 1, parallelism: 1, budget: BUDGET,
  }));
  return path;
}

const quiet = fn => async (...a) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(...a); } finally { process.stderr.write = write; }
};

// No `_loadArchetype` seam: the engine imports the real lib/archetypes loader.
async function runDebug(edit, shape) {
  const stratum = fakeStratum(edit, shape);
  const specPath = writeSpec();
  const { runs } = await runExperiment(specPath, { _stratumFactory: () => stratum });
  return { runs, stratum, expRoot: resolve(dirname(specPath), 'integ-exp') };
}

describe('real debug archetype through the stage runner', () => {
  // One row per outcome class: the planted bug left alone, and the gold fix.
  const GRADING_ROWS = [
    { name: 'untouched workspace', edit: () => {}, accuracy: 0 },
    { name: 'gold fix applied', edit: applyGoldFix, accuracy: 1 },
  ];
  for (const row of GRADING_ROWS) {
    test(`${row.name}: contract-valid record, accuracy ${row.accuracy}, digest and canary set`, { skip: SQLITE }, quiet(async () => {
      const { runs, stratum } = await runDebug(row.edit);
      assert.equal(runs.length, 1);
      const [run] = runs;
      assert.ok(validateRecord(run), JSON.stringify(validateRecord.errors));
      assert.equal(run.metrics.stage.oracleError, null, 'oracle ran');
      assert.equal(run.metrics.stage.accuracy, row.accuracy);
      assert.match(run.runKeyInputs.fixtureDigest ?? '', /^[0-9a-f]{64}$/);
      assert.deepEqual(run.runKeyInputs.archetype, { id: 'debug', version: loadArchetype('debug').version });
      // The runner handed buildInput/prompt the public scenario: the bug report reached the agent, the gold never did.
      const { calls } = stratum;
      assert.equal(calls.length, 1);
      assert.match(calls[0].prompt, /search_notes does not return a note whose body contains the query/);
      assert.doesNotMatch(calls[0].prompt, /title LIKE \$p OR body LIKE/);
    }));
  }

  test('the runner reads the archetype data names it documents (hiddenPath outside the sandbox, scenario without gold)', () => {
    const arch = loadArchetype('debug');
    assert.equal(typeof arch.hiddenPath, 'string');
    assert.ok(existsSync(join(arch.hiddenPath, 'fixture.json')), 'hiddenPath is the hidden material directory');
    assert.equal(arch.scenario && typeof arch.scenario, 'object');
    assert.equal(Object.hasOwn(arch.scenario, 'gold'), false);
    assert.equal(typeof arch.scenario.task, 'string');
  });

  // The hidden-inside-workspace guard must be evaluated for the real archetype (it was skipped while hiddenPath was undefined).
  const GUARD_ROWS = [
    { name: 'hiddenPath is the sandbox workspace itself', hidden: dir => dir },
    { name: 'hiddenPath is a directory inside the sandbox workspace', hidden: dir => join(dir, 'src') },
  ];
  for (const row of GUARD_ROWS) {
    test(`guard refuses when ${row.name}`, quiet(async () => {
      const specPath = writeSpec();
      const expRoot = resolve(dirname(specPath), 'integ-exp');
      // The workspace is created by provision() inside the run, so the path is resolved at first read after it exists.
      const findWorkspace = () => {
        const runsDir = join(expRoot, 'runs');
        if (!existsSync(runsDir)) return null;
        for (const rid of readdirSync(runsDir)) {
          const parent = join(runsDir, rid, 'workspace-tmp');
          if (!existsSync(parent)) continue;
          const ws = readdirSync(parent).find(n => n.startsWith('ws-'));
          if (ws) return join(parent, ws);
        }
        return null;
      };
      const real = loadArchetype('debug');
      const archetype = Object.create(real, {
        hiddenPath: {
          enumerable: true,
          get() {
            const ws = findWorkspace();
            return ws ? row.hidden(ws) : join(ROOT, 'not-yet-provisioned');
          },
        },
      });
      const stratum = fakeStratum(() => {});
      const { runs } = await runExperiment(specPath, { _stratumFactory: () => stratum, _loadArchetype: () => archetype });
      const [run] = runs;
      assert.equal(stratum.calls.length, 0, 'no dispatch after the refusal');
      assert.equal(run.metrics.stage.accuracy, null);
      assert.match(run.metrics.stage.oracleError, /hidden material .* is inside the workspace/);
    }));
  }
});

// COMP-STAGE-TRANSCRIPT-1: the runner builds the transcript from tool events for every provider, and a false
// mechanismEngaged names the sources it tried. One row per evidence case, each on the untouched workspace.
const CMD_EVENT = { kind: 'tool_use_summary', metadata: { tool: 'bash', summary: 'node --test test/repro.test.js', ok: false, input: { command: 'node --test test/repro.test.js' } } };
const CAT_EVENT = { kind: 'tool_use_summary', metadata: { tool: 'bash', summary: 'cat src/store.js', ok: true, input: { command: 'cat src/store.js' } } };
const PROSE_EVENT = { kind: 'agent_relay', metadata: { role: 'assistant', text: 'I ran node --test test/repro.test.js and it failed first' } };
const writeReproLog = cwd => {
  mkdirSync(join(cwd, '.test-log'), { recursive: true });
  writeFileSync(join(cwd, '.test-log', 'repro.log'), `2026-10-23T00:00:00Z repro-executed-notes-search\n`);
};

describe('stage runner transcript and mechanism evidence', () => {
  const ROWS = [
    { name: 'codex-shaped: command in tool events, no test log (probe A)', shape: { events: [CAT_EVENT, CMD_EVENT] },
      engaged: true, transcript: true },
    { name: 'claude-shaped: marker in the result transcript, no events (probe B)',
      shape: { transcript: '{"kind":"tool_result","output":"repro-executed-notes-search"}' }, engaged: true, transcript: true },
    { name: 'no events and no log (probe C)', shape: {}, engaged: false, transcript: false, label: 'no-evidence',
      sources: { transcript: { present: false, marker: false, command: false }, testLog: { present: false, marker: false } } },
    { name: 'test log only (probe D)', shape: {}, edit: writeReproLog, engaged: true, transcript: false },
    { name: 'events that never ran the repro (probe E)', shape: { events: [CAT_EVENT] }, engaged: false, transcript: true,
      label: 'evidence-without-repro' },
    { name: 'the agent only claims the run in prose: prose is not captured', shape: { events: [PROSE_EVENT] }, engaged: false,
      transcript: false, label: 'no-evidence' },
  ];
  for (const row of ROWS) {
    test(row.name, { skip: SQLITE }, quiet(async () => {
      const { runs, expRoot } = await runDebug(row.edit ?? (() => {}), row.shape);
      const [run] = runs;
      assert.ok(validateRecord(run), JSON.stringify(validateRecord.errors));
      const { stage } = run.metrics;
      assert.equal(stage.mechanismEngaged, row.engaged, JSON.stringify({ d: stage.detail, e: stage.oracleError, r: run._error }));
      assert.equal(typeof run.artifacts.transcriptPath, row.transcript ? 'string' : 'object');
      if (row.transcript) {
        const lines = readFileSync(resolve(expRoot, run.artifacts.transcriptPath), 'utf8').trim().split('\n');
        assert.ok(lines.length >= 1 && lines.every(l => JSON.parse(l) !== undefined), 'transcript.jsonl parses');
      }
      if (row.engaged) assert.equal(stage.detail.mechanism, undefined, 'a true check needs no explanation');
      else {
        assert.equal(stage.detail.mechanism.label, row.label);
        if (row.sources) assert.deepEqual(stage.detail.mechanism.sources, row.sources);
      }
    }));
  }
});
