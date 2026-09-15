import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { runPreMergeGateLocal } from '../lib/build.js';
import { consumerWaveFixture, git } from './helpers/consumer-wave-fixture.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTING_TRANSPORT_KEYS = [
  'route_mode',
  'routing_start',
  'routing_root',
  'routing_plan_intent',
  'routing_continuation',
];
const PIPELINES = [
  ['build-quick.stratum.yaml', 'decompose'],
  ['build.stratum.yaml', 'decompose'],
  ['gsd.stratum.yaml', 'decompose_gsd'],
];
const success = { output: { outcome: 'success', files_changed: ['owned.txt'] }, usage: { usd: 1 } };

test('shipped TDD decompositions require test ownership and preserve routing transport', () => {
  for (const [filename, stepId] of PIPELINES) {
    const spec = YAML.parse(readFileSync(join(ROOT, 'pipelines', filename), 'utf8'));
    const flow = spec.flows[spec.flows.entry];
    const step = flow.steps.find(candidate => candidate.id === stepId);

    assert.ok(step, `${filename} must contain ${stepId}`);
    assert.match(step.do, /MUST checklist:/i, `${filename} must use an explicit checklist`);
    assert.match(step.do, /files_owned MUST include every test file/i);
    assert.match(step.do, /implementer is required to write tests/i);
    assert.match(step.do, /may not\s+touch unowned paths/i);
    assert.match(step.do, /writes no test MUST say why in its description/i);
    assert.match(step.do, /files_owned MUST remain pairwise disjoint/i);
    assert.doesNotMatch(step.do, /\btest\//, `${filename} must not assume a test/ directory`);
    assert.deepEqual(step.ensure, [{ expr: 'len(result.tasks) >= 1' }]);
    for (const key of ROUTING_TRANSPORT_KEYS) {
      assert.equal(flow.input[key], 'string?', `${filename} must preserve ${key}`);
    }
  }
});

function captureAfterPreMergeBridge(t, edit) {
  const fixture = consumerWaveFixture(t);
  fixture.write('.gitignore', 'node_modules/\n');
  git(fixture.cwd, ['add', '.gitignore']);
  git(fixture.cwd, ['commit', '-qm', 'ignore dependency directory']);
  fixture.write('node_modules/pkg/marker.js', 'export default true;\n');

  const descriptor = fixture.descriptor({ id: 'T1', files_owned: ['owned.txt'] });
  const ready = fixture.artifacts.reconcileDescriptor(descriptor, fixture.audit(descriptor, 'running'));
  edit(fixture, ready.worktree);
  assert.equal(
    runPreMergeGateLocal(
      ready.worktree,
      ['test -f node_modules/pkg/marker.js'],
      fixture.cwd,
      30_000,
    ),
    null,
  );
  const issuance = fixture.artifacts.prepareIssuance(descriptor, success, {
    finalStage: true,
    itemBinding: fixture.binding(descriptor),
  });
  return { issuance, worktree: ready.worktree };
}

test('Compose dependency bridge is absent from ownership evidence while real unowned writes still fail', t => {
  const owned = captureAfterPreMergeBridge(t, (fixture, worktree) => {
    fixture.write('owned.txt', 'authorized\n', worktree);
  });
  assert.equal(owned.issuance.state, 'prepared');
  assert.deepEqual(owned.issuance.ownership.changedPaths, ['owned.txt']);
  assert.equal(existsSync(join(owned.worktree, 'node_modules')), false);

  const unowned = captureAfterPreMergeBridge(t, (fixture, worktree) => {
    fixture.write('unowned.txt', 'unauthorized\n', worktree);
  });
  assert.equal(unowned.issuance.state, 'failed');
  assert.equal(unowned.issuance.findings[0].code, 'FILES_OWNED_VIOLATION');
  assert.deepEqual(unowned.issuance.findings[0].files, ['unowned.txt']);
});
