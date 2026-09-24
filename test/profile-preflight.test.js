import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { loadPipelineProfiles, preflightPipelineProfiles, requirePipelineSidecar, sidecarCarriesExecutionConfig, runBuild } from '../lib/build.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const spec = { version: 1, flows: { entry: 'main', main: { steps: [
  { id: 'plan', agent: 'claude' },
  { id: 'work', agent: 'codex' },
  { id: 'gate', gate: {} },
] } } };

test('only a missing sidecar returns {}; malformed or non-object JSON names the path', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'profile-preflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const specPath = resolve(dir, 'test.stratum.yaml');
  const sidecar = resolve(dir, 'test.profiles.json');
  assert.deepEqual(loadPipelineProfiles(specPath), {});
  for (const content of ['{broken', 'null', '[]', '42', 'true', '"profile"']) {
    writeFileSync(sidecar, content);
    assert.throws(() => loadPipelineProfiles(specPath), error => {
      assert.ok(error.message.startsWith(`Profile sidecar ${sidecar} is invalid: `));
      return true;
    });
  }
  writeFileSync(sidecar, '{"plan":"claude::coordinator"}');
  assert.deepEqual(loadPipelineProfiles(specPath), { plan: 'claude::coordinator' });
});

test('resolves profiles, bare literals and no-tier defaults without mutating inputs', () => {
  const profiles = { plan: 'claude:orchestrator:coordinator' };
  const before = structuredClone(spec);
  const result = preflightPipelineProfiles(profiles, spec);
  assert.deepEqual(result, { ok: true, resolved: {
    plan: { profile: profiles.plan, provider: 'claude', tier: 'coordinator', modelID: 'claude-fable-5-1' },
    work: { profile: 'codex', provider: 'codex', tier: null, modelID: null },
  } });
  assert.deepEqual(spec, before);
  assert.deepEqual(preflightPipelineProfiles(profiles, YAML.stringify(spec)), result);
  assert.equal(preflightPipelineProfiles({ plan: 'claude:orchestrator' }, spec).resolved.plan.modelID, null);
});

test('aggregates unknown tier, unavailable provider tier and stale keys with step names', () => {
  assert.throws(() => preflightPipelineProfiles({
    plan: 'claude::bogus', work: 'codex::coordinator', typo: 'claude',
  }, spec, 'example.stratum.yaml'), error => {
    assert.match(error.message, /^Profile preflight failed for example\.stratum\.yaml:/);
    assert.match(error.message, /step "plan": .*unknown tier "bogus"/);
    assert.match(error.message, /step "work": .*tier "coordinator" is not available for provider "codex"/);
    assert.match(error.message, /step "typo": not found in spec/);
    return true;
  });
});

test('metadata is skipped, while invalid profile values cannot fall back to a literal', () => {
  assert.equal(preflightPipelineProfiles({ _comment: null, _reduceSteps: ['plan'] }, spec).ok, true);
  for (const profile of [null, '', false, 42, {}, []]) {
    assert.throws(() => preflightPipelineProfiles({ plan: profile }, spec), /step "plan": profile must be a non-empty agent string/);
  }
});

test('checks every flow and every fanout stage with the enclosing sidecar profile', () => {
  const nested = structuredClone(spec);
  nested.flows.other = { steps: [{ id: 'execute', fanout: { steps: [
    { agent: 'claude' }, { agent: 'codex' },
  ] } }] };
  const result = preflightPipelineProfiles({}, nested);
  assert.equal(result.resolved['execute/0'].provider, 'claude');
  assert.equal(result.resolved['execute/1'].provider, 'codex');
  // A fanout-keyed profile over stages with different agents cannot be applied
  // honestly to both (review r1 #1) — it fails closed before any tier check.
  assert.throws(() => preflightPipelineProfiles({ execute: 'claude::bogus' }, nested),
    /step "execute": multi-stage fanout stages declare different agents/);
  const same = structuredClone(nested);
  same.flows.other.steps[0].fanout.steps[1].agent = 'claude';
  assert.throws(() => preflightPipelineProfiles({ execute: 'claude::bogus' }, same), error => {
    assert.match(error.message, /step "execute\/0": .*unknown tier/);
    assert.match(error.message, /step "execute\/1": .*unknown tier/);
    return true;
  });
});

