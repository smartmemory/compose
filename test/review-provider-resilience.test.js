import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runLocalClaudeAgent } from '../lib/local-claude-connector.js';
import { runConsumerIssuance } from '../lib/build.js';

process.env.NODE_ENV = 'test';

const REVIEW_CLOSURE = {
  root: 'ReviewResult',
  contracts: {
    ReviewResult: {
      clean: 'boolean', summary: 'string', findings: 'array', meta: 'object',
      lenses_run: 'string[]', auto_fixes: 'array', asks: 'array',
    },
  },
};

const SUCCESS_RESULT = {
  type: 'result', subtype: 'success',
  result: JSON.stringify({ clean: true, summary: 'ok', findings: [] }),
  total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
};

const PROMPT_TOO_LONG_RESULT = {
  type: 'result', subtype: 'error_during_execution',
  errors: ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}'],
  total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 0 }, duration_ms: 2,
};

const RATE_LIMIT_RESULT = {
  type: 'result', subtype: 'error_during_execution',
  errors: ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}'],
  total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, duration_ms: 2,
};

function queryOf(result, onDispatch = () => {}) {
  return function ({ prompt }) {
    onDispatch(prompt);
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield result;
    })();
  };
}

function reviewDescriptor(overrides = {}) {
  return {
    id: 'review_lenses/0', step: 'review_lenses', flow: 'build',
    itemIndex: 0, stage: 0, generation: 1, attempt: 1, epoch: 1, dispatchToken: 'tok-1',
    agent: 'claude', do: 'TASK_SENTINEL: inspect the requested implementation',
    item: { id: 'lens-security', lens_name: 'security', lens_focus: 'auth paths', confidence_gate: 8 },
    policy: { isolation: 'none' },
    contract: REVIEW_CLOSURE,
    ...overrides,
  };
}

function progressRecorder() {
  const warnings = [];
  return {
    warnings,
    stepStart() {}, stepDone() {}, info() {}, debug() {},
    warn(message) { warnings.push(message); },
    toolUse() {}, toolSummary() {}, findings() {},
  };
}

async function driveConsumer({ descriptor, localQuery, context = {}, progress = progressRecorder() }) {
  const captured = { progress, stream: [] };
  const artifacts = {
    hooks: {},
    reconcileDescriptor: () => ({ action: 'execute', worktree: process.cwd() }),
    prepareIssuance: (_descriptor, envelope) => { captured.prepared = envelope; },
    reconcileAudit() {},
    restoreToPreStageWitness() {},
  };
  const stratum = {
    _localQuery: localQuery,
    onEvent: () => () => {},
    stepDone: async (_flowId, _stepId, envelope) => {
      captured.envelope = envelope;
      return { status: 'completed' };
    },
    audit: async () => ({}),
    agentRun: async () => ({ text: '' }),
    cancelAgentRun: async () => {},
  };
  const localSpec = {
    flows: {
      build: {
        steps: [{
          id: descriptor.step,
          fanout: { steps: [{ agent: 'claude', do: 'x', out: 'ReviewResult' }] },
        }],
      },
    },
  };

  await runConsumerIssuance({
    descriptor,
    flowId: 'flow-1',
    stratum,
    artifacts,
    localSpec,
    context: { cwd: process.cwd(), ...context },
    progress,
    streamWriter: { write(event) { captured.stream.push(event); } },
  });
  return captured;
}

describe('provider failure classification', () => {
  it('classifies a real-shaped prompt-limit result and preserves the original provider message', async () => {
    let thrown;
    try {
      await runLocalClaudeAgent('oversized', { query: queryOf(PROMPT_TOO_LONG_RESULT) });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown);
    assert.equal(thrown.providerFailureClass, 'prompt-too-long');
    assert.match(thrown.message, /API Error: 400/);
    assert.match(thrown.message, /Prompt is too long/);
  });
});

