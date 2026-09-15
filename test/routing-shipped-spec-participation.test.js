/** Shipped routing contracts: real files, never fixture-authored replacements. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  createRoutingStart,
  ROUTING_SPEC_PARTICIPATION,
  ROUTING_TRANSPORT_KEYS,
} from '../lib/routing-ledger.js';
import { loadPipelineProfiles, preflightPipelineProfiles } from '../lib/build.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_DIRS = ['pipelines', 'presets'];

function shippedSpecPaths() {
  return SPEC_DIRS.flatMap(dir => readdirSync(join(REPO_ROOT, dir))
    .filter(file => file.endsWith('.stratum.yaml'))
    .map(file => `${dir}/${file}`)).sort();
}

function entryInput(spec) {
  const flow = spec.flows?.[spec.flows.entry] ?? Object.values(spec.flows ?? {}).find(value => value?.steps);
  return flow?.input;
}

function declaresRoutingTransport(spec) {
  const input = entryInput(spec);
  return ROUTING_TRANSPORT_KEYS.every(key => input?.[key] === 'string?');
}

test('every shipped spec has an explicit routing-participation decision and matching entry contract', () => {
  const shipped = shippedSpecPaths();
  assert.deepEqual(
    Object.keys(ROUTING_SPEC_PARTICIPATION).sort(),
    shipped,
    'adding or removing a shipped spec requires an explicit routing-participation decision',
  );

  const violations = [];
  for (const path of shipped) {
    const decision = ROUTING_SPEC_PARTICIPATION[path];
    const spec = YAML.parse(readFileSync(join(REPO_ROOT, path), 'utf8'));
    if (typeof decision.reason !== 'string' || !decision.reason.trim()) {
      violations.push(`${path}: participation decision has no reason`);
    }
    if (typeof decision.participates !== 'boolean') {
      violations.push(`${path}: participation decision must be boolean`);
      continue;
    }
    const declares = declaresRoutingTransport(spec);
    if (decision.participates && !declares) {
      const input = entryInput(spec);
      const missing = ROUTING_TRANSPORT_KEYS.filter(key => input?.[key] !== 'string?');
      violations.push(`${path}: participates but entry input lacks string? declarations for ${missing.join(', ')}`);
    }
    if (!decision.participates && declares) {
      violations.push(`${path}: is non-participating but declares the complete routing transport`);
    }
  }
  assert.deepEqual(violations, []);
});

for (const name of ['build', 'build-quick']) {
  test(`createRoutingStart accepts the real parsed pipelines/${name}.stratum.yaml in shadow mode`, t => {
    const cwd = mkdtempSync(join(tmpdir(), `routing-real-${name}-`));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd });

    const path = join(REPO_ROOT, 'pipelines', `${name}.stratum.yaml`);
    const spec = YAML.parse(readFileSync(path, 'utf8'));
    const profiles = loadPipelineProfiles(path);
    const inputs = {
      featureCode: 'ROUTING-SHIPPED-SPEC',
      description: 'Prove the shipped entry contract can participate in shadow routing',
      pre_merge_gate: ['true'],
      implementer_agent: 'claude',
      reviewer_agent: 'codex',
    };
    const options = { mode: 'shadow' };
    const preflight = preflightPipelineProfiles(profiles, spec, path, inputs, options);

    const start = createRoutingStart({
      cwd,
      spec,
      inputs,
      originalProfiles: profiles,
      preflight,
      mode: 'shadow',
      presetId: spec.flows.entry,
    });
    assert.equal(start.mode, 'shadow');
    assert.deepEqual(start.spec.original, spec);
  });
}
