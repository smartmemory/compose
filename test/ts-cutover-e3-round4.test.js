/**
 * E3 cutover — round-4 review fixes (G1–G3).
 *
 * G1: scoped ordinary review steps recognized via resolved contract identity.
 * G2: consumer review items get the buildReviewPrompt operational scaffold.
 * G3: timeout/abort paths carry the failed run's billable usage.
 *
 * Run with: node --test test/ts-cutover-e3-round4.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import { resolveStepOutputContract, runConsumerIssuance } from '../lib/build.js';
import { runAndNormalize, AgentTimeoutError, AgentAbortedError } from '../lib/result-normalizer.js';

process.env.NODE_ENV = 'test';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const BUILD_SPEC = YAML.parse(readFileSync(join(REPO_ROOT, 'pipelines', 'build.stratum.yaml'), 'utf-8'));

const REVIEW_CLOSURE = {
  root: 'ReviewResult',
  contracts: {
    ReviewResult: {
      clean: 'boolean', summary: 'string', findings: 'array', meta: 'object',
      lenses_run: 'string[]', auto_fixes: 'array', asks: 'array',
    },
  },
};

// Captures the prompt + options handed to the SDK-shaped query, yields a result.
function makeCapturingQuery(resultMessage, captured = {}) {
  return function ({ prompt, options }) {
    captured.prompt = prompt;
    captured.options = options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield resultMessage;
    })();
  };
}

function stubProgress() {
  return { stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {}, toolUse() {}, toolSummary() {}, findings() {} };
}

async function driveConsumerIssuance({ descriptor, localQuery }) {
  const captured = {};
  const artifacts = {
    hooks: {},
    reconcileDescriptor: () => ({ action: 'execute', worktree: process.cwd() }),
    prepareIssuance: (_d, env) => { captured.prepared = env; },
    reconcileAudit: () => {},
    restoreToPreStageWitness: () => {},
  };
  const stratum = {
    _localQuery: localQuery,
    onEvent: () => () => {},
    stepDone: async (_flowId, _id, env) => { captured.envelope = env; return { status: 'completed' }; },
    audit: async () => ({}),
    agentRun: async () => ({ text: '' }),
    cancelAgentRun: async () => {},
  };
  const localSpec = {
    flows: { build: { steps: [{ id: descriptor.step, fanout: { steps: [{ agent: 'claude', do: 'x', out: 'ReviewResult' }] } }] } },
  };
  await runConsumerIssuance({
    descriptor, flowId: 'flow-1', stratum, artifacts, localSpec,
    context: { cwd: process.cwd() }, progress: stubProgress(), streamWriter: { write() {} },
  });
  return captured;
}

function reviewDescriptor(overrides = {}) {
  return {
    id: 'review_lenses/0', step: 'review_lenses', flow: 'build',
    itemIndex: 0, stage: 0, generation: 1, attempt: 1, epoch: 1, dispatchToken: 'tok-0',
    agent: 'claude', do: 'Run the review lens described by the item',
    item: { id: 'lens-security', lens_name: 'security', lens_focus: 'auth and crypto paths', confidence_gate: 8 },
    policy: { isolation: 'none' },
    contract: REVIEW_CLOSURE,
    ...overrides,
  };
}

const REVIEW_RESULT_MSG = {
  type: 'result', subtype: 'success',
  result: JSON.stringify({ clean: true, summary: 'ok', findings: [] }),
  total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
};

// ---------------------------------------------------------------------------
// G1 — resolver returns the contract NAME so scoped review steps are recognized
// ---------------------------------------------------------------------------
describe('G1 resolveStepOutputContract returns contractName', () => {
  it('scoped codex_review/review resolves contractName=ReviewResult', () => {
    const res = resolveStepOutputContract(BUILD_SPEC, 'build', 'codex_review/review');
    assert.equal(res.contractName, 'ReviewResult');
  });

  it('scoped coverage/run_tests resolves contractName=TestResult', () => {
    const res = resolveStepOutputContract(BUILD_SPEC, 'build', 'coverage/run_tests');
    assert.equal(res.contractName, 'TestResult');
  });

  it('a bare non-review step resolves its own contractName (not ReviewResult)', () => {
    const res = resolveStepOutputContract(BUILD_SPEC, 'build', 'blueprint');
    assert.equal(res.contractName, 'PhaseResult');
  });

  it('an unknown scoped id resolves contractName=null', () => {
    const res = resolveStepOutputContract(BUILD_SPEC, 'build', 'codex_review/nope');
    assert.equal(res.contractName, null);
  });
});

// ---------------------------------------------------------------------------
// G2 — consumer review items get the buildReviewPrompt scaffold
// ---------------------------------------------------------------------------
describe('G2 consumer review items get the review scaffold', () => {
  it('a review item prompt carries the scaffold (severity vocab, gate value, lens focus)', async () => {
    const captured = {};
    await driveConsumerIssuance({
      descriptor: reviewDescriptor(),
      localQuery: makeCapturingQuery(REVIEW_RESULT_MSG, captured),
    });
    assert.match(captured.prompt, /Severity Vocabulary/);
    assert.match(captured.prompt, /Confidence Gate/);
    assert.match(captured.prompt, /confidence >= 8/, 'the item confidence gate must appear in the scaffold');
    assert.match(captured.prompt, /Lens Focus: security/);
    assert.match(captured.prompt, /auth and crypto paths/);
  });

  it('a non-review item prompt has no review scaffold', async () => {
    const captured = {};
    await driveConsumerIssuance({
      descriptor: reviewDescriptor({
        contract: { root: 'TaskResult', contracts: { TaskResult: { outcome: 'string', summary: 'string' } } },
        item: { id: 't1' },
      }),
      localQuery: makeCapturingQuery({
        type: 'result', subtype: 'success', result: JSON.stringify({ outcome: 'complete', summary: 'done' }),
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
      }, captured),
    });
    assert.doesNotMatch(captured.prompt, /Severity Vocabulary/);
    assert.doesNotMatch(captured.prompt, /Confidence Gate/);
  });
});

// ---------------------------------------------------------------------------
// G3 — timeout/abort errors carry the failed run's usage
// ---------------------------------------------------------------------------
describe('G3 timeout/abort paths carry usage', () => {
  // A local query that emits usage-bearing tool activity, then hangs until aborted
  // (never yields a result), so the timeout/abort fires after usage is known.
  function makeUsageThenHangQuery() {
    return function ({ options }) {
      return (async function* () {
        yield { type: 'system', subtype: 'init', model: 'claude-test' };
        // A tool_use block drives the connector's onToolUse → onAgentEvent bridge
        // (the abort test's stop signal fires from there).
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] } };
        // Hang until the abort signal fires (timeout OR onAgentEvent stop), then
        // throw a usage-carrying error — the shape the connector attaches.
        await new Promise((resolve) => {
          const sig = options?.abortController?.signal;
          if (!sig || sig.aborted) { resolve(); return; }
          sig.addEventListener('abort', resolve, { once: true });
        });
        const err = new Error('aborted');
        err.usage = { input_tokens: 30, output_tokens: 12, tokens: 42, cost_usd: 0.03, usd: 0.03, duration_ms: 5, ms: 5, model: 'claude-test' };
        err.costUsd = 0.03;
        throw err;
      })();
    };
  }

  it('AgentTimeoutError carries usage from a usage-bearing rejection', async () => {
    const stratum = {
      _localQuery: makeUsageThenHangQuery(),
      onEvent: () => () => {},
      agentRun: async () => ({ text: '' }),
      cancelAgentRun: async () => {},
    };
    let thrown;
    try {
      await runAndNormalize(null, 'p', { step_id: 's', agent: 'claude', flow_id: 'f' }, {
        stratum, cwd: process.cwd(), localExecution: true, maxDurationMs: 30,
      });
    } catch (err) { thrown = err; }
    assert.ok(thrown instanceof AgentTimeoutError, `expected AgentTimeoutError, got ${thrown}`);
    assert.ok(thrown.usage, 'timeout error must carry the run usage');
    assert.equal(thrown.usage.tokens, 42);
    assert.equal(thrown.usage.cost_usd, 0.03);
  });

  it('AgentAbortedError carries usage from a usage-bearing rejection', async () => {
    let abortReason = null;
    const stratum = {
      _localQuery: makeUsageThenHangQuery(),
      onEvent: () => () => {},
      agentRun: async () => ({ text: '' }),
      cancelAgentRun: async () => {},
    };
    // onAgentEvent returns a truthy stop reason on the first tool event → abort.
    let thrown;
    try {
      await runAndNormalize(null, 'p', { step_id: 's', agent: 'claude', flow_id: 'f' }, {
        stratum, cwd: process.cwd(), localExecution: true,
        onAgentEvent: () => { abortReason = { signal: 'stuck' }; return abortReason; },
      });
    } catch (err) { thrown = err; }
    assert.ok(thrown instanceof AgentAbortedError, `expected AgentAbortedError, got ${thrown}`);
    assert.ok(thrown.usage, 'abort error must carry the run usage');
    assert.equal(thrown.usage.tokens, 42);
  });
});
