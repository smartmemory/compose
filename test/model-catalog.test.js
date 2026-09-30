import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createModelCatalogClient, getModelCatalog } from '../lib/model-catalog.js';
import { MODEL_TIERS, CODEX_MODEL_TIERS, DEVIN_MODEL_TIERS, TIER_THINKING,
  CODEX_TIER_THINKING, DEVIN_TIER_THINKING, createModelTierMaps } from '../server/model-tiers.js';

function fixture(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'compose-model-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'fake-bin.mjs');
  const mcp = join(dir, 'mcp.mjs');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@smartmemory/stratum',
    bin: { stratum: './fake-bin.mjs', 'stratum-mcp': './mcp.mjs' } }));
  writeFileSync(mcp, 'throw Error("MCP bin must never supply the catalog");');
  writeFileSync(bin, body);
  return { bin, mcp, dir, load: createModelCatalogClient({ resolveBin: kind => kind === 'mcp' ? mcp : bin }) };
}

test('bad JSON fails loudly naming the selected bin', t => {
  const f = fixture(t, 'console.log("not JSON");');
  assert.throws(f.load, error => error.message.includes(f.bin) && /Malformed model catalog JSON/.test(error.message));
});
test('valid JSON with malformed catalog fails loudly', t => {
  const f = fixture(t, 'console.log(JSON.stringify({catalog:{}, catalogDigest:"bad", path:"fake",version:"1"}));');
  assert.throws(f.load, /Malformed model catalog JSON/);
});
test('missing CLI in the selected MCP install fails loudly without substituting models', t => {
  const f = fixture(t, '');
  rmSync(f.bin);
  assert.throws(f.load, error => error.message.includes(f.bin) && /models --json failed/.test(error.message));
});
test('nonzero CLI exit cannot supply a partial catalog', t => {
  const f = fixture(t, 'console.log("{}"); console.error("broken installation"); process.exit(1);');
  assert.throws(f.load, /models --json failed: broken installation/);
});

for (const kind of ['malformed', 'unreadable']) test(`ancestor walk skips a ${kind} manifest and finds the Stratum installation`, t => {
  const payload = getModelCatalog();
  const f = fixture(t, `console.log(${JSON.stringify(JSON.stringify(payload))});`);
  const nested = join(f.dir, 'dist', 'mcp');
  mkdirSync(nested, { recursive: true });
  const manifest = join(f.dir, 'dist', 'package.json');
  if (kind === 'malformed') writeFileSync(manifest, '{bad');
  else mkdirSync(manifest); // EISDIR gives a deterministic read failure without permission assumptions.
  const mcp = join(nested, 'main.mjs');
  writeFileSync(mcp, '');
  const load = createModelCatalogClient({ resolveBin: binKind => binKind === 'mcp' ? mcp : f.bin,
    warn: () => assert.fail('same installation must not warn') });
  assert.equal(load().catalogDigest, payload.catalogDigest);
});

test('missing Stratum package names the MCP real path and directories checked', t => {
  const f = fixture(t, '');
  writeFileSync(join(f.dir, 'package.json'), '{bad');
  const nested = join(f.dir, 'dist', 'mcp');
  mkdirSync(nested, { recursive: true });
  const mcp = join(nested, 'main.mjs');
  writeFileSync(mcp, '');
  const link = join(f.dir, 'mcp-link.mjs');
  symlinkSync(mcp, link);
  const load = createModelCatalogClient({ resolveBin: () => link, run: () => assert.fail('must not spawn') });
  const realBin = realpathSync(mcp);
  assert.throws(load, error => {
    assert.ok(error.message.includes(`MCP bin ${realBin}`));
    assert.ok(error.message.includes(`directories checked: ${dirname(realBin)}, ${dirname(dirname(realBin))}, ${realpathSync(f.dir)}, `));
    assert.match(error.message, /, \/\. Set COMPOSE_STRATUM_TS_MCP_BIN/);
    return true;
  });
});

