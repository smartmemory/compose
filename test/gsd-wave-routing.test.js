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
