/**
 * RED acceptance test for lib/build.js's TS-native gate lifecycle.
 *
 * The Stratum workflow is real and runs through the TS MCP bin with isolated
 * state. Agent inference alone is stubbed at the connector-factory seam.
 * The review policy is "flag", runBuild's existing non-interactive audited
 * auto-approval path.
 *
 * RED until build.js discovers a TS gate from the `running` dispatch instead
 * instead of waiting for the retired gate envelope.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

const TS_MCP_BIN = '/Users/ruze/reg/my/forge/stratum/ts/src/mcp/bin.mjs';

const GATED_BUILD_SPEC = `
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
      - id: work
        do: "build \${input.description}"
        out: Result
      - id: review
        after: [work]
        gate:
          on_approve: finish
          on_revise: null
          on_kill: null
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

describe('build.js consumes the TS-native gate lifecycle', () => {
  test('work -> review auto-approve -> finish completes over the TS engine', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-build-gate-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-gate-'));
    const client = new StratumMcpClient();
    const agentSteps = [];

    try {
      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'TS-BUILD-GATE'), { recursive: true });
      await writeFile(
        join(workspace, '.compose', 'compose.json'),
        JSON.stringify({ version: 2, capabilities: { stratum: true } }),
      );
      await writeFile(
        join(workspace, '.compose', 'data', 'settings.json'),
        JSON.stringify({ policies: { review: 'flag' } }),
      );
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), GATED_BUILD_SPEC);
      await writeFile(
        join(workspace, 'docs', 'features', 'TS-BUILD-GATE', 'description.md'),
        '# TS build gate cutover\n',
      );

      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });

      installAgentHarness(
        client,
        stubAgentFactory((prompt) => {
          const match = prompt.match(/step "([^"]+)"/);
          agentSteps.push(match?.[1] ?? 'unknown');
        }),
        workspace,
      );

      await runBuild('TS-BUILD-GATE', {
        cwd: workspace,
        stratum: client,
        template: 'build',
        skipTriage: true,
        description: 'the gated TS cutover',
      });

      assert.deepEqual(
        agentSteps,
        ['work', 'finish'],
        'build.js must run both agent steps around the review gate',
      );

      const events = (await readFile(join(workspace, '.compose', 'build-stream.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const gateResolved = events.find(
        (event) => event.type === 'build_gate_resolved' && event.stepId === 'review',
      );
      assert.ok(gateResolved, 'build.js must discover and resolve the TS review gate');
      assert.equal(gateResolved.policyMode, 'flag');
      assert.equal(gateResolved.outcome, 'approve');

      const active = JSON.parse(
        await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
      );
      assert.equal(active.status, 'complete', 'the gated TS-backed build must complete');
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