// Discover all shipped specs and sidecars, including directories without sidecars.
for (const dir of ['presets', 'pipelines', 'templates']) {
  const root = resolve(repo, dir);
  if (!existsSync(root)) continue;
  const files = readdirSync(root, { recursive: true });
  for (const sidecar of files.filter(file => file.endsWith('.profiles.json'))) {
    test(`${dir}/${sidecar} has a matching spec`, () => {
      assert.ok(['yaml', 'yml'].some(ext => existsSync(resolve(root, sidecar.replace(/\.profiles\.json$/, `.stratum.${ext}`)))));
    });
  }
  for (const file of files.filter(file => /\.stratum\.ya?ml$/.test(file))) {
    test(`bundled profile preflight: ${dir}/${file}`, () => {
      const path = resolve(root, file);
      assert.equal(preflightPipelineProfiles(loadPipelineProfiles(path), readFileSync(path, 'utf8'), path).ok, true);
    });
  }
}

// Review r1 (slice 1): three routing shapes the first preflight certified wrongly.
const fanoutSpec = (fanout) => ({ version: 1, flows: { entry: 'main', main: { steps: [
  { id: 'seed', agent: 'claude' },
  { id: 'fan', after: ['seed'], fanout: { over: '${seed.output.tasks}', dispatch: 'consumer', ...fanout } },
] } } });

test('r1 #2: a fanout stage with no explicit agent still has its sidecar profile checked', () => {
  const spec = fanoutSpec({ steps: [{ do: 'work', out: 'TaskResult' }] });
  assert.throws(() => preflightPipelineProfiles({ fan: 'codex:x:coordinator' }, spec, 's'),
    /step "fan": .*coordinator.*not available for provider "codex"/);
  const ok = preflightPipelineProfiles({ fan: 'claude::critical' }, spec);
  assert.equal(ok.resolved.fan.modelID, 'claude-opus-5-5');
});

test('r1 #1: a multi-stage fanout whose stages declare different agents fails closed', () => {
  const spec = fanoutSpec({ steps: [
    { agent: '$.input.implementer_agent', do: 'a' },
    { agent: '$.input.reviewer_agent', do: 'b' },
  ] });
  assert.throws(() => preflightPipelineProfiles({}, spec, 's',
    { implementer_agent: 'claude::bogus', reviewer_agent: 'codex::critical' }),
    /step "fan": multi-stage fanout stages declare different agents/);
  // Same runtime reference on every stage is honest: one profile, every stage.
  const same = fanoutSpec({ steps: [
    { agent: '$.input.implementer_agent', do: 'a' },
    { agent: '$.input.implementer_agent', do: 'b' },
  ] });
  const ok = preflightPipelineProfiles({}, same, 's', { implementer_agent: 'claude', reviewer_agent: 'codex' });
  assert.equal(ok.resolved['fan/0'].provider, 'claude');
  assert.equal(ok.resolved['fan/1'].provider, 'claude');
});

test('r1 #3: a tiered or templated profile on an engine-dispatched fanout fails closed', () => {
  const spec = fanoutSpec({ dispatch: 'engine', steps: [{ agent: 'codex', do: 'work' }] });
  assert.throws(() => preflightPipelineProfiles({ fan: 'codex::critical' }, spec, 's'),
    /step "fan": .*dispatch: engine, where compose profiles are not applied/);
  assert.throws(() => preflightPipelineProfiles({ fan: 'claude:read-only-reviewer' }, spec, 's'),
    /dispatch: engine/);
  assert.equal(preflightPipelineProfiles({ fan: 'codex' }, spec).ok, true);
});

test('object-form sidecars normalize defaults, tier routing, metadata and gate mappings', () => {
  const spec = { version: 1, flows: { entry: 'main', main: { steps: [
    { id: 'plan', agent: 'claude' },
    { id: 'execute', after: ['plan'], fanout: { dispatch: 'consumer', isolation: 'worktree', steps: [{ agent: 'codex' }] } },
    { id: 'gate', after: ['execute'], gate: {} },
  ] } } };
  const profiles = { execute: { default: 'codex:implementer:standard', tier_from: 'item.tier' },
    _consumer: { execute: { ownership: 'item.files_owned', independent: true, checkpoint_gate: 'gate' } },
    gate: { decide_from: { step: 'plan', field: 'action', approve: ['done'], revise: ['retry'], kill: ['stop'] } } };
  const result = preflightPipelineProfiles(profiles, spec);
  assert.equal(result.normalized.execute.tier_from, 'item.tier');
  assert.equal(result.resolved.execute.modelID, 'gpt-6-sol');
  assert.match(result.profilesDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => preflightPipelineProfiles({ ...profiles, execute: { ...profiles.execute, tier_from: 'item.model' } }, spec), /tier_from/);
  const reserved = structuredClone(spec); reserved.flows.main.steps[2].id = 'review_gate';
  assert.throws(() => preflightPipelineProfiles({ review_gate: profiles.gate }, reserved), /not an available output gate/);
});