describe('deterministic prompt-limit retry policy', () => {
  it('never resends the same oversized prompt after a prompt-too-long rejection', async () => {
    const dispatched = [];
    const first = await driveConsumer({
      descriptor: reviewDescriptor(),
      localQuery: queryOf(PROMPT_TOO_LONG_RESULT, prompt => dispatched.push(prompt)),
    });
    assert.match(first.envelope.failure, /Prompt is too long/);
    assert.match(first.envelope.failure, /provider-failure:prompt-too-long/);

    const second = await driveConsumer({
      descriptor: reviewDescriptor({
        attempt: 2,
        dispatchToken: 'tok-2',
        previousFailure: { attempt: 1, reason: first.envelope.failure },
      }),
      localQuery: queryOf(SUCCESS_RESULT, prompt => dispatched.push(prompt)),
    });

    assert.equal(dispatched.length, 1, 'the provider must not see the unchanged deterministic retry');
    assert.match(second.envelope.failure, /retry suppressed/i);
    assert.match(second.envelope.failure, /Prompt is too long/);
  });
});

describe('transient rate-limit retry policy', () => {
  it('waits before retrying a real-shaped rate-limit rejection', async () => {
    const order = [];
    const first = await driveConsumer({
      descriptor: reviewDescriptor(),
      localQuery: queryOf(RATE_LIMIT_RESULT, () => order.push('dispatch-1')),
    });
    assert.match(first.envelope.failure, /provider-failure:rate-limited/);

    const second = await driveConsumer({
      descriptor: reviewDescriptor({
        attempt: 2,
        dispatchToken: 'tok-2',
        previousFailure: { attempt: 1, reason: first.envelope.failure },
      }),
      context: {
        reviewRetryPolicy: {
          baseMs: 25,
          maxMs: 25,
          sleep: async (ms) => { order.push(`wait-${ms}`); },
        },
      },
      localQuery: queryOf(SUCCESS_RESULT, () => order.push('dispatch-2')),
    });

    assert.deepEqual(order, ['dispatch-1', 'wait-25', 'dispatch-2']);
    assert.equal(second.envelope.output.clean, true);
    assert.ok(second.progress.warnings.some(message => /waiting 25ms/i.test(message)));
  });
});

describe('review prompt size budget', () => {
  it('drops ambient context before dispatch without cutting the task, contract, or schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compose-review-budget-'));
    const contextDir = join(root, 'context');
    await mkdir(contextDir);
    await writeFile(join(contextDir, 'bulk.md'), `AMBIENT_SENTINEL\n${'x'.repeat(20_000)}`);
    const dispatched = [];

    try {
      const result = await driveConsumer({
        descriptor: reviewDescriptor(),
        context: { contextDir, reviewPromptBudgetChars: 8_000 },
        localQuery: queryOf(SUCCESS_RESULT, prompt => dispatched.push(prompt)),
      });

      assert.equal(dispatched.length, 1);
      assert.ok(dispatched[0].length <= 8_000, `prompt length was ${dispatched[0].length}`);
      assert.doesNotMatch(dispatched[0], /AMBIENT_SENTINEL/);
      assert.match(dispatched[0], /TASK_SENTINEL/);
      assert.match(dispatched[0], /Severity Vocabulary/);
      assert.match(dispatched[0], /"clean"/);
      assert.match(dispatched[0], /The JSON block must be the last thing/);
      assert.ok(result.progress.warnings.some(message => /dropped.*docs\/context/i.test(message)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails locally before dispatch when required prompt content alone exceeds the budget', async () => {
    let dispatches = 0;
    const result = await driveConsumer({
      descriptor: reviewDescriptor({ do: `TASK_SENTINEL:${'y'.repeat(8_000)}` }),
      context: { reviewPromptBudgetChars: 1_000 },
      localQuery: queryOf(SUCCESS_RESULT, () => { dispatches += 1; }),
    });

    assert.equal(dispatches, 0);
    assert.match(result.envelope.failure, /prompt budget/i);
    assert.match(result.envelope.failure, /before provider dispatch/i);
  });
});
