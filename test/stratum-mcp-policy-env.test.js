/**
 * stratum-mcp-policy-env.test.js — GOV-COMPOSE-SEAM-1 step 0 (`plumbing`).
 *
 * Two things under test:
 *
 *  1. `connect()` injects the SmartMemory coordinates resolved from
 *     `.compose/compose.json` into the SPAWN env. It must be the spawn env,
 *     not `process.env` mutated later: Stratum's policy client reads env once,
 *     at construction (policy/smartmemory_client.ts).
 *  2. A workspace with the coupling OFF spawns a byte-identical env to before
 *     the feature existed. The fail-open ingest contract says an unconfigured
 *     project behaves as if none of this shipped.
 *
 * `plan()`'s policy passthrough is covered here too, mostly to pin the arg
 * NAME: the engine wants `policy_step_selector`, and `step_selector` (the field
 * inside a bundle rule) silently does nothing.
 */

process.env.NODE_ENV = 'test';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

const KEY_VAR = 'SMARTMEMORY_TEST_POLICY_KEY';

function makeProject(smartmemoryBlock) {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-policy-env-'));
  mkdirSync(join(dir, '.compose'), { recursive: true });
  writeFileSync(
    join(dir, '.compose', 'compose.json'),
    JSON.stringify({ workspaceId: 'forge', ...(smartmemoryBlock ? { smartmemory: smartmemoryBlock } : {}) }),
  );
  return dir;
}

const ENABLED = {
  enabled: true,
  baseUrl: 'https://api.example.test',
  apiKeyEnv: KEY_VAR,
  workspaceId: 'team_26f0bbe60a4c',
};

/**
 * The env a spawn WOULD carry, for a given project dir.
 *
 * `connect()` assembles `{...process.env, ...resolveStratumPolicyEnv(cwd)}` and
 * hands it straight to StdioClientTransport, which cannot be intercepted without
 * really spawning an MCP peer. So the contribution is asserted through the same
 * resolver `connect()` uses, and the wiring itself is pinned at source level by
 * the third test below. Both halves are needed: the resolver could be correct
 * and unwired, or wired and resolving from the wrong directory.
 */
async function spawnEnvFor(cwd) {
  const { resolveStratumPolicyEnv } = await import('../lib/smartmemory-config.js');
  return { ...process.env, ...resolveStratumPolicyEnv(cwd) };
}

describe('GOV-COMPOSE-SEAM-1 step 0: policy env injection', () => {
  it('an enabled workspace contributes all three vars to the spawn env', async () => {
    const dir = makeProject(ENABLED);
    process.env[KEY_VAR] = 'sk-live-test';
    try {
      const env = await spawnEnvFor(dir);
      assert.equal(env.SMARTMEMORY_API_URL, 'https://api.example.test');
      assert.equal(env.SMARTMEMORY_API_KEY, 'sk-live-test');
      assert.equal(env.SMARTMEMORY_WORKSPACE_ID, 'team_26f0bbe60a4c');
    } finally {
      delete process.env[KEY_VAR];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a workspace with the coupling off adds nothing to the spawn env', async () => {
    const dir = makeProject(null);
    try {
      const env = await spawnEnvFor(dir);
      assert.equal(env.SMARTMEMORY_API_URL, undefined);
      assert.equal(env.SMARTMEMORY_API_KEY, undefined);
      assert.equal(env.SMARTMEMORY_WORKSPACE_ID, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('connect() spreads the resolver into transportOpts.env', async () => {
    // Source-level pin: the wiring is a two-line spread inside connect(), and a
    // regression here (dropping the spread, or resolving from the wrong cwd)
    // would be invisible to the behavioural tests above.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../lib/stratum-mcp-client.js', import.meta.url), 'utf8');
    assert.match(src, /const policyEnv = resolveStratumPolicyEnv\(/,
      'connect() must resolve the policy env from config');
    assert.match(src, /transportOpts\.env = \{ \.\.\.\(opts\.env \?\? \{ \.\.\.process\.env \}\), \.\.\.policyEnv \}/,
      'connect() must spread policyEnv into the spawn env');
  });
});

describe('GOV-COMPOSE-SEAM-1 step 0: plan() policy passthrough', () => {
  function mockClient(response) {
    const calls = [];
    return {
      calls,
      mock: {
        callTool: async ({ name, arguments: args }) => {
          calls.push({ name, args });
          return { content: [{ type: 'text', text: JSON.stringify(response) }] };
        },
      },
    };
  }

  const SPEC = { flows: { build: { steps: [{ id: 's1', do: 'x' }] } } };

  it('omits both policy args when the caller passes none', async () => {
    const { calls, mock } = mockClient({ status: 'ready', runId: 'r1' });
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });
    await client.plan(SPEC, 'build', {});
    assert.equal('policy_bundle' in calls[0].args, false);
    assert.equal('policy_step_selector' in calls[0].args, false);
  });

  it('forwards policy_bundle and policy_step_selector under the engine arg names', async () => {
    const { calls, mock } = mockClient({ status: 'ready', runId: 'r1' });
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });
    const bundle = { bundle_id: 'b1', rules: [] };
    await client.plan(SPEC, 'build', {}, { policyBundle: bundle, policyStepSelector: 'review_*' });

    assert.deepEqual(calls[0].args.policy_bundle, bundle);
    assert.equal(calls[0].args.policy_step_selector, 'review_*');
    // The engine ignores `step_selector` at the call level — sending it instead
    // would bind every rule at its own selector and blow up the judge budget.
    assert.equal('step_selector' in calls[0].args, false);
  });

  it('drops an empty selector rather than sending a meaningless empty string', async () => {
    const { calls, mock } = mockClient({ status: 'ready', runId: 'r1' });
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });
    await client.plan(SPEC, 'build', {}, { policyStepSelector: '' });
    assert.equal('policy_step_selector' in calls[0].args, false);
  });
});
