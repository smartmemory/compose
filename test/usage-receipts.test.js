import { checkedConsumerAdapter } from './helpers/routing-adapter-check.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { runAndNormalize, UserInterruptError } from '../lib/result-normalizer.js';
import { resolveAgentConfig } from '../lib/agent-string.js';
import {
  ConsumerStuckError,
  makeAskAgent,
  reportUsageReceipts,
  runBuild,
} from '../lib/build.js';
import { runGsd } from '../lib/gsd.js';
import { tier1CodexReview, tier2FreshAgent } from '../lib/bug-escalation.js';
import { _clearCatalogCache } from '../lib/policy-catalog.js';
import { seedCanonicalCatalog } from './helpers/policy-catalog-stub.js';

import { SIMPLE_BUILD_SPEC, makeBuildWorkspace, fakeBuildStratum, readyWork, agentResult } from './helpers/build-stratum-fixture.js';

process.env.NODE_ENV = 'test';

function mcpResult(value) {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function receiptStratum({ budget } = {}) {
  const calls = [];
  return {
    calls,
    async usageReport(runId, receipt) {
      calls.push({ type: 'usageReport', runId, receipt });
      return { status: 'ok', ...(budget ? { budget } : {}), ledger: { spent: {} } };
    },
  };
}

function normalizedUsage(overrides = {}) {
  return {
    dispatch_id: 'dispatch-1',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    duration_ms: 25,
    input_tokens: 10,
    output_tokens: 5,
    cache_read: 2,
    cache_creation: 1,
    cost_usd: 0.004,
    usd_source: 'estimated',
    ...overrides,
  };
}


const SCOPED_RETRY_SPEC = `
version: 1
contracts:
  R:
    phase: string
    outcome: string
    summary: string
flows:
  entry: bug_fix
  bug_fix:
    input:
      task: string
    output:
      from: \${nested.output}
      contract: R
    steps:
      - id: nested
        run: child
        in:
          task: \${input.task}
  child:
    input:
      task: string
    output:
      from: \${work.output}
      contract: R
    steps:
      - id: work
        agent: claude
        do: stub
        out: R
`;

const REVIEW_GATE_SPEC = `
version: 1
contracts:
  ReviewResult:
    clean: boolean
    summary: string
    findings: array
    meta: object
    lenses_run: string[]
    auto_fixes: array
    asks: array
flows:
  entry: bug_fix
  bug_fix:
    input:
      task: string
    output:
      from: \${review_merge.output}
      contract: ReviewResult
    steps:
      - id: review_merge
        agent: claude
        do: merge review findings
        out: ReviewResult
      - id: review_gate
        after: [review_merge]
        gate:
          on_approve: null
          on_revise: review_merge
          on_kill: null
          max_rounds: 2
`;

const GSD_BLUEPRINT = `# Usage receipts GSD

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.js\` | new | A |

## Boundary Map

### S01: A

File Plan: \`a.js\` (new)

Produces:
  a.js → a (function)

Consumes: nothing
`;


function usageReceipts(stratum) {
  return stratum.calls.filter((call) => call.type === 'usageReport').map((call) => call.receipt);
}

function stepDoneEnvelopes(stratum) {
  return stratum.calls.filter((call) => call.type === 'stepDone').map((call) => call.envelope);
}

test('StratumMcpClient caches listTools, wraps usageReport, and runAgentText reports one dispatch usage record', async () => {
  const calls = [];
  const client = new StratumMcpClient();
  Object.defineProperty(client, '_testClient', {
    value: {
      async listTools() {
        calls.push({ type: 'listTools' });
        return { tools: [{ name: 'stratum_usage_report' }] };
      },
      async callTool({ name, arguments: args }) {
        calls.push({ type: name, args });
        if (name === 'stratum_agent_run') {
          return mcpResult({
            text: 'answer',
            usage: { tokens: 7, ms: 11 },
            telemetry: { model: 'gpt-5.6-codex', effort: 'high', durationMs: 11 },
          });
        }
        return mcpResult({ status: 'ok', runId: 'flow-1', seq: 1, ledger: { spent: {} } });
      },
    },
  });

  assert.equal(await client.hasTool('stratum_usage_report'), true);
  assert.equal(await client.hasTool('stratum_usage_report'), true);
  assert.equal(calls.filter((call) => call.type === 'listTools').length, 1);

  await client.usageReport('flow-1', { dispatchId: 'd', source: 'main', usage: { tokens: 1 } });
  const seen = [];
  assert.equal(await client.runAgentText('codex', 'question', { onUsage: (usages) => seen.push(...usages) }), 'answer');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].dispatch_id.length > 0, true);
  assert.deepEqual({ ...seen[0], dispatch_id: '<id>' }, {
    dispatch_id: '<id>', model: 'gpt-5.6-codex', effort: 'high', duration_ms: 11,
    input_tokens: 0, output_tokens: 7,
  });
  assert.equal(Object.hasOwn(seen[0], 'cost_usd'), false);
  assert.deepEqual(calls.find((call) => call.type === 'stratum_usage_report').args.runId, 'flow-1');
});

test('runAgentText warns once and returns text when its usage hook rejects', async () => {
  const client = new StratumMcpClient();
  Object.defineProperty(client, '_testClient', {
    value: {
      async callTool() {
        return mcpResult({
          text: 'answer',
          usage: { tokens: 7, ms: 11 },
          telemetry: { model: 'gpt-5.6-codex', durationMs: 11 },
        });
      },
    },
  });
  let hookCalls = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const text = await client.runAgentText('codex', 'question', {
      onUsage: async () => {
        hookCalls += 1;
        throw new Error('usage hook unavailable');
      },
    });
    assert.equal(text, 'answer');
    assert.equal(hookCalls, 1);
    assert.deepEqual(warnings, ['[stratum-agent] onUsage hook failed: usage hook unavailable']);
  } finally {
    console.warn = originalWarn;
  }
});

