import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { runGsd } from '../lib/gsd.js';
import { buildWaveFixture, waveSpec, task, decisionProfiles } from './helpers/build-wave-fixture.js';
const blueprint = `# Test\n\n## File Plan\n\n| File | Action | Purpose |\n|------|--------|---------|\n| \`f1.txt\` | new | File |\n\n## Boundary Map\n\n### S01: File\n\nFile Plan: \`f1.txt\` (new)\n\nProduces:\n  f1.txt → value (function)\n\nConsumes: nothing\n`;
for (const invalid of [false, true]) test(`public GSD whole-wave admission ${invalid ? 'rejects' : 'routes'}`, async t => {
  const f = buildWaveFixture(t, { tasks: invalid ? Array.from({ length: 6 }, (_, i) => task(i + 1, i === 5 ? '' : 'fast')) : [task(1, 'fast')] });
  mkdirSync(join(f.cwd, 'docs/features', f.code), { recursive: true });
  writeFileSync(join(f.cwd, 'docs/features', f.code, 'blueprint.md'), blueprint);
  writeFileSync(join(f.cwd, 'pipelines/gsd.stratum.yaml'), YAML.stringify(waveSpec({ gsd: true })));
  writeFileSync(join(f.cwd, 'pipelines/gsd.profiles.json'), JSON.stringify(decisionProfiles));
  for (const d of f.descriptors) d.flow = 'gsd';
  if (!invalid) {
    const plan = f.stratum.plan; const agentRun = f.stratum.agentRun; const stepDone = f.stratum.stepDone;
    const spec = waveSpec({ gsd: true });
    spec.flows.gsd.steps.unshift({ id: 'decompose_gsd', agent: 'claude', do: 'stale graph' });
    writeFileSync(join(f.cwd, 'pipelines/gsd.stratum.yaml'), YAML.stringify(spec));
    f.stratum.plan = async () => ({ status: 'ready', runId: f.runId, revisionDigest: 'revision',
      ready: [{ id: 'decompose_gsd', agent: 'claude', do: 'stale graph', dispatchToken: 'decompose' }] });
    f.stratum.agentRun = async (...args) => args[1] === 'stale graph'
      ? { text: JSON.stringify({ tasks: [{ ...task(1), id: 'STALE-ID' }] }) } : agentRun(...args);
    f.stratum.stepDone = async (...args) => args[1] === 'decompose_gsd' ? plan() : stepDone(...args);
  }
  await runGsd(f.code, { cwd: f.cwd, stratum: f.stratum, allowDirtyWorkspace: true, preMergeGate: [] });
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, invalid ? 0 : 1);
  if (!invalid) {
    assert.equal(f.stratum.calls.find(c => c.type === 'agentRun').args[2].modelID, 'gpt-5.3-codex-spark');
    const events = readFileSync(join(f.cwd, '.compose/gsd', f.code, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.find(e => e.kind === 'step_model').tier, 'fast');
    const timing = JSON.parse(readFileSync(join(f.cwd, '.compose/gsd', f.code, 'timing.json')));
    assert.ok(JSON.stringify(timing).includes('T1'));
    assert.equal(JSON.stringify(timing).includes('STALE-ID'), false);
  }
});

for (const invalid of [false, true]) test(`GSD routing-only no-tier/no-consumer ${invalid ? 'whole-wave refusal' : 'admission'}`, async t => {
  const { routingDigest } = await import('../lib/model-router.js');
  const { resolvePlanSpecValues } = await import('../lib/stratum-mcp-client.js');
  const spec = waveSpec({ gsd: true });
  Object.assign(spec.flows.gsd.input, Object.fromEntries(['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'].map(k => [k, 'string?'])));
  const profiles = { execute: { default: 'codex:implementer:standard', route: { learn: true } } };
  const f = buildWaveFixture(t, { spec, profiles, tasks: Array.from({ length: invalid ? 6 : 2 }, (_, i) => task(i + 1)) });
  mkdirSync(join(f.cwd, 'docs/features', f.code), { recursive: true });
  writeFileSync(join(f.cwd, 'docs/features', f.code, 'blueprint.md'), blueprint);
  writeFileSync(join(f.cwd, 'pipelines/gsd.stratum.yaml'), YAML.stringify(spec));
  writeFileSync(join(f.cwd, 'pipelines/gsd.profiles.json'), JSON.stringify(profiles));
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  const plan = f.stratum.plan;
  const digest = routingDigest(resolvePlanSpecValues(spec, {}));
  f.descriptors.forEach(d => Object.assign(d, { flow: 'gsd', revisionDigest: digest }));
  f.state.steps.execute.fanout.items.forEach((item, index) => Object.assign(item, { epoch: 0, index }));
  if (invalid) f.state.steps.execute.fanout.items[5].index = 99;
  f.stratum.plan = async (text, flow, input, options) => {
    f.state.spec = resolvePlanSpecValues(YAML.parse(text), input); f.state.revisionDigest = routingDigest(f.state.spec);
    f.state.workspaceRoot = options.workspaceRoot; f.state.input = input;
    const token = f.state.steps.plan.acceptedDispatchToken; delete f.state.steps.plan.acceptedDispatchToken;
    const response = await plan(text, flow, input, options); response.revisionDigest = f.state.revisionDigest; f.persist();
    const audit = f.stratum.audit;
    f.stratum.audit = async (...args) => { f.state.steps.plan.acceptedDispatchToken = token; f.persist(); return audit(...args); };
    return response;
  };
  const run = () => runGsd(f.code, { cwd: f.cwd, stratum: f.stratum, route_mode: 'shadow', allowDirtyWorkspace: true,
    preMergeGate: [], consumerArtifactsRoot: f.artifactRoot });
  if (invalid) await assert.rejects(run(), { code: 'WAVE_INPUT_INVALID' }); else await run();
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, invalid ? 0 : 2);
  assert.equal(f.journal().waveAdmissions, undefined);
});