test('local team-fable-astra requires its bundled sidecar (execution configuration)', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'required-sidecar-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = 'team-fable-astra';
  const bundled = resolve(repo, 'presets', `${name}.stratum.yaml`);
  assert.doesNotThrow(() => requirePipelineSidecar(bundled));
  for (const ext of ['yaml', 'yml']) {
    const local = resolve(dir, `${name}.stratum.${ext}`);
    writeFileSync(local, readFileSync(bundled));
    assert.throws(() => requirePipelineSidecar(local), { code: 'PROFILE_SIDECAR_REQUIRED' });
  }
  writeFileSync(resolve(dir, `${name}.profiles.json`), '{}');
  assert.doesNotThrow(() => requirePipelineSidecar(resolve(dir, `${name}.stratum.yaml`)));
});

test('a string-only bundled sidecar (tool restrictions) keeps missing → defaults for a same-named local spec', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'optional-string-sidecar-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [directory, name] of [['presets', 'team-feature'], ['pipelines', 'build']]) {
    const bundledSidecar = JSON.parse(readFileSync(resolve(repo, directory, `${name}.profiles.json`), 'utf-8'));
    assert.equal(sidecarCarriesExecutionConfig(bundledSidecar), false, `${name} sidecar is string-only`);
    const local = resolve(dir, `${name}.stratum.yaml`);
    writeFileSync(local, readFileSync(resolve(repo, directory, `${name}.stratum.yaml`)));
    assert.doesNotThrow(() => requirePipelineSidecar(local));
  }
  assert.equal(sidecarCarriesExecutionConfig(JSON.parse(readFileSync(resolve(repo, 'presets/team-fable-astra.profiles.json'), 'utf-8'))), true);
  assert.equal(sidecarCarriesExecutionConfig({ execute: { default: 'codex', tier_from: 'item.tier' } }), true);
  assert.equal(sidecarCarriesExecutionConfig({ _costCeiling: { default: 1, gates: [] } }), true);
  assert.equal(sidecarCarriesExecutionConfig({ plan: 'claude::critical', _comment: { any: 1 }, _reduceSteps: ['x'] }), false);
});

test('sidecars remain optional for custom specs and bundled counterparts without sidecars', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'optional-sidecar-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(existsSync(resolve(repo, 'pipelines/content.stratum.yaml')));
  assert.ok(!existsSync(resolve(repo, 'pipelines/content.profiles.json')));
  for (const name of ['content', 'custom-with-no-bundled-counterpart']) {
    const local = resolve(dir, `${name}.stratum.yaml`);
    writeFileSync(local, YAML.stringify(spec));
    assert.doesNotThrow(() => requirePipelineSidecar(local));
    assert.deepEqual(loadPipelineProfiles(local), {});
  }
});

test('runBuild refuses a local preset without its required sidecar before any plan call', async t => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'required-sidecar-build-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(resolve(cwd, '.compose/data'), { recursive: true });
  mkdirSync(resolve(cwd, 'pipelines'));
  writeFileSync(resolve(cwd, '.compose/compose.json'), JSON.stringify({ version: 2 }));
  writeFileSync(resolve(cwd, 'pipelines/team-fable-astra.stratum.yaml'),
    readFileSync(resolve(repo, 'presets/team-fable-astra.stratum.yaml')));
  const calls = [];
  const stratum = {
    async plan() { calls.push('plan'); throw new Error('unexpected plan'); },
    async resume() { calls.push('resume'); throw new Error('unexpected resume'); },
    async agentRun() { calls.push('agentRun'); throw new Error('unexpected agent'); },
    async close() {},
  };
  await assert.rejects(runBuild('X', { cwd, template: 'team-fable-astra', stratum,
    skipTriage: true, description: 'Missing sidecar regression' }),
  { code: 'PROFILE_SIDECAR_REQUIRED' });
  assert.deepEqual(calls, [], 'zero plans, resumed flows, or agents');
});
