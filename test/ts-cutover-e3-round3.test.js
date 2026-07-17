/**
 * E3 cutover — round-3 review fixes (F1–F4).
 *
 * F1: resolveStepOutputContract follows scoped subflow ready ids.
 * F2: the local claude connector restricts tool AVAILABILITY (not just prompting).
 * F3: a failed local claude run still reports its billable usage.
 * F4: consumer review fanout threads reviewMode/lens/confidenceGate.
 *
 * Run with: node --test test/ts-cutover-e3-round3.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import { runLocalClaudeAgent } from '../lib/local-claude-connector.js';
import {
  resolveStepOutputContract,
  deriveConsumerReviewOptions,
  runConsumerIssuance,
} from '../lib/build.js';

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

// A local-query stub (the NODE_ENV=test seam runAndNormalize reads off
// stratum._localQuery). Yields the supplied result message SDK-style.
function makeLocalQuery(resultMessage) {
  return function ({ options }) {
    void options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield resultMessage;
    })();
  };
}

function stubProgress() {
  return {
    stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {},
    toolUse() {}, toolSummary() {}, findings() {},
  };
}

// Drives a single isolation:none consumer issuance through the local claude path,
// capturing the step_done envelope. Minimal fakes for artifacts/stratum/context.
async function driveConsumerIssuance({ descriptor, localQuery, onUsage }) {
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
    descriptor,
    flowId: 'flow-1',
    stratum,
    artifacts,
    localSpec,
    context: { cwd: process.cwd(), ...(onUsage ? { onUsage } : {}) },
    progress: stubProgress(),
    streamWriter: { write() {} },
  });
  return captured;
}

function reviewDescriptor(overrides = {}) {
  return {
    id: 'review_lenses/0', step: 'review_lenses', flow: 'build',
    itemIndex: 0, stage: 0, generation: 1, attempt: 1, epoch: 1, dispatchToken: 'tok-0',
    agent: 'claude', do: 'Run the review lens described by the item',
    item: { id: 'lens-security', lens_name: 'security', confidence_gate: 8 },
    policy: { isolation: 'none' },
    contract: REVIEW_CLOSURE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// F4 — deriveConsumerReviewOptions (pure)
// ---------------------------------------------------------------------------
describe('F4 deriveConsumerReviewOptions', () => {
  it('a ReviewResult-contract descriptor is review, with the item lens + gate', () => {
    const opts = deriveConsumerReviewOptions(reviewDescriptor());
    assert.deepEqual(opts, { reviewMode: true, lens: 'security', confidenceGate: 8 });
  });

  it('defaults lens=general and gate=7 when the item omits them', () => {
    const opts = deriveConsumerReviewOptions(reviewDescriptor({ item: { id: 'x' } }));
    assert.deepEqual(opts, { reviewMode: true, lens: 'general', confidenceGate: 7 });
  });

  it('a non-ReviewResult descriptor is not review', () => {
    const opts = deriveConsumerReviewOptions(reviewDescriptor({
      contract: { root: 'TaskResult', contracts: { TaskResult: { outcome: 'string', summary: 'string' } } },
      item: { id: 't1' },
    }));
    assert.equal(opts.reviewMode, false);
  });
});

// ---------------------------------------------------------------------------
// F4 — consumer review fanout threads reviewMode/lens/gate to normalization
// ---------------------------------------------------------------------------
describe('F4 consumer review fanout runs review normalization', () => {
  it('stamps the item lens + confidence gate onto findings (proves the opts threaded)', async () => {
    // Finding lacks lens + applied_gate; only review normalization stamps them.
    const reviewJson = JSON.stringify({
      clean: false, summary: 'found one',
      findings: [{ file: 'a.js', line: 3, severity: 'should-fix', finding: 'bad name', confidence: 9 }],
    });
    const captured = await driveConsumerIssuance({
      descriptor: reviewDescriptor(),
      localQuery: makeLocalQuery({
        type: 'result', subtype: 'success', result: reviewJson,
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
      }),
    });
    const finding = captured.envelope?.output?.findings?.[0];
    assert.ok(finding, 'review normalization must produce a findings array');
    assert.equal(finding.lens, 'security', 'the item lens must be stamped (reviewMode + lens threaded)');
    assert.equal(finding.applied_gate, 8, 'the item confidence gate must be applied');
  });
});

// ---------------------------------------------------------------------------
// F3 — consumer failure envelope includes the failed run's usage
// ---------------------------------------------------------------------------
describe('F3 consumer failure path forwards usage', () => {
  it('a failed local run reports usage in the step_done envelope + onUsage', async () => {
    const usageSeen = [];
    const captured = await driveConsumerIssuance({
      descriptor: reviewDescriptor(),
      onUsage: (u) => usageSeen.push(u),
      localQuery: makeLocalQuery({
        type: 'result', subtype: 'error_during_execution', errors: ['kaboom'],
        total_cost_usd: 0.5, usage: { input_tokens: 200, output_tokens: 80 }, duration_ms: 900,
      }),
    });
    assert.ok(captured.envelope.failure, 'a failed run yields a failure envelope');
    assert.ok(captured.envelope.usage, 'the failure envelope must carry engine usage');
    assert.equal(captured.envelope.usage.tokens, 280);
    assert.ok(captured.envelope.usage.usd > 0, 'billed cost is reported');
    assert.equal(usageSeen.length, 1, 'compose cumulative ledger also sees the usage');
  });
});

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const BUILD_SPEC = YAML.parse(readFileSync(join(REPO_ROOT, 'pipelines', 'build.stratum.yaml'), 'utf-8'));

// A minimal SDK-shaped query stub. Captures the options object it was handed and
// yields the supplied result message.
function makeQueryStub(resultMessage, captured = {}) {
  return function query({ prompt, options }) {
    captured.prompt = prompt;
    captured.options = options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield resultMessage;
    })();
  };
}

// ---------------------------------------------------------------------------
// F1 — scoped subflow ready ids resolve their output contracts
// ---------------------------------------------------------------------------
describe('F1 resolveStepOutputContract follows scoped subflow ids', () => {
  it('codex_review/review resolves to the ReviewResult contract', () => {
    const res = resolveStepOutputContract(BUILD_SPEC, 'build', 'codex_review/review');
    assert.equal(res.hasOutContract, true);
    // ReviewResult fields from build.stratum.yaml
    assert.deepEqual(Object.keys(res.outputFields).sort(),
      ['asks', 'auto_fixes', 'clean', 'findings', 'lenses_run', 'meta', 'summary'].sort());
  });

  it('coverage/run_tests resolves to the TestResult contract', () => {
    const res = resolveStepOutputContract(BUILD_SPEC, 'build', 'coverage/run_tests');
    assert.equal(res.hasOutContract, true);
    assert.deepEqual(Object.keys(res.outputFields).sort(), ['failures', 'passing', 'summary'].sort());
  });

  it('a bare (unscoped) id still resolves in the entry flow', () => {
    const res = resolveStepOutputContract(BUILD_SPEC, 'build', 'blueprint');
    assert.equal(res.hasOutContract, true);
    assert.ok(Object.hasOwn(res.outputFields, 'phase'));
  });

  it('an unknown scoped id yields hasOutContract=false', () => {
    const res = resolveStepOutputContract(BUILD_SPEC, 'build', 'codex_review/nope');
    assert.equal(res.hasOutContract, false);
    assert.deepEqual(res.outputFields, {});
  });
});

// ---------------------------------------------------------------------------
// F2 — allowedTools must ALSO restrict tool availability (sdkOptions.tools)
// ---------------------------------------------------------------------------
describe('F2 local connector restricts tool availability', () => {
  const successResult = {
    type: 'result', subtype: 'success', result: '{}',
    total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
  };

  it('sets sdkOptions.tools to the allowlist when a profile passes allowedTools', async () => {
    const captured = {};
    await runLocalClaudeAgent('p', {
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Edit', 'Write'],
      query: makeQueryStub(successResult, captured),
    });
    assert.deepEqual(captured.options.tools, ['Read', 'Grep', 'Glob'],
      'availability must be restricted to the allowlist, not left as the full preset');
    assert.deepEqual(captured.options.allowedTools, ['Read', 'Grep', 'Glob']);
    assert.deepEqual(captured.options.disallowedTools, ['Edit', 'Write']);
  });

  it('uses the claude_code preset (no restriction) when no allowlist is given', async () => {
    const captured = {};
    await runLocalClaudeAgent('p', { query: makeQueryStub(successResult, captured) });
    assert.deepEqual(captured.options.tools, { type: 'preset', preset: 'claude_code' });
    assert.equal(captured.options.allowedTools, undefined);
  });
});

// ---------------------------------------------------------------------------
// F3 — a failed run carries its billable usage
// ---------------------------------------------------------------------------
describe('F3 failed local run reports usage', () => {
  it('attaches usage + costUsd to the thrown error on error_during_execution', async () => {
    const errResult = {
      type: 'result', subtype: 'error_during_execution',
      errors: ['boom'],
      total_cost_usd: 0.42,
      usage: { input_tokens: 100, output_tokens: 50 },
      duration_ms: 1234,
    };
    let thrown;
    try {
      await runLocalClaudeAgent('p', { query: makeQueryStub(errResult) });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'a non-success result must throw');
    assert.ok(thrown.usage, 'thrown error must carry usage');
    assert.equal(thrown.usage.input_tokens, 100);
    assert.equal(thrown.usage.output_tokens, 50);
    assert.equal(thrown.usage.cost_usd, 0.42);
    assert.equal(thrown.costUsd, 0.42);
  });
});
