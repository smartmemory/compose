/**
 * Phase 2 dispatch ownership and context capture.
 */

process.env.NODE_ENV = 'test';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { StratumMcpClient } = await import('../lib/stratum-mcp-client.js');
const { runLocalClaudeAgent } = await import('../lib/local-claude-connector.js');
const { runAndNormalize, AgentError } = await import('../lib/result-normalizer.js');
const { judge } = await import('../lib/experiment-judge.js');
const { readEvents, DISPATCH_LEDGER_RELATIVE_PATH } = await import('../lib/dispatch-ledger.js');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    try { chmodSync(join(dir, '.compose'), 0o700); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function makeClient(responses) {
  const calls = [];
  const client = new StratumMcpClient();
  Object.defineProperty(client, '_testClient', {
    configurable: true,
    value: {
      async callTool({ name, arguments: args }) {
        calls.push({ name, args });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return {
          content: [{ type: 'text', text: JSON.stringify(next ?? {}) }],
        };
      },
    },
  });
  return { client, calls };
}

function successQuery({
  text = '{}',
  model = 'claude-returned',
  inputTokens = 3,
  outputTokens = 2,
  costUsd = 0.02,
  durationMs = 7,
} = {}) {
  return async function* query() {
    if (model !== null) yield { type: 'system', subtype: 'init', model };
    yield {
      type: 'result',
      subtype: 'success',
      result: text,
      total_cost_usd: costUsd,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      duration_ms: durationMs,
    };
  };
}

function assertHiddenCarrier(value, expected = undefined) {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'dispatchId');
  assert.ok(descriptor, 'dispatchId carrier must exist');
  assert.equal(descriptor.enumerable, false);
  assert.match(descriptor.value, /^[0-9a-f-]{36}$/i);
  if (expected !== undefined) assert.equal(descriptor.value, expected);
  assert.equal(Object.keys(value).includes('dispatchId'), false);
}