test('client is lazy, invokes models --json, and caches once', t => {
  const payload = getModelCatalog();
  const f = fixture(t, `import {appendFileSync} from 'node:fs';
    appendFileSync(new URL('./calls', import.meta.url), JSON.stringify(process.argv.slice(2))+'\\n');
    console.log(${JSON.stringify(JSON.stringify(payload))});`);
  const first = f.load();
  writeFileSync(f.bin, 'throw Error("must not run twice");');
  assert.equal(f.load(), first);
  assert.equal(readFileSync(join(f.dir, 'calls'), 'utf8'), '["models","--json"]\n');
  assert.equal(first.catalogDigest, payload.catalogDigest);
  assert.equal(first.path, payload.path);
  assert.ok(Object.isFrozen(first.catalog.tiers.codex.standard));
});
test('imports and plain-object key enumeration do not spawn the CLI', t => {
  const f = fixture(t, 'throw Error("eager catalog read");');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { MODEL_TIERS } from './server/model-tiers.js';
    import { parseAgentString } from './lib/agent-string.js';
    console.log(JSON.stringify([Object.keys(MODEL_TIERS), parseAgentString('codex::fast')]));`], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env,
      COMPOSE_STRATUM_TS_MCP_BIN: f.mcp, COMPOSE_STRATUM_TS_CLI_BIN: f.bin },
  });
  assert.deepEqual(JSON.parse(out)[0], ['critical', 'standard', 'fast', 'budget', 'coordinator']);
});
test('shipped provider contract preserves every key and supported tier', () => {
  const { catalog } = getModelCatalog();
  for (const [provider, models, thinking, unavailable] of [
    ['claude', MODEL_TIERS, TIER_THINKING, 'budget'],
    ['codex', CODEX_MODEL_TIERS, CODEX_TIER_THINKING, 'coordinator'],
    ['devin', DEVIN_MODEL_TIERS, DEVIN_TIER_THINKING, 'coordinator'],
  ]) {
    assert.equal(Object.getPrototypeOf(models), Object.prototype);
    for (const map of [catalog.tiers[provider], models, thinking]) {
      assert.deepEqual(Object.keys(map), ['critical', 'standard', 'fast', 'budget', 'coordinator']);
    }
    assert.equal(thinking.standard, thinking.standard, 'thinking entries keep plain-object identity');
    const accepted = provider === 'claude' ? catalog.models.claude : Object.keys(catalog.pricing[provider]);
    for (const key of Object.keys(models)) {
      if (key === unavailable) { assert.equal(models[key], null); assert.equal(thinking[key], null); continue; }
      assert.equal(typeof models[key], 'string');
      assert.ok(models[key].length > 0 && accepted.includes(models[key]), `${provider}:${key} must be available in its provider list`);
      assert.ok(!catalog.retired[provider].includes(models[key]));
      assert.ok(thinking[key] && Object.hasOwn(thinking[key], 'mode') && Object.hasOwn(thinking[key], 'effort'));
    }
  }
  for (const key of ['fast', 'budget']) {
    assert.notEqual(catalog.tiers.codex[key].effort, 'low', `Codex ${key} effort is never low (routing policy)`);
    assert.notEqual(CODEX_TIER_THINKING[key].effort, 'low');
  }
});

for (const [name, run] of [
  ['CLI failure', () => { throw new Error('broken installation'); }],
  ['timeout', () => { throw Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' }); }],
  ['bad JSON', () => 'not JSON'],
  ['invalid catalog', () => JSON.stringify({ catalog: {} })],
]) test(`client caches ${name} and rethrows the same error without spawning again`, t => {
  const f = fixture(t, '');
  let calls = 0;
  const load = createModelCatalogClient({ resolveBin: () => f.mcp, run: (...args) => { calls++; return run(...args); } });
  let first;
  assert.throws(load, error => {
    first = error;
    assert.match(error.message, /This failure is cached for this process; restart Compose after fixing it\./);
    return true;
  });
  assert.throws(load, error => error === first);
  assert.throws(load, error => error === first);
  assert.equal(calls, 1);
});

test('client caches a resolver failure before any CLI spawn', () => {
  const failure = new Error('missing MCP installation');
  let resolutions = 0;
  const load = createModelCatalogClient({ resolveBin: () => { resolutions++; throw failure; },
    run: () => assert.fail('must not spawn') });
  for (let i = 0; i < 3; i++) assert.throws(load, error => {
    assert.equal(error, failure);
    assert.match(error.message, /This failure is cached for this process; restart Compose after fixing it\./);
    return true;
  });
  assert.equal(resolutions, 1);
});

test('catalog comes from the dispatch MCP installation; mismatched CLI warns once and provenance follows it', t => {
  const payload = getModelCatalog();
  const selected = fixture(t, '');
  const other = fixture(t, 'throw Error("wrong installation");');
  const path = join(selected.dir, 'models.toml');
  writeFileSync(selected.bin, `console.log(${JSON.stringify(JSON.stringify({ ...payload, path }))});`);
  // The actual resolver receives independent env overrides; nested bins exercise root discovery.
  const nested = join(selected.dir, 'dist', 'mcp');
  mkdirSync(nested, { recursive: true });
  const mcp = join(nested, 'main.mjs');
  writeFileSync(mcp, 'throw Error("not a catalog CLI");');
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { getModelCatalog } from './lib/model-catalog.js';
    import { preflightPipelineProfiles } from './lib/pipeline-profiles.js';
    const warnings = []; console.warn = message => warnings.push(message);
    const first = getModelCatalog();
    const preflight = preflightPipelineProfiles({work: 'codex::standard'},
      {flows:{main:{steps:[{id:'work',agent:'codex'}]}}});
    console.log(JSON.stringify({path:first.path, same:first===getModelCatalog(), warnings,
      provenance:preflight.staticProvenance.work}));`], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env,
      COMPOSE_STRATUM_TS_MCP_BIN: mcp, COMPOSE_STRATUM_TS_CLI_BIN: other.bin },
  });
  const actual = JSON.parse(output);
  assert.equal(actual.path, path);
  assert.equal(actual.same, true);
  assert.equal(actual.warnings.length, 1);
  for (const bin of [mcp, other.bin, selected.bin]) assert.ok(actual.warnings[0].includes(bin));
  assert.equal(actual.provenance.path, path);
  assert.equal(actual.provenance.catalogDigest, payload.catalogDigest);
});