test('runAgentText warns once and rethrows the original dispatch error when its usage hook rejects', async () => {
  const dispatchError = Object.assign(new Error('dispatch failed'), {
    dispatchId: 'failed-dispatch',
    usage: { tokens: 5, ms: 9 },
    telemetry: { model: 'gpt-5.6-codex', durationMs: 9 },
  });
  const client = new StratumMcpClient();
  Object.defineProperty(client, '_testClient', {
    value: { async callTool() { throw dispatchError; } },
  });
  let hookCalls = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await assert.rejects(
      () => client.runAgentText('codex', 'question', {
        onUsage: async () => {
          hookCalls += 1;
          throw new Error('usage hook unavailable');
        },
      }),
      (error) => error === dispatchError,
    );
    assert.equal(hookCalls, 1);
    assert.deepEqual(warnings, ['[stratum-agent] onUsage hook failed: usage hook unavailable']);
  } finally {
    console.warn = originalWarn;
  }
});

test('hasTool fails closed when MCP tool listing fails', async () => {
  const client = new StratumMcpClient();
  Object.defineProperty(client, '_testClient', { value: { async listTools() { throw new Error('old surface'); } } });
  assert.equal(await client.hasTool('stratum_usage_report'), false);
});

test('runAndNormalize emits one primary UsageRecord and preserves the merged usage object', async () => {
  let handler = null;
  const stratum = {
    onEvent(_flow, _step, fn) { handler = fn; return () => {}; },
    async agentRun() {
      handler({ schema_version: '0.2.6', kind: 'step_usage', metadata: {
        input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1, model: 'claude-sonnet-4-6',
      } });
      return { text: 'ok', dispatchId: 'primary-1', telemetry: { model: 'claude-sonnet-4-6', durationMs: 21 } };
    },
    async cancelAgentRun() {},
  };
  const out = await runAndNormalize(null, 'p', { step_id: 'work', output_fields: {} }, { stratum });
  assert.deepEqual(out.usage, {
    input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2, cost_usd: 0, model: 'claude-sonnet-4-6',
  });
  assert.equal(out.usages.length, 1);
  // COMP-COST-OWNER S3: the event states no cost, so the record carries NO cost_usd key.
  // It previously carried one the consumer derived from the tokens and labelled 'estimated'
  // -- provenance for a number no producer ever reported. The omission is what
  // recordBuildUsage counts as unpriced and what reportUsageReceipts refuses to stamp.
  assert.deepEqual(out.usages[0], {
    dispatch_id: 'primary-1', model: 'claude-sonnet-4-6', duration_ms: 21,
    input_tokens: 10, output_tokens: 5, cache_read: 2, cache_creation: 1,
    usd_source: 'estimated',
  });
});

test('runAndNormalize keeps review-repair usage as a separate dispatch record', async () => {
  let calls = 0;
  const stratum = {
    onEvent() { return () => {}; },
    async agentRun() {
      calls += 1;
      return calls === 1
        ? {
            text: 'not json', dispatchId: 'primary-review',
            usage: { tokens: 5, ms: 4 },
            telemetry: { model: 'gpt-primary', durationMs: 4 },
          }
        : {
            text: JSON.stringify({ summary: 'fixed', findings: [] }),
            dispatchId: 'repair-review',
            usage: { tokens: 3, ms: 2 },
            telemetry: { model: 'gpt-repair', durationMs: 2 },
          };
    },
    async cancelAgentRun() {},
  };
  const out = await runAndNormalize(
    null, 'review', { step_id: 'review', agent: 'codex', output_fields: {} },
    { stratum, reviewMode: true },
  );
  assert.equal(calls, 2);
  assert.deepEqual(out.usages.map((usage) => usage.dispatch_id), ['primary-review', 'repair-review']);
  assert.equal(out.usage.output_tokens, 8, 'existing merged usage still folds primary + repair');
});

test('reported prices stay reported and unpriced entries carry no usd key in receipts', async () => {
  const stratum = receiptStratum();
  await reportUsageReceipts(
    { stratum, flowId: 'flow-1', receiptsMode: true },
    { usages: [
      normalizedUsage({ dispatch_id: 'priced', usd_source: 'reported' }),
      normalizedUsage({ dispatch_id: 'unpriced', model: 'gpt-5.6-codex', cost_usd: undefined, usd_source: 'estimated' }),
    ] },
    { stepId: 'work', source: 'main' },
  );
  assert.equal(stratum.calls.length, 2);
  assert.deepEqual(stratum.calls[0].receipt.usage, { tokens: 15, usd: 0.004, ms: 25 });
  assert.equal(stratum.calls[0].receipt.usdSource, 'reported');
  assert.deepEqual(stratum.calls[1].receipt.usage, { tokens: 15, ms: 25 });
  assert.equal(Object.hasOwn(stratum.calls[1].receipt, 'usdSource'), false);
});

