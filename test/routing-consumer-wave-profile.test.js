import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { admitConsumerWave, planWithRouting } from '../lib/build.js';
import { routingDigest } from '../lib/model-router.js';
import { resolvePlanSpecValues } from '../lib/stratum-mcp-client.js';

const SPEC_TEXT = readFileSync('pipelines/build-quick.stratum.yaml', 'utf8');
const SPEC = YAML.parse(SPEC_TEXT);
const SIDECAR = JSON.parse(readFileSync('pipelines/build-quick.profiles.json', 'utf8'));

async function routedWave(t, { implementerAgent = 'claude', runtimeOverrides = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'routing-consumer-profile-'));
  const cwd = join(root, 'project');
  const stateRoot = join(root, 'flows');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(cwd); mkdirSync(stateRoot);
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Route'], { cwd });
  execFileSync('git', ['config', 'user.email', 'route@example.test'], { cwd });
  writeFileSync(join(cwd, 'base'), 'base');
  execFileSync('git', ['add', 'base'], { cwd });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const previousStateRoot = process.env.STRATUM_STATE_ROOT;
  process.env.STRATUM_STATE_ROOT = stateRoot;
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
    else process.env.STRATUM_STATE_ROOT = previousStateRoot;
  });

  const input = {
    featureCode: 'ROUTING-CONSUMER-PROFILE',
    description: 'Use the routing-start winner for consumer admission',
    pre_merge_gate: [],
    implementer_agent: implementerAgent,
    reviewer_agent: 'codex',
  };
  let snapshot;
  const stratum = {
    async plan(text, _flow, routedInput, options) {
      const effective = resolvePlanSpecValues(YAML.parse(text), routedInput);
      snapshot = {
        id: 'consumer-profile-run',
        revisionDigest: routingDigest(effective),
        spec: effective,
        input: routedInput,
        workspaceRoot: options.workspaceRoot,
        status: 'running',
        steps: {},
      };
      writeFileSync(join(stateRoot, `${snapshot.id}.json`), JSON.stringify(snapshot));
      return { runId: snapshot.id, revisionDigest: snapshot.revisionDigest, status: 'running', ready: [] };
    },
  };
  const { routing } = await planWithRouting({
    stratum,
    specYaml: SPEC_TEXT,
    flowName: 'build',
    input,
    cwd,
    featureCode: input.featureCode,
    profiles: SIDECAR,
    options: { mode: 'shadow', runtimeOverrides },
    artifactRoot,
  });

  const item = { id: 'task-1', description: 'Implement it', files_owned: ['lib/example.js'], files_read: [], depends_on: [] };
  const descriptor = {
    id: 'execute/0', step: 'execute', flow: 'build', item, itemIndex: 0, stage: 0,
    generation: 0, epoch: 0, dispatchToken: 'execute-token', policy: { isolation: 'worktree' },
  };
  snapshot.steps = {
    decompose: { status: 'succeeded', acceptedDispatchToken: 'decompose-token', output: { tasks: [item] } },
    execute: { status: 'running', epoch: 0, fanout: { items: [
      { status: 'ready', index: 0, stage: 0, epoch: 0, generation: 0, dispatchToken: descriptor.dispatchToken },
    ] } },
  };
  writeFileSync(join(stateRoot, `${snapshot.id}.json`), JSON.stringify(snapshot));

  const admitted = await admitConsumerWave({
    descriptor,
    descriptors: [descriptor],
    audit: snapshot,
    localSpec: SPEC,
    profiles: routing.start.mergedProfiles,
    artifacts: routing.artifacts,
    stratum,
    flowId: snapshot.id,
    routing,
  });
  const admissionId = admitted.bindings[descriptor.dispatchToken].routing.admissionId;
  return { admission: routing.artifacts.readRoutingRecord(admissionId), start: routing.start };
}

test('consumer admission uses the routing-start winner when the real sidecar omits the referenced stage', async t => {
  assert.equal(Object.hasOwn(SIDECAR, 'execute'), false, 'the shipped sidecar must omit execute');
  assert.equal(SPEC.flows.build.steps.find(step => step.id === 'execute').fanout.steps[0].agent, '$.input.implementer_agent');
  const { admission, start } = await routedWave(t);
  assert.deepEqual(admission.baseline.resolution, start.staticResolutions['build/execute/stage-0'].winner);
});

test('consumer admission preserves a recorded full-profile runtime override', async t => {
  const override = 'codex:general:critical';
  const { admission, start } = await routedWave(t, {
    implementerAgent: override,
    runtimeOverrides: { execute: override },
  });
  assert.deepEqual(admission.baseline.resolution, start.staticResolutions['build/execute/stage-0'].winner);
  assert.equal(admission.baseline.resolution.profile, override);
});

test('route mode off returns before resolving an omitted referenced-stage profile', async () => {
  const execute = SPEC.flows.build.steps.find(step => step.id === 'execute');
  const result = await admitConsumerWave({
    descriptor: { id: 'execute/0', step: 'execute', flow: 'build', stage: 0 },
    localSpec: { version: SPEC.version, flows: { entry: 'build', build: { steps: [execute] } } },
    profiles: SIDECAR,
  });
  assert.equal(result, null);
});
