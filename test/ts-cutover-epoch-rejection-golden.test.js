/**
 * Flag-day negative contract: the strict TS MCP surface rejects the retired
 * `epoch` request field. Issuance fencing is exclusively token-based.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const SPEC = {
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

test('stratum_step_done rejects the retired epoch request field', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-epoch-rejection-'));
  const transport = new StdioClientTransport({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN],
    env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'compose-epoch-negative', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const planned = await client.callTool({
      name: 'stratum_plan',
      arguments: { spec: SPEC, input: { name: 'Ada' } },
    });
    const payload = planned.structuredContent;
    const ready = payload.ready[0];

    await assert.rejects(
      client.callTool({
        name: 'stratum_step_done',
        arguments: {
          runId: payload.runId,
          stepId: 'work',
          result: { output: { value: 'done' } },
          dispatchToken: ready.dispatchToken,
          epoch: ready.epoch,
        },
      }),
      /stratum_step_done\.request\.epoch is undeclared/,
    );
  } finally {
    await client.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
