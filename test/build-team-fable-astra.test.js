/** Production preset golden: real engine/connector, recorded Claude and fake Codex. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { runBuild, resolveTemplatePath, loadPipelineProfiles, preflightPipelineProfiles } from '../lib/build.js';
import { parseTeamFlag } from '../lib/team-flag.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { TS_CLI_BIN, TS_MCP_BIN } from './helpers/stratum-test-bin.js';
import { makeFakeCodexProject } from './helpers/fake-codex-project.js';
import { fakeBuildStratum, agentResult } from './helpers/build-stratum-fixture.js';
import { decision } from './helpers/build-wave-fixture.js';
import { readGoldenJournal, frozenRoutingBaseline, serializeGolden, normalizedGoldenCalls, readRoutingEvidence, assertRoutingGolden, assertShadowGoldenInput, goldenProviderTool } from './helpers/build-wave-golden-fixture.js';
import { git } from './helpers/consumer-wave-fixture.js';

const presetPath = fileURLToPath(new URL('../presets/team-fable-astra.stratum.yaml', import.meta.url));
const spec = readFileSync(presetPath, 'utf8');
const profiles = loadPipelineProfiles(presetPath);
import { preflightPipelineProfiles as corePreflight } from '../lib/pipeline-profiles.js';
const frozen = frozenRoutingBaseline('bundled-build');
const code = 'S4-PRESET-1';
const core = 'module.exports = x => x * 2;\n';
const workerSummary = 'WORKER_SUMMARY_MUST_NEVER_REACH_REVIEW';
const task = { id: 'CORE', description: 'Implement core doubling', files_owned: ['core.cjs'],
  files_read: ['unit.test.cjs'], depends_on: [], tier: 'critical', tier_rationale: 'Design judgment for core behavior' };

test('fable-astra: real Stratum validator, CLI rewrite, bundled resolution and sidecar preflight', () => {
  const validated = spawnSync(process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    [TS_CLI_BIN, 'validate', presetPath], { encoding: 'utf8', timeout: 30000 });
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  assert.deepEqual(JSON.parse(validated.stdout), { valid: true });
  const parsed = parseTeamFlag([code, '--team', 'fable-astra']);
  assert.deepEqual(parsed, { template: 'team-fable-astra', args: [code] });
  assert.equal(resolveTemplatePath(parsed.template, '/tmp/no-s4-project'), presetPath);
  const preflight = preflightPipelineProfiles(profiles, spec);
  assert.equal(preflight.ok, true);
  assert.deepEqual(profiles._routing, { mode: 'shadow' });
  assert.deepEqual(Object.entries(profiles).filter(([, p]) => p?.route?.learn).map(([id]) => id), ['plan', 'execute']);
  assert.equal(preflight.resolved.plan.modelID, 'claude-fable-5-1');
  assert.equal(preflight.resolved.assess.modelID, 'claude-fable-5-1');
  assert.equal(preflight.resolved.verify.modelID, 'claude-opus-5-5');
  assert.equal(preflight.resolved.review.modelID, 'gpt-6-astra');
});

for (const mode of ['default shadow', 'off', 'paid shadow']) test(`fable-astra: ${mode} real preset wave → complete → ship and frozen oracle`, { timeout: 180000 }, async t => {
  const f = await makeFakeCodexProject({ featureCode: code, spec, profiles, git: true,
    recordModel: true, intentOnly: true, costUsd: 0.001,
    description: '# Goal\nImplement doubling.\n\n## Acceptance criteria\ncore(3) equals 6.\n',
    files: {
      '.compose/data/settings.json': JSON.stringify({ policies: { execute_merge: 'skip', assess_gate: 'skip' } }),
      'package.json': JSON.stringify({ scripts: { test: 'node --test unit.test.cjs' } }),
      'unit.test.cjs': "const {test}=require('node:test'); const assert=require('node:assert/strict');\ntest('doubles',()=>assert.equal(require('./core.cjs')(3),6));\n",
      'untouched.txt': 'sentinel\n',
    },
    lanes: [
      { name: 'review', match: 'Fresh independent read-only review', review: {
        check: "require('node:assert/strict').equal(require('./core.cjs')(3),6)",
        finding: { severity: 'error', files: ['core.cjs'], claim: 'Wrong output', evidence: 'core(3) != 6' },
      } },
      { name: 'worker', match: 'Implement the task described by', writes: [{ path: 'core.cjs', content: core }],
        text: JSON.stringify({ outcome: 'complete', summary: workerSummary, files_changed: ['core.cjs'],
          verification: { commands: ['node --test unit.test.cjs'], outcomes: ['1 pass, 0 fail'] } }) },
      { name: 'unexpected', text: '{"unexpected":true}' },
    ],
  });
  t.after(() => f.cleanup());
  git(f.workspace, ['config', 'user.name', 'Preset Golden']);
  git(f.workspace, ['config', 'user.email', 'preset@example.test']);
  const base = git(f.workspace, ['rev-parse', 'HEAD']);
  const ignoreBefore = Object.fromEntries(['.gitignore', '.git/info/exclude'].map(p => [p, existsSync(join(f.workspace, p)) ? readFileSync(join(f.workspace, p), 'utf8') : null]));
  f.artifactRoot = join(f.stateRoot, 'artifacts');
  const client = new StratumMcpClient();
  const connection = { command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN], cwd: f.workspace, env: f.env };
  const oldRoot = process.env.STRATUM_STATE_ROOT;
  const oldNodeEnv = process.env.NODE_ENV;
  process.env.STRATUM_STATE_ROOT = f.stateRoot;
  process.env.NODE_ENV = 'test';
  let flowId;
  const inference = [];
  const events = [];
  const roots = [];
  const completions = [];
  const fake = fakeBuildStratum({ agentRun: async (_provider, prompt, opts) => {
    const step = prompt.match(/executing step "([^"]+)"/)?.[1];
    let output;
    if (step === 'plan') output = { tasks: [task] };
    else if (step === 'verify') {
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const observed = execFileSync(process.execPath, ['--test', 'unit.test.cjs'], { cwd: opts.cwd, env, encoding: 'utf8' });
      assert.match(observed, /# fail 0/);
      output = { tests_pass: true, summary: 'Integrated doubling test passed',
        verification: { commands: ['node --test unit.test.cjs'], outcomes: [observed] },
        merged_diff: git(opts.cwd, ['diff', 'HEAD', '--']) };
      const addition = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', 'core.cjs'],
        { cwd: opts.cwd, encoding: 'utf8' });
      assert.equal(addition.status, 1, addition.stderr);
      output.merged_diff += addition.stdout;
      assert.match(output.merged_diff, /module.exports = x => x \* 2/);
    } else if (step === 'assess') {
      assert.match(prompt, new RegExp(workerSummary), 'assess receives worker evidence');
      output = decision('complete');
    } else throw new Error(`Unexpected Claude step: ${step}`);
    return { ...agentResult(output, `s4:${step}`), usdSource: 'reported' };
  } });
  const paidConnector = new StratumMcpClient();
  paidConnector._testClient = { callTool: await goldenProviderTool(async args => ({
    text: (await fake.agentRun('claude', args.prompt, { cwd: args.cwd })).text, usd: 0.25,
  })) };
  const stratum = new Proxy(client, { get(target, key) {
    if (key === 'onEvent' && mode === 'paid shadow') return (...args) => { const a = target.onEvent(...args), b = paidConnector.onEvent(...args); return () => { a(); b(); }; };
    if (key === 'plan') return async (...args) => {
      events.push(serializeGolden({ kind: 'plan', spec: args[0], flow: args[1], input: args[2], opts: args[3] }));
      assert.equal(args[0], spec, 'runBuild uses the unmodified bundled YAML');
      const result = await target.plan(...args); flowId = result.runId; return result;
    };
    if (key === 'agentRun') return async (provider, prompt, opts) => {
      events.push(serializeGolden({ kind: 'call', provider, prompt, opts }));
      if (mode !== 'off') roots.push(readRoutingEvidence(f, flowId));
      inference.push({ provider, prompt, opts });
      return provider === 'claude' ? (mode === 'paid shadow' ? paidConnector : fake).agentRun(provider, prompt, opts) : target.agentRun(provider, prompt, opts);
    };
    if (key === 'stepDone') return async (...args) => {
      completions.push({ step: args[1], envelope: args[2] });
      return target.stepDone(...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    await client.connect(connection);
    const { template } = parseTeamFlag([code, '--team', 'fable-astra']);
    assert.equal(resolveTemplatePath(template, f.workspace), presetPath, 'bundled preset selected without a local team copy');
    await runBuild(code, { cwd: f.workspace, template, stratum, skipTriage: true,
      description: 'Implement doubling. Acceptance criteria: core(3) equals 6.',
      consumerArtifactsRoot: f.artifactRoot, ...(mode === 'off' ? { route_mode: 'off' } : {}), gateOpts: { nonInteractive: true } });
    await client.connect(connection); // runBuild closes injected clients too.
    const audit = await client.audit(flowId);
    assert.equal(audit.status, 'completed', JSON.stringify(audit));
    assert.deepEqual(audit.steps.plan.output, { tasks: [task] });
    assert.equal(audit.steps.assess.output.action, 'complete');
    assert.equal(audit.steps.ship.status, 'succeeded');
    const gates = audit.events.filter(e => e.type === 'gate_resolved');
    assert.deepEqual(gates.map(e => [e.stepId, e.detail.decision]), [['execute_merge', 'approve'], ['assess_gate', 'approve']]);
    assert.ok(completions.every(c => !c.envelope.failure), JSON.stringify(completions));
    const journal = await readGoldenJournal(f);
    assert.equal(journal.wave.checkpoints.length, 1);
    assert.equal(corePreflight(profiles, spec, {}, { mode: 'off' }).profilesDigest, frozen.profileDigest);
    const plan = events.find(e => e.kind === 'plan');
    if (mode === 'off') {
      assert.deepEqual(plan.input, frozen.events[0].input);
      assert.equal(plan.flow, frozen.events[0].flow);
      assert.deepEqual(plan.opts, { ...frozen.events[0].opts, workspaceRoot: f.workspace });
      assert.equal(journal.routing, undefined);
      assert.equal(existsSync(join(f.workspace, '.compose/routing')), false);
      for (const [p, bytes] of Object.entries(ignoreBefore)) assert.equal(existsSync(join(f.workspace, p)) ? readFileSync(join(f.workspace, p), 'utf8') : null, bytes);
    } else {
      assertShadowGoldenInput(plan.input, frozen.events[0].input);
      assertRoutingGolden(readRoutingEvidence(f, flowId), 5);
      assert.equal(new Set(roots.map(r => r.rootBytes)).size, 1);
      for (const earlier of roots) for (const [id, record] of Object.entries(earlier.journal.routing.records)) {
        assert.deepEqual(journal.routing.records[id], record, 'records present before launch remain immutable');
      }
    }
    assert.deepEqual(normalizedGoldenCalls(events), normalizedGoldenCalls(frozen.events));
    if (mode === 'paid shadow') {
      const { readRoutingLedger } = await import('../lib/routing-ledger.js');
      const rows = readRoutingLedger({ cwd: f.workspace });
      assert.equal(rows.length, 5);
      const expected = { plan: 0.25, execute: 0.001, verify: 0.25, review: 0.001, assess: 0.25 };
      for (const row of rows) {
        assert.equal(row.cost.usd, expected[row.issuance.scopedStep]);
        assert.equal(row.calls.length, 1);
        assert.equal(row.completeness.state, 'complete');
      }
      assert.equal(rows.find(r => r.issuance.scopedStep === 'execute').outcome.label, 'accepted');
      assert.equal(rows.find(r => r.issuance.scopedStep === 'execute').calls[0].executedTier.value, 'critical');
    }
    assert.equal(git(f.workspace, ['rev-parse', 'HEAD^']), base);
    assert.equal(git(f.workspace, ['rev-list', '--count', `${base}..HEAD`]), '1');
    assert.ok(!git(f.workspace, ['rev-list', 'HEAD']).split('\n').includes(journal.wave.checkpoints[0].commit));
    assert.equal(git(f.workspace, ['rev-parse', 'HEAD^{tree}']), journal.wave.checkpoints[0].tree);
    assert.equal(readFileSync(join(f.workspace, 'core.cjs'), 'utf8'), core);
    assert.equal(readFileSync(join(f.workspace, 'untouched.txt'), 'utf8'), 'sentinel\n');
    const calls = await f.readAgentPids();
    assert.deepEqual(calls.map(c => c.lane), ['worker', 'review']);
    assert.ok(calls.every(c => c.model === 'gpt-6-astra'));
    const review = inference.find(c => c.provider === 'codex' && c.prompt.includes('Fresh independent read-only review'));
    assert.ok(review);
    assert.equal(review.opts.sandboxMode, 'read-only');
    assert.doesNotMatch(review.prompt, new RegExp(workerSummary));
    assert.match(review.prompt, /core\(3\) equals 6/);
    assert.match(review.prompt, /module.exports = x => x \* 2/);
    assert.match(review.prompt, /Integrated doubling test passed/);
    assert.deepEqual(inference.filter(c => c.provider === 'claude').map(c => c.opts.modelID),
      ['claude-fable-5-1', 'claude-opus-5-5', 'claude-fable-5-1']);
  } finally {
    await client.close();
    if (oldRoot === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = oldRoot;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
  }
});