describe('connector-owned dispatch capture', () => {
  test('agentRun records exactly one event and keeps intended/executed effort distinct', async () => {
    const project = tempDir('dispatch-project-');
    const worktree = tempDir('dispatch-worktree-');
    try {
      const { client, calls } = makeClient([{
        text: 'ok',
        usage: { tokens: 12, usd: 0.5, ms: 9 },
        telemetry: { model: 'claude-executed', effort: 'high', durationMs: 8 },
      }]);
      const result = await client.agentRun('claude', 'prompt', {
        cwd: worktree,
        effort: 'medium',
        telemetry: {
          project_cwd: project,
          site: 'build-step',
          build_id: 'build-1',
          feature_code: 'COMP-X',
          step_id: 'execute',
          attempt: 2,
          effort_intended: 'low',
        },
      });

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, { agent: 'claude', prompt: 'prompt', cwd: worktree });
      assertHiddenCarrier(result);
      const rows = readEvents(project);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].dispatch_id, result.dispatchId);
      assert.equal(rows[0].site, 'build-step');
      assert.equal(rows[0].effort_intended, 'low');
      assert.equal(rows[0].effort_executed, 'high');
      assert.equal(rows[0].tokens_in, null);
      assert.equal(rows[0].tokens_out, null);
      assert.equal(rows[0].tokens_total, 12);
      assert.equal(rows[0].usd, 0.5);
      assert.equal(rows[0].duration_ms, 9);
      assert.equal(existsSync(join(worktree, DISPATCH_LEDGER_RELATIVE_PATH)), false);
    } finally {
      cleanup(project, worktree);
    }
  });

  test('runAgentText remains a primitive string and records one dispatch', async () => {
    const project = tempDir('dispatch-text-');
    try {
      const { client, calls } = makeClient([{ text: 'plain text' }]);
      const result = await client.runAgentText('codex', 'prompt', {
        cwd: project,
        telemetry: { project_cwd: project, site: 'gate-qa' },
      });
      assert.equal(result, 'plain text');
      assert.equal(typeof result, 'string');
      assert.equal(calls.length, 1);
      const rows = readEvents(project);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].site, 'gate-qa');
      assert.equal(rows[0].agent, 'codex');
    } finally {
      cleanup(project);
    }
  });

  test('blocked and thrown Stratum calls record valid null-usage rows and preserve errors', async () => {
    const project = tempDir('dispatch-error-');
    try {
      const original = new Error('mcp disconnected');
      const { client } = makeClient([
        { status: 'budget_exhausted', text: '' },
        original,
      ]);
      const blocked = await client.agentRun('claude', 'blocked', {
        telemetry: { project_cwd: project, site: 'build-step' },
      });
      assertHiddenCarrier(blocked);

      let thrown;
      try {
        await client.agentRun('claude', 'error', {
          telemetry: { project_cwd: project, site: 'build-step' },
        });
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown, original);
      assertHiddenCarrier(thrown);

      const rows = readEvents(project);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].outcome, 'blocked');
      assert.equal(rows[1].outcome, 'error');
      for (const row of rows) {
        assert.equal(row.tokens_in, null);
        assert.equal(row.tokens_out, null);
        assert.equal(row.tokens_total, null);
        assert.equal(row.usd, null);
      }
    } finally {
      cleanup(project);
    }
  });

  test('local Claude success and failure each record one event with returned-only model/usage', async () => {
    const project = tempDir('dispatch-local-');
    const worktree = tempDir('dispatch-local-worktree-');
    try {
      const success = await runLocalClaudeAgent('prompt', {
        cwd: worktree,
        model: 'requested-model',
        telemetry: {
          project_cwd: project,
          site: 'consumer',
          effort_intended: 'medium',
        },
        query: successQuery({ model: 'returned-model' }),
      });
      assertHiddenCarrier(success);

      const original = new Error('sdk transport failed');
      const failingQuery = async function* failingQuery() { throw original; };
      let thrown;
      try {
        await runLocalClaudeAgent('prompt', {
          telemetry: { project_cwd: project, site: 'consumer' },
          query: failingQuery,
        });
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown, original);
      assertHiddenCarrier(thrown);

      const rows = readEvents(project);
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => [row.outcome, row.model, row.tokens_in, row.tokens_out, row.tokens_total]),
        [
          ['ok', 'returned-model', 3, 2, 5],
          ['error', null, null, null, null],
        ],
      );
      assert.equal(rows[0].effort_intended, 'medium');
      assert.equal(rows[0].effort_executed, null);
      assert.equal(rows[1].effort_executed, null);
    } finally {
      cleanup(project, worktree);
    }
  });

  test('missing site is recorded as unattributed', async () => {
    const project = tempDir('dispatch-unattributed-');
    try {
      const { client } = makeClient([{ text: 'ok' }]);
      await client.agentRun('claude', 'prompt', {
        telemetry: { project_cwd: project },
      });
      assert.equal(readEvents(project)[0].site, 'unattributed');
    } finally {
      cleanup(project);
    }
  });
});

