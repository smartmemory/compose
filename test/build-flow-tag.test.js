/**
 * COMP-BUILD-CANCEL S03-3/S03-4/S03-5b/S03-6 — driver tagging.
 *
 * Every agent a build dispatches while its flow is running carries
 * `flow: {runId, stepId?, itemIndex?}`, so `stratum_flow_cancel` can find and kill it
 * from another process. The tag is supplied by the call site, never inferred (C1).
 *
 * Requests are captured at the client's `agentRun`/`runAgentText` seam. That the seam's
 * `opts.flow` reaches the wire request is pinned separately, by
 * test/stratum-flow-cancel-client.test.js (S02, `buildAgentRunRequest`).
 */

process.env.NODE_ENV = 'test';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBuild, makeAskAgent } from '../lib/build.js';
import { flowTag, lookupBuildCancel, createBuildCancel } from '../lib/build-cancel.js';
import { preflightCodexWorktreeProbe } from '../lib/codex-preflight.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('flowTag — the one place a dispatch is decided to be tagged (S03-6)', () => {
  test('builds the tag from a run id, a step id and a numeric item index', () => {
    assert.deepEqual(flowTag('run-1', 'fan', 2), { runId: 'run-1', stepId: 'fan', itemIndex: 2 });
    assert.deepEqual(flowTag('run-1', 'work'), { runId: 'run-1', stepId: 'work' });
    assert.deepEqual(flowTag('run-1'), { runId: 'run-1' });
  });

  test('omits itemIndex rather than sending null — the server default-denies the shape', () => {
    assert.deepEqual(flowTag('run-1', 'fan', null), { runId: 'run-1', stepId: 'fan' });
    assert.deepEqual(flowTag('run-1', 'fan', undefined), { runId: 'run-1', stepId: 'fan' });
    assert.deepEqual(flowTag('run-1', 'fan', 0), { runId: 'run-1', stepId: 'fan', itemIndex: 0 });
  });

  test('no run id means no tag — a flow-less dispatch is never tagged', () => {
    assert.equal(flowTag(null, 'work'), undefined);
    assert.equal(flowTag(undefined, 'work'), undefined);
  });

  test('COMPOSE_FLOW_TAGGING=0 drops the tag, and with it the flow-driven cancellationId', () => {
    const prior = process.env.COMPOSE_FLOW_TAGGING;
    process.env.COMPOSE_FLOW_TAGGING = '0';
    try {
      assert.equal(flowTag('run-1', 'work', 1), undefined);
    } finally {
      if (prior === undefined) delete process.env.COMPOSE_FLOW_TAGGING;
      else process.env.COMPOSE_FLOW_TAGGING = prior;
    }
  });

  test('a request built without a flow and without a signal mints no cancellationId', async () => {
    const client = new StratumMcpClient();
    const seen = [];
    Object.defineProperty(client, '_testClient', {
      configurable: true,
      value: {
        async callTool({ arguments: args }) {
          seen.push(args);
          return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok' }) }] };
        },
      },
    });
    await client.runAgentText('claude', 'q', { telemetry: { site: 'gate-qa' } });
    assert.equal(seen[0].flow, undefined, 'byte-identical to a pre-feature request');
    assert.equal(seen[0].cancellationId, undefined);
  });
});

describe('the gate Q&A agent (R1: tagged, conditionally)', () => {
  function recordingStratum() {
    const calls = [];
    return {
      calls,
      async runAgentText(agentType, prompt, opts) { calls.push({ agentType, opts }); return 'an answer'; },
    };
  }

  test('a gate question carries flow: {runId, stepId} when the build has a flow id', async () => {
    const stratum = recordingStratum();
    const context = { cwd: process.cwd(), featureCode: 'COMP-X', flowId: 'run-77', stepHistory: [] };
    const askAgent = makeAskAgent(stratum, context, { step_id: 'approval' });
    assert.equal(await askAgent('why?'), 'an answer');
    assert.deepEqual(stratum.calls[0].opts.flow, { runId: 'run-77', stepId: 'approval' });
  });

  test('falls back to the dispatch id when the gate carries no step_id', async () => {
    const stratum = recordingStratum();
    const context = { cwd: process.cwd(), featureCode: 'COMP-X', flowId: 'run-77', stepHistory: [] };
    const askAgent = makeAskAgent(stratum, context, { id: 'review_gate' });
    await askAgent('why?');
    assert.deepEqual(stratum.calls[0].opts.flow, { runId: 'run-77', stepId: 'review_gate' });
  });

  test('a context with no flowId emits NO flow key — makeAskAgent is called that way in tests', async () => {
    const stratum = recordingStratum();
    const context = { cwd: process.cwd(), featureCode: 'COMP-X', stepHistory: [] };
    const askAgent = makeAskAgent(stratum, context, { step_id: 'approval' });
    await askAgent('why?');
    assert.equal(stratum.calls[0].opts.flow, undefined);
  });
});

