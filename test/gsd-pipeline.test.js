/**
 * pipelines/gsd.stratum.yaml v1 structural contract over the live TS engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolvePlanSpecValues, StratumMcpClient } from '../lib/stratum-mcp-client.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = join(REPO_ROOT, 'pipelines', 'gsd.stratum.yaml');
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';
const text = readFileSync(SPEC_PATH, 'utf-8');
const spec = YAML.parse(text);
const steps = spec.flows.gsd.steps;

test('YAML parses as the v1 gsd entry flow', () => {
  assert.ok(spec);
  assert.equal(spec.version, 1);
  assert.equal(spec.flows.entry, 'gsd');
});

test('the live TS MCP bin validates and accepts the spec', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'compose-gsd-spec-state-'));
  const client = new StratumMcpClient();
  try {
    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });
    const input = {
      featureCode: 'GSD-TEST',
      gateCommands: [],
      pre_merge_gate: [],
    };
    const validation = await client.validate(resolvePlanSpecValues(spec, input));
    assert.deepEqual(validation, { status: 'valid' });
    const planned = await client.plan(spec, 'gsd', input);
    assert.equal(planned.status, 'ready');
    assert.equal(planned.ready[0].id, 'decompose_gsd');
  } finally {
    await client.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('flow has the four authored v1 steps with expected ids', () => {
  assert.deepEqual(
    steps.map((step) => step.id),
    ['decompose_gsd', 'execute', 'execute_merge', 'ship_gsd'],
  );
});

test('flow inputs use the v1 scalar contract grammar', () => {
  assert.equal(spec.flows.gsd.input.featureCode, 'string');
  assert.equal(spec.flows.gsd.input.gateCommands, 'string[]');
  assert.equal(spec.flows.gsd.input.pre_merge_gate, 'string[]?');
});

test('decompose_gsd declares the TaskGraph contract and deterministic postcondition', () => {
  const step = steps.find(({ id }) => id === 'decompose_gsd');
  assert.equal(step.agent, 'claude');
  assert.equal(step.out, 'TaskGraph');
  assert.equal(step.attempts, 2);
  // The REAL v1 postcondition (the enforced invariant): at least one task.
  assert.deepEqual(step.ensure, [{ expr: 'len(result.tasks) >= 1' }]);
  // ADVISORY ONLY: the prompt asks the agent to reject file-ownership conflicts,
  // but this prompt text is NOT the enforcement mechanism. File-ownership
  // enforcement is deterministic and consumer-side since E3/F6 (a typed
  // TaskGraphOwnershipError → failure step_done envelope, so the engine's
  // attempts loop governs) — covered in test/gsd.test.js ("F6: decompose_gsd
  // files_owned conflict yields a failure envelope"). The dead python
  // `no_file_conflicts` ensure builtin is intentionally NOT resurrected here.
  assert.match(step.do, /Reject file ownership conflicts/);
});

test('execute carries the v1 consumer-fanout dispatch policy', () => {
  const step = steps.find(({ id }) => id === 'execute');
  assert.deepEqual(step.after, ['decompose_gsd']);
  assert.equal(step.attempts, 2);
  assert.equal(step.fanout.dispatch, 'consumer');
  assert.equal(step.fanout.concurrency, 1);
  assert.equal(step.fanout.isolation, 'worktree');
  assert.equal(step.fanout.require, 'all');
  assert.equal(step.fanout.merge, 'sequential');
  assert.equal(step.fanout.steps[0].agent, 'claude');
  assert.equal(step.fanout.steps[0].out, 'TaskResult');
});

test('execute fanout prompt uses only v1 item/input references', () => {
  const prompt = steps.find(({ id }) => id === 'execute').fanout.steps[0].do;
  const refs = [...prompt.matchAll(/\$\{([^{}]+)\}/g)].map((match) => match[1]);
  for (const ref of refs) {
    assert.ok(ref === 'item' || /^input\.[A-Za-z_][A-Za-z0-9_]*$/.test(ref),
      `unsupported v1 fanout reference: \${${ref}}`);
  }
});

test('ship_gsd declares the deterministic completion postcondition', () => {
  // The REAL v1 invariant on ship_gsd: the ship result must report outcome
  // 'complete' (a deterministic expr ensure, not a judged predicate).
  const step = steps.find(({ id }) => id === 'ship_gsd');
  assert.deepEqual(step.ensure, [{ expr: "result.outcome == 'complete'" }]);
});

test('ship_gsd enumerates docs, verification, commit, and no push', () => {
  const step = steps.find(({ id }) => id === 'ship_gsd');
  assert.match(step.do, /ROADMAP\.md/);
  assert.match(step.do, /CHANGELOG\.md/);
  assert.match(step.do, /CLAUDE\.md/);
  assert.match(step.do, /[Cc]ommit/);
  assert.match(step.do, /Do not push/);
});

test('ship_gsd does not precondition on plan.md or report.md', () => {
  const step = steps.find(({ id }) => id === 'ship_gsd');
  assert.doesNotMatch(step.do, /plan\.md/);
  assert.doesNotMatch(step.do, /report\.md/);
});

test('pre-merge commands are single-sourced into instruction and enforcement', () => {
  const decompose = steps.find(({ id }) => id === 'decompose_gsd');
  const execute = steps.find(({ id }) => id === 'execute');
  const ship = steps.find(({ id }) => id === 'ship_gsd');
  assert.match(decompose.do, /\$\{input\.pre_merge_gate\}/);
  assert.equal(execute.fanout.pre_merge, '$.input.pre_merge_gate');
  assert.match(ship.do, /\$\{input\.gateCommands\}/);
});

test('execute_merge preserves the deferred consumer merge decision', () => {
  const gate = steps.find(({ id }) => id === 'execute_merge');
  assert.deepEqual(gate.after, ['execute']);
  assert.deepEqual(gate.gate, {
    on_approve: 'ship_gsd',
    on_revise: 'execute',
    on_kill: null,
    max_rounds: 10,
  });
});
