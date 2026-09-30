import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { catalog, tier } from './helpers/model-catalog.js';
import { symbolicModelProjection } from './helpers/model-route-projection.js';

test('symbolic projection retains wrong selections and all other call options', () => {
  const resolution = { provider: 'codex', tier: 'standard', modelID: tier('codex', 'standard').model,
    effort: tier('codex', 'standard').effort, thinking: null, allowedTools: ['Read'], prompt: 'same' };
  const projected = symbolicModelProjection(resolution);
  assert.deepEqual(projected, { ...resolution, modelID: '<codex:standard>', effort: '<codex:standard>', thinking: '<codex:standard>' });
  assert.deepEqual(symbolicModelProjection(projected), projected);
  for (const [field, wrong] of [['modelID', 'wrong-model'], ['effort', 'wrong-effort'], ['thinking', { type: 'wrong' }]]) {
    assert.deepEqual(symbolicModelProjection({ ...resolution, [field]: wrong })[field], wrong);
  }
});

test('concrete production profilesDigest changes on catalog model AND effort changes; symbolic digest stays stable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-catalog-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'catalog.mjs');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@smartmemory/stratum', bin: { stratum: './catalog.mjs' } }));
  const probe = value => {
    writeFileSync(bin, `console.log(${JSON.stringify(JSON.stringify({ catalog: value, catalogDigest: 'a'.repeat(64), path: join(dir, 'models.toml'), version: 'fixture' }))});`);
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import {preflightPipelineProfiles} from './lib/pipeline-profiles.js';
      import {symbolicProfilesDigest} from './test/helpers/model-route-projection.js';
      const p=preflightPipelineProfiles({work:{default:'codex::standard',tier_from:'item.tier'}},
        {flows:{main:{steps:[{id:'work',fanout:{dispatch:'consumer',steps:[{agent:'codex'}]}}]}}});
      console.log(JSON.stringify({concrete:p.profilesDigest,symbolic:symbolicProfilesDigest(p),
        resolution:p.resolved.work,provenance:p.staticProvenance.work}));`], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env,
        COMPOSE_STRATUM_TS_MCP_BIN: bin, COMPOSE_STRATUM_TS_CLI_BIN: bin },
    }));
  };
  const original = probe(catalog);
  const modelChange = structuredClone(catalog);
  modelChange.tiers.codex.fast.model = Object.keys(catalog.pricing.codex).find(id => id !== catalog.tiers.codex.fast.model && !catalog.retired.codex.includes(id));
  const afterModel = probe(modelChange);
  const effortChange = structuredClone(catalog);
  effortChange.tiers.codex.standard.effort = catalog.tiers.codex.standard.effort === 'low' ? 'high' : 'low';
  const afterEffort = probe(effortChange);
  assert.notEqual(original.concrete, afterModel.concrete, 'model drift must change the real preflight digest');
  assert.notEqual(original.concrete, afterEffort.concrete, 'effort drift must change the real preflight digest');
  assert.equal(original.symbolic, afterModel.symbolic);
  assert.equal(original.symbolic, afterEffort.symbolic);
  assert.equal(afterEffort.resolution.effort, effortChange.tiers.codex.standard.effort);
  assert.equal(afterEffort.provenance.catalogDigest, 'a'.repeat(64));
  assert.equal(afterEffort.provenance.path, join(dir, 'models.toml'));
});

test('plain tier object adapters map independent synthetic model/effort/mode values', t => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-tier-adapters-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'catalog.mjs');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@smartmemory/stratum', bin: { stratum: './catalog.mjs' } }));
  const synthetic = structuredClone(catalog);
  synthetic.pricing.codex['fixture-codex-standard'] = { input: 1, output: 2, cache_read: 0 };
  synthetic.tiers.codex.standard = { model: 'fixture-codex-standard', effort: 'low', mode: 'unavailable' };
  synthetic.models.claude.push('fixture-claude-fast');
  synthetic.tiers.claude.fast = { model: 'fixture-claude-fast', effort: 'max', mode: 'adaptive' };
  writeFileSync(bin, `console.log(${JSON.stringify(JSON.stringify({ catalog: synthetic, catalogDigest: 'b'.repeat(64), path: bin, version: 'fixture' }))});`);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {MODEL_TIERS,CODEX_MODEL_TIERS,TIER_THINKING,CODEX_TIER_THINKING} from './server/model-tiers.js';
    console.log(JSON.stringify([MODEL_TIERS.fast,CODEX_MODEL_TIERS.standard,TIER_THINKING.fast,CODEX_TIER_THINKING.standard,MODEL_TIERS.budget]));`], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env,
      COMPOSE_STRATUM_TS_MCP_BIN: bin, COMPOSE_STRATUM_TS_CLI_BIN: bin },
  });
  assert.deepEqual(JSON.parse(output), ['fixture-claude-fast', 'fixture-codex-standard',
    { mode: 'adaptive', effort: 'max' }, { mode: null, effort: 'low' }, null]);
});
