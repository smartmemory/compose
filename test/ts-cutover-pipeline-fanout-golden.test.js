/**
 * Golden coverage for the production v1 pipeline cutover.
 *
 * The production YAML files are the fixtures. The TS engine is real; only
 * agent execution is stubbed in the end-to-end cases added below.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import { runBuild, filesOwnedConflict, loadPipelineProfiles } from '../lib/build.js';
import { validateAndRepairTaskGraph, runGsd } from '../lib/gsd.js';
import { checkGsdCumulativeBudget } from '../lib/budget-ledger.js';
import { runAndNormalize, AgentTimeoutError, AgentAbortedError } from '../lib/result-normalizer.js';
import { installFactoryShim } from '../lib/connector-factory-shim.js';
import { resolvePlanSpecValues, resolveStepProfile, StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { resolveAgentConfig } from '../lib/agent-string.js';
import { budgetStateFromLedger } from '../lib/gsd-budget.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TS_MCP_BIN = '/Users/ruze/reg/my/forge/stratum/ts/src/mcp/bin.mjs';
process.env.NODE_ENV = 'test';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function scriptedGateIO(script) {
  const input = new PassThrough();
  const output = new PassThrough();
  let next = 0;
  let rendered = '';
  output.on('data', (chunk) => {
    rendered += chunk.toString();
    const expected = script[next]?.prompt;
    if (expected && rendered.includes(expected)) {
      const line = script[next].line;
      next += 1;
      rendered = '';
      queueMicrotask(() => input.write(`${line}\n`));
    }
  });
  return { input, output, assertConsumed: () => assert.equal(next, script.length) };
}

function productionAgentFactory(invocations) {
  return function factory(_agent, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let payload;
        if (intent.includes('Explore the codebase')) {
          await mkdir(join(cwd, 'docs', 'features', 'PROD-FANOUT'), { recursive: true });
          await writeFile(join(cwd, 'docs', 'features', 'PROD-FANOUT', 'design.md'), '# Design\n');
          payload = { phase: 'design', artifact: 'docs/features/PROD-FANOUT/design.md', outcome: 'complete', summary: 'designed' };
        } else if (intent.includes('implementation blueprint')) {
          await mkdir(join(cwd, 'docs', 'features', 'PROD-FANOUT'), { recursive: true });
          await writeFile(join(cwd, 'docs', 'features', 'PROD-FANOUT', 'blueprint.md'), '# Blueprint\n');
          payload = { phase: 'blueprint', artifact: 'docs/features/PROD-FANOUT/blueprint.md', outcome: 'complete', summary: 'blueprinted' };
        } else if (intent.includes('Verify every file:line')) {
          payload = { phase: 'verification', artifact: 'docs/features/PROD-FANOUT/blueprint.md', outcome: 'complete', summary: 'verified' };
        } else if (intent.includes('ordered implementation plan')) {
          await writeFile(join(cwd, 'docs', 'features', 'PROD-FANOUT', 'plan.md'), '# Plan\n');
          payload = { phase: 'plan', artifact: 'docs/features/PROD-FANOUT/plan.md', outcome: 'complete', summary: 'planned' };
        } else if (intent.includes('decompose it into independent tasks')) {
          payload = {
            tasks: [
              { id: 'task-a', description: 'write a', files_owned: ['src/a.txt'], files_read: [], depends_on: [] },
              { id: 'task-b', description: 'write b', files_owned: ['src/b.txt'], files_read: [], depends_on: [] },
            ],
          };
        } else if (intent.includes('Implement the task described by')) {
          const id = intent.includes('task-a') ? 'task-a' : intent.includes('task-b') ? 'task-b' : null;
          assert.ok(id, `consumer prompt must carry the production task item: ${intent}`);
          await mkdir(join(cwd, 'src'), { recursive: true });
          await writeFile(join(cwd, 'src', `${id.at(-1)}.txt`), `${id}\n`);
          payload = { outcome: 'complete', summary: `${id} done`, files_changed: [`src/${id.at(-1)}.txt`] };
        } else {
          throw new Error(`unexpected production step before execute merge: ${intent}`);
        }
        invocations.push({ intent, cwd, payload });
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// A fake `codex` executable for the exec transport: the CodexConnector spawns
// `codex exec --json ...`, streams JSONL, and keeps the agent_message text +
// turn.completed usage. This lets a test drive the REAL engine agent_run seam
// (contract validation + connector) with no live agent runtime.
async function installFakeCodex(binDir, text = 'stub reply') {
  const fakeCodex = join(binDir, 'codex');
  await writeFile(
    fakeCodex,
    '#!/bin/bash\n'
    + 'cat > /dev/null\n'
    + `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"${text}"}}'\n`
    + "printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":7}}'\n",
  );
  await chmod(fakeCodex, 0o755);
  return fakeCodex;
}

const GSD_BLUEPRINT = `# GSD-E2E: Blueprint

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`contracts/foo.json\` | new | Foo contract |
| \`lib/bar.js\` | new | Bar module |

## Boundary Map

### S01: Foo contract

File Plan: \`contracts/foo.json\` (new)

Produces:
  contracts/foo.json → Foo (type)

Consumes: nothing

### S02: Bar implementation

File Plan: \`lib/bar.js\` (new)

Produces:
  lib/bar.js → bar (function)

Consumes:
  from S01: contracts/foo.json → Foo
`;

// Factory-shim agent for a real runGsd on the TS bin: decompose returns two
// disjoint tasks; each execute item writes its owned file + the TaskResult JSON
// to the EXACT compose-rendered path, and reports token usage.
function gsdAgentFactory(invocations) {
  const owner = { T01: 'contracts/foo.json', T02: 'lib/bar.js' };
  return function factory(_agent, { cwd }) {
    return {
      async *run(prompt) {
        let payload;
        if (/decompose it into independent tasks/i.test(prompt)) {
          payload = {
            tasks: [
              { id: 'T01', files_owned: ['contracts/foo.json'], files_read: [], depends_on: [], description: '' },
              { id: 'T02', files_owned: ['lib/bar.js'], files_read: ['contracts/foo.json'], depends_on: ['T01'], description: '' },
            ],
          };
        } else if (/Implement the task described by/i.test(prompt)) {
          const taskId = prompt.match(/results\/(T\d+)\.json/)?.[1];
          assert.ok(taskId, `execute prompt must carry the exact TaskResult path: ${prompt.slice(0, 400)}`);
          const ownedFile = owner[taskId];
          await mkdir(dirname(join(cwd, ownedFile)), { recursive: true });
          await writeFile(join(cwd, ownedFile), `// ${taskId}\n`);
          const resultRel = `.compose/gsd/GSD-E2E/results/${taskId}.json`;
          await mkdir(dirname(join(cwd, resultRel)), { recursive: true });
          await writeFile(join(cwd, resultRel), JSON.stringify({
            status: 'passed', files_changed: [ownedFile], summary: `${taskId} done`,
            produces: {}, gates: [{ command: 'pnpm build', status: 'pass', output: '' }], attempts: 1,
          }, null, 2));
          payload = { outcome: 'complete', summary: `${taskId} done`, files_changed: [ownedFile, resultRel] };
        } else {
          payload = { outcome: 'complete', summary: 'noop' };
        }
        invocations.push({ payload });
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'usage', input_tokens: 30, output_tokens: 0, cost_usd: 0.02, model: 'claude-test' };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

describe('GSD end-to-end on the TS route (D7b)', () => {
  test('decompose → consumer fanout (2 items) → merge approve, with usage debited', async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-gsd-e2e-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-gsd-state-'));
    const client = new StratumMcpClient();
    const invocations = [];
    t.after(async () => {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    });

    await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
    await mkdir(join(workspace, 'docs', 'features', 'GSD-E2E'), { recursive: true });
    await writeFile(join(workspace, 'docs', 'features', 'GSD-E2E', 'blueprint.md'), GSD_BLUEPRINT);
    // gsd.budget config: a per_task_ms ceiling (D2a) + a generous cumulative cap.
    await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({
      version: 2,
      gsd: { budget: { per_task_ms: 60000, cumulative: { max_total_tokens: 100000 } } },
    }));
    await writeFile(join(workspace, '.gitignore'), '.compose/data/locks/\n');
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test']);
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-m', 'baseline']);

    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      cwd: workspace,
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });
    installFactoryShim(client, gsdAgentFactory(invocations), workspace);

    const result = await runGsd('GSD-E2E', {
      cwd: workspace,
      stratum: client,
      gateCommands: ['true'],
      preMergeGate: ['true'],
    });

    if (result.status !== 'complete' && result.flowId) {
      const audit = await client.audit(result.flowId);
      const evs = audit.events
        .filter((e) => e.stepId === 'execute' && (e.detail?.failure || /fail|reject/i.test(e.type)))
        .map((e) => ({ t: e.type, idx: e.detail?.itemIndex, reason: e.detail?.failure?.reason ?? e.detail?.reason }));
      throw new Error(`runGsd not complete: ${JSON.stringify({ result, evs, invocations: invocations.length }).slice(0, 1200)}`);
    }
    assert.equal(result.status, 'complete', `runGsd should complete: ${JSON.stringify(result)}`);
    // Two items executed and their exact-path TaskResults landed in the blackboard.
    assert.ok(result.blackboardEntries >= 2, `expected >=2 blackboard entries, got ${result.blackboardEntries}`);
    const t01 = JSON.parse(await readFile(join(workspace, '.compose', 'gsd', 'GSD-E2E', 'results', 'T01.json'), 'utf8'));
    assert.equal(t01.summary, 'T01 done');
    // D2(b): each consumer item's usage debited the cumulative ledger.
    const usage = checkGsdCumulativeBudget(join(workspace, '.compose'), 'GSD-E2E', {}).usage;
    assert.ok(usage.totalTokens >= 60, `cumulative ledger must debit both items' tokens, got ${usage.totalTokens}`);
    assert.ok(usage.totalCostUsd > 0, 'cumulative ledger must debit cost');
  });
});

describe('controlled claude execution runs on the local connector (V2/V3)', () => {
  test('a read-only review profile binds allowedTools at the local execution seam (V3)', async () => {
    let capturedOptions = null;
    const stubQuery = ({ options }) => {
      capturedOptions = options;
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: '{"clean":true}', total_cost_usd: 0, usage: {}, duration_ms: 1 };
      })();
    };
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async () => { throw new Error('controlled claude must NOT use the engine agent_run seam'); },
    };
    const dispatch = { step_id: 'review_lenses', flow_id: 'f', agent: 'claude', output_fields: { clean: 'boolean' } };
    await runAndNormalize(null, 'p', dispatch, {
      stratum, profile: 'claude:read-only-reviewer', localExecution: true, localQuery: stubQuery,
    });
    // The restriction binds WHERE EXECUTION HAPPENS (the SDK options), not a mock echo.
    assert.deepEqual(capturedOptions.allowedTools, ['Read', 'Grep', 'Glob', 'Agent']);
    assert.deepEqual(capturedOptions.disallowedTools, ['Edit', 'Write', 'Bash']);
    assert.ok(!capturedOptions.allowedTools.includes('Edit'));
    assert.ok(!capturedOptions.allowedTools.includes('Write'));
    assert.ok(!capturedOptions.allowedTools.includes('Bash'));
  });

  test('a hanging agent on the local path is stopped by the per-item timeout (V2)', async () => {
    const stubQuery = ({ options }) => (async function* () {
      // Block until the connector's AbortController fires (the timeout), then
      // surface AbortError — exactly how the real SDK aborts.
      await new Promise((_, reject) => {
        options.abortController.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      yield { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, usage: {}, duration_ms: 1 };
    })();
    const stratum = { onEvent: () => () => {}, cancelAgentRun: async () => {}, agentRun: async () => { throw new Error('should not reach engine'); } };
    const dispatch = { step_id: 'review_lenses', flow_id: 'f', agent: 'claude', output_fields: { clean: 'boolean' } };
    await assert.rejects(
      runAndNormalize(null, 'p', dispatch, {
        stratum, profile: 'claude:read-only-reviewer', localExecution: true, localQuery: stubQuery, maxDurationMs: 50,
      }),
      (err) => err instanceof AgentTimeoutError,
    );
  });

  test('a stuck verdict on the local path aborts the run (V2/D3 on the real seam)', async () => {
    const stubQuery = ({ options }) => (async function* () {
      // Emit two same-file edits, then hang until aborted.
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x.js' } }] } };
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x.js' } }] } };
      await new Promise((_, reject) => {
        const sig = options.abortController.signal;
        // The stuck abort may have fired synchronously as the 2nd edit streamed.
        if (sig.aborted) return reject(new DOMException('aborted', 'AbortError'));
        sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      yield { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, usage: {}, duration_ms: 1 };
    })();
    const stratum = { onEvent: () => () => {}, cancelAgentRun: async () => {}, agentRun: async () => { throw new Error('should not reach engine'); } };
    const dispatch = { step_id: 'review_lenses', flow_id: 'f', agent: 'claude', output_fields: { clean: 'boolean' } };
    let toolEvents = 0;
    await assert.rejects(
      runAndNormalize(null, 'p', dispatch, {
        stratum, profile: 'claude:read-only-reviewer', localExecution: true, localQuery: stubQuery,
        onAgentEvent: (env) => {
          if (env.kind !== 'tool_use_summary') return null;
          toolEvents += 1;
          return toolEvents >= 2 ? { stuck: true, signal: 'same_file' } : null;
        },
      }),
      (err) => err instanceof AgentAbortedError && err.reason?.signal === 'same_file',
    );
  });
});

describe('usage reaches the engine ledger (V1)', () => {
  test('an item whose reported usage exceeds gsd.budget.max_tokens trips the ENGINE budget', async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-v1-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-v1-state-'));
    const client = new StratumMcpClient();
    t.after(async () => {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    });

    await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
    await mkdir(join(workspace, 'docs', 'features', 'GSD-E2E'), { recursive: true });
    await writeFile(join(workspace, 'docs', 'features', 'GSD-E2E', 'blueprint.md'), GSD_BLUEPRINT);
    // A flow token budget (10) far below what a single item reports (30 tokens).
    // The engine only sees that overrun if compose reports usage in the envelope.
    await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({
      version: 2, gsd: { budget: { max_tokens: 10 } },
    }));
    await writeFile(join(workspace, '.gitignore'), '.compose/data/locks/\n');
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test']);
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-m', 'baseline']);

    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      cwd: workspace,
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });
    installFactoryShim(client, gsdAgentFactory([]), workspace);

    const result = await runGsd('GSD-E2E', {
      cwd: workspace, stratum: client, gateCommands: ['true'], preMergeGate: ['true'],
    });

    // The engine tripped its OWN flow budget from the reported usage — without
    // usage in the envelope it would run to completion instead.
    assert.equal(result.status, 'budget', `expected engine budget_exhausted, got ${JSON.stringify(result)}`);
    assert.equal(result.axis, 'max_tokens');
    assert.ok((result.consumed?.tokens ?? 0) >= 10, `engine ledger must show the token debit, got ${JSON.stringify(result.consumed)}`);
  });
});

describe('agent execution uses the TS stratum_agent_run wire shape (D1)', () => {
  test('agentRun drives the real TS agent_run seam and returns text + usage', async (t) => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-d1-state-'));
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-d1-cwd-'));
    const binDir = await mkdtemp(join(tmpdir(), 'compose-ts-d1-bin-'));
    await installFakeCodex(binDir);
    const client = new StratumMcpClient();
    t.after(async () => {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    });
    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      cwd: workspace,
      env: {
        ...process.env,
        STRATUM_STATE_ROOT: stateRoot,
        STRATUM_CODEX_TRANSPORT: 'exec',
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });
    // Python-era request shape ({type,...}) is rejected by the TS contract with
    // 'request.type is undeclared'; the TS shape ({agent,prompt,cwd,...}) passes
    // and reaches the connector.
    const result = await client.agentRun('codex', 'do the thing', { cwd: workspace });
    assert.equal(result.text, 'stub reply');
    assert.ok(result.usage, 'TS complete response must carry usage for budget debiting');
  });
});

describe('GSD budgets on the TS route (D2)', () => {
  test('runAndNormalize threads the TS agent_run usage instead of dropping it (D2b)', async () => {
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async () => ({
        status: 'complete',
        text: '{"outcome":"complete","summary":"ok"}',
        usage: { tokens: 42, usd: 0.031, ms: 250 },
        telemetry: { model: 'claude-test' },
      }),
    };
    const dispatch = { step_id: 's', flow_id: 'f', agent: 'claude', output_fields: { outcome: 'string', summary: 'string' } };
    const { usage } = await runAndNormalize(null, 'p', dispatch, { stratum });
    const totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    assert.equal(totalTokens, 42, 'TS agent_run token usage must be threaded (not dropped)');
    assert.equal(usage.cost_usd, 0.031, 'TS agent_run cost must be threaded');
    assert.equal(usage.model, 'claude-test');
  });

  test('a per-item wall-clock limit expires an agent run and surfaces AgentTimeoutError (D2a)', async () => {
    let cancel;
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => { cancel?.(); },
      agentRun: () => new Promise((resolve) => { cancel = () => resolve({ text: '' }); }),
    };
    const dispatch = { step_id: 's', flow_id: 'f', agent: 'claude', output_fields: { outcome: 'string' } };
    await assert.rejects(
      runAndNormalize(null, 'p', dispatch, { stratum, maxDurationMs: 30 }),
      (err) => err instanceof AgentTimeoutError,
    );
  });

  test('budgetStateFromLedger maps the TS ledger to the legacy diagnostic shape (D2c)', () => {
    const state = budgetStateFromLedger({
      spent: { tokens: 1200, usd: 0.4, dispatches: 3, ms: 5000 },
      budget: { tokens: 1000, usd: 1, ms: 60000 },
    });
    assert.equal(state.consumed.tokens, 1200);
    assert.equal(state.consumed.dollars, 0.4);
    assert.equal(state.consumed.dispatches, 3);
    assert.equal(state.consumed.wall_s, 5);
    assert.equal(state.caps.max_tokens, 1000);
    assert.equal(state.caps.usd, 1);
    assert.equal(state.caps.ms, 60000);
  });
});

describe('stuck detection on the TS route (D3)', () => {
  test('runAndNormalize aborts an in-flight run when an observer trips (stuck wiring)', async () => {
    let cancel;
    let handler;
    const stratum = {
      onEvent: (_f, _s, h) => { handler = h; return () => {}; },
      cancelAgentRun: async () => { cancel?.(); },
      agentRun: () => {
        // Stream two same-file edits, then hang until the observer cancels.
        queueMicrotask(() => {
          handler?.({ schema_version: '0.2.5', kind: 'tool_use_summary', metadata: { tool: 'Edit', input: { file_path: 'x.js' } } });
          handler?.({ schema_version: '0.2.5', kind: 'tool_use_summary', metadata: { tool: 'Edit', input: { file_path: 'x.js' } } });
        });
        return new Promise((resolve) => { cancel = () => resolve({ text: '' }); });
      },
    };
    const dispatch = { step_id: 'execute', flow_id: 'f', agent: 'claude', output_fields: { outcome: 'string' } };
    let toolEvents = 0;
    await assert.rejects(
      runAndNormalize(null, 'p', dispatch, {
        stratum,
        onAgentEvent: (env) => {
          if (env.kind !== 'tool_use_summary') return null;
          toolEvents += 1;
          return toolEvents >= 2 ? { stuck: true, signal: 'same_file', detail: 'x.js edited twice' } : null;
        },
      }),
      (err) => err instanceof AgentAbortedError && err.reason?.signal === 'same_file',
    );
  });
});

describe('deterministic file_exists ensures on ordinary steps (D4)', () => {
  test('the restored ensures are present on the production ordinary steps', async () => {
    const YAML = (await import('yaml')).default;
    const spec = YAML.parse(await readFile(join(ROOT, 'pipelines', 'build.stratum.yaml'), 'utf8'));
    const steps = spec.flows.build.steps;
    for (const id of ['explore_design', 'blueprint', 'plan']) {
      const step = steps.find((s) => s.id === id);
      const exprs = (step.ensure ?? []).map((e) => e.expr).filter(Boolean);
      assert.ok(
        exprs.some((e) => e.includes('file_exists(result.artifact)')),
        `ordinary step ${id} must carry the deterministic file_exists(result.artifact) ensure`,
      );
    }
  });

  test('a file_exists(result.artifact) ensure rejects a claimed-complete-with-missing-artifact stub', async (t) => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-d4-state-'));
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-d4-cwd-'));
    const client = new StratumMcpClient();
    t.after(async () => {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });
    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      cwd: workspace,
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });
    const spec = {
      version: 1,
      contracts: { R: { artifact: 'string', outcome: 'string' } },
      flows: {
        entry: 'm',
        m: {
          input: {},
          output: { from: '${s.output}', contract: 'R' },
          steps: [{
            id: 's', agent: 'claude', do: 'produce an artifact', out: 'R', attempts: 1,
            ensure: [{ expr: 'file_exists(result.artifact)' }],
          }],
        },
      },
    };
    const planned = await client.plan(spec, 'm', {}, { workspaceRoot: workspace });
    const ready = planned.ready[0];
    // The agent claims a complete artifact that was never written to disk.
    const res = await client.stepDone(
      planned.runId, 's', { output: { artifact: 'docs/never-written.md', outcome: 'complete' } },
      ready.epoch, ready.dispatchToken,
    );
    assert.notEqual(res.status, 'completed', 'a missing artifact must NOT satisfy file_exists');
    assert.notEqual(res.status, 'ready', 'the step must not advance on a failed deterministic ensure');
  });

  test('a file_exists(result.artifact) ensure accepts a genuinely-written artifact (control)', async (t) => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-d4b-state-'));
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-d4b-cwd-'));
    const client = new StratumMcpClient();
    t.after(async () => {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });
    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      cwd: workspace,
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });
    const spec = {
      version: 1,
      contracts: { R: { artifact: 'string', outcome: 'string' } },
      flows: {
        entry: 'm',
        m: {
          input: {}, output: { from: '${s.output}', contract: 'R' },
          steps: [{ id: 's', agent: 'claude', do: 'x', out: 'R', attempts: 1, ensure: [{ expr: 'file_exists(result.artifact)' }] }],
        },
      },
    };
    await mkdir(join(workspace, 'docs'), { recursive: true });
    await writeFile(join(workspace, 'docs', 'written.md'), '# real\n');
    const planned = await client.plan(spec, 'm', {}, { workspaceRoot: workspace });
    const ready = planned.ready[0];
    const res = await client.stepDone(
      planned.runId, 's', { output: { artifact: 'docs/written.md', outcome: 'complete' } },
      ready.epoch, ready.dispatchToken,
    );
    assert.equal(res.status, 'completed', 'a written artifact must satisfy file_exists');
  });
});

describe('profile sidecar restores tool restrictions (D6)', () => {
  test('the build profile sidecar maps the review fanout to the read-only reviewer', () => {
    const profiles = loadPipelineProfiles(join(ROOT, 'pipelines', 'build.stratum.yaml'));
    assert.equal(profiles.review_lenses, 'claude:read-only-reviewer');
    assert.equal(profiles.blueprint, 'claude::critical');
    assert.equal(profiles.review_merge, 'claude:orchestrator');
  });

  test('a read-only profile makes the agent invocation carry read-only tool restrictions', async () => {
    let captured = null;
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async (agentType, prompt, opts) => {
        captured = { agentType, opts };
        return { text: '{"clean": true}', usage: {} };
      },
    };
    const dispatch = { step_id: 'review_lenses', flow_id: 'f', agent: 'claude', output_fields: { clean: 'boolean' } };
    await runAndNormalize(null, 'p', dispatch, { stratum, profile: 'claude:read-only-reviewer' });
    assert.deepEqual(captured.opts.allowedTools, ['Read', 'Grep', 'Glob', 'Agent']);
    assert.deepEqual(captured.opts.disallowedTools, ['Edit', 'Write', 'Bash']);
    assert.equal(captured.opts.sandboxMode, 'read-only', 'a read-only profile binds a read-only sandbox');
  });

  test('a bare provider literal (no profile) carries no tool restrictions', async () => {
    let captured = null;
    const stratum = {
      onEvent: () => () => {},
      cancelAgentRun: async () => {},
      agentRun: async (agentType, prompt, opts) => { captured = { agentType, opts }; return { text: '{}', usage: {} }; },
    };
    const dispatch = { step_id: 'execute', flow_id: 'f', agent: 'claude', output_fields: { outcome: 'string' } };
    await runAndNormalize(null, 'p', dispatch, { stratum });
    assert.equal(captured.opts.allowedTools, undefined);
    assert.equal(captured.opts.sandboxMode, undefined);
  });
});

describe('runtime tier profiles + scoped-id lookup (V4)', () => {
  test('resolvePlanSpecValues records a stripped runtime tier profile for the fanout step', () => {
    const spec = {
      version: 1,
      contracts: { R: { value: 'string' } },
      flows: {
        entry: 'main',
        main: {
          input: { implementer_agent: 'string' },
          output: { from: '${fan.output[0]}', contract: 'R' },
          steps: [{
            id: 'fan',
            fanout: {
              over: '${input.implementer_agent}', dispatch: 'consumer', concurrency: 1,
              isolation: 'worktree', require: 'all', merge: 'sequential',
              steps: [{ agent: '$.input.implementer_agent', do: 'work ${item}', out: 'R' }],
            },
          }],
        },
      },
    };
    const runtimeProfiles = {};
    const resolved = resolvePlanSpecValues(spec, { implementer_agent: 'claude::critical' }, runtimeProfiles);
    // Engine gets the bare literal; compose keeps the full tier string.
    assert.equal(resolved.flows.main.steps[0].fanout.steps[0].agent, 'claude');
    assert.equal(runtimeProfiles.fan, 'claude::critical');
    // The recovered profile resolves to the critical model tier (not bare claude).
    assert.notEqual(resolveAgentConfig('claude::critical').modelID, resolveAgentConfig('claude').modelID);
  });

  test('a bare provider literal records no runtime profile', () => {
    const spec = {
      version: 1,
      contracts: { R: { value: 'string' } },
      flows: {
        entry: 'main',
        main: {
          input: { implementer_agent: 'string' },
          output: { from: '${s.output}', contract: 'R' },
          steps: [{ id: 's', agent: '$.input.implementer_agent', do: 'x', out: 'R' }],
        },
      },
    };
    const runtimeProfiles = {};
    resolvePlanSpecValues(spec, { implementer_agent: 'claude' }, runtimeProfiles);
    assert.deepEqual(runtimeProfiles, {});
  });

  test('resolveStepProfile normalizes a scoped subflow ready id to the bare step id', () => {
    const profiles = { run_tests: 'claude::fast', blueprint: 'claude::critical' };
    assert.equal(resolveStepProfile(profiles, 'run_tests'), 'claude::fast');
    assert.equal(resolveStepProfile(profiles, 'coverage_check/run_tests'), 'claude::fast');
    assert.equal(resolveStepProfile(profiles, 'coverage/run_tests'), 'claude::fast');
    assert.equal(resolveStepProfile(profiles, 'nonexistent'), undefined);
  });
});

describe('deterministic file-ownership at the decompose seam (D5)', () => {
  test('filesOwnedConflict passes disjoint sets and flags an overlap with a clear reason', () => {
    assert.equal(
      filesOwnedConflict([
        { id: 't1', files_owned: ['a.js', 'b.js'] },
        { id: 't2', files_owned: ['c.js'] },
      ]),
      null,
    );
    const reason = filesOwnedConflict([
      { id: 't1', files_owned: ['a.js', 'shared.js'] },
      { id: 't2', files_owned: ['shared.js'] },
    ]);
    assert.match(reason ?? '', /shared\.js/);
    assert.match(reason ?? '', /t1/);
    assert.match(reason ?? '', /t2/);
  });

  test('filesOwnedConflict compares the FILE, not the spelling (V5 normalization)', () => {
    const reason = filesOwnedConflict([
      { id: 't1', files_owned: ['src/x.js'] },
      { id: 't2', files_owned: ['./src/x.js'] },
      { id: 't3', files_owned: ['src/../src/x.js'] },
    ]);
    assert.match(reason ?? '', /src\/x\.js/);
    // A genuinely different file with a cosmetic-looking path stays disjoint.
    assert.equal(
      filesOwnedConflict([
        { id: 't1', files_owned: ['src/a.js'] },
        { id: 't2', files_owned: ['./src/b.js'] },
      ]),
      null,
    );
  });

  test('validateAndRepairTaskGraph rejects overlapping decompose output (gsd seam)', () => {
    assert.throws(
      () => validateAndRepairTaskGraph(
        {
          tasks: [
            { id: 'T01', files_owned: ['lib/x.js'], files_read: [], depends_on: [] },
            { id: 'T02', files_owned: ['lib/x.js'], files_read: [], depends_on: [] },
          ],
        },
        '# blueprint\n',
        ['pnpm build'],
      ),
      /file-ownership conflict/i,
    );
  });
});

describe('production pipelines plan on the TS engine', () => {
  test('the full production build spec passes plan validation', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-production-plan-'));
    const client = new StratumMcpClient();
    try {
      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });
      const spec = await readFile(join(ROOT, 'pipelines', 'build.stratum.yaml'), 'utf8');
      const planned = await client.plan(spec, 'build', {
        featureCode: 'STRAT-TS-FANOUT-CONSUMER',
        description: 'production pipeline cutover smoke',
        implementer_agent: 'claude',
        reviewer_agent: 'codex',
        pre_merge_gate: ['node --test'],
      });
      assert.equal(planned.status, 'ready');
      assert.ok(planned.runId);
    } finally {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('the full production GSD spec passes plan validation', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-production-gsd-plan-'));
    const client = new StratumMcpClient();
    try {
      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });
      const spec = await readFile(join(ROOT, 'pipelines', 'gsd.stratum.yaml'), 'utf8');
      const planned = await client.plan(spec, 'gsd', {
        featureCode: 'STRAT-TS-FANOUT-CONSUMER',
        gateCommands: ['node --test'],
        pre_merge_gate: ['node --check lib/gsd.js'],
      });
      assert.equal(planned.status, 'ready');
      assert.equal(planned.ready[0].id, 'decompose_gsd');
    } finally {
      await client.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test('producer resolution clones the spec and substitutes literal fanout policy values', async () => {
    const source = {
      version: 1,
      contracts: { Result: { value: 'string' } },
      flows: {
        entry: 'main',
        main: {
          input: { implementer_agent: 'string', pre_merge_gate: 'string[]?' },
          output: { from: '${fan.output[0]}', contract: 'Result' },
          steps: [{
            id: 'fan',
            fanout: {
              over: '${input.pre_merge_gate}', dispatch: 'consumer', concurrency: 1,
              isolation: 'worktree', require: 'all', merge: 'sequential',
              pre_merge: '$.input.pre_merge_gate',
              steps: [{ agent: '$.input.implementer_agent', do: 'work ${item}', out: 'Result' }],
            },
          }],
        },
      },
    };
    const resolved = resolvePlanSpecValues(source, {
      implementer_agent: 'codex',
      pre_merge_gate: ['npm run lint', 'npm run build'],
    });
    assert.equal(resolved.flows.main.steps[0].fanout.steps[0].agent, 'codex');
    assert.deepEqual(resolved.flows.main.steps[0].fanout.pre_merge, ['npm run lint', 'npm run build']);
    assert.equal(source.flows.main.steps[0].fanout.steps[0].agent, '$.input.implementer_agent');
    assert.equal(source.flows.main.steps[0].fanout.pre_merge, '$.input.pre_merge_gate');
  });

  test('the production execute fanout revises once, reruns, approves, and lands both diffs', async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-ts-production-fanout-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-ts-production-state-'));
    const artifactRoot = await mkdtemp(join(tmpdir(), 'compose-ts-production-artifacts-'));
    const client = new StratumMcpClient();
    const invocations = [];
    t.after(async () => {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    });

    await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
    await mkdir(join(workspace, 'pipelines'), { recursive: true });
    await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
    await writeFile(
      join(workspace, '.compose', 'data', 'settings.json'),
      JSON.stringify({ policies: { design_gate: 'flag', plan_gate: 'flag', execute_merge: 'gate', review_lenses_gate: 'flag', ship_gate: 'flag' } }),
    );
    await writeFile(
      join(workspace, 'pipelines', 'build.stratum.yaml'),
      await readFile(join(ROOT, 'pipelines', 'build.stratum.yaml'), 'utf8'),
    );
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test']);
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-m', 'baseline']);

    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      cwd: workspace,
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });
    installFactoryShim(client, productionAgentFactory(invocations), workspace);
    const io = scriptedGateIO([
      { prompt: '\n> ', line: 'r' },
      { prompt: 'Rationale: ', line: 'rerun the production fanout' },
      { prompt: '\n> ', line: 'a' },
    ]);

    let stopError;
    let runResult;
    try {
      runResult = await runBuild('PROD-FANOUT', {
        cwd: workspace,
        stratum: client,
        template: 'build',
        skipTriage: true,
        description: 'production fanout golden',
        preMergeGate: [],
        consumerArtifactsRoot: artifactRoot,
        gateOpts: { input: io.input, output: io.output },
        consumerCrashHooks: {
          afterGateResolve({ gateStepId, outcome }) {
            if (gateStepId === 'execute_merge' && outcome === 'approve') {
              throw new Error('production fanout golden stop after approve');
            }
          },
        },
      });
    } catch (error) {
      stopError = error;
    }
    if (!stopError) {
      const debugActive = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN],
        cwd: workspace,
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });
      const debugAudit = await client.audit(debugActive.flowId);
      throw new Error(`production fanout did not reach approve: ${JSON.stringify({ runResult, debugAudit })}`);
    }
    assert.match(stopError.message, /production fanout golden stop after approve/);
    io.assertConsumed();
    assert.equal(await readFile(join(workspace, 'src', 'a.txt'), 'utf8'), 'task-a\n');
    assert.equal(await readFile(join(workspace, 'src', 'b.txt'), 'utf8'), 'task-b\n');
    assert.equal(
      invocations.filter(({ intent }) => intent.includes('Implement the task described by')).length,
      4,
      'two realistic items must run in both the revise and repair generations',
    );
    const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      cwd: workspace,
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });
    const audit = await client.audit(active.flowId);
    assert.deepEqual(
      audit.events
        .filter((event) => event.type === 'gate_resolved' && event.stepId === 'execute_merge')
        .map((event) => event.detail.decision),
      ['revise', 'approve'],
    );
  });
});
