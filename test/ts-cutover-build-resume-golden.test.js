/**
 * TS-cutover acceptance test for lib/build.js's resume path.
 *
 * The Stratum workflow is real and runs through the TS MCP bin with isolated
 * state. Only agent inference is stubbed, at the same connector-factory seam
 * used by the sibling TS-cutover build goldens.
 *
 * RED until StratumMcpClient.resume() sends the TS-native { runId } payload
 * and build.js consumes the resumed { runId, ready: [{ id }] } dispatch.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const RESUMABLE_BUILD_SPEC = `
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

function throwingAgentFactory(onRun) {
  return function factory() {
    return {
      async *run() {
        onRun();
        throw new Error('simulated interrupted agent');
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

function completingAgentFactory(onRun) {
  return function factory() {
    return {
      async *run() {
        onRun();
        yield { type: 'assistant', content: JSON.stringify({ value: 'built after resume' }) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

describe('build.js resumes a non-terminal TS-native Stratum run', () => {
  test('an interrupted build resumes the same run and completes its ready step', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-build-resume-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-resume-'));
    const firstClient = new StratumMcpClient();
    const resumeClient = new StratumMcpClient();
    let firstAgentRuns = 0;
    let resumedAgentRuns = 0;
    let resumeCalls = 0;

    try {
      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'TS-BUILD-RESUME'), { recursive: true });
      await writeFile(
        join(workspace, '.compose', 'compose.json'),
        JSON.stringify({ version: 2, capabilities: { stratum: true } }),
      );
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), RESUMABLE_BUILD_SPEC);
      await writeFile(
        join(workspace, 'docs', 'features', 'TS-BUILD-RESUME', 'description.md'),
        '# TS build resume cutover\n',
      );

      await firstClient.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      installAgentHarness(
        firstClient,
        throwingAgentFactory(() => { firstAgentRuns += 1; }),
        workspace,
      );

      await assert.rejects(
        () => runBuild('TS-BUILD-RESUME', {
          cwd: workspace,
          stratum: firstClient,
          template: 'build',
          skipTriage: true,
          description: 'the interrupted TS cutover',
        }),
        /simulated interrupted agent/,
      );
      assert.equal(firstAgentRuns, 1, 'the first build must reach and interrupt the agent step');

      const interruptedActive = JSON.parse(
        await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
      );
      const runId = interruptedActive.flowId;
      assert.ok(runId, 'the interrupted build must persist the TS runId');

      await resumeClient.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      const interruptedAudit = await resumeClient.audit(runId);
      assert.equal(interruptedAudit.status, 'running', 'the TS flow must remain non-terminal');
      assert.equal(
        interruptedAudit.steps.work?.status,
        'ready',
        'the interrupted TS step must remain ready for resume',
      );

      const realResume = resumeClient.resume.bind(resumeClient);
      resumeClient.resume = async (flowId) => {
        resumeCalls += 1;
        return realResume(flowId);
      };
      installAgentHarness(
        resumeClient,
        completingAgentFactory(() => { resumedAgentRuns += 1; }),
        workspace,
      );

      await runBuild('TS-BUILD-RESUME', {
        cwd: workspace,
        stratum: resumeClient,
        template: 'build',
        skipTriage: true,
        description: 'the interrupted TS cutover',
        resumeFlowId: runId,
      });

      assert.equal(resumeCalls, 1, 'the second build must call the real TS resume path once');
      assert.equal(resumedAgentRuns, 1, 'the resumed ready step must execute again');

      const completedActive = JSON.parse(
        await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
      );
      assert.equal(completedActive.status, 'complete', 'the resumed TS-backed build must complete');
      assert.equal(completedActive.flowId, runId, 'resume must retain the original TS runId');
    } finally {
      await firstClient.close();
      await resumeClient.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
