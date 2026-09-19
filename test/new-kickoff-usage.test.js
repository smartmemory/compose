/**
 * Regression coverage for the compose-new kickoff usage envelope.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runNew } from '../lib/new.js';

function makeProject(cwd) {
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 1 }));
  mkdirSync(join(cwd, 'pipelines'), { recursive: true });
  writeFileSync(join(cwd, 'pipelines', 'new.stratum.yaml'), `
version: 1
contracts:
  KickoffResult:
    summary: string
flows:
  entry: new
  new:
    input:
      projectName: string
      intent: string
    output:
      from: "\${kickoff.output}"
      contract: KickoffResult
    steps:
      - id: kickoff
        agent: claude
        do: "Create the kickoff result"
        out: KickoffResult
`);
}

test('runNew carries kickoff token and cost usage through stepDone', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'compose-new-usage-'));
  const previousPort = process.env.COMPOSE_PORT;
  process.env.COMPOSE_PORT = '1';
  t.after(() => {
    if (previousPort === undefined) delete process.env.COMPOSE_PORT;
    else process.env.COMPOSE_PORT = previousPort;
    rmSync(cwd, { recursive: true, force: true });
  });
  makeProject(cwd);

  const stepDoneCalls = [];
  const stratum = {
    async plan() {
      return {
        status: 'ready',
        runId: 'kickoff-flow',
        ready: [{
          id: 'kickoff',
          do: 'Create the kickoff result',
          agent: 'claude',
          dispatchToken: 'kickoff-token',
        }],
      };
    },
    onEvent() { return () => {}; },
    async agentRun() {
      return {
        text: JSON.stringify({ summary: 'Kickoff complete' }),
        usage: { tokens: 15, usd: 0.42, ms: 37 },
        split: { input: 11, output: 4, cacheRead: 3, cacheCreation: 2 },
        usdSource: 'reported',
        telemetry: { model: 'claude-test', durationMs: 37 },
        dispatchId: 'dispatch-kickoff-1',
      };
    },
    async stepDone(...args) {
      stepDoneCalls.push(args);
      return { status: 'completed', runId: 'kickoff-flow', output: { summary: 'Kickoff complete' } };
    },
    async audit() { return { status: 'completed', steps: {} }; },
    async close() {},
  };

  await runNew('Build a product', { cwd, projectName: 'KICKOFF', stratum });

  assert.equal(stepDoneCalls.length, 1);
  assert.deepEqual(stepDoneCalls[0], [
    'kickoff-flow',
    'kickoff',
    {
      output: { summary: 'Kickoff complete' },
      usage: { tokens: 15, usd: 0.42, ms: 37 },
    },
    'kickoff-token',
  ]);
});