describe('the flow-less callers stay untagged, deliberately', () => {
  test('no dispatch in the five flow-less modules passes a flow option', () => {
    for (const file of ['bug-escalation.js', 'codex-preflight.js', 'import.js', 'step-validator.js', 'new.js']) {
      const source = readFileSync(join(REPO_ROOT, 'lib', file), 'utf8');
      assert.equal(/^\s*flow:/m.test(source), false, `${file} must not tag its dispatches`);
      assert.equal(/flowTag\(/.test(source), false, `${file} must not import the tag helper`);
    }
  });
});

describe('the Codex worktree preflight aborts with the build (C36/C51)', () => {
  test('a never-settling probe rejects when the build cancel fires', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'compose-preflight-'));
    const buildCancel = createBuildCancel();
    try {
      const stratum = {
        async runAgentText(_agent, _prompt, opts) {
          // Never settles on its own. Only the chained signal ends it.
          return new Promise((_resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (opts.signal?.aborted) onAbort();
            else opts.signal?.addEventListener('abort', onAbort, { once: true });
          });
        },
      };
      const probing = preflightCodexWorktreeProbe({
        cwd: REPO_ROOT,
        projectCwd: REPO_ROOT,
        buildId: 'build-1',
        featureCode: 'COMP-X',
        stratum,
        dataDir,
        ts: `flowtag-${Date.now()}`,
        force: true,
        signal: buildCancel.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      buildCancel.cancel('signal:SIGINT');
      const result = await probing;
      assert.equal(result.ok, false, 'a cancelled probe is not a pass');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

const FANOUT_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  Result:
    value: string
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan.output[0]}
      contract: Result
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "work \${item}"
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 3
`;

describe('a real build tags every dispatch it issues', () => {
  test('the ordinary step and each consumer item carry the flow tag', { timeout: 120000 }, async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'compose-flowtag-ws-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'compose-flowtag-state-'));
    const client = new StratumMcpClient();
    t.after(async () => {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    });

    await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
    await mkdir(join(workspace, 'pipelines'), { recursive: true });
    await mkdir(join(workspace, 'docs', 'features', 'FLOWTAG-1'), { recursive: true });
    await writeFile(join(workspace, '.compose', 'compose.json'),
      JSON.stringify({ version: 2, capabilities: { stratum: true } }));
    await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), FANOUT_SPEC);
    await writeFile(join(workspace, 'docs', 'features', 'FLOWTAG-1', 'description.md'), '# flow tag\n');
    await writeFile(join(workspace, '.gitignore'), '.compose/data/\ndocs/features/*/audit.json\n');
    await writeFile(join(workspace, '.compose', 'data', 'settings.json'),
      JSON.stringify({ policies: { merge: 'skip' } }));
    const git = (args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.name', 'Compose Flow Tag']);
    git(['config', 'user.email', 'flow-tag@example.test']);
    git(['add', '-A']);
    git(['commit', '-qm', 'flow tag baseline']);

    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });

    installAgentHarness(client, (agentType, opts) => ({
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        if (intent.includes('enumerate the consumer items')) {
          yield { type: 'assistant', content: JSON.stringify({ items: ['alpha', 'beta'] }) };
          return;
        }
        const item = intent.match(/\bwork (\w+)\b/)?.[1] ?? 'x';
        await mkdir(join(opts.cwd ?? workspace, 'items'), { recursive: true });
        await writeFile(join(opts.cwd ?? workspace, 'items', `${item}.txt`), `done:${item}\n`);
        yield { type: 'assistant', content: JSON.stringify({ value: `done-${item}` }) };
      },
      interrupt() {},
      get isRunning() { return false; },
    }), workspace);

    // Record what each site handed the client, and prove the handle is reachable by
    // flow id from the moment the run exists (S03-5b) — before any agent dispatches.
    const dispatched = [];
    const realAgentRun = client.agentRun;
    let registeredDuringRun = null;
    client.agentRun = async (agentType, prompt, opts = {}) => {
      dispatched.push({ agentType, flow: opts.flow, buildSignalPresent: Boolean(opts.signal) });
      if (registeredDuringRun === null && opts.flow?.runId) {
        registeredDuringRun = lookupBuildCancel(opts.flow.runId) !== null;
      }
      return realAgentRun(agentType, prompt, opts);
    };

    await runBuild('FLOWTAG-1', {
      cwd: workspace,
      stratum: client,
      template: 'build',
      skipTriage: true,
      description: 'flow tagging',
    });

    assert.ok(dispatched.length >= 3, `expected an enumerate plus two items, got ${dispatched.length}`);
    const runIds = new Set(dispatched.map((entry) => entry.flow?.runId));
    assert.equal(runIds.size, 1, 'every dispatch carries the same run id');
    assert.ok([...runIds][0], 'every dispatch is tagged');

    const enumerate = dispatched.find((entry) => entry.flow?.stepId === 'enumerate');
    assert.ok(enumerate, 'the ordinary step is tagged with its own step id');
    assert.equal(enumerate.flow.itemIndex, undefined, 'an ordinary step has no item index');

    const items = dispatched.filter((entry) => typeof entry.flow?.itemIndex === 'number');
    assert.equal(items.length, 2, 'each consumer item is tagged with a numeric index');
    assert.deepEqual(items.map((entry) => entry.flow.itemIndex).sort(), [0, 1]);
    for (const item of items) assert.equal(item.flow.stepId, 'fan');

    assert.equal(registeredDuringRun, true,
      'the in-process handle is registered before the first dispatch, not at context build');
  });
});
