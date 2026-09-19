/**
 * gate-round-reentry.test.js — COMP-PLAN-GATE-LOOP regression coverage.
 *
 * Reproduces the plan-gate infinite loop: resolving a gate with `revise` routes
 * back through earlier steps and re-enters the same gate. Before the fix Compose
 * always passed round 1, so re-entry collided with the prior resolved gate id
 * (`<flowId>:<stepId>:1`) and replayed its stale `revise` outcome — explore →
 * gate → explore forever. The fix threads Stratum's current round (read from the
 * persisted flow file) into the gate id so each re-entry is a fresh, pending gate.
 *
 * All tests run in direct mode (no server) by using a port that is not in use.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VisionWriter } from '../lib/vision-writer.js';
import { VisionStore } from '../server/vision-store.js';
import { assertGateReentryWithinCap, MAX_GATE_REENTRIES, decideMergeRepairOutcome, runBuild } from '../lib/build.js';
import { ConsumerFanoutArtifacts } from '../lib/consumer-fanout.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const RETRYING_CONSUMER_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  Result:
    value: string
flows:
  entry: main
  main:
    max_rounds: 40
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
        do: "enumerate retry items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 1
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "write conflicting item \${item}"
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 40
`;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function setupRetryingConsumer(t, slug) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gate-reentry-resume-${slug}-`));
  const workspace = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'state');
  const artifactRoot = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(workspace, '.compose', 'data'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'pipelines'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'docs', 'features', 'GATE-RETRY'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'conflicts'), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.compose/data/\n');
  fs.writeFileSync(
    path.join(workspace, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true } }),
  );
  fs.writeFileSync(
    path.join(workspace, '.compose', 'data', 'settings.json'),
    JSON.stringify({ policies: { merge: 'skip' } }),
  );
  fs.writeFileSync(path.join(workspace, 'pipelines', 'build.stratum.yaml'), RETRYING_CONSUMER_SPEC);
  fs.writeFileSync(
    path.join(workspace, 'docs', 'features', 'GATE-RETRY', 'description.md'),
    '# Durable merge gate retries\n',
  );
  for (let i = 0; i <= MAX_GATE_REENTRIES; i++) {
    fs.writeFileSync(path.join(workspace, 'conflicts', `file-${i}.txt`), 'base\n');
  }
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.name', 'Compose Gate Retry']);
  git(workspace, ['config', 'user.email', 'compose-gate-retry@example.test']);
  git(workspace, ['add', '-A']);
  git(workspace, ['commit', '-qm', 'gate retry baseline']);

  const previousStateRoot = process.env.STRATUM_STATE_ROOT;
  const previousPort = process.env.COMPOSE_PORT;
  process.env.STRATUM_STATE_ROOT = stateRoot;
  process.env.COMPOSE_PORT = '65534';
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
    else process.env.STRATUM_STATE_ROOT = previousStateRoot;
    if (previousPort === undefined) delete process.env.COMPOSE_PORT;
    else process.env.COMPOSE_PORT = previousPort;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { workspace, stateRoot, artifactRoot };
}

function conflictingAgentFactory(workspace, state, { rotatingFiles }) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        if (intent.includes('enumerate retry items')) {
          yield { type: 'assistant', content: JSON.stringify({ items: ['a'] }) };
        } else {
          const round = state.fanCalls++;
          const file = `conflicts/file-${rotatingFiles ? round : 0}.txt`;
          fs.writeFileSync(path.join(cwd, file), `worker-${round}\n`);
          fs.writeFileSync(path.join(workspace, file), `target-${round}\n`);
          yield { type: 'assistant', content: JSON.stringify({ value: `round-${round}` }) };
        }
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

async function connectRetryClient(scenario, agentFactory) {
  const client = new StratumMcpClient();
  await client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN],
    env: { ...process.env, STRATUM_STATE_ROOT: scenario.stateRoot },
  });
  installAgentHarness(client, agentFactory, scenario.workspace);
  return client;
}

function retryBuildOptions(scenario, resumeFlowId) {
  return {
    cwd: scenario.workspace,
    template: 'build',
    skipTriage: true,
    description: 'durable merge gate retry regression',
    consumerArtifactsRoot: scenario.artifactRoot,
    ...(resumeFlowId ? { resumeFlowId } : {}),
  };
}

function activeFlowId(workspace) {
  return JSON.parse(
    fs.readFileSync(path.join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
  ).flowId;
}

describe('assertGateReentryWithinCap', () => {
  it('does not throw at or under the cap', () => {
    assert.doesNotThrow(() => assertGateReentryWithinCap(1, 'plan_design_gate'));
    assert.doesNotThrow(() => assertGateReentryWithinCap(MAX_GATE_REENTRIES, 'plan_design_gate'));
  });

  it('throws once the cap is exceeded, naming the step and the recovery path', () => {
    assert.throws(
      () => assertGateReentryWithinCap(MAX_GATE_REENTRIES + 1, 'plan_design_gate'),
      (err) => {
        assert.match(err.message, /plan_design_gate/);
        assert.match(err.message, /--resume/);
        return true;
      },
    );
  });

  it('honors a custom cap', () => {
    assert.doesNotThrow(() => assertGateReentryWithinCap(3, 'g', 3));
    assert.throws(() => assertGateReentryWithinCap(4, 'g', 3));
  });
});

describe('round-aware gate id breaks the revise replay loop', () => {
  let tmpDir;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-round-')); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('a revise re-entry at a new round mints a fresh pending gate instead of replaying the resolved one', async () => {
    const writer = new VisionWriter(tmpDir, { port: 19990 }); // unused port → direct mode

    // Round 1: create the gate and resolve it `revise` (what kicks off the loop).
    const g1 = await writer.createGate('flow-loop', 'plan_design_gate', 'item-x', { round: 1 });
    await writer.resolveGate(g1, 'revise');
    assert.ok(g1.endsWith(':plan_design_gate:1'));

    // BUG control: re-entering at the SAME round returns the prior gate id, which
    // is already resolved — exactly the stale-outcome replay that looped forever.
    const stale = await writer.createGate('flow-loop', 'plan_design_gate', 'item-x', { round: 1 });
    assert.equal(stale, g1);
    assert.equal((await writer.getGate(g1)).status, 'resolved');

    // FIX: re-entering at the next round mints a distinct, pending gate that
    // blocks for a fresh decision rather than replaying `revise`.
    const g2 = await writer.createGate('flow-loop', 'plan_design_gate', 'item-x', { round: 2 });
    assert.notEqual(g2, g1);
    assert.ok(g2.endsWith(':plan_design_gate:2'));
    assert.equal((await writer.getGate(g2)).status, 'pending');
  });

  it('a fresh flow does NOT reuse a stale pending gate from a prior crashed flow', async () => {
    const writer = new VisionWriter(tmpDir, { port: 19990 }); // direct mode

    // A prior run left a pending gate that nobody ever resolved (crash/SIGKILL).
    const stale = await writer.createGate('flow-old', 'plan_design_gate', 'item-y', { round: 1 });
    assert.equal((await writer.getGate(stale)).status, 'pending');

    // A fresh run (new flowId), same feature+step, must mint its OWN gate — not
    // inherit the dead run's gate (which would be polled until the server TTL).
    const fresh = await writer.createGate('flow-new', 'plan_design_gate', 'item-y', { round: 1 });
    assert.notEqual(fresh, stale);
    assert.ok(fresh.endsWith('flow-new:plan_design_gate:1'));
    assert.equal((await writer.getGate(fresh)).status, 'pending');
  });
});

describe('VisionStore.findPendingGate is flow-scoped (server path)', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-store-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('does not reuse a pending gate from a different flow', () => {
    const store = new VisionStore(dir);
    store.createGate({
      id: 'flow-old:s:1', flowId: 'flow-old', itemId: 'item-z', stepId: 's',
      status: 'pending', createdAt: new Date().toISOString(),
    });
    // Different flow → no match (a fresh run mints its own gate).
    assert.equal(store.findPendingGate('item-z', 's', 'flow-new'), null);
    // Same flow → legit within-flow dedup still works.
    assert.ok(store.findPendingGate('item-z', 's', 'flow-old'));
    // Legacy null flowId → falls back to item+step match.
    assert.ok(store.findPendingGate('item-z', 's'));
  });
});

describe('decideMergeRepairOutcome', () => {
  const failure = 'MERGE_WITNESS_PRECOMPUTE_FAILED: patch does not apply';

  it('revises on the first failure at a gate', () => {
    const decision = decideMergeRepairOutcome(undefined, failure, 'revise');
    assert.deepEqual(decision, { outcome: 'revise', repeated: false, rationale: failure });
  });

  it('revises again when the failure changed (genuine progress)', () => {
    const decision = decideMergeRepairOutcome(failure, 'MERGE_WITNESS_NOT_UNIQUE: chain', 'revise');
    assert.equal(decision.outcome, 'revise');
    assert.equal(decision.repeated, false);
  });

  it('kills instead of paying for another round when the failure repeats byte-identically', () => {
    const decision = decideMergeRepairOutcome(failure, failure, 'revise');
    assert.equal(decision.outcome, 'kill');
    assert.equal(decision.repeated, true);
    assert.match(decision.rationale, /identical to the previous round/);
    assert.match(decision.rationale, /--fresh/);
    assert.doesNotMatch(decision.rationale, /--resume/);
  });

  it('keeps kill as kill when the gate has no revise route', () => {
    assert.equal(decideMergeRepairOutcome(undefined, failure, 'kill').outcome, 'kill');
    assert.equal(decideMergeRepairOutcome(failure, failure, 'kill').outcome, 'kill');
  });

  it('kills when regenerated merge failures have the same code and file but different messages', () => {
    const first = [
      'MERGE_APPLY_FAILED: consumer merge apply failed and baseline was restored:',
      'error: patch failed: src/ds/tokens.json:14',
      'error: src/ds/tokens.json: patch does not apply',
    ].join('\n');
    const regenerated = [
      'MERGE_APPLY_FAILED: consumer merge apply failed and baseline was restored:',
      'error: patch failed: src/ds/tokens.json:27',
      'error: src/ds/tokens.json: patch does not apply (different hunk context)',
    ].join('\n');

    const decision = decideMergeRepairOutcome(first, regenerated, 'revise');

    assert.equal(decision.outcome, 'kill');
    assert.equal(decision.repeated, true);
    assert.match(decision.rationale, /same merge failure.*src\/ds\/tokens\.json/i);
  });

  it('still revises when the merge failure moved to a different file', () => {
    const first = 'MERGE_APPLY_FAILED: error: patch failed: src/ds/tokens.json:14';
    const progressed = 'MERGE_APPLY_FAILED: error: patch failed: src/styles/tokens.css:14';
    const decision = decideMergeRepairOutcome(first, progressed, 'revise');
    assert.equal(decision.outcome, 'revise');
    assert.equal(decision.repeated, false);
  });
});

describe('consumer merge gate retry journal', () => {
  let root;
  let targetCwd;
  let artifactRoot;
  const options = () => ({ runId: 'flow-resume', targetCwd, artifactRoot });

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-retry-journal-'));
    targetCwd = path.join(root, 'workspace');
    artifactRoot = path.join(root, 'artifacts');
    fs.mkdirSync(targetCwd, { recursive: true });
  });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('reloads the reentry count and last failure fingerprint in a fresh manager', () => {
    const firstRun = new ConsumerFanoutArtifacts(options());
    firstRun.recordGateRetryState('merge', {
      roundCount: MAX_GATE_REENTRIES,
      lastFailureFingerprint: 'merge-failure-v1:MERGE_APPLY_FAILED:["src/ds/tokens.json"]',
    });

    const resumedRun = new ConsumerFanoutArtifacts(options());
    const state = resumedRun.gateRetryState('merge');

    assert.deepEqual(state, {
      roundCount: MAX_GATE_REENTRIES,
      lastFailureFingerprint: 'merge-failure-v1:MERGE_APPLY_FAILED:["src/ds/tokens.json"]',
    });
    assert.throws(
      () => assertGateReentryWithinCap(state.roundCount + 1, 'merge'),
      /re-entered 21 times/,
    );
  });
});

describe('runBuild merge-gate retry state survives resume', () => {
  it('does not grant a fresh cap after a new runBuild resumes the same flow', async (t) => {
    const scenario = setupRetryingConsumer(t, 'cap');
    const state = { fanCalls: 0 };
    const factory = conflictingAgentFactory(scenario.workspace, state, { rotatingFiles: true });
    const firstClient = await connectRetryClient(scenario, factory);
    await assert.rejects(
      runBuild('GATE-RETRY', { ...retryBuildOptions(scenario), stratum: firstClient }),
      /Gate "merge" re-entered 21 times/,
    );
    await firstClient.close();

    const flowId = activeFlowId(scenario.workspace);
    const callsAtCap = state.fanCalls;
    const resumedClient = await connectRetryClient(scenario, factory);
    try {
      await assert.rejects(
        runBuild('GATE-RETRY', {
          ...retryBuildOptions(scenario, flowId),
          stratum: resumedClient,
        }),
        /Gate "merge" re-entered 22 times/,
      );
    } finally {
      await resumedClient.close();
    }

    assert.equal(state.fanCalls, callsAtCap, 'resume must trip before redispatching another paid lane');
    const journal = new ConsumerFanoutArtifacts({
      runId: flowId,
      targetCwd: scenario.workspace,
      artifactRoot: scenario.artifactRoot,
    });
    assert.equal(journal.gateRetryState('merge').roundCount, 22);
  });

  it('uses the prior journaled failure when a fresh runBuild resumes at the same gate', async (t) => {
    const scenario = setupRetryingConsumer(t, 'failure');
    const state = { fanCalls: 0 };
    const factory = conflictingAgentFactory(scenario.workspace, state, { rotatingFiles: false });
    const firstClient = await connectRetryClient(scenario, factory);
    const realGateResolve = firstClient.gateResolve.bind(firstClient);
    let interruptedOutcome;
    firstClient.gateResolve = async (...args) => {
      if (args[1] === 'merge') {
        interruptedOutcome = args[2];
        throw new Error('interrupt before merge gate resolution');
      }
      return realGateResolve(...args);
    };
    await assert.rejects(
      runBuild('GATE-RETRY', { ...retryBuildOptions(scenario), stratum: firstClient }),
      /interrupt before merge gate resolution/,
    );
    await firstClient.close();
    assert.equal(interruptedOutcome, 'revise');

    const flowId = activeFlowId(scenario.workspace);
    const beforeResume = new ConsumerFanoutArtifacts({
      runId: flowId,
      targetCwd: scenario.workspace,
      artifactRoot: scenario.artifactRoot,
    }).gateRetryState('merge');
    assert.equal(beforeResume.roundCount, 1);
    assert.match(beforeResume.lastFailureFingerprint, /^merge-failure-v1:/);

    const resumedClient = await connectRetryClient(scenario, factory);
    try {
      await runBuild('GATE-RETRY', {
        ...retryBuildOptions(scenario, flowId),
        stratum: resumedClient,
      });
      const journal = new ConsumerFanoutArtifacts({
        runId: flowId,
        targetCwd: scenario.workspace,
        artifactRoot: scenario.artifactRoot,
      });
      assert.equal(journal.journal.mergeTransactions[0]?.gateOutcome, 'kill');
    } finally {
      await resumedClient.close();
    }
    assert.equal(state.fanCalls, 1, 'resume at the waiting gate must not need another lane generation');
  });
});