test('main build receipt is sent before stepDone with source main', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'usage-receipts-build-'));
  const order = [];
  try {
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    mkdirSync(join(cwd, 'pipelines'), { recursive: true });
    mkdirSync(join(cwd, 'docs', 'bugs', 'BUG-R'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2 }));
    writeFileSync(join(cwd, 'pipelines', 'bug-fix.stratum.yaml'), `
version: 1
contracts:
  R:
    phase: string
    outcome: string
    summary: string
flows:
  entry: bug_fix
  bug_fix:
    input:
      task: string
    output:
      from: \${work.output}
      contract: R
    steps:
      - id: work
        agent: claude
        do: stub
        out: R
`);
    const stratum = {
      hasTool: async () => true,
      plan: async () => ({
        status: 'ready', runId: 'flow-main',
        ready: [{ id: 'work', agent: 'claude', do: 'stub', attempt: 1, dispatchToken: 'tok' }],
      }),
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async () => ({
        text: JSON.stringify({ phase: 'work', outcome: 'complete', summary: 'done' }),
        usage: { tokens: 6, ms: 4 },
        telemetry: { model: 'claude-test', durationMs: 4 },
        dispatchId: 'main-dispatch',
      }),
      usageReport: async (_runId, receipt) => {
        order.push({ type: 'usageReport', receipt });
        return { status: 'ok', ledger: { spent: {} } };
      },
      stepDone: async (_runId, _stepId, envelope) => {
        order.push({ type: 'stepDone', envelope });
        return { status: 'completed', runId: 'flow-main' };
      },
      audit: async () => ({ status: 'completed', steps: {}, events: [] }),
      close: async () => {},
    };
    await runBuild('BUG-R', {
      cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x',
    });
    assert.deepEqual(order.map((entry) => entry.type), ['usageReport', 'stepDone']);
    assert.equal(order[0].receipt.source, 'main');
    assert.equal(order[0].receipt.stepId, 'work');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runBuild reports retry-fixer and both main attempts with receipt ownership', async () => {
  const code = 'BUG-RECEIPT-RETRY';
  const cwd = makeBuildWorkspace(code, { spec: SCOPED_RETRY_SPEC });
  let agentCall = 0;
  let doneCall = 0;
  const stratum = fakeBuildStratum({
    plan: readyWork({ id: 'nested/work' }),
    agentRun: async () => {
      agentCall += 1;
      if (agentCall === 2) {
        return agentResult({ outcome: 'complete', summary: 'fixed' }, 'fixer-dispatch');
      }
      return agentResult(
        { phase: 'work', outcome: 'complete', summary: `main ${agentCall}` },
        `main-dispatch-${agentCall}`,
      );
    },
    stepDone: async () => {
      doneCall += 1;
      if (doneCall === 1) {
        return readyWork({
          id: 'nested/work', attempt: 2, dispatchToken: 'tok-2',
          previousFailure: { reason: 'ensure failed' },
        });
      }
      return { status: 'completed', runId: 'flow-receipts' };
    },
  });
  try {
    await runBuild(code, { cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x' });
    const receipts = usageReceipts(stratum);
    assert.deepEqual(receipts.map((receipt) => receipt.source), ['main', 'fixer', 'main']);
    assert.deepEqual(receipts.map((receipt) => receipt.stepId), ['nested/work', 'nested/work', 'nested/work']);
    assert.deepEqual(receipts.map((receipt) => receipt.usdSource), ['reported', 'reported', 'reported']);
    assert.equal(stepDoneEnvelopes(stratum).length, 2);
    assert.equal(stepDoneEnvelopes(stratum).every((envelope) => !Object.hasOwn(envelope, 'usage')), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// C9: the review-repair fixer used to be dispatched with `profile: <agent literal>`,
// which drops the sidecar's tool restrictions and model tier. The sibling
// review_merge repair site keys off the sidecar's `fix` entry; this one must too.
test('the review-repair fixer runs under the sidecar fix profile', async () => {
  const code = 'BUG-FIX-PROFILE';
  const cwd = makeBuildWorkspace(code, {
    // A fix profile must name a declared step, as the shipped bug-fix preset
    // does. This fixture exercises the retry fixer, not a scheduled fix step.
    spec: `${SCOPED_RETRY_SPEC}      - id: fix
        after: [work]
        when: "false"
        agent: claude
        do: stub
        out: R
`,
    profiles: { fix: 'claude:read-only-reviewer:critical' },
  });
  let agentCall = 0;
  let doneCall = 0;
  const stratum = fakeBuildStratum({
    plan: readyWork({ id: 'nested/work' }),
    agentRun: async () => {
      agentCall += 1;
      if (agentCall === 2) return agentResult({ outcome: 'complete', summary: 'fixed' }, 'fixer-dispatch');
      return agentResult({ phase: 'work', outcome: 'complete', summary: `main ${agentCall}` }, `main-${agentCall}`);
    },
    stepDone: async () => {
      doneCall += 1;
      if (doneCall === 1) {
        return readyWork({ id: 'nested/work', attempt: 2, dispatchToken: 'tok-2', previousFailure: { reason: 'ensure failed' } });
      }
      return { status: 'completed', runId: 'flow-receipts' };
    },
  });
  try {
    await runBuild(code, { cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x' });
    const runs = stratum.calls.filter((call) => call.type === 'agentRun').map((call) => call.args);
    assert.equal(runs.length, 3, 'main, fixer, main retry');
    const [main, fixer] = runs;
    assert.equal(fixer[0], 'claude', 'the fixer keeps the implementer identity');
    assert.ok(Array.isArray(fixer[2].allowedTools) && fixer[2].allowedTools.length > 0,
      'the fixer inherits the sidecar profile tool restrictions');
    assert.equal(fixer[2].modelID, resolveAgentConfig('claude:read-only-reviewer:critical').modelID);
    assert.equal(main[2].allowedTools, undefined, 'the unprofiled main step stays unrestricted');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runBuild fatal main throw reports its receipt before propagating', async () => {
  const code = 'BUG-RECEIPT-FATAL';
  const cwd = makeBuildWorkspace(code);
  const stratum = fakeBuildStratum({
    agentRun: async () => {
      throw Object.assign(new Error('fatal agent failure'), {
        dispatchId: 'fatal-dispatch',
        usage: { tokens: 4, usd: 0.03, ms: 7, usd_source: 'reported' },
      });
    },
  });
  try {
    await assert.rejects(
      () => runBuild(code, { cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x' }),
      /fatal agent failure/,
    );
    const receipts = usageReceipts(stratum);
    assert.equal(receipts.length, 1);
    assert.deepEqual(
      { source: receipts[0].source, stepId: receipts[0].stepId, usage: receipts[0].usage, usdSource: receipts[0].usdSource },
      { source: 'main', stepId: 'work', usage: { tokens: 4, usd: 0.03, ms: 7 }, usdSource: 'reported' },
    );
    assert.equal(stepDoneEnvelopes(stratum).length, 0, 'fatal throws have no stepDone envelope');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runBuild late main timeout reports exact raw usage and debits the accumulator', async () => {
  const code = 'BUG-RECEIPT-TIMEOUT';
  const cwd = makeBuildWorkspace(code);
  const stratum = fakeBuildStratum({
    agentRun: (_agent, _prompt, { signal }) => new Promise((resolve) => {
      const finish = () => resolve({
        text: JSON.stringify({ phase: 'work', outcome: 'complete', summary: 'late' }),
        dispatchId: 'late-timeout-dispatch',
        usage: { tokens: 9, usd: 0.02, ms: 5 },
        telemetry: { model: 'claude-test', durationMs: 5 },
      });
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    }),
  });
  try {
    await runBuild(code, {
      cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x', stepTimeoutMs: 5,
    });
    const receipts = usageReceipts(stratum);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].source, 'main');
    assert.equal(receipts[0].stepId, 'work');
    assert.deepEqual(receipts[0].usage, { tokens: 9, ms: 5 });
    assert.equal(Object.hasOwn(receipts[0], 'usdSource'), false, 'unlabelled raw USD provenance is omitted');
    const envelopes = stepDoneEnvelopes(stratum);
    assert.equal(envelopes.length, 1);
    assert.equal(Object.hasOwn(envelopes[0], 'usage'), false, 'receipts mode owns engine usage');
    const ledger = readFileSync(join(cwd, '.compose', 'data', 'dispatch-ledger.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const actuals = ledger.find((row) => row.kind === 'build-actuals' && row.feature_code === code);
    assert.equal(actuals.tokens_total, 9);
    assert.equal(actuals.usd, 0.02);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runBuild policy violation reports the revision dispatch separately', async () => {
  const code = 'BUG-RECEIPT-POLICY';
  const memoryDir = seedCanonicalCatalog();
  const cwd = makeBuildWorkspace(code, { compose: { policyCheck: { memoryDir } } });
  let call = 0;
  const stratum = fakeBuildStratum({
    agentRun: async () => {
      call += 1;
      return agentResult({
        phase: 'work', outcome: 'complete',
        summary: call === 1 ? 'Want me to continue with the tests?' : 'Tests completed.',
      }, call === 1 ? 'policy-main' : 'policy-revision');
    },
  });
  try {
    await runBuild(code, { cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x' });
    const receipts = usageReceipts(stratum);
    assert.deepEqual(receipts.map((receipt) => receipt.source), ['policy_revision', 'main']);
    assert.deepEqual(receipts.map((receipt) => receipt.stepId), ['work', 'work']);
    assert.deepEqual(receipts.map((receipt) => receipt.usdSource), ['reported', 'reported']);
    assert.equal(stepDoneEnvelopes(stratum).length, 1);
    assert.equal(Object.hasOwn(stepDoneEnvelopes(stratum)[0], 'usage'), false);
  } finally {
    _clearCatalogCache();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test('runBuild dirty review gate reports the gate fixer before gateResolve revise', async () => {
  const code = 'BUG-RECEIPT-GATE';
  const cwd = makeBuildWorkspace(code, { spec: REVIEW_GATE_SPEC, profiles: { _reduceSteps: ['review_merge'] } });
  let agentCall = 0;
  let gateResolved = false;
  const stratum = fakeBuildStratum({
    plan: readyWork({ id: 'review_merge', do: 'merge review findings' }),
    agentRun: async () => {
      agentCall += 1;
      if (agentCall === 1) {
        return agentResult({
          clean: false,
          summary: 'one must-fix',
          findings: [{ file: 'a.js', line: 1, severity: 'must-fix', finding: 'broken', lens: 'security', confidence: 9 }],
          meta: {}, lenses_run: ['security'], auto_fixes: [], asks: [],
        }, 'review-main');
      }
      return agentResult({ outcome: 'complete', summary: 'fixed' }, 'review-gate-fixer');
    },
    stepDone: async () => ({ status: 'running', runId: 'flow-receipts' }),
    audit: async () => gateResolved
      ? { status: 'completed', steps: {}, events: [] }
      : { status: 'running', steps: { review_gate: { status: 'waiting_gate', gateToken: 'gate-token' } }, events: [] },
    gateResolve: async (_flowId, _stepId, outcome) => {
      assert.equal(outcome, 'revise');
      gateResolved = true;
      return { status: 'completed', runId: 'flow-receipts' };
    },
  });
  try {
    await runBuild(code, { cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x' });
    const receipts = usageReceipts(stratum);
    assert.deepEqual(receipts.map((receipt) => receipt.source), ['main', 'gate_fixer']);
    assert.deepEqual(receipts.map((receipt) => receipt.stepId), ['review_merge', 'review_gate']);
    assert.deepEqual(receipts.map((receipt) => receipt.usdSource), ['reported', 'reported']);
    assert.equal(stratum.calls.filter((call) => call.type === 'gateResolve').length, 1);
    assert.equal(Object.hasOwn(stepDoneEnvelopes(stratum)[0], 'usage'), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runBuild logs receipt-hook rejection, continues, and still sends stepDone', async () => {
  const code = 'BUG-RECEIPT-REJECT';
  const cwd = makeBuildWorkspace(code);
  const warnings = [];
  const originalWarn = console.warn;
  const stratum = fakeBuildStratum({
    agentRun: async () => agentResult({ phase: 'work', outcome: 'complete', summary: 'done' }, 'reject-dispatch'),
    usageReport: async () => { throw new Error('receipt sink unavailable'); },
  });
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await runBuild(code, { cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x' });
    const receipts = usageReceipts(stratum);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].source, 'main');
    assert.equal(receipts[0].stepId, 'work');
    assert.equal(receipts[0].usdSource, 'reported');
    assert.equal(warnings.some((warning) => /\[usage-receipt\] failed for reject-dispatch: receipt sink unavailable/.test(warning)), true);
    assert.equal(stepDoneEnvelopes(stratum).length, 1);
    assert.equal(Object.hasOwn(stepDoneEnvelopes(stratum)[0], 'usage'), false);
  } finally {
    console.warn = originalWarn;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('surface-14 mode emits no receipts', async () => {
  const stratum = receiptStratum();
  await reportUsageReceipts(
    { stratum, flowId: 'flow-1', receiptsMode: false },
    { usages: [normalizedUsage()] },
    { source: 'main' },
  );
  assert.equal(stratum.calls.length, 0);
});

test('fanout envelope omits usage in receipts mode and preserves it on the old surface', async () => {
  const drive = async (receiptsMode) => {
    const cwd = mkdtempSync(join(tmpdir(), 'usage-receipts-fanout-'));
    const receiptClient = receiptStratum();
    const stepDoneCalls = [];
    const seenUsage = [];
    const stratum = {
      ...receiptClient,
      _localQuery: () => (async function* () {
        yield { type: 'system', subtype: 'init', model: 'claude-test' };
        yield {
          type: 'result', subtype: 'success',
          result: JSON.stringify({ outcome: 'complete', summary: 'done' }),
          total_cost_usd: 0.01,
          usage: { input_tokens: 4, output_tokens: 2 },
          duration_ms: 5,
        };
      })(),
      onEvent: () => () => {},
      agentRun: async () => ({ text: '' }),
      cancelAgentRun: async () => {},
      stepDone: async (_flowId, _stepId, envelope) => {
        stepDoneCalls.push(envelope);
        return { status: 'completed', runId: 'flow-1' };
      },
      audit: async () => ({}),
    };
    const descriptor = {
      id: 'items/0', step: 'items', flow: 'build', itemIndex: 0, stage: 0,
      generation: 1, attempt: 1, epoch: 1, dispatchToken: 'tok-1',
      agent: 'claude', do: 'work', item: { id: 'T1' },
      policy: { isolation: 'none' },
      contract: { root: 'R', contracts: { R: { outcome: 'string', summary: 'string' } } },
    };
    const artifacts = {
      hooks: {},
      reconcileDescriptor: () => ({ action: 'execute', worktree: cwd }),
      prepareIssuance: (_descriptor, envelope) => ({ diff: '', envelope }),
      reconcileAudit() {}, restoreToPreStageWitness() {},
    };
    const receiptContext = { stratum, flowId: 'flow-1', receiptsMode };
    try {
      await checkedConsumerAdapter({
        descriptor, flowId: 'flow-1', stratum, artifacts,
        localSpec: { flows: { build: { steps: [{ id: 'items', fanout: { steps: [{ agent: 'claude', do: 'x', out: 'R' }] } }] } }, contracts: { R: { outcome: 'string', summary: 'string' } } },
        context: {
          cwd, flowId: 'flow-1', receiptsMode,
          onUsage: (usage, meta) => {
            seenUsage.push(usage);
            return reportUsageReceipts(receiptContext, usage, meta);
          },
        },
        progress: { stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {}, toolUse() {}, toolSummary() {}, findings() {} },
        streamWriter: { write() {} },
      });
      return { calls: receiptClient.calls, envelope: stepDoneCalls[0], seenUsage };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };

  const modern = await drive(true);
  assert.equal(modern.seenUsage.length, 1);
  assert.equal(modern.calls.length, 1);
  assert.deepEqual(modern.calls[0].receipt.usage, { tokens: 6, usd: 0.01, ms: 5 });
  assert.equal(modern.calls[0].receipt.usdSource, 'reported');
  assert.equal(Object.hasOwn(modern.envelope, 'usage'), false);
  const legacy = await drive(false);
  assert.equal(legacy.calls.length, 0);
  assert.deepEqual(legacy.envelope.usage, { tokens: 6, usd: 0.01, ms: 5 });
});

test('consumer abort reports usage at the real consumer seam before propagating stuck', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'usage-receipts-abort-'));
  const receiptClient = receiptStratum();
  let eventHandler = null;
  const stratum = {
    ...receiptClient,
    onEvent: (_flowId, _stepId, handler) => { eventHandler = handler; return () => {}; },
    agentRun: async () => {
      eventHandler({
        schema_version: '0.2.6', kind: 'tool_use_summary',
        metadata: { tool: 'Edit', input: { file_path: 'a.js' }, summary: '', output: '' },
      });
      return {
        text: JSON.stringify({ outcome: 'complete', summary: 'late' }),
        dispatchId: 'consumer-abort-dispatch',
        usage: { tokens: 9, usd: 0.02, ms: 5 },
        telemetry: { model: 'codex-test', durationMs: 5 },
      };
    },
    cancelAgentRun: async () => {},
    stepDone: async () => {
      receiptClient.calls.push({ type: 'stepDone' });
      return { status: 'completed', runId: 'flow-1' };
    },
  };
  const descriptor = {
    id: 'execute/0', step: 'execute', flow: 'build', itemIndex: 0, stage: 0,
    generation: 1, attempt: 1, epoch: 1, dispatchToken: 'abort-token',
    agent: 'codex', do: 'work', item: { id: 'T1' }, policy: { isolation: 'none' },
    contract: { root: 'R', contracts: { R: { outcome: 'string', summary: 'string' } } },
  };
  const artifacts = {
    hooks: {},
    reconcileDescriptor: () => ({ action: 'execute', worktree: cwd }),
    prepareIssuance: (_descriptor, envelope) => ({ diff: '', envelope }),
    reconcileAudit() {}, restoreToPreStageWitness() {},
  };
  const stuckDetector = {
    startTask() {}, record() {},
    check: () => ({ stuck: true, signal: 'same_file', detail: 'fixture abort' }),
  };
  try {
    await assert.rejects(
      () => checkedConsumerAdapter({
        descriptor, flowId: 'flow-1', stratum, artifacts,
        localSpec: { flows: { build: { steps: [{ id: 'execute', fanout: { steps: [{ agent: 'claude', do: 'x', out: 'R' }] } }] } }, contracts: { R: { outcome: 'string', summary: 'string' } } },
        context: {
          cwd, flowId: 'flow-1', receiptsMode: true,
          onUsage: (usage, meta) => reportUsageReceipts({ stratum, flowId: 'flow-1', receiptsMode: true }, usage, meta),
        },
        progress: { stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {}, toolUse() {}, toolSummary() {}, findings() {} },
        streamWriter: { write() {} }, stuckDetector,
      }),
      (error) => error instanceof ConsumerStuckError,
    );
    assert.equal(receiptClient.calls.length, 1);
    const receipt = receiptClient.calls[0].receipt;
    assert.equal(receipt.source, 'consumer');
    assert.equal(receipt.stepId, 'execute');
    assert.deepEqual(receipt.usage, { tokens: 9, ms: 5 });
    assert.equal(Object.hasOwn(receipt, 'usdSource'), false);
    assert.equal(receiptClient.calls.filter((call) => call.type === 'stepDone').length, 0,
      'consumer abort has no stepDone envelope');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runGsd ordinary step gives usage to receipts mode or the legacy envelope, never both', async () => {
  const drive = async (receiptsMode) => {
    const cwd = mkdtempSync(join(tmpdir(), 'usage-receipts-gsd-'));
    const code = receiptsMode ? 'GSD-RECEIPTS' : 'GSD-LEGACY';
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    mkdirSync(join(cwd, 'docs', 'features', code), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2 }));
    writeFileSync(join(cwd, 'docs', 'features', code, 'blueprint.md'), GSD_BLUEPRINT);
    const calls = [];
    const stratum = {
      hasTool: async () => receiptsMode,
      plan: async () => ({
        status: 'ready', runId: `flow-${code}`,
        ready: [{ id: 'decompose_gsd', agent: 'claude', do: 'decompose', dispatchToken: 'gsd-token' }],
      }),
      agentRun: async () => ({
        text: JSON.stringify({ tasks: [{ id: 'T01', files_owned: ['a.js'], files_read: [], depends_on: [], description: '' }] }),
        dispatchId: `dispatch-${code}`,
        usage: { tokens: 9, usd: 0.02, ms: 5, usd_source: 'reported' },
        telemetry: { model: 'claude-test', durationMs: 5 },
      }),
      usageReport: async (_runId, receipt) => {
        calls.push({ type: 'usageReport', receipt });
        return { status: 'ok', ledger: { spent: {} } };
      },
      stepDone: async (_runId, _stepId, envelope) => {
        calls.push({ type: 'stepDone', envelope });
        return { status: 'completed', runId: `flow-${code}` };
      },
      audit: async () => ({ status: 'completed', steps: {}, events: [] }),
    };
    try {
      await runGsd(code, { cwd, stratum, allowDirtyWorkspace: true });
      return { calls };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };

  const modern = await drive(true);
  const modernReceipts = modern.calls.filter((call) => call.type === 'usageReport');
  const modernDone = modern.calls.find((call) => call.type === 'stepDone');
  assert.equal(modernReceipts.length, 1);
  assert.equal(modernReceipts[0].receipt.source, 'main');
  assert.equal(modernReceipts[0].receipt.stepId, 'decompose_gsd');
  assert.deepEqual(modernReceipts[0].receipt.usage, { tokens: 9, usd: 0.02, ms: 5 });
  assert.equal(modernReceipts[0].receipt.usdSource, 'reported');
  assert.equal(Object.hasOwn(modernDone.envelope, 'usage'), false);

  const legacy = await drive(false);
  assert.equal(legacy.calls.filter((call) => call.type === 'usageReport').length, 0);
  assert.deepEqual(legacy.calls.find((call) => call.type === 'stepDone').envelope.usage, { tokens: 9, usd: 0.02, ms: 5 });
});

test('runGsd ordinary step rejection records usage before rethrowing the original error', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'usage-receipts-gsd-reject-'));
  const code = 'GSD-RECEIPT-REJECT';
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'features', code), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2 }));
  writeFileSync(join(cwd, 'docs', 'features', code, 'blueprint.md'), GSD_BLUEPRINT);
  const calls = [];
  const dispatchError = Object.assign(new Error('gsd agent failed'), {
    dispatchId: 'gsd-failed-dispatch',
    usage: { tokens: 9, usd: 0.02, ms: 5, model: 'claude-test', usd_source: 'reported' },
  });
  const stratum = {
    hasTool: async () => true,
    plan: async () => ({
      status: 'ready', runId: `flow-${code}`,
      ready: [{ id: 'decompose_gsd', agent: 'claude', do: 'decompose', dispatchToken: 'gsd-token' }],
    }),
    agentRun: async () => { throw dispatchError; },
    usageReport: async (_runId, receipt) => {
      calls.push({ type: 'usageReport', receipt });
      return { status: 'ok', ledger: { spent: {} } };
    },
    stepDone: async () => {
      calls.push({ type: 'stepDone' });
      return { status: 'completed', runId: `flow-${code}` };
    },
  };
  try {
    await assert.rejects(
      () => runGsd(code, { cwd, stratum, allowDirtyWorkspace: true }),
      (error) => error === dispatchError,
    );
    const receipts = calls.filter((call) => call.type === 'usageReport');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].receipt.source, 'main');
    assert.equal(receipts[0].receipt.stepId, 'decompose_gsd');
    assert.deepEqual(receipts[0].receipt.usage, { tokens: 9, usd: 0.02, ms: 5 });
    assert.equal(receipts[0].receipt.usdSource, 'reported');
    const ledger = JSON.parse(readFileSync(join(cwd, '.compose', 'data', 'budget-ledger.json'), 'utf8'));
    assert.equal(ledger.features[code].totalTokens, 9);
    assert.equal(ledger.features[code].totalCostUsd, 0.02);
    assert.equal(calls.filter((call) => call.type === 'stepDone').length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('gate Q&A latches flow exhaustion and skips subsequent dispatches', async () => {
  let dispatches = 0;
  const context = {
    cwd: '/tmp', featureCode: 'F-1', flowId: 'flow-1', receiptsMode: true,
    async recordBuildUsage() { return [{ budget: 'flow_exhausted' }]; },
  };
  const stratum = {
    async runAgentText(_agent, _prompt, opts) {
      dispatches += 1;
      await opts.onUsage([normalizedUsage()]);
      return 'first answer';
    },
  };
  const askAgent = makeAskAgent(stratum, context, { step_id: 'approval' });
  assert.equal(await askAgent('first?'), 'first answer');
  assert.equal(await askAgent('second?'), '(budget exhausted)');
  assert.equal(dispatches, 1);
});

test('bug escalation tier 1 passes an escalation usage callback', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'usage-receipts-escalation-'));
  try {
    const seen = [];
    const context = {
      cwd, mode: 'bug', bug_code: 'BUG-1', step_id: 'retro_check',
      onUsage: async (usage, meta) => seen.push({ usage, meta }),
    };
    const stratum = {
      async runAgentText(_agent, _prompt, opts) {
        await opts.onUsage([normalizedUsage()]);
        return JSON.stringify({ summary: 'ok', findings: [] });
      },
    };
    await tier1CodexReview(stratum, context, 'bug', 'repro', 'diff', []);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].meta.source, 'escalation');
    assert.equal(seen[0].meta.stepId, 'retro_check');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('bug escalation tier 2 passes an escalation usage callback', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'usage-receipts-escalation-t2-'));
  try {
    execSync('git init -q', { cwd });
    execSync('git config user.email t@example.com', { cwd });
    execSync('git config user.name Test', { cwd });
    writeFileSync(join(cwd, 'README.md'), 'x\n');
    execSync('git add README.md && git commit -qm init', { cwd });
    const seen = [];
    const context = {
      cwd, mode: 'bug', bug_code: 'BUG-2', step_id: 'retro_check',
      onUsage: async (usage, meta) => seen.push({ usage, meta }),
    };
    const stratum = {
      async runAgentText(_agent, _prompt, opts) {
        await opts.onUsage([normalizedUsage()]);
        return 'reasoning';
      },
    };
    await tier2FreshAgent(stratum, context, {
      clean: false, summary: 'new hypothesis',
      findings: [{ finding: 'new hypothesis', severity: 'must-fix', confidence: 9 }],
    }, [], null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].meta.source, 'escalation');
    assert.equal(seen[0].meta.stepId, 'retro_check');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runAgentText keeps a provider-reported usd when the engine labels it usdSource beside usage (ConnectorResult)', async () => {
  const client = new StratumMcpClient();
  Object.defineProperty(client, '_testClient', {
    value: {
      async callTool() {
        return mcpResult({
          text: 'answer',
          usage: { usd: 0.02, tokens: 9, ms: 5 },
          usdSource: 'reported',
          telemetry: { model: 'claude-sonnet-4-6', durationMs: 5 },
        });
      },
    },
  });
  const seen = [];
  await client.runAgentText('claude', 'q', { onUsage: (usages) => seen.push(...usages) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cost_usd, 0.02);
  assert.equal(seen[0].usd_source, 'reported');
});

test('runAgentText still drops an unlabelled usd (fail closed)', async () => {
  const client = new StratumMcpClient();
  Object.defineProperty(client, '_testClient', {
    value: {
      async callTool() {
        return mcpResult({
          text: 'answer',
          usage: { usd: 0.02, tokens: 9, ms: 5 },
          telemetry: { model: 'claude-sonnet-4-6', durationMs: 5 },
        });
      },
    },
  });
  const seen = [];
  await client.runAgentText('claude', 'q', { onUsage: (usages) => seen.push(...usages) });
  assert.equal(Object.hasOwn(seen[0], 'cost_usd'), false);
  assert.equal(Object.hasOwn(seen[0], 'usd_source'), false);
});


test('policy revision with unconfirmed termination aborts build before any step settlement', async () => {
  const code = 'BUG-POLICY-CANCEL';
  const memoryDir = seedCanonicalCatalog();
  const cwd = makeBuildWorkspace(code, { compose: { policyCheck: { memoryDir } } });
  let call = 0;
  const uncertainty = Object.assign(new Error('revision still running'), { code: 'CANCELLATION_UNCONFIRMED' });
  const stratum = fakeBuildStratum({
    agentRun: async () => {
      if (++call === 2) throw uncertainty;
      return agentResult({ phase: 'work', outcome: 'complete', summary: 'Want me to continue with the tests?' }, 'policy-main');
    },
  });
  try {
    await assert.rejects(
      runBuild(code, { cwd, stratum, mode: 'bug', template: 'bug-fix', skipTriage: true, description: 'x' }),
      (error) => error === uncertainty,
    );
    assert.equal(call, 2);
    assert.equal(stepDoneEnvelopes(stratum).length, 0, 'never settle while revision termination is unknown');
  } finally {
    _clearCatalogCache();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

for (const [control, receiptsMode] of [
  ['timeout', true], ['timeout', false], ['interrupt', true], ['interrupt', false],
]) {
  test(`review repair ${control} preserves both dispatches in ${receiptsMode ? 'receipts' : 'legacy budget'} mode`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'usage-repair-timeout-'));
    const receipts = receiptStratum();
    const envelopes = [];
    let dispatchCount = 0;
    const ui = Object.assign(new EventEmitter(), {
      stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {}, toolUse() {}, toolSummary() {}, findings() {},
      consumeAction: () => 'skip',
    });
    const stratum = {
      ...receipts, onEvent: () => () => {},
      async agentRun(_agent, _prompt, { signal }) {
        if (++dispatchCount === 1) return {
          text: 'review requires formatting', dispatchId: 'primary-review',
          usage: { tokens: 5, ms: 4 }, telemetry: { model: 'gpt-primary', durationMs: 4 },
        };
        if (control === 'interrupt') queueMicrotask(() => ui.emit('interrupt'));
        return new Promise((_resolve, reject) => {
          const finish = () => reject(Object.assign(new Error('repair stopped'), {
            name: 'AbortError', dispatchId: 'repair-review', usage: { tokens: 3, ms: 2 },
            telemetry: { model: 'gpt-repair', durationMs: 2 },
          }));
          if (signal.aborted) finish();
          else signal.addEventListener('abort', finish, { once: true });
        });
      },
      async stepDone(_flow, _step, envelope) { envelopes.push(envelope); return { status: 'completed', runId: 'flow-1' }; },
      audit: async () => ({}),
    };
    const descriptor = {
      id: 'review/0', step: 'review', flow: 'build', itemIndex: 0, stage: 0,
      generation: 1, attempt: 1, epoch: 1, dispatchToken: 'tok-1',
      agent: 'codex', do: 'review', item: { id: 'T1' }, policy: { isolation: 'none' },
      contract: { root: 'ReviewResult', contracts: { ReviewResult: { summary: 'string', findings: 'array' } } },
    };
    const artifacts = {
      hooks: {}, reconcileDescriptor: () => ({ action: 'execute', worktree: cwd }),
      prepareIssuance: (_descriptor, envelope) => ({ diff: '', envelope }), reconcileAudit() {}, restoreToPreStageWitness() {},
    };
    const seenUsage = [];
    try {
      const running = checkedConsumerAdapter({
        descriptor, flowId: 'flow-1', stratum, artifacts, perItemTimeoutMs: control === 'timeout' ? 30 : 1_000,
        localSpec: { flows: { build: { steps: [{ id: 'review', fanout: { steps: [{ agent: 'codex', do: 'review', out: 'ReviewResult' }] } }] } }, contracts: descriptor.contract.contracts },
        context: { cwd, flowId: 'flow-1', receiptsMode, onUsage: (usage, meta) => {
          seenUsage.push(usage);
          return reportUsageReceipts({ stratum, flowId: 'flow-1', receiptsMode }, usage, meta);
        } },
        progress: ui,
        streamWriter: { write() {} },
      });
      if (control === 'interrupt') await assert.rejects(running, UserInterruptError);
      else await running;
      assert.equal(dispatchCount, 2);
      assert.equal(seenUsage.length, 1);
      assert.deepEqual(seenUsage[0].usages.map((entry) => entry.dispatch_id), ['primary-review', 'repair-review']);
      assert.equal(seenUsage[0].output_tokens, 8);
      assert.equal(envelopes.length, control === 'interrupt' ? 0 : 1);
      if (control === 'timeout') assert.match(envelopes[0].failure, /timed out/i);
      if (receiptsMode) {
        assert.equal(receipts.calls.length, 2);
        assert.deepEqual(receipts.calls.map((entry) => entry.receipt.usage), [{ tokens: 5, ms: 4 }, { tokens: 3, ms: 2 }]);
        if (control === 'timeout') assert.equal(Object.hasOwn(envelopes[0], 'usage'), false);
      } else if (control === 'timeout') {
        assert.deepEqual(envelopes[0].usage, { tokens: 8, ms: 6 });
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

// S1b: canonical receipt bytes originate at the real connector boundary.
for (const streamed of [false, true]) for (const [field, change] of Object.entries({
  cost: r => { r.cost_usd = 99; }, tokens: r => { r.output_tokens += 1; },
  duration: r => { r.duration_ms += 1; }, model: r => { r.model = 'changed-model'; },
  'embedded effort': r => { r.model = 'gpt-5.4/low'; },
  effort: r => { r.effort = 'low'; }, provenance: r => { r.usd_source = 'estimated'; },
  split: r => { r.input_tokens += 1; r.output_tokens -= 1; }, cache: r => { r.cache_read += 1; },
})) test(`real normalizer forwarding refuses contradictory ${field}, streamed=${streamed}`, async t => {
  const { fixture } = await import('./helpers/routing-s1b-fixture.js');
  const { callsForRouting } = await import('../lib/routing-runtime.js');
  const f = fixture(t); const issuance = f.issue();
  const client = new StratumMcpClient(); let deliveries = 0;
  f.context.stratum = { usageReport: async () => { deliveries++; return { status: 'ok' }; } };
  const { realCodexTool } = await import('./helpers/real-codex-tool.js');
  let progressEvents = 0, connectorResult;
  client._testClient = { callTool: realCodexTool({ streamed, onResult: value => { connectorResult = value; } }) };
  const returned = await runAndNormalize(null, 'work', { step_id: 'work', agent: 'codex' }, {
    stratum: client, routingCalls: callsForRouting(f.context, issuance),
    onAgentEvent(event) { if (event.kind === 'step_usage') progressEvents++; },
  });
  assert.equal(progressEvents, streamed ? 1 : 0);
  // Forward the producer's normalized shape, never the stored canonical receipt.
  const original = structuredClone(returned.usages);
  await reportUsageReceipts(f.context, returned.usages);
  const before = deliveries; change(returned.usages[0]);
  await assert.rejects(reportUsageReceipts(f.context, returned.usages), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  assert.equal(deliveries, before);
  await reportUsageReceipts(f.context, original);
  const paid = f.reopen().journal.pendingUsageReceipts.find(p => p.receipt.detail?.routing?.kind === 'paid-call').receipt;
  assert.deepEqual(paid.usage, { tokens: 8, ms: connectorResult.telemetry.durationMs, usd: 0.2 });
  assert.deepEqual(paid.split, { input: 3, output: 5, cacheRead: 2 });
});
for (const transport of ['mcp-streamed', 'mcp-returned', 'local-sdk']) {
  test(`real Claude ${transport} forwarding preserves duration, provenance and token splits`, async t => {
    const { fixture } = await import('./helpers/routing-s1b-fixture.js');
    const { callsForRouting } = await import('../lib/routing-runtime.js');
    const { ClaudeConnector } = await import('../../stratum/ts/dist/connectors/claude.js');
    const f = fixture(t); const issuance = f.issue();
    f.context.stratum = { usageReport: async () => ({ status: 'ok' }) };
    const query = async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' };
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.2, duration_ms: 31,
        usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } };
    };
    const client = new StratumMcpClient();
    client._testClient = { callTool: async ({ arguments: args }, _schema, request) => {
      let seq = 0;
      const producer = new ClaudeConnector({ model: 'claude-sonnet-4-6', query, env: {}, onEvent(event) {
        if (transport === 'mcp-streamed') request.onprogress({ message: JSON.stringify({ schema_version: '0.2.8',
          step_id: '_agent_run', seq: seq++, ts: new Date().toISOString(), kind: event.kind,
          metadata: { ...event.metadata, stepId: '_agent_run' } }) });
      } });
      return mcpResult(await producer.run(args.prompt));
    } };
    const returned = await runAndNormalize(null, 'work', { step_id: 'work', agent: 'claude' }, {
      stratum: client, localExecution: transport === 'local-sdk', localQuery: query,
      routingCalls: callsForRouting(f.context, issuance),
    });
    await reportUsageReceipts(f.context, returned.usages);
    const paid = f.reopen().journal.pendingUsageReceipts.find(p => p.receipt.detail?.routing?.kind === 'paid-call').receipt;
    assert.deepEqual(paid.usage, { tokens: 8, ms: 31, usd: 0.2 });
    assert.equal(paid.usdSource, 'reported');
    assert.deepEqual(paid.split, transport === 'local-sdk' ? { input: 3, output: 5 }
      : { input: 3, output: 5, cacheRead: 2, cacheCreation: 1 });
    for (const field of ['duration_ms', 'input_tokens', 'output_tokens', ...(transport === 'local-sdk' ? [] : ['cache_read', 'cache_creation'])]) {
      const changed = structuredClone(returned.usages); changed[0][field] += 1;
      await assert.rejects(reportUsageReceipts(f.context, changed), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
    }
    const changed = structuredClone(returned.usages); changed[0].usd_source = 'estimated';
    await assert.rejects(reportUsageReceipts(f.context, changed), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  });
}
test('participating receipt entry refuses missing owner journal while legacy no-artifacts calls remain valid', async () => {
  const { flushWaveReceipts, publishConsumerCheckpoint } = await import('../lib/build.js');
  let calls = 0; const context = { routing: {}, receiptsMode: true, flowId: 'r', stratum: { usageReport: async () => { calls++; } } };
  await assert.rejects(reportUsageReceipts(context, normalizedUsage()), { code: 'ROUTING_BINDING_MISSING' });
  await assert.rejects(flushWaveReceipts(context), { code: 'ROUTING_BINDING_MISSING' });
  await assert.rejects(publishConsumerCheckpoint(context, {}), { code: 'ROUTING_BINDING_MISSING' });
  assert.equal(calls, 0);
  await flushWaveReceipts({ artifacts: {} }); await publishConsumerCheckpoint({ artifacts: {} }, {});
});
