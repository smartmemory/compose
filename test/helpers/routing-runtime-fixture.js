/** Real engine + real Compose connector boundary; only provider inference is controlled. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';
import { TS_MCP_BIN } from './stratum-test-bin.js';
import { runBuild } from '../../lib/build.js';
import { runGsd } from '../../lib/gsd.js';
import { readRoutingLedger } from '../../lib/routing-ledger.js';
export const CODE = 'ROUTE-D2';
const transport = Object.fromEntries(['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'].map(k => [k, 'string?']));
export const simpleSpec = (gsd = false) => ({ version: 1, contracts: { R: { outcome: 'string', summary: 'string' } }, flows: {
  entry: gsd ? 'gsd' : 'bug_fix', [gsd ? 'gsd' : 'bug_fix']: { input: gsd ? { featureCode: 'string', gateCommands: 'string[]', pre_merge_gate: 'string[]', ...transport } : { task: 'string', ...transport },
    steps: [{ id: 'work', agent: 'claude', do: 'WORK', out: 'R', attempts: 1 }], output: { from: '${work.output}', contract: 'R' } },
} });
export async function runtimeFixture(t, { gsd = false, spec = simpleSpec(gsd), profiles = {}, inference, intercept, mode = 'shadow', setup, engineEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'routing-runtime-'));
  const cwd = join(root, 'workspace'), stateRoot = join(root, 'engine'), artifactRoot = join(root, 'artifacts');
  mkdirSync(cwd); mkdirSync(stateRoot);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git(['init', '-q']); git(['config', 'user.name', 'Routing Test']); git(['config', 'user.email', 'routing@example.test']);
  mkdirSync(join(cwd, '.compose/data'), { recursive: true }); mkdirSync(join(cwd, 'pipelines'));
  mkdirSync(join(cwd, 'docs/bugs', CODE), { recursive: true }); mkdirSync(join(cwd, 'docs/features', CODE), { recursive: true });
  writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({ version: 2 }));
  writeFileSync(join(cwd, '.compose/data/settings.json'), JSON.stringify({ policies: { assess_gate: 'skip', merge: 'skip' } }));
  writeFileSync(join(cwd, 'docs/bugs', CODE, 'description.md'), '# D2 runtime\n');
  writeFileSync(join(cwd, 'docs/features', CODE, 'blueprint.md'), '# Runtime\n\n## File Plan\n\n| File | Action | Purpose |\n|------|--------|---------|\n| `a.txt` | new | A |\n\n## Boundary Map\n\n### S01: A\n\nFile Plan: `a.txt` (new)\n\nProduces:\n  a.txt → a (function)\n\nConsumes: nothing\n');
  const { validateSpec } = await import('../../../stratum/ts/dist/ir/validate.js');
  const validation = validateSpec(spec);
  if (!validation.ok) throw Error(JSON.stringify(validation.errors));
  const name = gsd ? 'gsd' : 'bug-fix';
  writeFileSync(join(cwd, 'pipelines', `${name}.stratum.yaml`), YAML.stringify(spec));
  writeFileSync(join(cwd, 'pipelines', `${name}.profiles.json`), JSON.stringify(profiles));
  await setup?.({ cwd, root });
  writeFileSync(join(cwd, '.gitignore'), '.compose/data/\n.compose/gsd/\n'); git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const previous = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = stateRoot; process.env.NODE_ENV = 'test';
  const engine = new StratumMcpClient();
  await engine.connect({ command: process.execPath, args: [TS_MCP_BIN], cwd, env: { ...process.env, ...engineEnv, STRATUM_STATE_ROOT: stateRoot, RESEND_API_KEY: '', STRIPE_API_KEY: '' } });
  const connector = new StratumMcpClient();
  const calls = [], receipts = [], reports = []; let flowId;
  connector._testClient = { callTool: async ({ name, arguments: args }) => {
    if (name !== 'stratum_agent_run') throw Error(`Unexpected inference tool ${name}`);
    const ordinal = calls.length; calls.push(structuredClone(args));
    const value = await inference?.(args, f, ordinal) ?? { text: '{"outcome":"complete","summary":"done"}', usage: { tokens: 11, ms: 7, usd: 0.12 }, usdSource: 'reported', telemetry: { model: 'claude-sonnet-4-6', effort: 'high' } };
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } };
  const stratum = new Proxy(engine, { get(target, key) {
    if (key === '_localQuery') return connector._localQuery;
    if (key === 'agentRun' || key === 'runAgentText' || key === 'onEvent') return connector[key].bind(connector);
    if (key === 'close') return async () => {}; // fixture owns the connection for post-return assertions
    if (key === 'plan') return async (...args) => { const response = await target.plan(...args); flowId = response.runId; return await intercept?.(key, args, response, f) ?? response; };
    if (['usageReport', 'stepDone', 'gateResolve', 'resume'].includes(key)) return async (...args) => {
      if (key === 'usageReport') receipts.push(structuredClone(args));
      if (key === 'stepDone') reports.push(structuredClone(args));
      const before = await intercept?.(`before:${key}`, args, null, f); if (before !== undefined) return before;
      const response = await target[key](...args); return await intercept?.(key, args, response, f) ?? response;
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const f = { root, cwd, stateRoot, artifactRoot, engine, connector, stratum, spec, profiles, calls, receipts, reports,
    get flowId() { return flowId; },
    snapshot: () => JSON.parse(readFileSync(join(stateRoot, `${flowId}.json`))),
    journal: () => { const dir = readdirSync(artifactRoot).find(d => d.startsWith(flowId)); return JSON.parse(readFileSync(join(artifactRoot, dir, 'journal.json'))); },
    rows: () => readRoutingLedger({ cwd }),
    run: (opts = {}) => gsd ? runGsd(CODE, { cwd, stratum, route_mode: mode, gateCommands: ['true'], preMergeGate: ['true'], consumerArtifactsRoot: artifactRoot, ...opts })
      : runBuild(CODE, { cwd, stratum, route_mode: mode, mode: 'bug', template: 'bug-fix', skipTriage: true, consumerArtifactsRoot: artifactRoot, gateOpts: { nonInteractive: true }, ...opts }),
  };
  t.after(async () => { await engine.close(); if (previous === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = previous; rmSync(root, { recursive: true, force: true }); });
  return f;
}

export async function runtimeWaveFixture(t, { incompletePartition = false, added = false, lostRevise = false, gsd = false, checkpoint = true, skipB = false, multiStage = false, hold = false, failBTransport = false, repairRounds = 1, initialBFiles, repairFilesByRound } = {}) {
  const spec = simpleSpec(gsd), flow = spec.flows[spec.flows.entry];
  Object.assign(spec.contracts, { Graph: { tasks: 'object[]' }, Review: { blocking: 'boolean', findings: 'object[]' },
    Decision: { action: 'string', rationale: 'string', open_count: 'number', blocking: 'boolean', addressed_findings: 'object[]', open_findings: 'object[]', tasks: 'object[]' } });
  flow.max_rounds = 3; flow.carry = { wave: { initial: '${plan.output.tasks}', on_revise: { assess_gate: '${assess.output.tasks}' } } };
  flow.steps = [
    { id: 'plan', agent: 'claude', do: 'PLAN', out: 'Graph' },
    { id: 'execute', after: ['plan'], fanout: { over: '${wave}', dispatch: 'consumer', isolation: 'worktree', concurrency: 2, merge: 'sequential', require: 'all',
      steps: [{ agent: 'codex', do: 'IMPLEMENT ${item}', out: 'R' }] } },
    { id: 'merge', after: ['execute'], gate: { on_approve: 'review', on_revise: 'execute', on_kill: null } },
    { id: 'review', after: ['merge'], agent: 'claude', do: 'REVIEW', out: 'Review' },
    { id: 'assess', after: ['review'], agent: 'claude', do: 'ASSESS', out: 'Decision' },
    { id: 'assess_gate', after: ['assess'], gate: { on_approve: 'finish', on_revise: 'execute', on_kill: null } },
    { id: 'finish', after: ['assess_gate'], agent: 'claude', do: 'FINISH', out: 'R' },
  ];
  if (skipB) { flow.steps[1].fanout.steps[0].when = 'item.id != "B"'; flow.steps[1].fanout.require = 'any'; }
  if (multiStage) flow.steps[1].fanout.steps.push({ agent: 'codex', do: 'IMPLEMENT ${item}', out: 'R' });
  flow.output = { from: '${finish.output}', contract: 'R' };
  const task = id => ({ id, description: `Implement ${id}`, files_owned: [`${id.toLowerCase()}.txt`], files_read: [], depends_on: [], tier: 'standard' });
  const tasks = [task('A'), task('B')], replacement = added ? task('C') : { ...task('B'), description: 'Correct B' };
  if (initialBFiles) tasks[1].files_owned = initialBFiles;
  const replacements = Array.from({ length: repairRounds }, (_, epoch) => repairFilesByRound
    ? { ...replacement, files_owned: repairFilesByRound[epoch] } : replacement);
  const finding = { severity: 'error', files: ['b.txt'], claim: 'B is defective', evidence: 'Independent test observed B defect' };
  const profiles = { ...(checkpoint ? { _consumer: { execute: { ownership: 'item.files_owned', independent: true, checkpoint_gate: 'merge' } } } : {}), execute: { default: 'codex:implementer:standard', tier_from: 'item.tier' },
    assess_gate: { decide_from: { step: 'assess', field: 'action', approve: ['complete'], revise: ['repair', 'implement'], kill: ['blocked'] }, validators: [{ name: 'WaveDecision', review_step: 'review' }] } };
  const captured = [], gates = [];
  const f = await runtimeFixture(t, { gsd, spec, profiles, inference: async (args, f) => {
    const state = f.snapshot(), epoch = state.steps.execute.epoch ?? 0;
    let output;
    if (args.prompt.includes('IMPLEMENT {')) {
      const id = args.prompt.match(/"id"\s*:\s*"([ABC])"/)[1];
      if (failBTransport && id === 'B') throw Error('lost consumer transport');
      const files = initialBFiles || repairFilesByRound
        ? (epoch === 0 ? tasks.find(task => task.id === id) : replacements[Math.min(epoch - 1, replacements.length - 1)]).files_owned
        : [`${id.toLowerCase()}.txt`];
      for (const file of files) writeFileSync(join(args.cwd, file), `${id}:${epoch}\n`);
      output = { outcome: 'complete', summary: `${id} done` };
    } else if (args.prompt.includes('PLAN')) output = { tasks };
    else if (args.prompt.includes('ASSESS')) {
      const review = state.steps.review.output;
      output = { action: epoch >= repairRounds ? 'complete' : added ? 'implement' : 'repair', rationale: 'Observed review', blocking: review.blocking,
        open_findings: epoch >= repairRounds || added ? [] : incompletePartition ? review.findings.slice(0, 1) : review.findings,
        addressed_findings: [], open_count: hold ? 99 : epoch >= repairRounds || added ? 0 : incompletePartition ? 1 : review.findings.length, tasks: epoch >= repairRounds ? [] : [replacements[epoch]] };
    } else if (args.prompt.includes('REVIEW')) output = { blocking: epoch < repairRounds && !added, findings: epoch >= repairRounds || added ? [] : incompletePartition ? [finding, { ...finding, claim: 'Second independently reported defect' }] : [{ ...finding, ...(repairFilesByRound ? { files: repairFilesByRound[epoch] } : {}) }] };
    else output = { outcome: 'complete', summary: 'done' };
    return { text: JSON.stringify(output), usage: { tokens: 5, ms: 10, usd: 0.1 }, usdSource: 'reported', telemetry: { model: args.model ?? 'claude-sonnet-4-6', effort: args.effort ?? 'high' } };
  }, intercept(method, args, response, f) {
    if (method === 'before:gateResolve') {
      const entry = { before: f.snapshot(), journal: f.journal(), args: structuredClone(args) };
      gates.push(entry); if (args[1] === 'assess_gate') captured.push(entry);
    }
    if (lostRevise && method === 'gateResolve' && args[1] === 'assess_gate' && args[2] === 'revise') throw Error('lost revise response');
  } });
  return Object.assign(f, { captured, gates, tasks, replacement });
}
