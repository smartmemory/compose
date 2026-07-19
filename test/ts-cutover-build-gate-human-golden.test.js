/**
 * Golden acceptance tests for lib/build.js's human TS-native gate lifecycle.
 *
 * The Stratum workflow is real and runs through the TS MCP bin with isolated
 * state. Agent inference alone is stubbed at the connector-factory seam.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

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
  const chunks = [];
  let next = 0;
  let rendered = '';

  output.on('data', (chunk) => {
    const text = chunk.toString();
    chunks.push(text);
    rendered += text;

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
    text: () => chunks.join(''),
    assertConsumed: () => assert.equal(next, script.length, 'all scripted gate input must be consumed'),
  };
}

async function runScenario(featureCode, script) {
  const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-build-gate-human-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-state-gate-human-'));
  const client = new StratumMcpClient();
  const agentSteps = [];
  const io = scriptedGateIO(script);
  const previousStateRoot = process.env.STRATUM_STATE_ROOT;
  const previousComposePort = process.env.COMPOSE_PORT;

  try {
    process.env.STRATUM_STATE_ROOT = stateRoot;
    process.env.COMPOSE_PORT = '65534';

    await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
    await mkdir(join(workspace, 'pipelines'), { recursive: true });
    await mkdir(join(workspace, 'docs', 'features', featureCode), { recursive: true });
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
      join(workspace, 'docs', 'features', featureCode, 'description.md'),
      '# TS human gate cutover\n',
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

    await runBuild(featureCode, {
      cwd: workspace,
      stratum: client,
      template: 'build',
      skipTriage: true,
      description: 'the human-gated TS cutover',
      gateOpts: { input: io.input, output: io.output },
    });

    io.assertConsumed();
    const events = (await readFile(join(workspace, '.compose', 'build-stream.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const active = JSON.parse(
      await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
    );
    const vision = JSON.parse(
      await readFile(join(workspace, '.compose', 'data', 'vision-state.json'), 'utf8'),
    );

    return { active, agentSteps, events, panel: io.text(), vision };
  } finally {
    if (previousStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
    else process.env.STRATUM_STATE_ROOT = previousStateRoot;
    if (previousComposePort === undefined) delete process.env.COMPOSE_PORT;
    else process.env.COMPOSE_PORT = previousComposePort;
    await client.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
}

describe('build.js drives human gates over the TS engine', () => {
  test('revise re-enters a fresh gate, then approve completes', async () => {
    const result = await runScenario('TS-HUMAN-REVISE', [
      { prompt: '\n> ', line: 'r' },
      { prompt: 'Rationale: ', line: 'rework required' },
      { prompt: '\n> ', line: 'a' },
    ]);

    const resolved = result.events.filter(
      (event) => event.type === 'build_gate_resolved' && event.stepId === 'review',
    );
    assert.deepEqual(resolved.map((event) => event.outcome), ['revise', 'approve']);
    assert.deepEqual(result.agentSteps, ['work', 'work', 'finish']);
    assert.equal(result.active.status, 'complete');
  });

  test('kill records an aborted build instead of a hard failure', async () => {
    const result = await runScenario('TS-HUMAN-KILL', [
      { prompt: '\n> ', line: 'k' },
      { prompt: 'Rationale: ', line: 'stop this build' },
    ]);

    const resolved = result.events.find(
      (event) => event.type === 'build_gate_resolved' && event.stepId === 'review',
    );
    assert.equal(resolved?.outcome, 'kill');
    assert.equal(result.active.status, 'aborted');
    const item = result.vision.items.find(
      (candidate) => candidate.lifecycle?.featureCode === 'TS-HUMAN-KILL',
    );
    assert.equal(item?.status, 'killed');
  });

  test('prompt receives the synthesized gate routing', async () => {
    const result = await runScenario('TS-HUMAN-PROMPT', [
      { prompt: '\n> ', line: 'a' },
    ]);

    const gate = result.events.find((event) => event.type === 'build_gate');
    assert.equal(gate?.stepId, 'review');
    assert.match(result.panel, /Gate: review/);
    assert.match(result.panel, /Approve\s+→\s+finish/);
    assert.equal(result.active.status, 'complete');
  });
});
