/**
 * Golden acceptance tests for Phase-2 issuance-token fencing
 * (STRAT-TS-FANOUT-CONSUMER design, universal fencing).
 *
 * The Stratum workflow is real and runs through the TS MCP bin with isolated
 * state. Agent inference alone is stubbed at the connector-factory seam.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { runBuild } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const HUMAN_GATED_BUILD_SPEC = `
version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${finish.output}
      contract: Result
    steps:
      - id: work
        do: "build \${input.description}"
        out: Result
      - id: review
        after: [work]
        gate:
          on_approve: finish
          on_revise: work
          on_kill: null
          max_rounds: 3
      - id: finish
        after: [review]
        do: "finish \${input.description}"
        out: Result
`;

const GATE_SPEC = {
  version: 1,
  contracts: { Result: { value: 'string' } },
  flows: {
    entry: 'main',
    main: {
      max_rounds: 2,
      input: { name: 'string' },
      output: { from: '${finish.output}', contract: 'Result' },
      steps: [
        { id: 'work', do: 'work ${input.name}', out: 'Result' },
        { id: 'review', after: ['work'], gate: { on_approve: 'finish', on_revise: 'work', on_kill: null } },
        { id: 'finish', after: ['review'], do: 'finish ${input.name}', out: 'Result' },
      ],
    },
  },
};

function stubAgentFactory() {
  return function factory() {
    return {
      async *run() {
        yield { type: 'assistant', content: JSON.stringify({ value: 'built' }) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

function scriptedGateIO(script) {
  const input = new PassThrough();
  const output = new PassThrough();
  let next = 0;
  let rendered = '';

  output.on('data', (chunk) => {
    rendered += chunk.toString();
    const expectedPrompt = script[next]?.prompt;
    if (expectedPrompt && rendered.includes(expectedPrompt)) {
      const line = script[next].line;
      next += 1;
      rendered = '';
      queueMicrotask(() => input.write(`${line}\n`));
    }
  });

  return {
    input,
    output,
    assertConsumed: () => assert.equal(next, script.length, 'all scripted gate input must be consumed'),
  };
}

async function connectTsClient(client, stateRoot) {
  await client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN],
    env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
  });
}

describe('Phase-2 issuance-token fencing over the TS engine', () => {
  test('a full gated build echoes every ready dispatchToken and audit-discovered gateToken', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-token-echo-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-token-'));
    const client = new StratumMcpClient();
    const reportedSteps = [];
    const reportedGates = [];
    const auditGateTokens = new Map();
    const io = scriptedGateIO([
      { prompt: '\n> ', line: 'r' },
      { prompt: 'Rationale: ', line: 'rework required' },
      { prompt: '\n> ', line: 'a' },
    ]);
    const previousStateRoot = process.env.STRATUM_STATE_ROOT;
    const previousComposePort = process.env.COMPOSE_PORT;

    try {
      process.env.STRATUM_STATE_ROOT = stateRoot;
      process.env.COMPOSE_PORT = '65534';

      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'TS-TOKEN-ECHO'), { recursive: true });
      await writeFile(
        join(workspace, '.compose', 'compose.json'),
        JSON.stringify({ version: 2, capabilities: { stratum: true } }),
      );
      await writeFile(
        join(workspace, '.compose', 'data', 'settings.json'),
        JSON.stringify({ policies: { review: 'gate' } }),
      );
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), HUMAN_GATED_BUILD_SPEC);
      await writeFile(
        join(workspace, 'docs', 'features', 'TS-TOKEN-ECHO', 'description.md'),
        '# TS issuance token echo\n',
      );

      await connectTsClient(client, stateRoot);

      const realAudit = client.audit.bind(client);
      client.audit = async (flowId) => {
        const audit = await realAudit(flowId);
        for (const [stepId, step] of Object.entries(audit.steps ?? {})) {
          if (step?.status === 'waiting_gate') {
            auditGateTokens.set(`${flowId}:${stepId}`, step.gateToken);
          }
        }
        return audit;
      };

      const realStepDone = client.stepDone.bind(client);
      client.stepDone = async (flowId, stepId, result, dispatchToken) => {
        reportedSteps.push({ stepId, dispatchToken });
        return realStepDone(flowId, stepId, result, dispatchToken);
      };

      const realGateResolve = client.gateResolve.bind(client);
      client.gateResolve = async (flowId, stepId, outcome, rationale, resolvedBy, gateToken) => {
        reportedGates.push({
          stepId,
          outcome,
          gateToken,
          auditGateToken: auditGateTokens.get(`${flowId}:${stepId}`),
        });
        return realGateResolve(flowId, stepId, outcome, rationale, resolvedBy, gateToken);
      };

      installAgentHarness(client, stubAgentFactory(), workspace);

      await runBuild('TS-TOKEN-ECHO', {
        cwd: workspace,
        stratum: client,
        template: 'build',
        skipTriage: true,
        description: 'the issuance-token echo cutover',
        gateOpts: { input: io.input, output: io.output },
      });

      io.assertConsumed();
      assert.deepEqual(reportedSteps.map(({ stepId }) => stepId), ['work', 'work', 'finish']);
      assert.ok(
        reportedSteps.every(({ dispatchToken }) => typeof dispatchToken === 'string' && dispatchToken.length > 0),
        'build.js must echo a non-empty dispatchToken on every TS-path stepDone',
      );
      assert.equal(
        new Set(reportedSteps.map(({ dispatchToken }) => dispatchToken)).size,
        reportedSteps.length,
        'each ready issuance must carry its own dispatchToken',
      );
      assert.deepEqual(reportedGates.map(({ outcome }) => outcome), ['revise', 'approve']);
      assert.ok(
        reportedGates.every(({ gateToken, auditGateToken }) => (
          typeof gateToken === 'string' && gateToken.length > 0 && gateToken === auditGateToken
        )),
        'each gateResolve must echo the gateToken discovered on that waiting audit entry',
      );
      assert.notEqual(reportedGates[0].gateToken, reportedGates[1].gateToken);
    } finally {
      if (previousStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
      else process.env.STRATUM_STATE_ROOT = previousStateRoot;
      if (previousComposePort === undefined) delete process.env.COMPOSE_PORT;
      else process.env.COMPOSE_PORT = previousComposePort;
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('the client transmits dispatchToken and the engine rejects a superseded issuance', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-dispatch-token-wire-'));
    const client = new StratumMcpClient();
    const spec = {
      version: 1,
      contracts: { Result: { value: 'string' } },
      flows: {
        entry: 'main',
        main: {
          input: { name: 'string' },
          output: { from: '${work.output}', contract: 'Result' },
          steps: [{ id: 'work', do: 'work ${input.name}', out: 'Result', attempts: 2 }],
        },
      },
    };

    try {
      await connectTsClient(client, stateRoot);
      const planned = await client.plan(spec, 'main', { name: 'Ada' });
      const flowId = planned.runId;
      const first = planned.ready[0];
      const retried = await client.stepDone(
        flowId,
        'work',
        { failure: 'retry' },
        first.dispatchToken,
      );
      const current = retried.ready[0];
      assert.notEqual(current.dispatchToken, first.dispatchToken);

      await assert.rejects(
        client.stepDone(
          flowId,
          'work',
          { output: { value: 'stale' } },
          first.dispatchToken,
        ),
        /superseded issuance/,
      );
      const accepted = await client.stepDone(
        flowId,
        'work',
        { output: { value: 'fresh' } },
        current.dispatchToken,
      );
      assert.equal(accepted.status, 'completed');
    } finally {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('the engine rejects a missing dispatchToken for an ordinary step id', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-missing-dispatch-token-'));
    const client = new StratumMcpClient();
    const spec = {
      version: 1,
      contracts: { Result: { value: 'string' } },
      flows: {
        entry: 'main',
        main: {
          input: { name: 'string' },
          output: { from: '${work.output}', contract: 'Result' },
          steps: [{ id: 'work', do: 'work ${input.name}', out: 'Result' }],
        },
      },
    };

    try {
      await connectTsClient(client, stateRoot);
      const planned = await client.plan(spec, 'main', { name: 'Ada' });
      await assert.rejects(
        client.stepDone(planned.runId, 'work', { output: { value: 'missing echo' } }),
        /stratum_step_done\.request\.dispatchToken is required/,
      );
    } finally {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('the client transmits gateToken and the engine rejects a prior gate round', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-gate-token-wire-'));
    const client = new StratumMcpClient();

    try {
      await connectTsClient(client, stateRoot);
      const planned = await client.plan(GATE_SPEC, 'main', { name: 'Ada' });
      const flowId = planned.runId;
      const first = planned.ready[0];
      await client.stepDone(flowId, 'work', { output: { value: 'one' } }, first.dispatchToken);
      const firstGateToken = (await client.audit(flowId)).steps.review.gateToken;
      const revised = await client.gateResolve(flowId, 'review', 'revise', 'rework', 'human', firstGateToken);

      const second = revised.ready[0];
      await client.stepDone(flowId, 'work', { output: { value: 'two' } }, second.dispatchToken);
      const secondGateToken = (await client.audit(flowId)).steps.review.gateToken;
      assert.notEqual(secondGateToken, firstGateToken);

      await assert.rejects(
        client.gateResolve(flowId, 'review', 'approve', 'late decision', 'human', firstGateToken),
        /superseded gate round/,
      );
      const accepted = await client.gateResolve(
        flowId,
        'review',
        'approve',
        'current decision',
        'human',
        secondGateToken,
      );
      assert.equal(accepted.status, 'ready');
      assert.equal(accepted.ready[0].id, 'finish');
    } finally {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('the client prototype exposes no legacy parallel lifecycle surface', () => {
    const methods = Object.getOwnPropertyNames(StratumMcpClient.prototype)
      .filter((name) => name.startsWith('parallel'));
    assert.deepEqual(methods, []);
  });

  test('TS connection does not perform advertised-tool discovery', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-no-discovery-'));
    const client = new StratumMcpClient();
    const originalListTools = Client.prototype.listTools;
    let discoveryCalls = 0;
    Client.prototype.listTools = async () => {
      discoveryCalls += 1;
      throw new Error('tool discovery must be dead');
    };

    try {
      await connectTsClient(client, stateRoot);
      assert.equal(discoveryCalls, 0);
    } finally {
      Client.prototype.listTools = originalListTools;
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
