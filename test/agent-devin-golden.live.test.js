/** Controller-run only. Never invoke a provider without COMPOSE_DEVIN_LIVE=1. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { PassThrough } from 'node:stream';
import { runBuild, readBuildAccumulator } from '../lib/build.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { readFlowSpend } from '../lib/flow-state.js';
import { readRoutingLedger } from '../lib/routing-ledger.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

export async function devinBuildFixture({ live = false, roles = {}, authoredAgent = 'devin' } = {}) {
  if (live) assert.equal(process.env.COMPOSE_DEVIN_LIVE, '1');
  process.env.NODE_ENV = 'test';
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.COMPOSE_PORT, '19997');
  if (live) assert.equal(process.platform, 'darwin');
  const root = mkdtempSync(join(tmpdir(), 'compose-devin-golden-'));
  const cwd = join(root, 'repo'), stateRoot = join(root, 'state'), home = join(root, 'home');
  const config = join(homedir(), '.config/devin/config.json');
  const beforeConfig = live && existsSync(config) ? readFileSync(config) : null;
  const previousState = process.env.STRATUM_STATE_ROOT;
  const client = new StratumMcpClient();
  const receipts = [], calls = [], reports = [];
  let flowId, planInputs, accumulated;
  try {
    for (const dir of [cwd, stateRoot, home, join(cwd, '.compose/data'), join(cwd, 'pipelines')]) mkdirSync(dir, { recursive: true });
    if (live) {
      mkdirSync(join(home, '.local/share/devin'), { recursive: true });
      copyFileSync(join(homedir(), '.local/share/devin/credentials.toml'), join(home, '.local/share/devin/credentials.toml'));
      chmodSync(join(home, '.local/share/devin/credentials.toml'), 0o600);
    }
    const spec = { version: 1, contracts: { R: { outcome: 'string', summary: 'string' } }, flows: { entry: 'build', build: { max_rounds: 2,
      input: { featureCode: 'string', description: 'string', implementer_agent: 'string', reviewer_agent: 'string', pre_merge_gate: 'string[]', ...Object.fromEntries(['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'].map(key => [key, 'string?'])) },
      output: { from: '${execute.output[0]}', contract: 'R' }, steps: [{ id: 'execute', fanout: {
        over: '${input.pre_merge_gate}', pre_merge: '$.input.pre_merge_gate', dispatch: 'consumer', concurrency: 1, isolation: 'worktree', require: 'all', merge: 'sequential',
        steps: [{ agent: authoredAgent, do: 'Write devin-proof.txt containing exactly DEVIN_OK followed by a newline. Do not commit. Return JSON {"outcome":"complete","summary":"wrote file"}.', out: 'R' }],
      } }, { id: 'merge', after: ['execute'], gate: { on_approve: null, on_revise: 'execute', on_kill: null } }],
    } } };
    const { validateSpec } = await import('@smartmemory/stratum/dist/ir/validate.js');
    const { resolvePlanSpecValues } = await import('../lib/stratum-mcp-client.js');
    const validation = validateSpec(resolvePlanSpecValues(spec, { pre_merge_gate: ['true'] }));
    assert.ok(validation.ok, JSON.stringify(validation.errors));
    writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({ version: 2, capabilities: { preMergeGate: true } }));
    writeFileSync(join(cwd, 'pipelines/build.stratum.yaml'), YAML.stringify(spec));
    writeFileSync(join(cwd, 'pipelines/build.profiles.json'), JSON.stringify({ execute: 'devin::fast' }));
    writeFileSync(join(cwd, '.gitignore'), '.compose/data/\n.compose/routing/\n');
    const git = args => execFileSync('git', args, { cwd, stdio: 'pipe' });
    git(['init', '-q']); git(['config','user.name','Devin Test']); git(['config','user.email','devin@example.test']); git(['add','.']); git(['commit','-qm','fixture']);
    process.env.STRATUM_STATE_ROOT = stateRoot;
    await client.connect({ command: process.execPath, args: [TS_MCP_BIN], cwd,
      env: { ...process.env, HOME: home, STRATUM_STATE_ROOT: stateRoot, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
    const fakeConnector = new StratumMcpClient();
    fakeConnector._testClient = { callTool: async ({ name, arguments: args }) => {
      assert.equal(name, 'stratum_agent_run');
      writeFileSync(join(args.cwd, 'devin-proof.txt'), 'DEVIN_OK\n');
      return { content: [{ type: 'text', text: JSON.stringify({
        text: '{"outcome":"complete","summary":"wrote file"}', usage: { tokens: 11, ms: 7, usd: 0 }, usdSource: 'estimated',
        split: { input: 10, output: 1 }, telemetry: { model: 'swe-2-medium', effort: 'medium', durationMs: 7 },
      }) }] };
    } };
    const agentRun = live ? client.agentRun.bind(client) : fakeConnector.agentRun.bind(fakeConnector);
    const stratum = new Proxy(client, { get(target, key) {
      if (key === 'close') return async () => {};
      if (key === 'agentRun') return async (agent, prompt, opts) => {
        assert.equal(agent, 'devin');
        assert.equal(opts.modelID, 'swe-2-medium'); assert.equal(opts.effort, 'medium');
        assert.equal(opts.sandboxMode, 'workspace-write'); assert.notEqual(opts.cwd, cwd);
        calls.push({ agent, opts });
        return agentRun(agent, prompt, opts);
      };
      if (key === 'plan') return async (...args) => { planInputs = args[2]; let result; try { result = await target.plan(...args); } catch (error) { throw new Error(JSON.stringify({ input: args[2], data: error.data, message: error.message })); } flowId = result.runId ?? result.flow_id; return result; };
      if (key === 'usageReport') return async (...args) => { receipts.push(args[1]); return target.usageReport(...args); };
      if (key === 'stepDone') return async (...args) => { accumulated = readBuildAccumulator(cwd, 'DEVIN-1'); reports.push(args); return target.stepDone(...args); };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const input = new PassThrough(), output = new PassThrough();
    output.on('data', chunk => { if (chunk.toString().includes('> ')) queueMicrotask(() => input.write('a\n')); });
    await runBuild('DEVIN-1', { cwd, stratum, template: 'build', skipTriage: true, description: 'Devin consumer golden', preMergeGate: ['true'],
      consumerArtifactsRoot: join(root, 'artifacts'), route_mode: 'shadow', gateOpts: { input, output }, ...roles });
    assert.equal(calls.length, 1); assert.ok(reports.length > 0);
    assert.equal(readFileSync(join(cwd, 'devin-proof.txt'), 'utf8'), 'DEVIN_OK\n');
    const receipt = receipts.find(r => r.telemetry?.model === 'swe-2-medium');
    assert.ok(receipt); assert.equal(receipt.usage.usd, 0); assert.equal(receipt.usdSource, 'estimated');
    assert.equal(accumulated.usd, 0);
    assert.equal(accumulated.usd_source, 'estimated');
    assert.equal(accumulated.usd_unknown_count, 0, 'the normalized dispatch must retain known zero');
    const snapshot = JSON.parse(readFileSync(join(stateRoot, `${flowId}.json`)));
    assert.equal(readFlowSpend(flowId, { revisionDigest: snapshot.revisionDigest }).spent, 0);
    {
      const calls = readRoutingLedger({ cwd }).flatMap(row => row.calls);
      const call = calls.find(call => call.resolution?.reportedModel === 'swe-2-medium');
      assert.ok(call); assert.equal(call.executedTier.status, 'known'); assert.equal(call.executedTier.value, 'fast');
      assert.equal(call.resolution.reportedEffort, 'medium');
      assert.equal(call.resolution.usageEvidence.usd, 0);
      assert.equal(call.resolution.usageEvidence.provenance, 'estimated');
    }
    return { planInputs, receipts };
  } finally {
    try { await client.close(); } finally {
      if (previousState === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = previousState;
      rmSync(root, { recursive: true, force: true });
      if (live) {
        assert.deepEqual(existsSync(config) ? readFileSync(config) : null, beforeConfig, 'real Devin config must remain unchanged');
        const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
        assert.equal(processes.includes(root), false, 'no process from this private Devin run remains');
      }
      assert.equal(existsSync(root), false, 'temporary homes, credentials, runs, worktrees and state removed');
    }
  }
}

test('live Devin consumer worktree build, known zero cost and executed tier', {
  skip: process.env.COMPOSE_DEVIN_LIVE !== '1', timeout: 90000,
}, () => devinBuildFixture({ live: true }));
