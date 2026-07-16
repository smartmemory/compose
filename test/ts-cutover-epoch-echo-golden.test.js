/**
 * Golden acceptance tests for Phase-1 step_done epoch fencing
 * (STRAT-TS-FANOUT-CONSUMER design, fencing scope amendment 2026-07-15).
 *
 * The TS engine's stepDone rejects a report whose echoed epoch is superseded,
 * but only when the client echoes one. These tests lock the compose half of
 * the fence: build.js must thread every dispatched ready entry's epoch into
 * stepDone, and StratumMcpClient must transmit it on the wire.
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

import { runBuild } from '../lib/build.js';
import { installFactoryShim } from '../lib/connector-factory-shim.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

const TS_MCP_BIN = '/Users/ruze/reg/my/forge/stratum/ts/src/mcp/bin.mjs';

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

function stubAgentFactory(onRun) {
  return function factory() {
    return {
      async *run(prompt) {
        onRun(prompt);
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

describe('Phase-1 epoch fencing over the TS engine', () => {
  test('build.js echoes each ready entry epoch through a revise round', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-epoch-echo-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-epoch-'));
    const client = new StratumMcpClient();
    const reported = [];
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
      await mkdir(join(workspace, 'docs', 'features', 'TS-EPOCH-ECHO'), { recursive: true });
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
        join(workspace, 'docs', 'features', 'TS-EPOCH-ECHO', 'description.md'),
        '# TS epoch echo\n',
      );

      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      // Record what build.js hands the wire layer, then delegate for real.
      const realStepDone = client.stepDone.bind(client);
      client.stepDone = async (flowId, stepId, result, epoch, dispatchToken) => {
        reported.push({ stepId, epoch });
        return realStepDone(flowId, stepId, result, epoch, dispatchToken);
      };

      installFactoryShim(client, stubAgentFactory(() => {}), workspace);

      await runBuild('TS-EPOCH-ECHO', {
        cwd: workspace,
        stratum: client,
        template: 'build',
        skipTriage: true,
        description: 'the epoch echo cutover',
        gateOpts: { input: io.input, output: io.output },
      });

      io.assertConsumed();
      // The revise bumps the epoch of EVERY descendant of the revision target
      // (engine.ts revise scope invalidation), so both the re-issued `work` and
      // the downstream `finish` are issued at epoch 1. Every report must carry
      // the engine-issued epoch of the entry it answers.
      assert.deepEqual(reported, [
        { stepId: 'work', epoch: 0 },
        { stepId: 'work', epoch: 1 },
        { stepId: 'finish', epoch: 1 },
      ], 'build.js must echo the dispatched ready entry epoch on every stepDone');
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

  test('the client transmits the epoch and the real engine fences on it', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-epoch-wire-'));
    const client = new StratumMcpClient();
    const spec = {
      version: 1,
      contracts: { Result: { value: 'string' } },
      flows: {
        entry: 'main',
        main: {
          max_rounds: 2,
          input: { name: 'string' },
          output: { from: '${build.output}', contract: 'Result' },
          steps: [
            { id: 'build', do: 'build ${input.name}', out: 'Result' },
            { id: 'review', after: ['build'], gate: { on_approve: null, on_revise: 'build', on_kill: null } },
          ],
        },
      },
    };

    try {
      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      const planned = await client.plan(spec, 'main', { name: 'Ada' });
      const flowId = planned.runId ?? planned.flow_id;
      assert.equal(planned.ready?.[0]?.epoch, 0, 'the engine issues the first entry at epoch 0');

      await client.stepDone(flowId, 'build', { output: { value: 'v1' } }, 0);
      await client.gateResolve(flowId, 'review', 'revise', 'rework');

      // The wire must carry the echo: a stale epoch is rejected by the real
      // engine, the current one is accepted.
      await assert.rejects(
        client.stepDone(flowId, 'build', { output: { value: 'stale' } }, 0),
        /superseded epoch/,
      );
      const accepted = await client.stepDone(flowId, 'build', { output: { value: 'v2' } }, 1);
      assert.equal(accepted.status, 'running', 'the current-epoch report must be accepted');
    } finally {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