test('bins in the same installation (including a symlink) do not warn', t => {
  const payload = getModelCatalog();
  const f = fixture(t, `console.log(${JSON.stringify(JSON.stringify(payload))});`);
  const link = join(f.dir, 'mcp-link.mjs');
  symlinkSync(f.mcp, link);
  const load = createModelCatalogClient({ resolveBin: kind => kind === 'mcp' ? link : f.bin,
    warn: () => assert.fail('same installation must not warn') });
  assert.equal(load().catalogDigest, payload.catalogDigest);
});

test('all six tier adapters map a synthetic client catalog to independent expected values', t => {
  const f = fixture(t, '');
  const synthetic = {
    claude: { default: { model: 'c-default' } }, codex: { default: { model: 'x-default' } },
    devin: { default: { model: 'd-default' } },
    models: { claude: ['c-default', 'c-critical', 'c-standard', 'c-fast', 'c-coordinator'] },
    pricing: {
      codex: { 'x-default': {}, 'x-critical': {}, 'x-fast': {}, 'x-budget': {}, 'x-coordinator': {} },
      devin: { 'd-default': {}, 'd-critical': {}, 'd-standard': {}, 'd-budget': {}, 'd-coordinator': {} },
    },
    retired: { claude: [], codex: [], devin: [] },
    tiers: {
      claude: {
        critical: { model: 'c-critical', mode: 'adaptive', effort: 'max' },
        standard: { model: 'c-standard', mode: 'off', effort: 'minimal' },
        fast: { model: 'c-fast', mode: 'unavailable', effort: 'unavailable' },
        budget: 'unavailable',
        coordinator: { model: 'c-coordinator', mode: 'adaptive', effort: 'low' },
      },
      codex: {
        critical: { model: 'x-critical', mode: 'unavailable', effort: 'high' },
        standard: 'unavailable',
        fast: { model: 'x-fast', mode: 'off', effort: 'medium' },
        budget: { model: 'x-budget', mode: 'adaptive', effort: 'unavailable' },
        coordinator: { model: 'x-coordinator', mode: 'unavailable', effort: 'xhigh' },
      },
      devin: {
        critical: { model: 'd-critical', mode: 'off', effort: 'low' },
        standard: { model: 'd-standard', mode: 'unavailable', effort: 'unavailable' },
        fast: 'unavailable',
        budget: { model: 'd-budget', mode: 'adaptive', effort: 'minimal' },
        coordinator: { model: 'd-coordinator', mode: 'off', effort: 'max' },
      },
    },
  };
  const load = createModelCatalogClient({ resolveBin: () => f.mcp,
    run: () => JSON.stringify({ catalog: synthetic, catalogDigest: 'c'.repeat(64), path: f.bin, version: 'synthetic' }) });
  assert.deepEqual(createModelTierMaps(load), {
    MODEL_TIERS: { critical: 'c-critical', standard: 'c-standard', fast: 'c-fast', budget: null, coordinator: 'c-coordinator' },
    CODEX_MODEL_TIERS: { critical: 'x-critical', standard: null, fast: 'x-fast', budget: 'x-budget', coordinator: 'x-coordinator' },
    DEVIN_MODEL_TIERS: { critical: 'd-critical', standard: 'd-standard', fast: null, budget: 'd-budget', coordinator: 'd-coordinator' },
    TIER_THINKING: { critical: { mode: 'adaptive', effort: 'max' }, standard: { mode: 'off', effort: 'minimal' },
      fast: { mode: null, effort: null }, budget: null, coordinator: { mode: 'adaptive', effort: 'low' } },
    CODEX_TIER_THINKING: { critical: { mode: null, effort: 'high' }, standard: null,
      fast: { mode: 'off', effort: 'medium' }, budget: { mode: 'adaptive', effort: null }, coordinator: { mode: null, effort: 'xhigh' } },
    DEVIN_TIER_THINKING: { critical: { mode: 'off', effort: 'low' }, standard: { mode: null, effort: null },
      fast: null, budget: { mode: 'adaptive', effort: 'minimal' }, coordinator: { mode: 'off', effort: 'max' } },
  });
});
