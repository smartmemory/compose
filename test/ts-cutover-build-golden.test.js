/**
 * TS-cutover acceptance test for lib/build.js's simple (non-parallel) path.
 *
 * The Stratum workflow is real and runs through the TS MCP bin with isolated
 * state. Only agent inference is stubbed, at the same connector-factory seam
 * used by the existing build integration tests.
 *
 * RED until build.js consumes TS-native dispatches:
 *   { status: ready|running|completed, runId, ready: [{ id }] }
 * instead of Python dispatch vocabulary:
 *   { status: execute_step|await_gate|complete, flow_id, step_id }.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.js';
import { installFactoryShim } from '../lib/connector-factory-shim.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

const TS_MCP_BIN = '/Users/ruze/reg/my/forge/stratum/ts/src/mcp/bin.mjs';

const SIMPLE_BUILD_SPEC = `
version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${work.output}
      contract: Result
    steps:
      - id: work
        do: "build \${input.description}"
        out: Result
`;

const SIDE_EFFECT_BUILD_SPEC = `
version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${finish.output}
      contract: Result
    steps:
      - id: side_effect
        do: "record \${input.description}"
      - id: finish
        after: [side_effect]
        set:
          value: input.description
        out: Result
`;

const FAILING_BUILD_SPEC = `
version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${work.output}
      contract: Result
    steps:
      - id: work
        do: "build \${input.description}"
        out: Result
        attempts: 2
`;

const POINTER_BUILD_SPEC = `
version: 1
contracts:
  Result:
    value: string
flows:
  entry: delivery
  delivery:
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${work.output}
      contract: Result
    steps:
      - id: work
        do: "deliver \${input.description}"
        out: Result
`;

function stubAgentFactory(onRun, output = { value: 'built' }) {
  return function factory() {
    return {
      async *run() {
        onRun();
        yield { type: 'assistant', content: JSON.stringify(output) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

describe('build.js consumes TS-native Stratum responses', () => {
  test('simple build dispatches one agent step and completes over the TS engine', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-build-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-'));
    const client = new StratumMcpClient();
    let agentRuns = 0;

    try {
      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'TS-BUILD-1'), { recursive: true });
      await writeFile(
        join(workspace, '.compose', 'compose.json'),
        JSON.stringify({ version: 2, capabilities: { stratum: true } }),
      );
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), SIMPLE_BUILD_SPEC);
      await writeFile(
        join(workspace, 'docs', 'features', 'TS-BUILD-1', 'description.md'),
        '# TS build cutover\n',
      );

      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      installFactoryShim(client, stubAgentFactory(() => { agentRuns += 1; }), workspace);

      await runBuild('TS-BUILD-1', {
        cwd: workspace,
        stratum: client,
        template: 'build',
        skipTriage: true,
        description: 'the TS cutover',
      });

      assert.equal(
        agentRuns,
        1,
        'build.js must consume the TS ready dispatch and run its single agent step',
      );

      const active = JSON.parse(
        await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
      );
      assert.equal(active.status, 'complete', 'the simple TS-backed build must complete');
      assert.ok(active.flowId, 'the TS runId must be persisted as the active build flowId');
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('a side-effect step with no out contract completes without retrying', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-build-no-out-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-no-out-'));
    const client = new StratumMcpClient();
    let agentRuns = 0;

    try {
      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'TS-BUILD-NO-OUT'), { recursive: true });
      await writeFile(
        join(workspace, '.compose', 'compose.json'),
        JSON.stringify({ version: 2, capabilities: { stratum: true } }),
      );
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), SIDE_EFFECT_BUILD_SPEC);
      await writeFile(
        join(workspace, 'docs', 'features', 'TS-BUILD-NO-OUT', 'description.md'),
        '# TS no-out cutover\n',
      );

      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      installFactoryShim(client, stubAgentFactory(() => { agentRuns += 1; }), workspace);

      await runBuild('TS-BUILD-NO-OUT', {
        cwd: workspace,
        stratum: client,
        template: 'build',
        skipTriage: true,
        description: 'the side effect',
      });

      assert.equal(agentRuns, 1, 'a no-out side-effect step must not fail and retry');
      const active = JSON.parse(
        await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
      );
      assert.equal(active.status, 'complete', 'the no-out TS-backed build must complete');
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('a TS flow that exhausts contract retries terminalizes active build state as failed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-build-failed-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-failed-'));
    const client = new StratumMcpClient();
    let agentRuns = 0;

    try {
      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'TS-BUILD-FAILED'), { recursive: true });
      await writeFile(
        join(workspace, '.compose', 'compose.json'),
        JSON.stringify({ version: 2, capabilities: { stratum: true } }),
      );
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), FAILING_BUILD_SPEC);
      await writeFile(
        join(workspace, 'docs', 'features', 'TS-BUILD-FAILED', 'description.md'),
        '# TS failed cutover\n',
      );

      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      installFactoryShim(
        client,
        stubAgentFactory(() => { agentRuns += 1; }, { wrong: true }),
        workspace,
      );

      await runBuild('TS-BUILD-FAILED', {
        cwd: workspace,
        stratum: client,
        template: 'build',
        skipTriage: true,
        description: 'the failing cutover',
      });

      assert.equal(agentRuns, 2, 'the TS engine must exhaust both declared attempts');
      const active = JSON.parse(
        await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
      );
      assert.equal(active.status, 'failed', 'a failed TS flow must not remain running or complete');
      assert.match(
        active.failureReason,
        /Required|contract/i,
        'the TS engine failure reason must be persisted on the terminal active build',
      );
      assert.equal(typeof active.completedAt, 'string', 'failed active build state must be terminalized');
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('the flows.entry pointer resolves an out contract when the template name differs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-build-pointer-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-pointer-'));
    const client = new StratumMcpClient();
    let agentRuns = 0;

    try {
      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'TS-BUILD-POINTER'), { recursive: true });
      await writeFile(
        join(workspace, '.compose', 'compose.json'),
        JSON.stringify({ version: 2, capabilities: { stratum: true } }),
      );
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), POINTER_BUILD_SPEC);
      await writeFile(
        join(workspace, 'docs', 'features', 'TS-BUILD-POINTER', 'description.md'),
        '# TS entry-pointer cutover\n',
      );

      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      installFactoryShim(client, stubAgentFactory(() => { agentRuns += 1; }), workspace);

      await runBuild('TS-BUILD-POINTER', {
        cwd: workspace,
        stratum: client,
        template: 'build',
        skipTriage: true,
        description: 'the entry pointer',
      });

      assert.equal(agentRuns, 1, 'the entry flow out contract must normalize on the first attempt');
      const active = JSON.parse(
        await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
      );
      assert.equal(active.status, 'complete', 'the pointer-resolved TS-backed build must complete');
      assert.equal(active.pipeline, 'delivery', 'active build state must record the executed entry flow');
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