describe('normalizer and explicit call-site context', () => {
  test('review repair records one primary and one repair dispatch with both carriers returned', async () => {
    const project = tempDir('dispatch-repair-');
    try {
      const repaired = JSON.stringify({ summary: 'fixed', findings: [] });
      const { client } = makeClient([
        { text: 'not json', telemetry: { model: 'm1', effort: 'low' } },
        { text: repaired, telemetry: { model: 'm1', effort: 'low' } },
      ]);
      const normalized = await runAndNormalize(null, 'review', {
        flow_id: 'flow-1',
        step_id: 'review',
        attempt: 3,
        agent: 'claude',
        output_fields: {},
      }, {
        stratum: client,
        reviewMode: true,
        profile: 'claude::fast',
        telemetry: {
          project_cwd: project,
          site: 'review',
          build_id: 'build-1',
          feature_code: 'COMP-X',
        },
      });

      assert.match(normalized.dispatchIds.primary, /^[0-9a-f-]{36}$/i);
      assert.match(normalized.dispatchIds.repair, /^[0-9a-f-]{36}$/i);
      const rows = readEvents(project);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => row.site), ['review', 'review-repair']);
      assert.deepEqual(rows.map((row) => row.step_id), ['review', 'review']);
      assert.deepEqual(rows.map((row) => row.attempt), [3, 3]);
      assert.deepEqual(rows.map((row) => row.dispatch_id), [
        normalized.dispatchIds.primary,
        normalized.dispatchIds.repair,
      ]);
    } finally {
      cleanup(project);
    }
  });

  test('an unparseable repair is billed but not credited as the settling dispatch', async () => {
    const project = tempDir('dispatch-repair-unused-');
    try {
      const { client } = makeClient([
        { text: 'not json', usage: { tokens: 10, usd: 0.1 } },
        { text: 'still not json', usage: { tokens: 7, usd: 0.05 } },
      ]);
      const normalized = await runAndNormalize(null, 'review', {
        flow_id: 'flow-1',
        step_id: 'review',
        agent: 'claude',
        output_fields: {},
      }, {
        stratum: client,
        reviewMode: true,
        profile: 'claude::fast',
        telemetry: {
          project_cwd: project,
          site: 'review',
          build_id: 'build-1',
          feature_code: 'COMP-X',
        },
      });

      assert.match(normalized.dispatchIds.primary, /^[0-9a-f-]{36}$/i);
      assert.equal(normalized.dispatchIds.repair, null);
      const rows = readEvents(project);
      assert.equal(rows.filter((row) => row.kind === 'dispatch').length, 2);
      assert.equal(normalized.usage.output_tokens, 17);
      assert.ok(Math.abs(normalized.usage.cost_usd - 0.15) < 1e-9);
    } finally {
      cleanup(project);
    }
  });

  test('a repair dispatch that throws is not credited as the settling dispatch', async () => {
    const project = tempDir('dispatch-repair-failed-');
    try {
      const { client } = makeClient([
        { text: 'not json', usage: { tokens: 4, usd: 0.02 } },
        new Error('repair transport failed'),
      ]);
      const normalized = await runAndNormalize(null, 'review', {
        flow_id: 'flow-1',
        step_id: 'review',
        agent: 'claude',
        output_fields: {},
      }, {
        stratum: client,
        reviewMode: true,
        profile: 'claude::fast',
        telemetry: {
          project_cwd: project,
          site: 'review',
          build_id: 'build-1',
          feature_code: 'COMP-X',
        },
      });

      assert.match(normalized.dispatchIds.primary, /^[0-9a-f-]{36}$/i);
      assert.equal(normalized.dispatchIds.repair, null);
      assert.ok(normalized.result, 'text-mode fallback still yields a review result');
      const rows = readEvents(project);
      assert.deepEqual(
        rows.filter((row) => row.kind === 'dispatch').map((row) => row.outcome),
        ['ok', 'error'],
      );
    } finally {
      cleanup(project);
    }
  });

  test('normalizer copies a connector carrier through AgentError replacement', async () => {
    const underlying = new Error('connector failed');
    Object.defineProperty(underlying, 'dispatchId', { value: 'dispatch-original', enumerable: false });
    const stratum = {
      onEvent() { return () => {}; },
      async agentRun() { throw underlying; },
      async cancelAgentRun() {},
    };
    await assert.rejects(
      runAndNormalize(null, 'prompt', { step_id: 's', output_fields: {} }, { stratum }),
      (error) => {
        assert.ok(error instanceof AgentError);
        assert.equal(error.dispatchId, 'dispatch-original');
        assert.equal(Object.keys(error).includes('dispatchId'), false);
        return true;
      },
    );
  });

  test('judge records exactly one dispatch at site judge', async () => {
    const project = tempDir('dispatch-judge-');
    try {
      const payload = JSON.stringify({
        correctness: 8,
        clarity: 8,
        idiomaticity: 8,
        rationale: 'good',
      });
      const { client } = makeClient([{ text: `\`\`\`json\n${payload}\n\`\`\`` }]);
      const result = await judge({
        diff: 'diff',
        goal: 'goal',
        judgeModel: 'claude::fast',
        stratum: client,
        cwd: project,
      });
      assert.equal(result.correctness, 8);
      const rows = readEvents(project);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].site, 'judge');
    } finally {
      cleanup(project);
    }
  });
});

describe('capture is fail-open', () => {
  test('an EACCES ledger path preserves connector success values and original errors', async () => {
    const project = tempDir('dispatch-eacces-');
    const composeDir = join(project, '.compose');
    mkdirSync(composeDir);
    chmodSync(composeDir, 0o400);
    try {
      const { client } = makeClient([{ text: 'ok' }]);
      const stratumResult = await client.agentRun('claude', 'prompt', {
        telemetry: { project_cwd: project, site: 'build-step' },
      });
      assert.equal(stratumResult.text, 'ok');

      const original = new Error('original sdk error');
      const failingQuery = async function* failingQuery() { throw original; };
      await assert.rejects(
        runLocalClaudeAgent('prompt', {
          telemetry: { project_cwd: project, site: 'consumer' },
          query: failingQuery,
        }),
        (error) => error === original,
      );
    } finally {
      cleanup(project);
    }
  });
});
